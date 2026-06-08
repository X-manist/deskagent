'use strict';
const { EventEmitter } = require('events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const nacl = require('tweetnacl');

const PAIRING_TTL_MS = 24 * 60 * 60 * 1000;
const FILE_SHARE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const REMOTE_TURN_TTL_MS = 15 * 60 * 1000;
const MAX_REMOTE_EVENTS = 500;
const MAX_ZIP32_SIZE = 0xffffffff;

let crcTable = null;

function stableMachineId(baseDir) {
  return 'deskagent-' + crypto.createHash('sha256').update(String(baseDir || os.hostname())).digest('hex').slice(0, 24);
}

function randomCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 8; i += 1) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out;
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function crc32Table() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}

function crc32(buf) {
  const table = crc32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function zipNameSegment(value) {
  return String(value || 'file')
    .replace(/[\0\\/]+/g, '_')
    .trim() || 'file';
}

function collectZipEntries(inputPaths) {
  const entries = [];
  const walk = (absPath, zipName) => {
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absPath)) {
        walk(path.join(absPath, child), path.posix.join(zipName, zipNameSegment(child)));
      }
      return;
    }
    if (!stat.isFile()) return;
    if (stat.size > MAX_ZIP32_SIZE) {
      throw new Error('目录或多文件打包暂不支持超过 4GB 的单个文件，请直接发送该大文件');
    }
    entries.push({ absPath, zipName: zipName.replace(/^\/+/, '') || zipNameSegment(path.basename(absPath)), stat });
  };
  for (const item of inputPaths) {
    const absPath = path.resolve(item);
    if (!fs.existsSync(absPath)) throw new Error(`文件不存在：${absPath}`);
    walk(absPath, zipNameSegment(path.basename(absPath)));
  }
  if (!entries.length) throw new Error('没有可分享的文件');
  return entries;
}

function writeAll(fd, buf) {
  fs.writeSync(fd, buf, 0, buf.length);
}

function createZipArchive(inputPaths, outputPath) {
  const entries = collectZipEntries(inputPaths);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const central = [];
  let offset = 0;
  const fd = fs.openSync(outputPath, 'w');
  try {
    for (const entry of entries) {
      const data = fs.readFileSync(entry.absPath);
      const nameBuf = Buffer.from(entry.zipName, 'utf8');
      const { time, date } = dosDateTime(entry.stat.mtimeMs);
      const checksum = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      writeAll(fd, local);
      writeAll(fd, nameBuf);
      writeAll(fd, data);
      central.push({ nameBuf, checksum, size: data.length, time, date, offset });
      offset += local.length + nameBuf.length + data.length;
    }
    const centralOffset = offset;
    for (const entry of central) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.checksum, 16);
      header.writeUInt32LE(entry.size, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.nameBuf.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(entry.offset, 42);
      writeAll(fd, header);
      writeAll(fd, entry.nameBuf);
      offset += header.length + entry.nameBuf.length;
    }
    const centralSize = offset - centralOffset;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    writeAll(fd, end);
  } finally {
    fs.closeSync(fd);
  }
  return { entryCount: entries.length };
}

function prepareShareArtifact(inputPaths, cacheDir) {
  const resolved = (inputPaths || []).map((item) => path.resolve(String(item || ''))).filter(Boolean);
  if (!resolved.length) throw new Error('请选择要发送到手机的文件或目录');
  if (resolved.length === 1) {
    const stat = fs.statSync(resolved[0]);
    if (stat.isFile()) {
      return {
        filePath: resolved[0],
        name: path.basename(resolved[0]) || 'download',
        packaged: false,
        temporary: false,
        sourceCount: 1,
      };
    }
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const firstName = resolved.length === 1 ? zipNameSegment(path.basename(resolved[0])) : 'deskagent-share';
  const name = `${firstName}-${stamp}.zip`;
  const filePath = path.join(cacheDir, name);
  const zipInfo = createZipArchive(resolved, filePath);
  return {
    filePath,
    name,
    packaged: true,
    temporary: true,
    sourceCount: resolved.length,
    entryCount: zipInfo.entryCount,
  };
}

function asciiFilenameFallback(name) {
  return String(name || 'download')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .trim()
    .slice(0, 180) || 'download';
}

function encodeRfc5987(value) {
  return encodeURIComponent(String(value || 'download'))
    .replace(/['()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');
}

function contentDispositionAttachment(name) {
  const fallback = asciiFilenameFallback(name).replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(name || fallback)}`;
}

function contentTypeFor(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.zip') return 'application/zip';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.txt' || ext === '.md' || ext === '.csv') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function remoteActivityDisplay(payload = {}) {
  if (payload.display) return payload.display;
  if (payload.kind === 'file') return '已修改文件：' + (payload.files || []).join(', ');
  if (payload.kind === 'reasoning') return payload.text || '思考中';
  if (payload.kind === 'command') {
    const status = payload.phase === 'started' || payload.phase === 'delta' ? '正在执行命令' : '命令执行完成';
    return [status, payload.text || '', payload.output ? `输出：${payload.output}` : ''].filter(Boolean).join('\n');
  }
  if (payload.kind === 'tool') {
    const status = payload.phase === 'started' || payload.phase === 'progress' ? '正在调用工具' : '工具调用完成';
    return [status, payload.text || '', payload.output ? `结果：${payload.output}` : ''].filter(Boolean).join('\n');
  }
  return payload.text || '';
}

function fromBase64url(value) {
  return Buffer.from(String(value || ''), 'base64url');
}

function tweetNaclBrowserPath() {
  try {
    return require.resolve('tweetnacl/nacl-fast.min.js');
  } catch (_) {
    return '';
  }
}

function json(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(bytes);
}

function html(res, body) {
  const bytes = Buffer.from(body);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
  });
  res.end(bytes);
}

function js(res, body) {
  const bytes = Buffer.from(body);
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Content-Length': bytes.length,
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(bytes);
}

function wsAcceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(String(key || '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function wsTextFrame(text) {
  const payload = Buffer.from(String(text));
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length <= 0xffff) {
    const head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
    return Buffer.concat([head, payload]);
  }
  const head = Buffer.alloc(10);
  head[0] = 0x81;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([head, payload]);
}

function wsCloseFrame() {
  return Buffer.from([0x88, 0x00]);
}

function notFound(res) {
  json(res, 404, { ok: false, error: 'not_found' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function networkUrls(port) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const iface of entries || []) {
      if (!iface || iface.internal || iface.family !== 'IPv4') continue;
      urls.push(`http://${iface.address}:${port}`);
    }
  }
  urls.sort((a, b) => {
    const ap = a.includes('192.168.') || a.includes('10.') || a.includes('172.');
    const bp = b.includes('192.168.') || b.includes('10.') || b.includes('172.');
    return Number(bp) - Number(ap) || a.localeCompare(b);
  });
  return urls;
}

function encryptJson(key, data) {
  const secret = new Uint8Array(key);
  const nonce = crypto.randomBytes(nacl.secretbox.nonceLength);
  const plaintext = Buffer.from(JSON.stringify(data));
  const encrypted = nacl.secretbox(new Uint8Array(plaintext), new Uint8Array(nonce), secret);
  return {
    v: 1,
    n: base64url(nonce),
    data: base64url(Buffer.from(encrypted)),
  };
}

function decryptJson(key, envelope) {
  if (!envelope || Number(envelope.v) !== 1) throw new Error('加密消息版本不支持');
  const nonce = fromBase64url(envelope.n || envelope.iv);
  const encrypted = fromBase64url(envelope.data);
  const plaintext = nacl.secretbox.open(
    new Uint8Array(encrypted),
    new Uint8Array(nonce),
    new Uint8Array(key),
  );
  if (!plaintext) throw new Error('加密消息校验失败');
  return JSON.parse(Buffer.from(plaintext).toString('utf8'));
}

function stripThinkText(value) {
  let text = String(value || '');
  text = text.replace(/```(?:think|thinking)[^\n]*\n[\s\S]*?(?:\n```\s*|$)/gi, '');
  text = text.replace(/<think(?:ing)?\b[^>]*>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi, '');
  text = text.replace(/<\/think(?:ing)?>/gi, '');
  text = text.replace(/&lt;think(?:ing)?\b[^&]*?&gt;[\s\S]*?(?:&lt;\/think(?:ing)?&gt;|$)/gi, '');
  text = text.replace(/&lt;\/think(?:ing)?&gt;/gi, '');
  return text;
}

function remoteVisibleMessages(messages) {
  return (messages || [])
    .map((item) => ({
      item,
      text: stripThinkText(item && item.text),
    }))
    .filter(({ item, text }) => item && item.kind === 'message' && String(text || '').trim())
    .map(({ item, text }) => ({
      role: item.role === 'ai' || item.role === 'assistant' ? 'assistant' : 'user',
      text,
    }));
}

function remotePageHtml() {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>智界助手直连控制</title>
  <style>
    :root { color-scheme: light dark; --bg:#f6f7fb; --surface:#ffffff; --surface2:#f1f4f9; --line:#d9dfeb; --text:#171b22; --muted:#667085; --accent:#2563eb; --accent2:#0f766e; --danger:#dc2626; --shadow:0 20px 50px rgba(18,24,40,.10); }
    * { box-sizing:border-box; }
    html, body { min-height:100%; }
    body { margin:0; min-height:100svh; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; color:var(--text); background:var(--bg); }
    main { height:100svh; width:min(1180px,100%); margin:0 auto; padding:12px; display:flex; flex-direction:column; gap:10px; }
    header { flex:0 0 auto; min-height:48px; display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .title-row { display:flex; align-items:center; gap:8px; min-width:0; }
    h1 { margin:0; font-size:18px; line-height:1.25; white-space:nowrap; }
    .actions { display:flex; gap:8px; align-items:center; justify-content:flex-end; }
    .pill, .ghost, .icon { padding:7px 10px; border:1px solid var(--line); border-radius:8px; color:var(--muted); background:var(--surface); font-size:12px; }
    .ghost, .icon { cursor:pointer; color:var(--text); font-weight:650; }
    .icon { min-width:42px; display:none; }
    .layout { flex:1; min-height:0; display:grid; grid-template-columns:288px minmax(0,1fr); gap:10px; align-items:stretch; }
    .panel { border:1px solid var(--line); border-radius:10px; background:var(--surface); box-shadow:var(--shadow); overflow:hidden; min-width:0; }
    .side { display:flex; flex-direction:column; min-height:0; }
    .side-head { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:12px; border-bottom:1px solid var(--line); }
    .side-title { font-size:13px; font-weight:750; color:var(--muted); }
    .sessions { padding:8px; overflow:auto; display:flex; flex-direction:column; gap:7px; }
    .files { flex:0 0 auto; border-top:1px solid var(--line); padding:8px; display:flex; flex-direction:column; gap:7px; max-height:34%; overflow:auto; }
    .file-link { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px; border:1px solid var(--line); border-radius:8px; color:var(--text); background:transparent; text-decoration:none; }
    .file-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; font-weight:650; }
    .file-meta { flex:0 0 auto; color:var(--muted); font-size:11px; }
    .session { width:100%; text-align:left; color:var(--text); background:transparent; border:1px solid transparent; border-radius:8px; padding:9px; cursor:pointer; }
    .session.active { border-color:rgba(37,99,235,.28); background:#eff6ff; }
    .session-title { font-size:14px; line-height:1.38; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
    .session-meta { margin-top:4px; color:var(--muted); font-size:11px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .chat { display:flex; flex-direction:column; min-height:0; }
    .status { flex:0 0 auto; padding:12px 14px; border-bottom:1px solid var(--line); color:var(--muted); font-size:13px; }
    .messages { flex:1; min-height:0; overflow:auto; padding:14px; display:flex; flex-direction:column; gap:10px; background:var(--surface2); }
    .msg { max-width:82%; padding:10px 12px; border-radius:14px; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; font-size:15px; }
    .me { align-self:flex-end; background:var(--accent); color:white; border-bottom-right-radius:5px; }
    .ai { align-self:flex-start; border:1px solid var(--line); background:var(--surface); border-bottom-left-radius:5px; }
    .sys { align-self:center; max-width:100%; border:1px solid var(--line); background:var(--surface); color:var(--muted); font-size:13px; }
    .activity-msg { display:inline-flex; align-items:center; gap:8px; text-align:left; }
    .activity-spin { width:14px; height:14px; border:2px solid rgba(37,99,235,.22); border-top-color:var(--accent); border-radius:999px; animation:spin .8s linear infinite; }
    .activity-done .activity-spin { display:none; }
    .streaming::after { content:""; display:inline-block; width:6px; height:1em; margin-left:3px; vertical-align:-2px; background:var(--accent2); animation:blink 1s steps(2,end) infinite; }
    @keyframes blink { 0%,45%{opacity:1} 46%,100%{opacity:0} }
    @keyframes spin { to { transform:rotate(360deg); } }
    form { flex:0 0 auto; display:flex; gap:9px; padding:10px; border-top:1px solid var(--line); background:var(--surface); }
    textarea { flex:1; min-height:48px; max-height:140px; resize:vertical; padding:10px 11px; border:1px solid var(--line); border-radius:10px; color:var(--text); background:var(--surface); font:inherit; font-size:16px; line-height:1.45; }
    button { flex:0 0 auto; min-width:76px; border:0; border-radius:10px; color:white; background:var(--accent); font:inherit; font-weight:700; cursor:pointer; }
    button.ghost { min-width:auto; border:1px solid var(--line); color:var(--text); background:var(--surface); font-weight:650; }
    button:disabled { opacity:.58; cursor:not-allowed; }
    .err { color:var(--danger); }
    .drawer-backdrop { display:none; }
    @media (max-width:720px) {
      main{width:100%;padding:0;gap:0}
      header{height:52px;padding:8px 10px;border-bottom:1px solid var(--line);background:var(--surface)}
      h1{font-size:17px}
      .icon{display:inline-flex;align-items:center;justify-content:center}
      .actions{gap:6px}
      .actions .ghost{display:none}
      .layout{display:block;position:relative;min-height:0}
      .side{position:fixed;z-index:20;inset:0 auto 0 0;width:min(82vw,320px);border-radius:0;border-left:0;box-shadow:0 24px 80px rgba(18,24,40,.22);transform:translateX(-105%);transition:transform .18s ease}
      body.drawer-open .side{transform:translateX(0)}
      .drawer-backdrop{position:fixed;z-index:19;inset:0;background:rgba(15,23,42,.36)}
      body.drawer-open .drawer-backdrop{display:block}
      .chat{height:calc(100svh - 52px);border:0;border-radius:0;box-shadow:none}
      .messages{padding:12px}
      .msg{max-width:92%;font-size:15px}
      form{padding:10px max(10px,env(safe-area-inset-right)) max(10px,env(safe-area-inset-bottom)) max(10px,env(safe-area-inset-left))}
    }
    @media (prefers-color-scheme: dark) { :root { --bg:#101318; --surface:#171b22; --surface2:#11151b; --line:#2b3442; --text:#eef2f7; --muted:#98a2b3; --accent:#3b82f6; --accent2:#2dd4bf; --shadow:none; } .session.active{background:#172554} textarea{background:#11151b} }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="title-row">
        <button class="icon" id="toggleHistory" type="button">历史</button>
        <h1>智界助手</h1>
      </div>
      <div class="actions">
        <button class="ghost" id="newSession" type="button">新建会话</button>
        <button class="ghost" id="refreshSessions" type="button">刷新历史</button>
        <span class="pill" id="state">初始化</span>
      </div>
    </header>
    <div class="layout">
      <aside class="panel side">
        <div class="side-head">
          <div class="side-title">历史会话</div>
          <span class="pill" id="sessionCount">0</span>
        </div>
        <div class="sessions" id="sessions"></div>
        <div class="files">
          <div class="side-head" style="padding:0 0 6px;border:0">
            <div class="side-title">可下载文件</div>
            <span class="pill" id="fileCount">0</span>
          </div>
          <div id="files"></div>
        </div>
      </aside>
      <section class="panel chat">
        <div class="status" id="status">正在建立加密直连…</div>
        <div class="messages" id="messages"></div>
        <form id="form">
          <textarea id="text" placeholder="输入要发送给桌面助手的任务…"></textarea>
          <button id="send" type="submit">发送</button>
        </form>
      </section>
    </div>
    <div class="drawer-backdrop" id="drawerBackdrop"></div>
  </main>
  <script src="/vendor/tweetnacl.min.js"></script>
  <script>
    const params = new URLSearchParams(location.search);
    const hashParams = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    const code = params.get('code') || hashParams.get('code') || '';
    const keyText = hashParams.get('k') || params.get('k') || '';
    const stateEl = document.getElementById('state');
    const statusEl = document.getElementById('status');
    const messagesEl = document.getElementById('messages');
    const sessionsEl = document.getElementById('sessions');
    const sessionCountEl = document.getElementById('sessionCount');
    const filesEl = document.getElementById('files');
    const fileCountEl = document.getElementById('fileCount');
    const form = document.getElementById('form');
    const textEl = document.getElementById('text');
    const sendEl = document.getElementById('send');
    const newSessionEl = document.getElementById('newSession');
    const refreshSessionsEl = document.getElementById('refreshSessions');
    const toggleHistoryEl = document.getElementById('toggleHistory');
    const drawerBackdropEl = document.getElementById('drawerBackdrop');
    let keyBytes;
    let currentThreadId = '';
    let activeTurnId = '';
    let activeSeq = 0;
    let activeAiEl = null;
    let polling = false;
    const activeActivities = new Map();
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    function setDrawer(open) {
      document.body.classList.toggle('drawer-open', !!open);
    }

    function b64ToBytes(value) {
      const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
      const raw = atob(normalized);
      return Uint8Array.from(raw, c => c.charCodeAt(0));
    }
    function bytesToB64(bytes) {
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }
    function loadKey() {
      if (!window.nacl || !nacl.secretbox) throw new Error('加密模块加载失败，请重新扫码');
      keyBytes = b64ToBytes(keyText);
      if (keyBytes.length !== nacl.secretbox.keyLength) throw new Error('连接密钥无效，请重新扫码');
    }
    function encryptJson(data) {
      const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
      const cipher = nacl.secretbox(enc.encode(JSON.stringify(data)), nonce, keyBytes);
      return { v:1, n:bytesToB64(nonce), data:bytesToB64(cipher) };
    }
    function decryptJson(env) {
      const plain = nacl.secretbox.open(b64ToBytes(env.data), b64ToBytes(env.n || env.iv), keyBytes);
      if (!plain) throw new Error('加密消息校验失败');
      return JSON.parse(dec.decode(plain));
    }
    function add(text, cls='sys') {
      const el = document.createElement('div');
      el.className = 'msg ' + cls;
      el.textContent = text;
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function formatSize(bytes) {
      const value = Number(bytes || 0);
      if (value >= 1024 * 1024 * 1024) return (value / 1024 / 1024 / 1024).toFixed(1) + ' GB';
      if (value >= 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB';
      if (value >= 1024) return (value / 1024).toFixed(1) + ' KB';
      return value + ' B';
    }
    function renderFiles(files) {
      filesEl.innerHTML = '';
      fileCountEl.textContent = String((files || []).length);
      if (!(files || []).length) {
        const empty = document.createElement('div');
        empty.className = 'session-meta';
        empty.textContent = '桌面端发送后会显示在这里';
        filesEl.appendChild(empty);
        return;
      }
      for (const file of files) {
        const link = document.createElement('a');
        link.className = 'file-link';
        link.href = file.download_url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.download = file.name || '';
        const name = document.createElement('span');
        name.className = 'file-name';
        name.textContent = file.name || 'download';
        const meta = document.createElement('span');
        meta.className = 'file-meta';
        meta.textContent = formatSize(file.size);
        link.appendChild(name);
        link.appendChild(meta);
        filesEl.appendChild(link);
      }
    }
    async function loadFiles() {
      const payload = await secure('/api/remote/direct/files', { t:'list_files', at:Date.now() });
      renderFiles(payload.files || []);
    }
    function updateActivity(event) {
      const key = event.item_id || event.kind || 'activity';
      let el = activeActivities.get(key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'msg sys activity-msg';
        const spin = document.createElement('span');
        spin.className = 'activity-spin';
        const label = document.createElement('span');
        label.className = 'activity-text';
        el.appendChild(spin);
        el.appendChild(label);
        messagesEl.appendChild(el);
        activeActivities.set(key, el);
      }
      const label = el.querySelector('.activity-text');
      if (label) label.textContent = event.display || event.text || '工具执行中…';
      const completed = event.phase === 'completed';
      el.classList.toggle('activity-done', completed);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function stripThinkText(value) {
      let text = String(value || '');
      const fence = String.fromCharCode(96, 96, 96);
      text = text.replace(new RegExp(fence + '(?:think|thinking)[^\\n]*\\n[\\s\\S]*?(?:\\n' + fence + '\\s*|$)', 'gi'), '');
      text = text.replace(/<think(?:ing)?\b[^>]*>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi, '');
      text = text.replace(/<\/think(?:ing)?>/gi, '');
      text = text.replace(/&lt;think(?:ing)?\b[^&]*?&gt;[\s\S]*?(?:&lt;\/think(?:ing)?&gt;|$)/gi, '');
      text = text.replace(/&lt;\/think(?:ing)?&gt;/gi, '');
      return text;
    }
    async function api(path, body) {
      const res = await fetch(path, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    async function secure(path, payload) {
      const res = await api(path, { code, msg: await encryptJson(payload) });
      return await decryptJson(res.msg);
    }
    function fmtTime(value) {
      if (!value) return '';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleString([], { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
    }
    function setCurrentThread(threadId) {
      currentThreadId = threadId || '';
      for (const el of sessionsEl.querySelectorAll('.session')) {
        el.classList.toggle('active', el.dataset.threadId === currentThreadId);
      }
    }
    async function boot() {
      if (!code || !keyText) throw new Error('连接参数不完整，请重新扫码');
      loadKey();
      const payload = await secure('/api/remote/direct/hello', { t:'hello', at:Date.now() });
      stateEl.textContent = '已加密连接';
      statusEl.textContent = payload.message || '已直连这台电脑';
      add('已建立端到端加密直连。');
      await loadSessions();
      await loadFiles().catch(() => {});
      setInterval(() => loadFiles().catch(() => {}), 10000);
      textEl.focus();
    }
    function renderSessions(list) {
      sessionsEl.innerHTML = '';
      sessionCountEl.textContent = String(list.length);
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'session-meta';
        empty.textContent = '暂无历史会话';
        sessionsEl.appendChild(empty);
        return;
      }
      for (const session of list) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'session';
        btn.dataset.threadId = session.id;
        btn.innerHTML = '<div class="session-title"></div><div class="session-meta"></div>';
        btn.querySelector('.session-title').textContent = session.preview || '新会话';
        btn.querySelector('.session-meta').textContent = (fmtTime(session.updated_at || session.created_at) || '最近') + ' · ' + String(session.id || '').slice(0, 8);
        btn.addEventListener('click', () => {
          setDrawer(false);
          openHistory(session.id);
        });
        sessionsEl.appendChild(btn);
      }
      setCurrentThread(currentThreadId);
    }
    async function loadSessions() {
      const payload = await secure('/api/remote/direct/sessions', { t:'list_sessions', at:Date.now() });
      const sessions = payload.sessions || [];
      if (!currentThreadId) currentThreadId = payload.current_thread_id || (sessions[0] && sessions[0].id) || '';
      renderSessions(sessions);
    }
    function renderHistory(messages) {
      messagesEl.innerHTML = '';
      for (const message of messages || []) {
        const visibleText = stripThinkText(message.text || '');
        if (visibleText.trim()) add(visibleText, message.role === 'assistant' ? 'ai' : 'me');
      }
      if (!(messages || []).length) add('已切换会话。', 'sys');
    }
    async function openHistory(threadId) {
      if (!threadId || polling) return;
      const payload = await secure('/api/remote/direct/history', { t:'history', thread_id:threadId, at:Date.now() });
      setCurrentThread(payload.thread_id || threadId);
      renderHistory(payload.messages || []);
      statusEl.textContent = '已打开历史会话';
    }
    async function createSession() {
      if (polling) return;
      const payload = await secure('/api/remote/direct/new-session', { t:'new_session', at:Date.now() });
      setCurrentThread(payload.thread_id);
      messagesEl.innerHTML = '';
      add('已新建会话。', 'sys');
      statusEl.textContent = '新会话已就绪';
      await loadSessions();
      setDrawer(false);
    }
    function ensureAiBubble() {
      if (activeAiEl) return activeAiEl;
      activeAiEl = document.createElement('div');
      activeAiEl.className = 'msg ai streaming';
      activeAiEl.textContent = '';
      messagesEl.appendChild(activeAiEl);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return activeAiEl;
    }
    function handleTurnEvent(event) {
      if (event.type === 'accepted') {
        statusEl.textContent = event.message || '桌面助手已接收任务';
      } else if (event.type === 'thread_changed') {
        setCurrentThread(event.thread_id);
      } else if (event.type === 'delta') {
        const raw = event.text || ((activeAiEl && activeAiEl.dataset.rawText) || '') + (event.delta || '');
        const visibleText = stripThinkText(raw);
        if (visibleText.trim()) {
          const bubble = ensureAiBubble();
          bubble.dataset.rawText = raw;
          bubble.textContent = visibleText;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      } else if (event.type === 'message') {
        const visibleText = stripThinkText(event.text || '');
        if (visibleText.trim()) {
          ensureAiBubble().textContent = visibleText;
          activeAiEl.classList.remove('streaming');
        }
      } else if (event.type === 'activity') {
        updateActivity(event);
      } else if (event.type === 'error') {
        add(event.message || '远程任务失败', 'sys err');
        return true;
      } else if (event.type === 'done') {
        return true;
      }
      return false;
    }
    function wsUrl(turnId) {
      const url = new URL('/api/remote/direct/ws', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('code', code);
      url.searchParams.set('turn_id', turnId);
      return url.toString();
    }
    function streamTurnSocket(turnId) {
      return new Promise((resolve, reject) => {
        if (!window.WebSocket) return reject(new Error('WebSocket 不可用'));
        let opened = false;
        let done = false;
        const ws = new WebSocket(wsUrl(turnId));
        const timer = setTimeout(() => {
          if (!opened) {
            try { ws.close(); } catch (_) {}
            reject(new Error('WebSocket 连接超时'));
          }
        }, 900);
        ws.addEventListener('open', () => {
          opened = true;
          clearTimeout(timer);
          stateEl.textContent = '已加密连接 · WS';
        });
        ws.addEventListener('message', async (event) => {
          try {
            const outer = JSON.parse(event.data);
            const payload = await decryptJson(outer.msg);
            if (payload.thread_id) setCurrentThread(payload.thread_id);
            activeSeq = payload.next_seq || activeSeq;
            if (payload.event && handleTurnEvent(payload.event)) {
              done = true;
              try { ws.close(); } catch (_) {}
              resolve();
            }
          } catch (err) {
            done = true;
            try { ws.close(); } catch (_) {}
            reject(err);
          }
        });
        ws.addEventListener('error', () => {
          if (!opened) reject(new Error('WebSocket 连接失败'));
        });
        ws.addEventListener('close', () => {
          clearTimeout(timer);
          if (!opened) return;
          if (!done) reject(new Error('WebSocket 连接已断开'));
        });
      });
    }
    async function pollTurn(turnId) {
      if (!turnId || polling) return;
      polling = true;
      activeTurnId = turnId;
      activeSeq = 0;
      activeAiEl = null;
      let done = false;
      let failed = false;
      try {
        try {
          await streamTurnSocket(turnId);
          done = true;
        } catch (_) {
          stateEl.textContent = '已加密连接 · HTTP';
        }
        while (!done && activeTurnId === turnId) {
          const payload = await secure('/api/remote/direct/events', { t:'events', turn_id:turnId, since_seq:activeSeq, at:Date.now() });
          activeSeq = payload.next_seq || activeSeq;
          if (payload.thread_id) setCurrentThread(payload.thread_id);
          for (const event of payload.events || []) {
            if (handleTurnEvent(event)) done = true;
          }
          done = done || !!payload.done;
          if (!done) await new Promise(resolve => setTimeout(resolve, 650));
        }
      } catch (err) {
        failed = true;
        throw err;
      } finally {
        if (activeAiEl) activeAiEl.classList.remove('streaming');
        activeTurnId = '';
        polling = false;
        if (!failed) {
          statusEl.textContent = '回复完成';
          await loadSessions().catch(() => {});
          await loadFiles().catch(() => {});
        }
      }
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = textEl.value.trim();
      if (!text) return;
      sendEl.disabled = true;
      newSessionEl.disabled = true;
      add(text, 'me');
      textEl.value = '';
      try {
        const payload = await secure('/api/remote/direct/command', { t:'chat_message', text, thread_id:currentThreadId, at:Date.now() });
        setCurrentThread(payload.thread_id);
        statusEl.textContent = payload.message || '桌面助手已接收任务';
        await pollTurn(payload.turn_id);
      } catch (err) {
        add((err && err.message) || '发送失败', 'sys err');
      } finally {
        sendEl.disabled = false;
        newSessionEl.disabled = false;
        textEl.focus();
      }
    });
    newSessionEl.addEventListener('click', () => createSession().catch(err => add((err && err.message) || '新建失败', 'sys err')));
    refreshSessionsEl.addEventListener('click', () => loadSessions().catch(err => add((err && err.message) || '刷新失败', 'sys err')));
    if (toggleHistoryEl) toggleHistoryEl.addEventListener('click', () => setDrawer(!document.body.classList.contains('drawer-open')));
    if (drawerBackdropEl) drawerBackdropEl.addEventListener('click', () => setDrawer(false));
    boot().catch((err) => {
      stateEl.textContent = '连接失败';
      statusEl.textContent = (err && err.message) || '连接失败';
      statusEl.classList.add('err');
      sendEl.disabled = true;
      newSessionEl.disabled = true;
      refreshSessionsEl.disabled = true;
    });
  </script>
</body>
</html>`;
}

class RemoteHost extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.machineId = stableMachineId(opts.baseDir);
    this.running = false;
    this.server = null;
    this.port = 0;
    this.pairing = null;
    this.lastError = '';
    this.inFlight = new Set();
    this.remoteTurns = new Map();
    this.wsClients = new Map();
    this.fileShares = new Map();
    this.engineListeners = null;
  }

  auth() {
    return this.opts.auth ? this.opts.auth() : {};
  }

  engine() {
    return this.opts.engine ? this.opts.engine() : null;
  }

  isLoggedIn() {
    const auth = this.auth();
    return !!(auth && auth.token);
  }

  async start() {
    if (this.running || !this.isLoggedIn()) return;
    this.running = true;
    this.emitState();
    try {
      await this.ensureServer();
      await this.refreshPairing();
      this.lastError = '';
      this.emitState();
    } catch (e) {
      this.running = false;
      this.lastError = (e && e.message) || String(e);
      await this.closeServer();
      this.emitState();
      throw e;
    }
  }

  async stop() {
    this.running = false;
    await this.closeServer();
    this.detachEngineListeners();
    this.remoteTurns.clear();
    this.clearFileShares();
    this.emitState();
  }

  async restart() {
    await this.stop();
    if (this.isLoggedIn()) await this.start();
  }

  async ensureServer() {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '0.0.0.0', () => {
        this.port = this.server.address().port;
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  async closeServer() {
    const server = this.server;
    this.server = null;
    this.port = 0;
    for (const clients of this.wsClients.values()) {
      for (const client of clients) {
        try { client.end(wsCloseFrame()); } catch (_) {}
      }
    }
    this.wsClients.clear();
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
  }

  async refreshPairing() {
    if (!this.server) await this.ensureServer();
    const urls = networkUrls(this.port);
    const baseUrl = urls[0] || `http://127.0.0.1:${this.port}`;
    const code = randomCode();
    const key = crypto.randomBytes(32);
    const expiresAtMs = Date.now() + PAIRING_TTL_MS;
    const url = new URL('/remote', baseUrl);
    url.searchParams.set('code', code);
    url.hash = `k=${base64url(key)}`;
    this.pairing = {
      code,
      key,
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
      payload: {
        version: 2,
        product: 'deskagent',
        mode: 'direct-encrypted',
        code,
        machine_id: this.machineId,
        url: url.toString(),
        urls,
        crypto: 'xsalsa20-poly1305',
      },
      qrText: url.toString(),
      rawPayloadText: JSON.stringify({ url: url.toString(), code, mode: 'direct-encrypted' }),
      qrDataUrl: await QRCode.toDataURL(url.toString(), {
        margin: 1,
        width: 220,
        errorCorrectionLevel: 'M',
      }),
    };
    this.lastError = '';
    this.emitState();
    return this.info();
  }

  currentPairing(code) {
    if (!this.pairing || this.pairing.code !== String(code || '').toUpperCase()) {
      throw new Error('连接码无效，请刷新二维码');
    }
    if (Date.now() > this.pairing.expiresAtMs) {
      throw new Error('连接码已过期，请刷新二维码');
    }
    return this.pairing;
  }

  async encryptedResponse(pairing, data) {
    return { ok: true, msg: encryptJson(pairing.key, data) };
  }

  decryptRequest(body) {
    const pairing = this.currentPairing(body.code);
    return { pairing, payload: decryptJson(pairing.key, body.msg) };
  }

  ensureEngine() {
    const engine = this.engine();
    if (!engine) throw new Error('本地智能引擎未初始化');
    this.ensureEngineListeners(engine);
    return engine;
  }

  ensureEngineListeners(engine) {
    if (this.engineListeners && this.engineListeners.engine === engine) return;
    this.detachEngineListeners();
    if (!engine || typeof engine.on !== 'function') return;
    const listeners = {
      engine,
      delta: (payload) => this.captureRemoteEngineEvent('delta', payload),
      message: (payload) => this.captureRemoteEngineEvent('message', payload),
      done: (payload) => this.captureRemoteEngineEvent('done', payload),
      error: (payload) => this.captureRemoteEngineEvent('error', payload),
      threadChanged: (payload) => this.captureRemoteEngineEvent('threadChanged', payload),
      activity: (payload) => this.captureRemoteEngineEvent('activity', payload),
    };
    engine.on('delta', listeners.delta);
    engine.on('message', listeners.message);
    engine.on('turnDone', listeners.done);
    engine.on('turnError', listeners.error);
    engine.on('threadChanged', listeners.threadChanged);
    engine.on('activity', listeners.activity);
    this.engineListeners = listeners;
  }

  detachEngineListeners() {
    if (!this.engineListeners) return;
    const prev = this.engineListeners;
    if (prev.engine && typeof prev.engine.off === 'function') {
      prev.engine.off('delta', prev.delta);
      prev.engine.off('message', prev.message);
      prev.engine.off('turnDone', prev.done);
      prev.engine.off('turnError', prev.error);
      prev.engine.off('threadChanged', prev.threadChanged);
      prev.engine.off('activity', prev.activity);
    }
    this.engineListeners = null;
  }

  remoteTurnByThread(threadId) {
    for (const turn of this.remoteTurns.values()) {
      if (turn.threadId === threadId && !turn.done) return turn;
    }
    return null;
  }

  pushRemoteEvent(turn, event) {
    if (!turn) return;
    turn.seq += 1;
    turn.updatedAt = Date.now();
    const storedEvent = { seq: turn.seq, at: new Date().toISOString(), ...event };
    turn.events.push(storedEvent);
    if (turn.events.length > MAX_REMOTE_EVENTS) {
      turn.events.splice(0, turn.events.length - MAX_REMOTE_EVENTS);
    }
    if (event.type === 'done' || event.type === 'error') turn.done = true;
    this.broadcastRemoteEvent(turn, storedEvent);
  }

  broadcastRemoteEvent(turn, event) {
    const clients = this.wsClients.get(turn.id);
    if (!clients || !clients.size || !this.pairing) return;
    const payload = {
      t: 'event',
      turn_id: turn.id,
      thread_id: turn.threadId,
      next_seq: turn.seq,
      event,
    };
    const frame = wsTextFrame(JSON.stringify({ ok: true, msg: encryptJson(this.pairing.key, payload) }));
    for (const client of [...clients]) {
      try {
        client.write(frame);
        if (event.type === 'done' || event.type === 'error') {
          setTimeout(() => {
            try { client.end(wsCloseFrame()); } catch (_) {}
          }, 80);
        }
      } catch (_) {
        clients.delete(client);
      }
    }
  }

  captureRemoteEngineEvent(type, payload = {}) {
    this.pruneRemoteTurns();
    let turn = this.remoteTurnByThread(payload.threadId);
    if (!turn && payload.staleThreadId) turn = this.remoteTurnByThread(payload.staleThreadId);
    if (!turn) return;
    if (type === 'delta') {
      const visibleText = stripThinkText(payload.text || '');
      const visibleDelta = stripThinkText(payload.delta || '');
      this.pushRemoteEvent(turn, {
        type: 'delta',
        thread_id: payload.threadId,
        item_id: payload.itemId,
        delta: visibleDelta,
        text: visibleText,
      });
    } else if (type === 'message') {
      this.pushRemoteEvent(turn, {
        type: 'message',
        thread_id: payload.threadId,
        item_id: payload.itemId,
        role: 'assistant',
        text: stripThinkText(payload.text || ''),
      });
    } else if (type === 'done') {
      this.pushRemoteEvent(turn, {
        type: 'done',
        thread_id: payload.threadId,
        usage: payload.usage || null,
      });
      this.inFlight.delete(turn.id);
      this.emitState();
    } else if (type === 'error') {
      this.pushRemoteEvent(turn, {
        type: 'error',
        thread_id: payload.threadId,
        message: payload.message || '远程任务失败',
      });
      this.inFlight.delete(turn.id);
      this.emitState();
    } else if (type === 'threadChanged' && payload.threadId) {
      turn.threadId = payload.threadId;
      this.pushRemoteEvent(turn, {
        type: 'thread_changed',
        thread_id: payload.threadId,
        stale_thread_id: payload.staleThreadId || null,
        recovered: !!payload.recovered,
      });
    } else if (type === 'activity') {
      this.pushRemoteEvent(turn, {
        type: 'activity',
        thread_id: payload.threadId,
        item_id: payload.itemId || null,
        kind: payload.kind || '',
        phase: payload.phase || '',
        status: payload.status || '',
        text: payload.text || '',
        output: payload.output || '',
        display: remoteActivityDisplay(payload),
      });
    }
  }

  pruneFileShares() {
    const now = Date.now();
    for (const [token, share] of this.fileShares.entries()) {
      if (share.expiresAtMs > now && fs.existsSync(share.filePath)) continue;
      this.fileShares.delete(token);
      if (share.temporary) {
        try { fs.rmSync(share.filePath, { force: true }); } catch (_) {}
      }
    }
  }

  clearFileShares() {
    for (const share of this.fileShares.values()) {
      if (share.temporary) {
        try { fs.rmSync(share.filePath, { force: true }); } catch (_) {}
      }
    }
    this.fileShares.clear();
  }

  directBaseUrl() {
    const urls = this.port ? networkUrls(this.port) : [];
    return urls[0] || (this.port ? `http://127.0.0.1:${this.port}` : '');
  }

  publicShare(share, baseUrl = '') {
    const downloadPath = share.downloadPath;
    return {
      id: share.token,
      token: share.token,
      name: share.name,
      size: share.size,
      created_at: share.createdAt,
      expires_at: share.expiresAt,
      packaged: !!share.packaged,
      source_count: share.sourceCount || 1,
      entry_count: share.entryCount || 1,
      download_path: downloadPath,
      download_url: baseUrl ? new URL(downloadPath, baseUrl).toString() : downloadPath,
    };
  }

  publicShares(baseUrl = '') {
    this.pruneFileShares();
    return [...this.fileShares.values()]
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((share) => this.publicShare(share, baseUrl));
  }

  async sharePaths(inputPaths) {
    if (!this.server) await this.ensureServer();
    this.pruneFileShares();
    const cacheDir = path.join(this.opts.baseDir || os.tmpdir(), 'remote-file-shares');
    const prepared = prepareShareArtifact(inputPaths, cacheDir);
    const stat = fs.statSync(prepared.filePath);
    const token = base64url(crypto.randomBytes(24));
    const expiresAtMs = Date.now() + FILE_SHARE_TTL_MS;
    const downloadPath = `/api/remote/direct/files/${token}/${encodeURIComponent(prepared.name)}`;
    const share = {
      ...prepared,
      token,
      size: stat.size,
      createdAtMs: Date.now(),
      createdAt: new Date().toISOString(),
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
      downloadPath,
    };
    this.fileShares.set(token, share);
    this.emitState();
    return { ok: true, share: this.publicShare(share, this.directBaseUrl()), state: this.info() };
  }

  pruneRemoteTurns() {
    const doneCutoff = Date.now() - REMOTE_TURN_TTL_MS;
    const staleCutoff = Date.now() - REMOTE_TURN_TTL_MS * 2;
    for (const [id, turn] of this.remoteTurns.entries()) {
      if ((turn.done && turn.updatedAt < doneCutoff) || turn.createdAt < staleCutoff) {
        const clients = this.wsClients.get(id);
        if (clients) {
          for (const client of clients) {
            try { client.end(wsCloseFrame()); } catch (_) {}
          }
          this.wsClients.delete(id);
        }
        this.remoteTurns.delete(id);
      }
    }
  }

  async handleRequest(req, res) {
    try {
      if (req.method === 'OPTIONS') return json(res, 204, {});
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === '/remote') return html(res, remotePageHtml());
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/api/remote/direct/files/')) {
        return this.handleFileDownload(req, res, url);
      }
      if (req.method === 'GET' && url.pathname === '/vendor/tweetnacl.min.js') {
        const vendorPath = tweetNaclBrowserPath();
        if (!vendorPath) return notFound(res);
        return js(res, fs.readFileSync(vendorPath, 'utf8'));
      }
      if (req.method === 'GET' && url.pathname === '/api/remote/direct/status') {
        return json(res, 200, { ok: true, machine_id: this.machineId, pairing: !!this.pairing });
      }
      if (req.method !== 'POST') return notFound(res);
      if (url.pathname === '/api/remote/direct/hello') {
        const body = await readBody(req);
        const { pairing } = this.decryptRequest(body);
        return json(res, 200, await this.encryptedResponse(pairing, {
          t: 'hello',
          machine_id: this.machineId,
          message: '已直连这台电脑',
          at: Date.now(),
        }));
      }
      if (url.pathname === '/api/remote/direct/sessions') {
        const body = await readBody(req);
        const { pairing, payload } = this.decryptRequest(body);
        const result = await this.handleSessionsPayload(payload);
        return json(res, 200, await this.encryptedResponse(pairing, result));
      }
      if (url.pathname === '/api/remote/direct/new-session') {
        const body = await readBody(req);
        const { pairing, payload } = this.decryptRequest(body);
        const result = await this.handleNewSessionPayload(payload);
        return json(res, 200, await this.encryptedResponse(pairing, result));
      }
      if (url.pathname === '/api/remote/direct/history') {
        const body = await readBody(req);
        const { pairing, payload } = this.decryptRequest(body);
        const result = await this.handleHistoryPayload(payload);
        return json(res, 200, await this.encryptedResponse(pairing, result));
      }
      if (url.pathname === '/api/remote/direct/events') {
        const body = await readBody(req);
        const { pairing, payload } = this.decryptRequest(body);
        const result = await this.handleEventsPayload(payload);
        return json(res, 200, await this.encryptedResponse(pairing, result));
      }
      if (url.pathname === '/api/remote/direct/files') {
        const body = await readBody(req);
        const { pairing, payload } = this.decryptRequest(body);
        const result = await this.handleFilesPayload(payload, url.origin);
        return json(res, 200, await this.encryptedResponse(pairing, result));
      }
      if (url.pathname === '/api/remote/direct/command') {
        const body = await readBody(req);
        const { pairing, payload } = this.decryptRequest(body);
        const result = await this.handleCommandPayload(payload);
        return json(res, 200, await this.encryptedResponse(pairing, result));
      }
      return notFound(res);
    } catch (e) {
      json(res, 400, { ok: false, error: (e && e.message) || '远程请求失败' });
    }
  }

  handleFileDownload(req, res, url) {
    this.pruneFileShares();
    const parts = url.pathname.split('/').filter(Boolean);
    const token = parts[4] || '';
    const share = this.fileShares.get(token);
    if (!share || Date.now() > share.expiresAtMs || !fs.existsSync(share.filePath)) {
      return notFound(res);
    }
    const stat = fs.statSync(share.filePath);
    const range = String(req.headers.range || '');
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    if (range.startsWith('bytes=')) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        if (match[1]) start = Number(match[1]);
        if (match[2]) end = Number(match[2]);
        if (!match[1] && match[2]) {
          const tail = Number(match[2]);
          start = Math.max(0, stat.size - tail);
          end = stat.size - 1;
        }
        if (start <= end && start < stat.size) {
          status = 206;
          end = Math.min(end, stat.size - 1);
        } else {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }
      }
    }
    const length = stat.size ? end - start + 1 : 0;
    const headers = {
      'Content-Type': contentTypeFor(share.name),
      'Content-Length': length,
      'Content-Disposition': contentDispositionAttachment(share.name),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    if (!stat.size) {
      res.end();
      return;
    }
    fs.createReadStream(share.filePath, { start, end }).pipe(res);
  }

  handleUpgrade(req, socket) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      if (url.pathname !== '/api/remote/direct/ws') {
        socket.destroy();
        return;
      }
      const code = url.searchParams.get('code') || '';
      const turnId = url.searchParams.get('turn_id') || url.searchParams.get('turnId') || '';
      const pairing = this.currentPairing(code);
      this.pruneRemoteTurns();
      const turn = this.remoteTurns.get(turnId);
      if (!turn) {
        socket.destroy();
        return;
      }
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
        '',
        '',
      ].join('\r\n'));
      let clients = this.wsClients.get(turnId);
      if (!clients) {
        clients = new Set();
        this.wsClients.set(turnId, clients);
      }
      clients.add(socket);
      const cleanup = () => {
        clients.delete(socket);
        if (!clients.size) this.wsClients.delete(turnId);
      };
      socket.on('close', cleanup);
      socket.on('end', cleanup);
      socket.on('error', cleanup);
      for (const event of turn.events) {
        const payload = {
          t: 'event',
          turn_id: turn.id,
          thread_id: turn.threadId,
          next_seq: turn.seq,
          event,
        };
        socket.write(wsTextFrame(JSON.stringify({ ok: true, msg: encryptJson(pairing.key, payload) })));
      }
      if (turn.done) {
        setTimeout(() => {
          try { socket.end(wsCloseFrame()); } catch (_) {}
        }, 100);
      }
    } catch (_) {
      try { socket.destroy(); } catch (_) {}
    }
  }

  async handleCommandPayload(payload) {
    if (!payload || payload.t !== 'chat_message') throw new Error('不支持的远程命令');
    const engine = this.ensureEngine();
    const text = String(payload.text || payload.prompt || '').trim();
    if (!text) throw new Error('远程消息为空');
    const turnId = crypto.randomUUID();
    this.inFlight.add(turnId);
    try {
      let threadId = payload.thread_id || payload.threadId || null;
      if (!threadId) {
        const created = await engine.startNewThread();
        threadId = created.threadId;
      }
      const turn = {
        id: turnId,
        threadId,
        seq: 0,
        events: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        done: false,
      };
      this.remoteTurns.set(turnId, turn);
      this.pushRemoteEvent(turn, {
        type: 'accepted',
        thread_id: threadId,
        message: '桌面助手已接收任务',
      });
      const result = await engine.send(text, [], threadId);
      if (result && result.threadId && result.threadId !== threadId) {
        turn.threadId = result.threadId;
        this.pushRemoteEvent(turn, {
          type: 'thread_changed',
          thread_id: result.threadId,
          stale_thread_id: threadId,
          recovered: !!result.recovered,
        });
      }
      return {
        t: 'accepted',
        turn_id: turnId,
        thread_id: (result && result.threadId) || turn.threadId || threadId,
        accepted_at: new Date().toISOString(),
        message: '桌面助手已接收任务',
      };
    } catch (e) {
      this.inFlight.delete(turnId);
      const turn = this.remoteTurns.get(turnId);
      if (turn) {
        this.pushRemoteEvent(turn, {
          type: 'error',
          thread_id: turn.threadId,
          message: (e && e.message) || '远程任务失败',
        });
      }
      throw e;
    } finally {
      this.emitState();
    }
  }

  async handleSessionsPayload(payload) {
    if (payload && payload.t && payload.t !== 'list_sessions') throw new Error('不支持的远程命令');
    const engine = this.ensureEngine();
    const sessions = typeof engine.listThreads === 'function' ? await engine.listThreads() : [];
    return {
      t: 'sessions',
      current_thread_id: engine.threadId || null,
      sessions: (sessions || []).map((s) => ({
        id: s.id,
        preview: s.preview || '新会话',
        created_at: s.createdAt || s.created_at || null,
        updated_at: s.updatedAt || s.updated_at || null,
        status: s.status || '',
      })),
    };
  }

  async handleNewSessionPayload(payload) {
    if (payload && payload.t && payload.t !== 'new_session') throw new Error('不支持的远程命令');
    const engine = this.ensureEngine();
    const result = await engine.startNewThread();
    return { t: 'new_session', thread_id: result.threadId };
  }

  async handleHistoryPayload(payload) {
    if (!payload || payload.t !== 'history') throw new Error('不支持的远程命令');
    const threadId = String(payload.thread_id || payload.threadId || '').trim();
    if (!threadId) throw new Error('缺少会话 ID');
    const engine = this.ensureEngine();
    const result = await engine.resumeThread(threadId);
    return {
      t: 'history',
      thread_id: result.threadId || threadId,
      messages: remoteVisibleMessages(result.messages || []),
    };
  }

  async handleEventsPayload(payload) {
    if (!payload || payload.t !== 'events') throw new Error('不支持的远程命令');
    this.pruneRemoteTurns();
    const turnId = String(payload.turn_id || payload.turnId || '').trim();
    if (!turnId) throw new Error('缺少远程任务 ID');
    const turn = this.remoteTurns.get(turnId);
    if (!turn) {
      return {
        t: 'events',
        turn_id: turnId,
        thread_id: null,
        done: true,
        next_seq: Number(payload.since_seq || payload.sinceSeq || 0),
        events: [{ seq: Number(payload.since_seq || payload.sinceSeq || 0) + 1, type: 'error', message: '远程任务已过期，请重新发送' }],
      };
    }
    const sinceSeq = Number(payload.since_seq || payload.sinceSeq || 0);
    const events = turn.events.filter((event) => event.seq > sinceSeq);
    return {
      t: 'events',
      turn_id: turnId,
      thread_id: turn.threadId,
      done: turn.done,
      next_seq: turn.seq,
      events,
    };
  }

  async handleFilesPayload(payload, baseUrl) {
    if (payload && payload.t && payload.t !== 'list_files') throw new Error('不支持的远程命令');
    return {
      t: 'files',
      files: this.publicShares(baseUrl),
    };
  }

  info() {
    const urls = this.port ? networkUrls(this.port) : [];
    return {
      enabled: this.running,
      loggedIn: this.isLoggedIn(),
      mode: 'direct-encrypted',
      backendIsLocal: false,
      remoteLinkIsLocal: false,
      remoteLinkLocalReason: '',
      directUrl: urls[0] || '',
      directUrls: urls,
      machineId: this.machineId,
      hasMachineToken: false,
      pairing: this.pairing ? {
        code: this.pairing.code,
        expiresAt: this.pairing.expiresAt,
        payload: this.pairing.payload,
        qrText: this.pairing.qrText,
        rawPayloadText: this.pairing.rawPayloadText,
        qrDataUrl: this.pairing.qrDataUrl,
      } : null,
      fileShares: this.publicShares(this.directBaseUrl()),
      lastError: this.lastError,
      inFlight: this.inFlight.size,
    };
  }

  emitState() {
    this.emit('state', this.info());
  }
}

module.exports = {
  RemoteHost,
  decryptJson,
  encryptJson,
  networkUrls,
  stripThinkText,
  PAIRING_TTL_MS,
  FILE_SHARE_TTL_MS,
  contentDispositionAttachment,
  createZipArchive,
};
