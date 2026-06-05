'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { loadEnvFiles, defaultEnvCandidates } = require('./env');
const { Engine } = require('./engine');
const { LocalBridge } = require('./bridge');
const { RemoteHost } = require('./remote');
const { downloadUrlAttachment, importLocalAttachments } = require('./attachments');
const { createWorkspaceCheckpoint, rollbackWorkspace } = require('./workspace');

loadEnvFiles(defaultEnvCandidates(path.resolve(__dirname, '..', '..')));

const DEFAULT_CLOUD_BACKEND_URL = 'http://admin-deskagent.debinxiang.top/';

// The metering/auth backend (deskagent-server). The desktop never holds the real
// upstream key: it authenticates the member's JWT here and the backend forwards
// to the real relay while metering token usage.
const defaultBackendUrl = app.isPackaged ? DEFAULT_CLOUD_BACKEND_URL : 'http://127.0.0.1:8787';
function backendUrlCandidates() {
  const raw = process.env.DESKAGENT_BACKEND_URL
    || process.env.DESKAGENT_BACKEND_URLS
    || defaultBackendUrl;
  const urls = String(raw)
    .split(/[,\s]+/)
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return [...new Set(urls.length ? urls : [defaultBackendUrl])];
}
const BACKEND_URLS = backendUrlCandidates();
let activeBackendUrl = BACKEND_URLS[0];
function backendUrl() {
  return activeBackendUrl || BACKEND_URLS[0];
}

const DEFAULT_SETTINGS = {
  // Production default points at the team relay (OpenAI-compatible gateway).
  // The relay holds the real upstream provider keys; the desktop app only needs
  // the relay base URL + the member's subscription token.
  baseUrl: defaultModelProviderSettings().baseUrl,
  apiKey: defaultModelProviderSettings().apiKey,
  model: defaultModelProviderSettings().model,
  relayMode: defaultModelProviderSettings().relayMode,
  mcpProfile: process.env.DESKAGENT_MCP_PROFILE || 'core',
  memberToken: '',
  workspaceDir: '',
};

function preferredProvider() {
  const explicit = String(process.env.UPSTREAM_PROVIDER || process.env.MODEL_PROVIDER || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (process.env.GLM_API_KEY || process.env.GLM_BASE_URL || process.env.GLM_MODEL) return 'glm';
  return 'openai';
}

function defaultModelProviderSettings() {
  const provider = preferredProvider();
  if (provider === 'glm') {
    return {
      baseUrl: process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: process.env.GLM_API_KEY || '',
      model: process.env.GLM_MODEL || 'glm-5.1',
      relayMode: 'glm',
    };
  }
  return {
    baseUrl: process.env.OPENAI_BASE_URL || 'https://llmapi.debinxiang.top/v1',
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.ADAPTER_MODEL || process.env.OPENAI_MODEL || 'glm-5.1',
    relayMode: process.env.RELAY_MODE || 'openai',
  };
}

function envSettings() {
  const provider = defaultModelProviderSettings();
  return {
    baseUrl: provider.baseUrl || undefined,
    apiKey: provider.apiKey || undefined,
    model: provider.model || undefined,
    relayMode: process.env.RELAY_MODE || provider.relayMode || undefined,
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
let backendProc = null;
let backendStartPromise = null;

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
    return {
      ...base,
      baseUrl: `${backendUrl()}/v1`,
      apiKey: auth.token,
      relayMode: process.env.DESKAGENT_BACKEND_RELAY_MODE || 'chat',
    };
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

async function backendAvailable(timeoutMs = 1200, baseUrl = backendUrl()) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    return res.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function backendBinaryPath() {
  const exe = process.platform === 'win32' ? 'deskagent-server.exe' : 'deskagent-server';
  const candidates = [
    process.env.DESKAGENT_SERVER_BIN,
    app.isPackaged ? path.join(process.resourcesPath, 'bin', exe) : '',
    path.join(__dirname, '..', '..', '..', 'server', 'target', 'release', exe),
    path.join(__dirname, '..', '..', '..', 'server', 'target', 'debug', exe),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

async function waitForBackendReady(timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await backendAvailable(800)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function ensureLocalBackend() {
  const localUrl = backendUrl();
  if (!isLocalBackendUrl(localUrl)) return false;
  if (await backendAvailable()) return true;
  if (backendStartPromise) return backendStartPromise;
  backendStartPromise = (async () => {
    const bin = backendBinaryPath();
    if (!bin) return false;
    const dataDir = path.join(paths.base, 'server');
    fs.mkdirSync(dataDir, { recursive: true });
    const env = {
      ...process.env,
      BIND_ADDR: new URL(localUrl).host,
      DATABASE_URL: process.env.DATABASE_URL || `sqlite://${path.join(dataDir, 'deskagent.db')}?mode=rwc`,
    };
    backendProc = spawn(bin, [], {
      cwd: dataDir,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    backendProc.stderr.on('data', (chunk) => {
      sendToWindow('engine:log', { src: 'server', msg: String(chunk).trim() });
    });
    backendProc.on('exit', (code, signal) => {
      backendProc = null;
      backendStartPromise = null;
      sendToWindow('engine:log', { src: 'server', msg: `deskagent-server exited (${code ?? signal ?? 'unknown'})` });
    });
    return waitForBackendReady();
  })();
  try {
    return await backendStartPromise;
  } finally {
    if (!backendProc) backendStartPromise = null;
  }
}

async function prepareEngineSettings() {
  directRelayFallbackActive = false;
  if (!isLoggedIn()) return;
  const resolvedBackendUrl = await resolveBackendUrl();
  await refreshMemberModelSetting();
  if (!isLocalBackendUrl(resolvedBackendUrl) && await backendAvailable(1200, resolvedBackendUrl)) return;
  if (await ensureLocalBackend()) return;

  // Development/internal-test safety net: when the configured member backend is
  // localhost and not running, but .env has a direct relay key, keep chat usable
  // instead of surfacing an opaque adapter 502. Remote/production backends still
  // fail closed so membership metering is not bypassed accidentally.
  if (
    isLocalBackendUrl(backendUrl()) &&
    hasDirectRelaySettings() &&
    process.env.DESKAGENT_DIRECT_RELAY_FALLBACK !== 'false'
  ) {
    directRelayFallbackActive = true;
    sendToWindow('engine:status', {
      state: 'starting',
      message: '本地会员服务未启动，开发模式直连模型通道…',
    });
    return;
  }

  throw new Error(`会员服务未连接：${backendUrl()}。请先启动 deskagent-server 或配置 DESKAGENT_BACKEND_URL。`);
}

async function resolveBackendUrl(timeoutMs = 1200) {
  if (isLocalBackendUrl(backendUrl())) return backendUrl();
  if (await backendAvailable(timeoutMs, backendUrl())) return backendUrl();
  for (const candidate of BACKEND_URLS) {
    if (candidate === backendUrl() || isLocalBackendUrl(candidate)) continue;
    if (await backendAvailable(timeoutMs, candidate)) {
      activeBackendUrl = candidate;
      return activeBackendUrl;
    }
  }
  return backendUrl();
}

async function backendFetch(p, { method = 'GET', body, withAuth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (withAuth && auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
  const ordered = [await resolveBackendUrl(), ...BACKEND_URLS.filter((url) => url !== backendUrl())];
  let lastError = null;
  for (const candidate of ordered) {
    activeBackendUrl = candidate;
    await ensureLocalBackend();
    let res;
    try {
      res = await fetch(`${candidate}${p}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      lastError = e;
      if (!isLocalBackendUrl(candidate)) continue;
      break;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `请求失败 (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  const err = new Error(`会员服务未连接：${BACKEND_URLS.join(', ')}。请确认 deskagent-server 已启动或配置 DESKAGENT_BACKEND_URL。`);
  err.cause = lastError;
  throw err;
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
  const settingsFile = path.join(base, 'settings.json');
  let mountedWorkspace = '';
  try {
    const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (stored && typeof stored.workspaceDir === 'string') mountedWorkspace = stored.workspaceDir.trim();
  } catch (_) {}
  const p = {
    base,
    agentHome,
    workspaceDir: mountedWorkspace ? path.resolve(mountedWorkspace) : path.join(base, 'workspace'),
    settingsFile,
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

async function cloudDefaultModel() {
  try {
    const catalog = await backendFetch('/api/models');
    return catalog.default_model || (catalog.models && catalog.models[0] && catalog.models[0].id) || '';
  } catch (_) {
    return '';
  }
}

async function preferredMemberModel() {
  if (!isLoggedIn()) return '';
  try {
    const me = await backendFetch('/api/me', { withAuth: true });
    const entitlements = Array.isArray(me.entitlements) ? me.entitlements : [];
    const entitlement = entitlements.find((item) => Number(item.tokens_remaining || 0) > 0 && item.model);
    if (entitlement) return entitlement.model;
  } catch (_) {}
  return cloudDefaultModel();
}

async function refreshMemberModelSetting() {
  const model = await preferredMemberModel();
  if (!model) return getSettings();
  const current = getSettings();
  if (current.model === model) return current;
  const next = { ...current, model };
  settingsCache = next;
  saveSettings(next);
  sendToWindow('settings:updated', { ...next, apiKey: next.apiKey ? '••••••••' : '' });
  return next;
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

function bridgeOptions() {
  return {
    baseDir: paths.base,
    workspaceDir: paths.workspaceDir,
    settings: getSettings,
    mcpCommand: process.execPath,
    mcpScriptPath: app.isPackaged
      ? path.join(process.resourcesPath, 'deskagent-mcp.js')
      : path.join(__dirname, '..', 'mcp', 'deskagent-mcp.js'),
    mcpEnv: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

async function startBridge() {
  bridge = new LocalBridge(bridgeOptions());
  await bridge.start();
}

function createRemoteHost() {
  remoteHost = new RemoteHost({
    baseDir: paths.base,
    workspaceDir: paths.workspaceDir,
    appVersion: app.getVersion ? app.getVersion() : '0.1.0',
    auth: () => auth,
    engine: () => engine,
  });
  wireRemoteEvents();
}

async function switchWorkspaceDir(nextDir) {
  const workspaceDir = path.resolve(nextDir);
  fs.mkdirSync(workspaceDir, { recursive: true });
  if (engine) {
    await engine.stop();
    engine = null;
  }
  await stopRemoteHost();
  if (bridge) {
    await bridge.stop();
    bridge = null;
  }
  paths.workspaceDir = workspaceDir;
  await startBridge();
  createRemoteHost();
  sendToWindow('workspace:changed', { workspaceDir });
  if (isLoggedIn()) {
    await startRemoteHost();
    await startEngine();
  }
  return workspaceDir;
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
  const picked = result.filePaths.map((p) => ({ kind, path: p, name: path.basename(p) }));
  const items = importLocalAttachments(picked, { workspaceDir: paths.workspaceDir });
  return { canceled: false, items };
});

ipcMain.handle('app:importAttachments', async (_e, items) => {
  return { canceled: false, items: importLocalAttachments(items || [], { workspaceDir: paths.workspaceDir }) };
});

ipcMain.handle('app:downloadAttachment', async (_e, url) => {
  const item = await downloadUrlAttachment(url, { workspaceDir: paths.workspaceDir });
  return { canceled: false, items: [item] };
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

ipcMain.handle('app:mountWorkspace', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择工作目录',
    message: '选择后，agent 会把该目录作为运行与读写工作区',
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) {
    return { canceled: true, workspaceDir: paths.workspaceDir };
  }
  const workspaceDir = path.resolve(result.filePaths[0]);
  const next = { ...getSettings(), workspaceDir };
  settingsCache = next;
  saveSettings(next);
  await switchWorkspaceDir(workspaceDir);
  return { ok: true, workspaceDir };
});

ipcMain.handle('app:createWorkspaceCheckpoint', async (_e, label) => {
  return createWorkspaceCheckpoint(paths.workspaceDir, label || 'DeskAgent checkpoint');
});

ipcMain.handle('app:rollbackWorkspace', async () => {
  const result = await rollbackWorkspace(paths.workspaceDir);
  sendToWindow('workspace:changed', { workspaceDir: paths.workspaceDir });
  return result;
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
  await startBridge();
  createRemoteHost();
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
  if (backendProc) backendProc.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('window-all-closed', async () => {
  if (engine) await engine.stop();
  if (remoteHost) await remoteHost.stop();
  if (backendProc) backendProc.kill();
  if (process.platform !== 'darwin') app.quit();
});
