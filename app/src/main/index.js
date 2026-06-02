'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadEnvFiles, defaultEnvCandidates } = require('./env');
const { Engine } = require('./engine');
const { LocalBridge } = require('./bridge');
const { RemoteHost } = require('./remote');

loadEnvFiles(defaultEnvCandidates(path.resolve(__dirname, '..', '..')));

// The metering/auth backend (deskagent-server). The desktop never holds the real
// upstream key: it authenticates the member's JWT here and the backend forwards
// to the real relay while metering token usage.
const BACKEND_URL = (process.env.DESKAGENT_BACKEND_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');

const DEFAULT_SETTINGS = {
  // Production default points at the team relay (OpenAI-compatible gateway).
  // The relay holds the real upstream provider keys; the desktop app only needs
  // the relay base URL + the member's subscription token.
  baseUrl: process.env.OPENAI_BASE_URL || process.env.GLM_BASE_URL || 'https://llmapi.debinxiang.top/v1',
  apiKey: process.env.OPENAI_API_KEY || process.env.GLM_API_KEY || '',
  model: process.env.ADAPTER_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini',
  relayMode: process.env.RELAY_MODE || 'openai',
  mcpProfile: process.env.DESKAGENT_MCP_PROFILE || 'core',
  memberToken: '',
};

function envSettings() {
  return {
    baseUrl: process.env.OPENAI_BASE_URL || process.env.GLM_BASE_URL || undefined,
    apiKey: process.env.OPENAI_API_KEY || process.env.GLM_API_KEY || undefined,
    model: process.env.ADAPTER_MODEL || process.env.OPENAI_MODEL || undefined,
    relayMode: process.env.RELAY_MODE || undefined,
    mcpProfile: process.env.DESKAGENT_MCP_PROFILE || undefined,
  };
}

let win = null;
let engine = null;
let paths = null;
let bridge = null;
let remoteHost = null;
let auth = { token: '', phone: '' };
let directRelayFallbackActive = false;

function loadAuth() {
  try {
    auth = { token: '', phone: '', ...JSON.parse(fs.readFileSync(paths.authFile, 'utf8')) };
  } catch (_) {
    auth = { token: '', phone: '' };
  }
  return auth;
}

function saveAuth() {
  fs.writeFileSync(paths.authFile, JSON.stringify(auth, null, 2));
}

function isLoggedIn() {
  return !!(auth && auth.token);
}

// When logged in, the engine talks to the backend gateway with the member JWT —
// overriding any baked relay/key so the real upstream key never reaches the client.
function effectiveSettings() {
  const base = getSettings();
  if (isLoggedIn() && !directRelayFallbackActive) {
    return { ...base, baseUrl: `${BACKEND_URL}/v1`, apiKey: auth.token, relayMode: 'openai' };
  }
  return base;
}

function isLocalBackendUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch (_) {
    return false;
  }
}

function hasDirectRelaySettings() {
  const s = getSettings();
  return !!String(s.baseUrl || '').trim() && !!String(s.apiKey || '').trim() && s.apiKey !== '••••••••';
}

async function backendAvailable(timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { signal: controller.signal });
    return res.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function prepareEngineSettings() {
  directRelayFallbackActive = false;
  if (!isLoggedIn()) return;
  if (await backendAvailable()) return;

  // Development/internal-test safety net: when the configured member backend is
  // localhost and not running, but .env has a direct relay key, keep chat usable
  // instead of surfacing an opaque adapter 502. Remote/production backends still
  // fail closed so membership metering is not bypassed accidentally.
  if (
    isLocalBackendUrl(BACKEND_URL) &&
    hasDirectRelaySettings() &&
    process.env.DESKAGENT_DIRECT_RELAY_FALLBACK !== 'false'
  ) {
    directRelayFallbackActive = true;
    sendToWindow('engine:status', {
      state: 'starting',
      message: '本地会员服务未启动，开发模式直连中转站…',
    });
    return;
  }

  throw new Error(`会员服务未连接：${BACKEND_URL}。请先启动 deskagent-server 或配置 DESKAGENT_BACKEND_URL。`);
}

async function backendFetch(p, { method = 'GET', body, withAuth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (withAuth && auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
  const res = await fetch(`${BACKEND_URL}${p}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `请求失败 (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

function canSendToWindow() {
  return !!(win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed());
}

function sendToWindow(channel, payload) {
  if (canSendToWindow()) win.webContents.send(channel, payload);
}

function wireRemoteEvents() {
  if (!remoteHost) return;
  remoteHost.on('state', (payload) => sendToWindow('remote:state', payload));
}

async function startRemoteHost() {
  if (!remoteHost || !isLoggedIn()) return;
  try {
    await remoteHost.start();
  } catch (e) {
    sendToWindow('remote:state', {
      ...(remoteHost ? remoteHost.info() : {}),
      lastError: (e && e.message) || String(e),
    });
  }
}

async function stopRemoteHost() {
  if (remoteHost) await remoteHost.stop();
}

function setupPaths() {
  const base = app.getPath('userData');
  const agentHome = path.join(base, 'agent-home');
  const legacyHome = path.join(base, 'codex-home');
  if (!fs.existsSync(agentHome) && fs.existsSync(legacyHome)) {
    fs.cpSync(legacyHome, agentHome, { recursive: true });
  }
  const p = {
    base,
    agentHome,
    workspaceDir: path.join(base, 'workspace'),
    settingsFile: path.join(base, 'settings.json'),
    authFile: path.join(base, 'auth.json'),
  };
  fs.mkdirSync(p.agentHome, { recursive: true });
  fs.mkdirSync(p.workspaceDir, { recursive: true });
  return p;
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw, ...Object.fromEntries(Object.entries(envSettings()).filter(([, v]) => v)) };
  } catch (_) {
    return { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(envSettings()).filter(([, v]) => v)) };
  }
}

function saveSettings(s) {
  fs.writeFileSync(paths.settingsFile, JSON.stringify(s, null, 2));
}

let settingsCache = null;
function getSettings() {
  if (!settingsCache) settingsCache = loadSettings();
  return settingsCache;
}

// Copy bundled agent configuration into the dedicated runtime home.
// This includes skills plus MCP/rules/subagents shipped by the app.
function installBundledAgentConfig() {
  const src = app.isPackaged
    ? path.join(process.resourcesPath, 'agentconfig')
    : path.join(__dirname, '..', '..', '..', 'agentconfig');
  if (fs.existsSync(src)) {
    for (const name of fs.readdirSync(src)) {
      fs.cpSync(path.join(src, name), path.join(paths.agentHome, name), { recursive: true });
    }
  }
}

function listSkills() {
  const dir = path.join(paths.agentHome, 'skills');
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const md = path.join(dir, name, 'SKILL.md');
    if (fs.existsSync(md)) {
      const text = fs.readFileSync(md, 'utf8');
      const descMatch = text.match(/description:\s*"?([^"\n]+)"?/i);
      const titleMatch = text.match(/title:\s*"?([^"\n]+)"?/i) || text.match(/name:\s*"?([^"\n]+)"?/i);
      out.push({ id: name, title: (titleMatch && titleMatch[1]) || name, description: (descMatch && descMatch[1]) || '' });
    }
  }
  return out;
}

function wireEngineEvents() {
  const fwd = (channel) => (payload) => sendToWindow(channel, payload);
  engine.on('status', fwd('engine:status'));
  engine.on('delta', fwd('chat:delta'));
  engine.on('message', fwd('chat:message'));
  engine.on('activity', fwd('chat:activity'));
  engine.on('turnDone', fwd('chat:turnDone'));
  engine.on('turnError', fwd('chat:error'));
  engine.on('turnState', fwd('chat:turnState'));
  engine.on('threadChanged', fwd('chat:threadChanged'));
  engine.on('historyLoaded', fwd('chat:historyLoaded'));
  engine.on('log', (src, msg) => sendToWindow('engine:log', { src, msg }));
}

async function startEngine() {
  try {
    await prepareEngineSettings();
    engine = new Engine({
      agentHome: paths.agentHome,
      workspaceDir: paths.workspaceDir,
      settings: effectiveSettings,
      bridgeInfo: () => (bridge ? bridge.info() : null),
    });
    wireEngineEvents();
    await engine.start();
  } catch (e) {
    engine = null;
    sendToWindow('engine:status', { state: 'error', message: '启动失败: ' + (e && e.message) });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: '智界桌面助手',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

// ---- IPC ----
ipcMain.handle('app:bootstrap', async () => {
  return {
    settings: { ...getSettings(), apiKey: getSettings().apiKey ? '••••••••' : '' },
    skills: listSkills(),
    paths: { workspaceDir: paths.workspaceDir },
    currentThreadId: engine && engine.threadId,
    auth: { loggedIn: isLoggedIn(), phone: auth.phone },
    remote: remoteHost ? remoteHost.info() : null,
  };
});

// ---- Auth / membership IPC (talks to deskagent-server) ----
ipcMain.handle('auth:status', async () => ({ loggedIn: isLoggedIn(), phone: auth.phone }));

ipcMain.handle('auth:sendSms', async (_e, phone) => {
  return backendFetch('/auth/sms/send', { method: 'POST', body: { phone } });
});

ipcMain.handle('auth:verifySms', async (_e, { phone, code }) => {
  const r = await backendFetch('/auth/sms/verify', { method: 'POST', body: { phone, code } });
  auth = { token: r.token, phone };
  saveAuth();
  // Unblock the login UI immediately; the engine is started in the background so
  // a slow or failing runtime spawn can never make a successful login look stuck.
  sendToWindow('auth:state', { loggedIn: true, phone });
  startRemoteHost();
  (async () => {
    try {
      if (engine) await engine.stop();
      await startEngine();
    } catch (e) {
      sendToWindow('engine:status', { state: 'error', message: '启动失败: ' + (e && e.message) });
    }
  })();
  return { ok: true, user: r.user, is_new: r.is_new };
});

ipcMain.handle('auth:me', async () => backendFetch('/api/me', { withAuth: true }));

ipcMain.handle('auth:packages', async () => backendFetch('/api/packages'));

ipcMain.handle('auth:createOrder', async (_e, { package_id, provider }) => {
  return backendFetch('/api/orders', { method: 'POST', withAuth: true, body: { package_id, provider: provider || 'manual' } });
});

ipcMain.handle('auth:confirmOrder', async (_e, outTradeNo) => {
  return backendFetch(`/api/orders/${outTradeNo}/confirm`, { method: 'POST', withAuth: true });
});

ipcMain.handle('auth:logout', async () => {
  auth = { token: '', phone: '' };
  saveAuth();
  await stopRemoteHost();
  if (engine) {
    await engine.stop();
    engine = null;
  }
  sendToWindow('auth:state', { loggedIn: false });
  return { ok: true };
});

ipcMain.handle('app:saveSettings', async (_e, partial) => {
  const cur = getSettings();
  const next = { ...cur, ...partial };
  if (partial.apiKey === '••••••••') next.apiKey = cur.apiKey; // unchanged masked value
  settingsCache = next;
  saveSettings(next);
  // Restart engine to apply — but only when logged in, otherwise the engine
  // stays stopped (we must never run it without a metered backend token).
  if (isLoggedIn()) {
    if (engine) await engine.stop();
    await startEngine();
  }
  return { ok: true };
});

ipcMain.handle('chat:send', async (_e, payload) => {
  if (!engine) throw new Error('引擎未初始化');
  const text = typeof payload === 'string' ? payload : (payload && payload.text) || '';
  const attachments = (payload && payload.attachments) || [];
  const threadId = payload && payload.threadId;
  const result = await engine.send(text, attachments, threadId);
  return { ok: true, ...(result || {}) };
});

ipcMain.handle('app:pickAttachments', async (_e, kind) => {
  const { dialog } = require('electron');
  let properties;
  let filters;
  if (kind === 'directory') {
    properties = ['openDirectory', 'multiSelections'];
  } else if (kind === 'image') {
    properties = ['openFile', 'multiSelections'];
    filters = [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }];
  } else {
    properties = ['openFile', 'multiSelections'];
  }
  const result = await dialog.showOpenDialog(win, { properties, filters });
  if (result.canceled) return { canceled: true, items: [] };
  const items = result.filePaths.map((p) => ({ kind, path: p, name: path.basename(p) }));
  return { canceled: false, items };
});

ipcMain.handle('chat:interrupt', async (_e, threadId) => {
  if (engine) await engine.interrupt(threadId);
  return { ok: true };
});

ipcMain.handle('chat:listSessions', async () => {
  if (!engine) return { sessions: [], currentThreadId: null };
  const sessions = await engine.listThreads();
  return { sessions, currentThreadId: engine.threadId };
});

ipcMain.handle('chat:newSession', async () => {
  if (!engine) throw new Error('引擎未初始化');
  const result = await engine.startNewThread();
  return { ok: true, threadId: result.threadId };
});

ipcMain.handle('chat:resumeSession', async (_e, threadId) => {
  if (!engine) throw new Error('引擎未初始化');
  const result = await engine.resumeThread(threadId);
  return { ok: true, ...result };
});

ipcMain.handle('app:openWorkspace', async () => {
  shell.openPath(paths.workspaceDir);
  return { ok: true };
});

ipcMain.handle('remote:status', async () => (remoteHost ? remoteHost.info() : null));

ipcMain.handle('remote:refreshPairing', async () => {
  if (!remoteHost) throw new Error('远程连接服务未初始化');
  if (!isLoggedIn()) throw new Error('请先登录后再开启远程连接');
  if (!remoteHost.running) await startRemoteHost();
  return remoteHost.refreshPairing();
});

app.whenReady().then(async () => {
  paths = setupPaths();
  installBundledAgentConfig();
  bridge = new LocalBridge({
    baseDir: paths.base,
    workspaceDir: paths.workspaceDir,
    settings: getSettings,
    mcpCommand: process.execPath,
    mcpScriptPath: app.isPackaged
      ? path.join(process.resourcesPath, 'deskagent-mcp.js')
      : path.join(__dirname, '..', 'mcp', 'deskagent-mcp.js'),
    mcpEnv: { ELECTRON_RUN_AS_NODE: '1' },
  });
  await bridge.start();
  remoteHost = new RemoteHost({
    baseDir: paths.base,
    workspaceDir: paths.workspaceDir,
    backendUrl: BACKEND_URL,
    appVersion: app.getVersion ? app.getVersion() : '0.1.0',
    auth: () => auth,
    engine: () => engine,
  });
  wireRemoteEvents();
  createWindow();
  win.webContents.once('did-finish-load', () => {
    loadAuth();
    if (isLoggedIn()) {
      sendToWindow('auth:state', { loggedIn: true, phone: auth.phone });
      startRemoteHost();
      startEngine();
    } else {
      sendToWindow('auth:state', { loggedIn: false });
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', async () => {
  if (engine) await engine.stop();
  if (remoteHost) await remoteHost.stop();
  if (bridge) await bridge.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('window-all-closed', async () => {
  if (engine) await engine.stop();
  if (remoteHost) await remoteHost.stop();
  if (process.platform !== 'darwin') app.quit();
});
