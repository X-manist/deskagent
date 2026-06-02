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
const REMOTE_TURN_TTL_MS = 15 * 60 * 1000;
const MAX_REMOTE_EVENTS = 500;

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

function remoteVisibleMessages(messages) {
  return (messages || [])
    .filter((item) => item && item.kind === 'message' && String(item.text || '').trim())
    .map((item) => ({
      role: item.role === 'ai' || item.role === 'assistant' ? 'assistant' : 'user',
      text: String(item.text || ''),
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
    :root { color-scheme: light dark; --bg:#f4efd9; --paper:#fffdf5; --paper2:rgba(255,253,245,.72); --line:rgba(67,82,55,.18); --text:#20241f; --muted:#6f7566; --accent:#4f8d43; --danger:#aa584a; --gold:#b39150; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; overflow-x:hidden; font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; color:var(--text); background:linear-gradient(140deg,#fffdf5,var(--bg)); }
    main { width:min(1040px,100%); margin:0 auto; padding:16px; }
    header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; }
    h1 { margin:0; font-size:22px; line-height:1.25; }
    .actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
    .pill, .ghost { padding:7px 10px; border:1px solid var(--line); border-radius:999px; color:var(--muted); background:var(--paper2); font-size:12px; }
    .ghost { cursor:pointer; color:var(--text); }
    .layout { display:grid; grid-template-columns:minmax(200px,280px) minmax(0,1fr); gap:12px; align-items:stretch; }
    .panel { border:1px solid var(--line); border-radius:12px; background:rgba(255,253,245,.86); box-shadow:0 18px 42px rgba(86,75,40,.12); overflow:hidden; min-width:0; }
    .side { display:flex; flex-direction:column; min-height:66vh; }
    .side-head { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:12px; border-bottom:1px solid var(--line); }
    .side-title { font-size:13px; font-weight:700; color:var(--muted); }
    .sessions { padding:8px; overflow:auto; display:flex; flex-direction:column; gap:7px; }
    .session { width:100%; text-align:left; color:var(--text); background:transparent; border:1px solid transparent; border-radius:8px; padding:9px; cursor:pointer; }
    .session.active { border-color:var(--line); background:var(--paper2); }
    .session-title { font-size:13px; line-height:1.35; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
    .session-meta { margin-top:4px; color:var(--muted); font-size:11px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .status { padding:13px 14px; border-bottom:1px solid var(--line); color:var(--muted); font-size:13px; }
    .messages { min-height:56vh; max-height:68vh; overflow:auto; padding:16px; display:flex; flex-direction:column; gap:10px; }
    .msg { max-width:88%; padding:10px 12px; border-radius:10px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; font-size:14px; }
    .me { align-self:flex-end; background:var(--accent); color:white; }
    .ai { align-self:flex-start; border:1px solid var(--line); background:rgba(255,255,255,.58); }
    .sys { align-self:flex-start; border:1px solid var(--line); background:rgba(255,255,255,.5); color:var(--muted); }
    .streaming::after { content:""; display:inline-block; width:6px; height:1em; margin-left:3px; vertical-align:-2px; background:var(--gold); animation:blink 1s steps(2,end) infinite; }
    @keyframes blink { 0%,45%{opacity:1} 46%,100%{opacity:0} }
    form { display:flex; gap:9px; padding:12px; border-top:1px solid var(--line); }
    textarea { flex:1; min-height:48px; max-height:140px; resize:vertical; padding:10px 11px; border:1px solid var(--line); border-radius:10px; color:var(--text); background:white; font:inherit; line-height:1.45; }
    button { flex:0 0 auto; min-width:76px; border:0; border-radius:10px; color:white; background:var(--accent); font:inherit; font-weight:700; cursor:pointer; }
    button.ghost { min-width:auto; border:1px solid var(--line); color:var(--text); background:var(--paper2); font-weight:650; }
    button:disabled { opacity:.58; cursor:not-allowed; }
    .err { color:var(--danger); }
    @media (max-width:720px) { main{padding:12px} header{align-items:flex-start; flex-direction:column} .actions{justify-content:flex-start} .layout{grid-template-columns:1fr} .side{min-height:auto; max-height:28vh} .messages{min-height:48vh; max-height:56vh} .msg{max-width:94%} }
    @media (prefers-color-scheme: dark) { :root { --bg:#0f1210; --paper:#171b17; --paper2:rgba(31,36,31,.72); --line:rgba(220,225,205,.16); --text:#ece9de; --muted:#a9ad9e; --accent:#779d62; --gold:#d8b46a; } body{background:linear-gradient(140deg,#171b17,#0f1210)} .panel{background:rgba(23,27,23,.88)} textarea{background:#111510} .ai,.sys{background:rgba(255,255,255,.045)} }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>智界助手直连控制</h1>
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
      </aside>
      <section class="panel">
        <div class="status" id="status">正在建立加密直连…</div>
        <div class="messages" id="messages"></div>
        <form id="form">
          <textarea id="text" placeholder="输入要发送给桌面助手的任务…"></textarea>
          <button id="send" type="submit">发送</button>
        </form>
      </section>
    </div>
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
    const form = document.getElementById('form');
    const textEl = document.getElementById('text');
    const sendEl = document.getElementById('send');
    const newSessionEl = document.getElementById('newSession');
    const refreshSessionsEl = document.getElementById('refreshSessions');
    let keyBytes;
    let currentThreadId = '';
    let activeTurnId = '';
    let activeSeq = 0;
    let activeAiEl = null;
    let polling = false;
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
        btn.addEventListener('click', () => openHistory(session.id));
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
        add(message.text || '', message.role === 'assistant' ? 'ai' : 'me');
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
    async function pollTurn(turnId) {
      if (!turnId || polling) return;
      polling = true;
      activeTurnId = turnId;
      activeSeq = 0;
      activeAiEl = null;
      let done = false;
      let failed = false;
      try {
        while (!done && activeTurnId === turnId) {
          const payload = await secure('/api/remote/direct/events', { t:'events', turn_id:turnId, since_seq:activeSeq, at:Date.now() });
          activeSeq = payload.next_seq || activeSeq;
          if (payload.thread_id) setCurrentThread(payload.thread_id);
          for (const event of payload.events || []) {
            if (event.type === 'accepted') {
              statusEl.textContent = event.message || '桌面助手已接收任务';
            } else if (event.type === 'thread_changed') {
              setCurrentThread(event.thread_id);
            } else if (event.type === 'delta') {
              ensureAiBubble().textContent = event.text || ((activeAiEl && activeAiEl.textContent) || '') + (event.delta || '');
              messagesEl.scrollTop = messagesEl.scrollHeight;
            } else if (event.type === 'message') {
              ensureAiBubble().textContent = event.text || '';
              activeAiEl.classList.remove('streaming');
            } else if (event.type === 'error') {
              add(event.message || '远程任务失败', 'sys err');
              done = true;
            } else if (event.type === 'done') {
              done = true;
            }
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
    };
    engine.on('delta', listeners.delta);
    engine.on('message', listeners.message);
    engine.on('turnDone', listeners.done);
    engine.on('turnError', listeners.error);
    engine.on('threadChanged', listeners.threadChanged);
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
    turn.events.push({ seq: turn.seq, at: new Date().toISOString(), ...event });
    if (turn.events.length > MAX_REMOTE_EVENTS) {
      turn.events.splice(0, turn.events.length - MAX_REMOTE_EVENTS);
    }
    if (event.type === 'done' || event.type === 'error') turn.done = true;
  }

  captureRemoteEngineEvent(type, payload = {}) {
    this.pruneRemoteTurns();
    let turn = this.remoteTurnByThread(payload.threadId);
    if (!turn && payload.staleThreadId) turn = this.remoteTurnByThread(payload.staleThreadId);
    if (!turn) return;
    if (type === 'delta') {
      this.pushRemoteEvent(turn, {
        type: 'delta',
        thread_id: payload.threadId,
        item_id: payload.itemId,
        delta: payload.delta || '',
        text: payload.text || '',
      });
    } else if (type === 'message') {
      this.pushRemoteEvent(turn, {
        type: 'message',
        thread_id: payload.threadId,
        item_id: payload.itemId,
        role: 'assistant',
        text: payload.text || '',
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
    }
  }

  pruneRemoteTurns() {
    const doneCutoff = Date.now() - REMOTE_TURN_TTL_MS;
    const staleCutoff = Date.now() - REMOTE_TURN_TTL_MS * 2;
    for (const [id, turn] of this.remoteTurns.entries()) {
      if ((turn.done && turn.updatedAt < doneCutoff) || turn.createdAt < staleCutoff) {
        this.remoteTurns.delete(id);
      }
    }
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
