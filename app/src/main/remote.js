'use strict';
const { EventEmitter } = require('events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const nacl = require('tweetnacl');

const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;

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

function remotePageHtml() {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>智界助手直连控制</title>
  <style>
    :root { color-scheme: light dark; --bg:#f4efd9; --paper:#fffdf5; --line:rgba(67,82,55,.18); --text:#20241f; --muted:#6f7566; --accent:#4f8d43; --danger:#aa584a; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; color:var(--text); background:linear-gradient(140deg,#fffdf5,var(--bg)); }
    main { width:min(720px,100%); margin:0 auto; padding:22px 16px 34px; }
    header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:18px; }
    h1 { margin:0; font-size:22px; line-height:1.25; }
    .pill { padding:7px 10px; border:1px solid var(--line); border-radius:999px; color:var(--muted); font-size:12px; }
    .panel { border:1px solid var(--line); border-radius:12px; background:rgba(255,253,245,.86); box-shadow:0 18px 42px rgba(86,75,40,.12); overflow:hidden; }
    .status { padding:13px 14px; border-bottom:1px solid var(--line); color:var(--muted); font-size:13px; }
    .messages { min-height:48vh; max-height:60vh; overflow:auto; padding:16px; display:flex; flex-direction:column; gap:10px; }
    .msg { max-width:88%; padding:10px 12px; border-radius:10px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; font-size:14px; }
    .me { align-self:flex-end; background:var(--accent); color:white; }
    .sys { align-self:flex-start; border:1px solid var(--line); background:rgba(255,255,255,.5); color:var(--muted); }
    form { display:flex; gap:9px; padding:12px; border-top:1px solid var(--line); }
    textarea { flex:1; min-height:48px; max-height:140px; resize:vertical; padding:10px 11px; border:1px solid var(--line); border-radius:10px; color:var(--text); background:white; font:inherit; line-height:1.45; }
    button { flex:0 0 auto; min-width:76px; border:0; border-radius:10px; color:white; background:var(--accent); font:inherit; font-weight:700; cursor:pointer; }
    button:disabled { opacity:.58; cursor:not-allowed; }
    .err { color:var(--danger); }
    @media (prefers-color-scheme: dark) { :root { --bg:#0f1210; --paper:#171b17; --line:rgba(220,225,205,.16); --text:#ece9de; --muted:#a9ad9e; --accent:#779d62; } body{background:linear-gradient(140deg,#171b17,#0f1210)} .panel{background:rgba(23,27,23,.88)} textarea{background:#111510} }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>智界助手直连控制</h1>
      <span class="pill" id="state">初始化</span>
    </header>
    <section class="panel">
      <div class="status" id="status">正在建立加密直连…</div>
      <div class="messages" id="messages"></div>
      <form id="form">
        <textarea id="text" placeholder="输入要发送给桌面助手的任务…"></textarea>
        <button id="send" type="submit">发送</button>
      </form>
    </section>
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
    const form = document.getElementById('form');
    const textEl = document.getElementById('text');
    const sendEl = document.getElementById('send');
    let keyBytes;
    const enc = new TextEncoder();
    const dec = new TextDecoder();

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
    async function api(path, body) {
      const res = await fetch(path, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    async function boot() {
      if (!code || !keyText) throw new Error('连接参数不完整，请重新扫码');
      loadKey();
      const hello = await api('/api/remote/direct/hello', { code, msg: await encryptJson({ t:'hello', at:Date.now() }) });
      const payload = await decryptJson(hello.msg);
      stateEl.textContent = '已加密连接';
      statusEl.textContent = payload.message || '已直连这台电脑';
      add('已建立端到端加密直连。');
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = textEl.value.trim();
      if (!text) return;
      sendEl.disabled = true;
      add(text, 'me');
      textEl.value = '';
      try {
        const res = await api('/api/remote/direct/command', { code, msg: await encryptJson({ t:'chat_message', text, at:Date.now() }) });
        const payload = await decryptJson(res.msg);
        add(payload.message || '桌面助手已接收任务');
      } catch (err) {
        add((err && err.message) || '发送失败', 'sys err');
      } finally {
        sendEl.disabled = false;
        textEl.focus();
      }
    });
    boot().catch((err) => {
      stateEl.textContent = '连接失败';
      statusEl.textContent = (err && err.message) || '连接失败';
      statusEl.classList.add('err');
      sendEl.disabled = true;
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
    this.emitState();
  }

  async restart() {
    await this.stop();
    if (this.isLoggedIn()) await this.start();
  }

  async ensureServer() {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
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

  async handleRequest(req, res) {
    try {
      if (req.method === 'OPTIONS') return json(res, 204, {});
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === '/remote') return html(res, remotePageHtml());
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
        const pairing = this.currentPairing(body.code);
        decryptJson(pairing.key, body.msg);
        return json(res, 200, await this.encryptedResponse(pairing, {
          t: 'hello',
          machine_id: this.machineId,
          message: '已直连这台电脑',
          at: Date.now(),
        }));
      }
      if (url.pathname === '/api/remote/direct/command') {
        const body = await readBody(req);
        const pairing = this.currentPairing(body.code);
        const payload = decryptJson(pairing.key, body.msg);
        const result = await this.handleCommandPayload(payload);
        return json(res, 200, await this.encryptedResponse(pairing, result));
      }
      return notFound(res);
    } catch (e) {
      json(res, 400, { ok: false, error: (e && e.message) || '远程请求失败' });
    }
  }

  async handleCommandPayload(payload) {
    if (!payload || payload.t !== 'chat_message') throw new Error('不支持的远程命令');
    const engine = this.engine();
    if (!engine) throw new Error('本地智能引擎未初始化');
    const text = String(payload.text || payload.prompt || '').trim();
    if (!text) throw new Error('远程消息为空');
    const commandId = crypto.randomUUID();
    this.inFlight.add(commandId);
    try {
      let threadId = payload.thread_id || payload.threadId || null;
      if (!threadId) {
        const created = await engine.startNewThread();
        threadId = created.threadId;
      }
      const result = await engine.send(text, [], threadId);
      return {
        t: 'accepted',
        thread_id: result.threadId || threadId,
        accepted_at: new Date().toISOString(),
        message: '桌面助手已接收任务',
      };
    } finally {
      this.inFlight.delete(commandId);
      this.emitState();
    }
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
};
