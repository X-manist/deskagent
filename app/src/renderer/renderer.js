'use strict';
const $ = (sel) => document.querySelector(sel);
const messagesEl = $('#messages');
const inputEl = $('#input');
const sendBtn = $('#sendBtn');
const stopBtn = $('#stopBtn');
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const modelTag = $('#modelTag');
const sessionsEl = $('#sessions');
const newSessionBtn = $('#newSessionBtn');
const attachmentsEl = $('#attachments');
const attachBtn = $('#attachBtn');
const attachMenu = $('#attachMenu');
const runtimeStateText = $('#runtimeStateText');
const themeButtons = Array.from(document.querySelectorAll('[data-theme-choice]'));
const remoteStateNote = $('#remoteStateNote');
const remoteCodeEl = $('#remoteCode');
const remoteMetaEl = $('#remoteMeta');
const remoteQrEl = $('#remoteQr');
const refreshRemoteBtn = $('#refreshRemote');
const copyRemoteBtn = $('#copyRemote');
const urlModal = $('#urlModal');
const urlInput = $('#urlInput');
const urlErr = $('#urlErr');
const cancelUrlBtn = $('#cancelUrl');
const downloadUrlBtn = $('#downloadUrl');
const mountWorkspaceBtn = $('#mountWorkspace');
const checkpointWorkspaceBtn = $('#checkpointWorkspace');
const rollbackWorkspaceBtn = $('#rollbackWorkspace');
const workspaceHint = $('#workspaceHint');
const settingsModel = $('#settingsModel');
const settingsWorkspace = $('#settingsWorkspace');

let attachments = [];
const THEME_STORAGE_KEY = 'deskagent.themeMode';
const THEME_CHOICES = new Set(['auto', 'light', 'dark', 'eye']);
let themeRefreshTimer = null;

// Engine lifecycle readiness (app-server up). Per-conversation "busy" (a turn in
// flight) is tracked separately per thread so multiple chats can run at once.
let engineReady = false;

// Multiple concurrent conversations. Only the active one is rendered to the DOM;
// background conversations keep accumulating into their in-memory `items` buffer
// (and show a busy dot in the sidebar) until the user switches to them.
const conversations = new Map(); // threadId -> { id, items:[], busy, streamItemId }
let activeId = null;
const activeBubbles = new Map(); // itemId -> DOM bubble (active conversation only)
let sessionsLoaded = false;
let preparingSend = false;
let activeConversationPromise = null;
let remoteState = null;
let urlDownloading = false;
let currentWorkspaceDir = '';

function basename(value) {
  return String(value || '').split(/[\\/]/).filter(Boolean).pop() || value || '';
}

function setWorkspaceHint(dir) {
  currentWorkspaceDir = dir || currentWorkspaceDir || '';
  if (!workspaceHint) return;
  workspaceHint.textContent = currentWorkspaceDir ? `工作区：${basename(currentWorkspaceDir)}` : '';
  workspaceHint.title = currentWorkspaceDir || '';
  renderSettingsSummary();
}

function setModelTag(settings) {
  const model = settings && settings.model ? settings.model : '';
  modelTag.textContent = model ? `模型：${model}` : '';
  if (settingsModel) settingsModel.textContent = model || '登录后自动获取';
}

function renderSettingsSummary() {
  if (settingsWorkspace) {
    settingsWorkspace.textContent = currentWorkspaceDir ? basename(currentWorkspaceDir) : '默认工作区';
    settingsWorkspace.title = currentWorkspaceDir || '';
  }
}

function autoThemeForNow() {
  const hour = new Date().getHours();
  if (hour >= 22 || hour < 7) return 'dark';
  if (hour >= 18) return 'eye';
  return 'light';
}

function readThemeMode() {
  try {
    const value = window.localStorage && window.localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_CHOICES.has(value) ? value : 'auto';
  } catch (_) {
    return 'auto';
  }
}

function applyThemeMode(mode, persist = false) {
  const nextMode = THEME_CHOICES.has(mode) ? mode : 'auto';
  const theme = nextMode === 'auto' ? autoThemeForNow() : nextMode;
  const root = document.documentElement || document.body;
  if (root) {
    if (root.dataset) {
      root.dataset.themeMode = nextMode;
      root.dataset.theme = theme;
    } else if (root.setAttribute) {
      root.setAttribute('data-theme-mode', nextMode);
      root.setAttribute('data-theme', theme);
    }
  }
  themeButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.themeChoice === nextMode);
  });
  if (persist) {
    try {
      if (window.localStorage) window.localStorage.setItem(THEME_STORAGE_KEY, nextMode);
    } catch (_) {}
  }
  if (themeRefreshTimer) clearInterval(themeRefreshTimer);
  if (nextMode === 'auto') {
    themeRefreshTimer = setInterval(() => applyThemeMode('auto'), 60 * 1000);
    if (themeRefreshTimer && typeof themeRefreshTimer.unref === 'function') themeRefreshTimer.unref();
  }
}

function getConv(threadId) {
  if (!threadId) return null;
  let conv = conversations.get(threadId);
  if (!conv) {
    conv = { id: threadId, items: [], busy: false, streamItemId: null };
    conversations.set(threadId, conv);
  }
  return conv;
}

function activeConv() {
  return activeId ? conversations.get(activeId) : null;
}

async function ensureActiveConversation() {
  const existing = activeConv();
  if (existing) return existing;
  if (!engineReady) return null;
  if (!activeConversationPromise) {
    activeConversationPromise = (async () => {
      let threadId = null;
      try {
        const data = await window.api.listSessions();
        threadId = data && data.currentThreadId;
      } catch (_) {}
      if (!threadId) {
        const result = await window.api.newSession();
        threadId = result && result.threadId;
      }
      if (!threadId) return null;
      setActive(threadId);
      await refreshSessions();
      return activeConv();
    })().finally(() => {
      activeConversationPromise = null;
    });
  }
  return activeConversationPromise;
}

function clearWelcome() {
  const w = messagesEl.querySelector('.welcome');
  if (w) w.remove();
}

function showWelcome() {
  messagesEl.innerHTML = `
    <div class="welcome">
      <h1>你好，我是智界助手</h1>
      <p>我能帮你写作、翻译、整理资料、运行脚本、收发邮件、处理微信和执行定时任务。直接说出你的需求即可。</p>
    </div>
  `;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessageContent(bubble, role, text) {
  if (window.DeskAgentRichRenderer && window.DeskAgentRichRenderer.renderMessageContent) {
    window.DeskAgentRichRenderer.renderMessageContent(bubble, role, text);
    return;
  }
  bubble.textContent = text || '';
}

function makeMessageEl(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const avatar = document.createElement('div');
  avatar.className = `avatar ${role === 'user' ? 'user' : 'ai'}`;
  avatar.textContent = role === 'user' ? '我' : '智';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  renderMessageContent(bubble, role, text);
  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  return { wrap, bubble };
}

function makeActivityEl(kind, text) {
  const el = document.createElement('div');
  el.className = `activity ${kind === 'file' ? 'file' : kind === 'mcp' ? 'mcp' : ''}`;
  el.textContent = text;
  return el;
}

// Render a single buffered item into the active DOM pane.
function appendItemDom(item) {
  clearWelcome();
  if (item.kind === 'message') {
    const { wrap, bubble } = makeMessageEl(item.role, item.text);
    messagesEl.appendChild(wrap);
    if (item.itemId) activeBubbles.set(item.itemId, bubble);
  } else if (item.kind === 'activity') {
    messagesEl.appendChild(makeActivityEl(item.activityKind, item.display));
  }
  scrollToBottom();
}

// Re-render the whole active conversation from its buffer (used on switch).
function renderActive() {
  messagesEl.innerHTML = '';
  activeBubbles.clear();
  const conv = activeConv();
  if (!conv || !conv.items.length) {
    showWelcome();
    return;
  }
  for (const item of conv.items) {
    if (item.kind === 'message') {
      const { wrap, bubble } = makeMessageEl(item.role, item.text);
      messagesEl.appendChild(wrap);
      if (item.itemId) activeBubbles.set(item.itemId, bubble);
    } else if (item.kind === 'activity') {
      messagesEl.appendChild(makeActivityEl(item.activityKind, item.display));
    }
  }
  scrollToBottom();
}

function activityDisplay(p) {
  if (p.kind === 'file') return '已修改文件：' + (p.files || []).join(', ');
  if (p.kind === 'mcp') return (p.phase === 'started' ? '调用工具：' : '工具完成：') + p.text;
  if (p.kind === 'command') return '$ ' + p.text;
  return p.text || '';
}

// Push an item to a conversation buffer; mirror into the DOM if it's active.
function pushItem(conv, item) {
  if (!conv) return;
  conv.items.push(item);
  if (conv.id === activeId) appendItemDom(item);
}

function showSendFailure(message, conv) {
  const item = { kind: 'activity', activityKind: '', display: '发送失败：' + message };
  if (conv) {
    pushItem(conv, item);
    return;
  }
  clearWelcome();
  messagesEl.appendChild(makeActivityEl('', item.display));
  scrollToBottom();
}

function showSystemNotice(message, conv = activeConv()) {
  const item = { kind: 'activity', activityKind: '', display: message };
  if (conv) {
    pushItem(conv, item);
    return;
  }
  clearWelcome();
  messagesEl.appendChild(makeActivityEl('', item.display));
  scrollToBottom();
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function refreshSessions() {
  if (!window.api.listSessions) return;
  try {
    const data = await window.api.listSessions();
    if (!activeId && data.currentThreadId) setActive(data.currentThreadId);
    sessionsEl.innerHTML = '';
    (data.sessions || []).forEach((session) => {
      const conv = conversations.get(session.id);
      const busy = conv && conv.busy;
      const el = document.createElement('button');
      el.className = 'session-item' + (session.id === activeId ? ' active' : '');
      el.innerHTML = `
        <div class="session-preview">${busy ? '● ' : ''}${session.preview || '新会话'}</div>
        <div class="session-meta">${formatTime(session.updatedAt || session.createdAt)} · ${session.id.slice(0, 8)}</div>
      `;
      el.addEventListener('click', () => switchToSession(session.id));
      sessionsEl.appendChild(el);
    });
    sessionsLoaded = true;
  } catch (e) {
    if (!sessionsLoaded) sessionsEl.innerHTML = '<div class="session-meta">会话列表加载失败</div>';
  }
}

// Switch the visible conversation. If we already have its buffer in memory we
// render it directly; otherwise we resume it from the app-server to load history.
async function switchToSession(threadId) {
  if (!engineReady || threadId === activeId) return;
  const existing = conversations.get(threadId);
  if (existing && (existing.loaded || existing.items.length)) {
    setActive(threadId);
    await refreshSessions();
    return;
  }
  try {
    const result = await window.api.resumeSession(threadId);
    // historyLoaded fills the buffer; ensure active + render.
    setActive(result.threadId || threadId);
  } catch (_) {}
  await refreshSessions();
}

function setActive(threadId) {
  activeId = threadId;
  getConv(threadId);
  renderActive();
  updateComposer();
}

// Send/stop buttons reflect the ACTIVE conversation's busy state; the new-chat
// button only needs the engine to be alive.
function updateComposer() {
  const conv = activeConv();
  const busy = !!(conv && conv.busy);
  sendBtn.classList.toggle('hidden', busy);
  stopBtn.classList.toggle('hidden', !busy);
  sendBtn.disabled = !engineReady || busy || preparingSend;
  newSessionBtn.disabled = !engineReady;
}

function setLifecycle(state, message) {
  engineReady = state === 'ready';
  statusDot.className = 'dot';
  if (state === 'ready') {
    statusDot.classList.add('ready');
    statusText.textContent = '就绪';
    if (!sessionsLoaded) refreshSessions();
  } else if (state === 'starting') {
    statusDot.classList.add('busy');
    statusText.textContent = message || '正在启动…';
  } else if (state === 'error') {
    statusDot.classList.add('error');
    statusText.textContent = message || '出错了';
  } else {
    statusText.textContent = message || state;
  }
  if (runtimeStateText) runtimeStateText.textContent = statusText.textContent;
  updateComposer();
}

function formatExpiresAt(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderRemoteState(state) {
  remoteState = state || {};
  if (!remoteStateNote || !remoteCodeEl || !remoteMetaEl) return;
  if (!remoteState.loggedIn) {
    remoteStateNote.textContent = '待登录';
    remoteCodeEl.textContent = '--------';
    remoteMetaEl.textContent = '登录后可生成本机直连二维码';
    if (remoteQrEl) {
      remoteQrEl.removeAttribute('src');
      remoteQrEl.classList.add('hidden');
    }
    if (refreshRemoteBtn) refreshRemoteBtn.disabled = true;
    if (copyRemoteBtn) copyRemoteBtn.disabled = true;
    return;
  }
  if (!remoteState.enabled) {
    remoteStateNote.textContent = remoteState.lastError ? '异常' : '未连接';
    remoteCodeEl.textContent = '--------';
    remoteMetaEl.textContent = remoteState.lastError || '正在开启本机加密直连';
    if (remoteQrEl) {
      remoteQrEl.removeAttribute('src');
      remoteQrEl.classList.add('hidden');
    }
    if (refreshRemoteBtn) refreshRemoteBtn.disabled = false;
    if (copyRemoteBtn) copyRemoteBtn.disabled = true;
    return;
  }
  const pairing = remoteState.pairing || {};
  remoteStateNote.textContent = remoteState.lastError ? '异常' : '本机直连';
  remoteCodeEl.textContent = pairing.code || '--------';
  if (remoteQrEl) {
    if (pairing.qrDataUrl) {
      remoteQrEl.src = pairing.qrDataUrl;
      remoteQrEl.classList.remove('hidden');
    } else {
      remoteQrEl.removeAttribute('src');
      remoteQrEl.classList.add('hidden');
    }
  }
  const exp = formatExpiresAt(pairing.expiresAt);
  remoteMetaEl.textContent = remoteState.lastError || (exp
    ? `同一 Wi-Fi/VPN 下扫码连接，${exp} 过期`
    : '同一 Wi-Fi/VPN 下扫码连接这台电脑');
  if (refreshRemoteBtn) refreshRemoteBtn.disabled = false;
  if (copyRemoteBtn) copyRemoteBtn.disabled = !pairing.qrText;
}

function attachIcon(kind) {
  if (kind === 'image') return '图';
  if (kind === 'directory') return '夹';
  return '文';
}

function renderAttachments() {
  attachmentsEl.innerHTML = '';
  if (!attachments.length) {
    attachmentsEl.classList.add('hidden');
    return;
  }
  attachmentsEl.classList.remove('hidden');
  attachments.forEach((att, idx) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.innerHTML = `
      <span class="chip-icon">${attachIcon(att.kind)}</span>
      <span class="chip-name" title="${att.path}">${att.name}</span>
      <button class="chip-remove" title="移除">×</button>
    `;
    chip.querySelector('.chip-remove').addEventListener('click', () => {
      attachments.splice(idx, 1);
      renderAttachments();
    });
    attachmentsEl.appendChild(chip);
  });
}

function addAttachments(items) {
  for (const it of items || []) {
    if (!it || !it.path) continue;
    if (!attachments.some((a) => a.path === it.path && a.kind === it.kind)) attachments.push(it);
  }
  renderAttachments();
}

function inferKind(name) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name || '') ? 'image' : 'file';
}

function setUrlDownloading(value) {
  urlDownloading = value;
  if (downloadUrlBtn) {
    downloadUrlBtn.disabled = value;
    downloadUrlBtn.textContent = value ? '下载中…' : '下载并添加';
  }
}

function openUrlAttachmentModal() {
  if (!urlModal) return;
  urlInput.value = '';
  urlErr.textContent = '';
  setUrlDownloading(false);
  urlModal.classList.remove('hidden');
  setTimeout(() => urlInput.focus(), 0);
}

function closeUrlAttachmentModal() {
  if (!urlModal || urlDownloading) return;
  urlModal.classList.add('hidden');
  urlErr.textContent = '';
}

async function downloadUrlAttachment() {
  if (urlDownloading) return;
  const value = String(urlInput.value || '').trim();
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 http 或 https 链接');
    urlErr.textContent = '';
    setUrlDownloading(true);
    const res = await window.api.downloadAttachment(parsed.toString());
    if (res && !res.canceled) addAttachments(res.items);
    urlModal.classList.add('hidden');
  } catch (e) {
    urlErr.textContent = (e && e.message) || 'URL 附件添加失败';
  } finally {
    setUrlDownloading(false);
  }
}

async function doSend() {
  const text = inputEl.value.trim();
  if ((!text && !attachments.length) || !engineReady || preparingSend) return;
  preparingSend = true;
  updateComposer();
  let conv = null;
  try {
    conv = await ensureActiveConversation();
  } catch (e) {
    preparingSend = false;
    updateComposer();
    showSendFailure((e && e.message) || '无法创建会话', activeConv());
    return;
  }
  if (!conv) {
    preparingSend = false;
    updateComposer();
    showSendFailure('未找到可发送的会话，请稍后重试', activeConv());
    return;
  }
  if (conv.busy) {
    preparingSend = false;
    updateComposer();
    return;
  }
  const targetId = conv.id;
  const sending = attachments.slice();
  const summary = sending.length
    ? (text ? text + '\n\n' : '') + sending.map((a) => `${attachIcon(a.kind)} ${a.name}`).join('  ')
    : text;
  pushItem(conv, { kind: 'message', role: 'user', text: summary });
  inputEl.value = '';
  inputEl.style.height = 'auto';
  attachments = [];
  renderAttachments();
  // Optimistically mark busy so the composer flips to Stop immediately.
  conv.busy = true;
  if (targetId === activeId) updateComposer();
  try {
    const result = await window.api.send(text, sending, targetId);
    if (result && result.recovered && result.threadId && result.threadId !== targetId) {
      conv.busy = false;
      const next = getConv(result.threadId);
      next.items.push({ kind: 'message', role: 'user', text: summary });
      next.busy = true;
      setActive(result.threadId);
      await refreshSessions();
    }
  } catch (e) {
    conv.busy = false;
    if (targetId === activeId) updateComposer();
    showSendFailure((e && e.message) || '发送失败', conv);
  } finally {
    preparingSend = false;
    updateComposer();
  }
}

sendBtn.addEventListener('click', doSend);
stopBtn.addEventListener('click', () => window.api.interrupt(activeId));
newSessionBtn.addEventListener('click', async () => {
  if (!engineReady) return;
  const result = await window.api.newSession();
  const conv = getConv(result.threadId);
  conv.items = [];
  conv.busy = false;
  setActive(result.threadId);
  await refreshSessions();
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    return doSend();
  }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
});

// Quick prompts + skills
document.querySelectorAll('.quick-btn').forEach((b) => {
  b.addEventListener('click', () => {
    inputEl.value = b.dataset.prompt;
    inputEl.focus();
    inputEl.dispatchEvent(new Event('input'));
  });
});

themeButtons.forEach((button) => {
  button.addEventListener('click', () => applyThemeMode(button.dataset.themeChoice, true));
});
applyThemeMode(readThemeMode());

// Attachments: picker menu
attachBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  attachMenu.classList.toggle('hidden');
});
document.addEventListener('click', () => attachMenu.classList.add('hidden'));
attachMenu.addEventListener('click', (e) => e.stopPropagation());
attachMenu.querySelectorAll('button[data-attach]').forEach((b) => {
  b.addEventListener('click', async () => {
    attachMenu.classList.add('hidden');
    if (b.dataset.attach === 'url') {
      openUrlAttachmentModal();
      return;
    }
    try {
      const res = await window.api.pickAttachments(b.dataset.attach);
      if (res && !res.canceled) addAttachments(res.items);
    } catch (_) {}
  });
});

if (cancelUrlBtn) cancelUrlBtn.addEventListener('click', closeUrlAttachmentModal);
if (downloadUrlBtn) downloadUrlBtn.addEventListener('click', downloadUrlAttachment);
if (urlInput) {
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      downloadUrlAttachment();
    } else if (e.key === 'Escape') {
      closeUrlAttachmentModal();
    }
  });
}
if (urlModal) {
  urlModal.addEventListener('click', (e) => {
    if (e.target === urlModal) closeUrlAttachmentModal();
  });
}

// Attachments: drag & drop files/directories onto the window
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const files = Array.from(e.dataTransfer.files || []);
  const items = files
    .map((f) => {
      const p = window.api.getPathForFile(f);
      if (!p) return null;
      const kind = f.type ? (f.type.startsWith('image/') ? 'image' : 'file') : inferKind(f.name);
      return { kind, path: p, name: f.name };
    })
    .filter(Boolean);
  if (!items.length) return;
  window.api.importAttachments(items)
    .then((res) => {
      if (res && !res.canceled) addAttachments(res.items);
    })
    .catch((error) => showSendFailure((error && error.message) || '附件导入失败', activeConv()));
});

$('#openWorkspace').addEventListener('click', () => window.api.openWorkspace());
if (mountWorkspaceBtn) {
  mountWorkspaceBtn.addEventListener('click', async () => {
    mountWorkspaceBtn.disabled = true;
    try {
      const result = await window.api.mountWorkspace();
      if (result && !result.canceled) {
        setWorkspaceHint(result.workspaceDir);
        await refreshSessions();
      }
    } catch (e) {
      showSendFailure((e && e.message) || '挂载工作目录失败', activeConv());
    } finally {
      mountWorkspaceBtn.disabled = false;
    }
  });
}

if (checkpointWorkspaceBtn) {
  checkpointWorkspaceBtn.addEventListener('click', async () => {
    checkpointWorkspaceBtn.disabled = true;
    try {
      const result = await window.api.createWorkspaceCheckpoint('用户手动保存');
      showSystemNotice((result && result.message) || '已保存工作区快照');
    } catch (e) {
      showSendFailure((e && e.message) || '保存快照失败', activeConv());
    } finally {
      checkpointWorkspaceBtn.disabled = false;
    }
  });
}

if (rollbackWorkspaceBtn) {
  rollbackWorkspaceBtn.addEventListener('click', async () => {
    const ok = window.confirm('将使用 DeskAgent 快照回退当前工作区文件。这个操作会改动工作区内容，是否继续？');
    if (!ok) return;
    rollbackWorkspaceBtn.disabled = true;
    try {
      const result = await window.api.rollbackWorkspace();
      showSystemNotice((result && result.message) || '已回退工作区');
    } catch (e) {
      showSendFailure((e && e.message) || '回退失败', activeConv());
    } finally {
      rollbackWorkspaceBtn.disabled = false;
    }
  });
}

if (refreshRemoteBtn) {
  refreshRemoteBtn.addEventListener('click', async () => {
    refreshRemoteBtn.disabled = true;
    try {
      renderRemoteState(await window.api.remote.refreshPairing());
    } catch (e) {
      renderRemoteState({ ...(remoteState || {}), lastError: (e && e.message) || '刷新失败' });
    } finally {
      refreshRemoteBtn.disabled = false;
    }
  });
}

if (copyRemoteBtn) {
  copyRemoteBtn.addEventListener('click', async () => {
    const text = remoteState && remoteState.pairing && remoteState.pairing.qrText;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const old = copyRemoteBtn.textContent;
      copyRemoteBtn.textContent = '已复制';
      setTimeout(() => {
        copyRemoteBtn.textContent = old;
      }, 1200);
    } catch (_) {}
  });
}

// Settings modal
const modal = $('#settingsModal');
$('#openSettings').addEventListener('click', () => {
  renderSettingsSummary();
  modal.classList.remove('hidden');
});
$('#cancelSettings').addEventListener('click', () => modal.classList.add('hidden'));

// ---- Engine events (all routed by threadId) ----
window.api.on('engine:status', (p) => setLifecycle(p.state, p.message));

window.api.on('chat:delta', (p) => {
  const conv = getConv(p.threadId);
  if (!conv) return;
  let item = conv.items.find((it) => it.kind === 'message' && it.itemId === p.itemId);
  if (!item) {
    item = { kind: 'message', role: 'ai', text: p.text, itemId: p.itemId, streaming: true };
    conv.items.push(item);
    if (conv.id === activeId) appendItemDom(item);
  } else {
    item.text = p.text;
    if (conv.id === activeId) {
      const bubble = activeBubbles.get(p.itemId);
      if (bubble) {
        renderMessageContent(bubble, 'ai', p.text);
        scrollToBottom();
      }
    }
  }
});

window.api.on('chat:message', (p) => {
  const conv = getConv(p.threadId);
  if (!conv) return;
  let item = p.itemId && conv.items.find((it) => it.kind === 'message' && it.itemId === p.itemId);
  if (!item) {
    // Fall back to the most recent streaming AI bubble without a final text.
    item = [...conv.items].reverse().find((it) => it.kind === 'message' && it.role === 'ai' && it.streaming);
  }
  if (item) {
    item.text = p.text;
    item.streaming = false;
    if (conv.id === activeId) {
      const bubble = item.itemId && activeBubbles.get(item.itemId);
      if (bubble) renderMessageContent(bubble, 'ai', p.text);
      else renderActive();
    }
  } else if (p.text) {
    pushItem(conv, { kind: 'message', role: 'ai', text: p.text, itemId: p.itemId });
  }
});

window.api.on('chat:activity', (p) => {
  if (p.phase !== 'completed' && p.phase !== 'started') return;
  // Match the original display filter: command on start; file on completion;
  // mcp on both; everything else ignored to avoid noise.
  if (p.kind === 'command' && p.phase !== 'started') return;
  if (p.kind === 'file' && p.phase !== 'completed') return;
  if (p.kind !== 'command' && p.kind !== 'file' && p.kind !== 'mcp') return;
  const conv = getConv(p.threadId);
  if (!conv) return;
  pushItem(conv, { kind: 'activity', activityKind: p.kind, display: activityDisplay(p) });
});

window.api.on('chat:turnState', (p) => {
  const conv = getConv(p.threadId);
  if (!conv) return;
  conv.busy = p.state === 'turn';
  if (conv.id === activeId) updateComposer();
  refreshSessions();
});

window.api.on('chat:turnDone', (p) => {
  const conv = p && p.threadId ? getConv(p.threadId) : activeConv();
  if (conv) {
    conv.busy = false;
    conv.streamItemId = null;
    if (conv.id === activeId) updateComposer();
  }
  refreshSessions();
});

window.api.on('chat:error', (p) => {
  const conv = p && p.threadId ? getConv(p.threadId) : activeConv();
  if (!conv) return;
  conv.busy = false;
  pushItem(conv, { kind: 'activity', activityKind: '', display: '错误：' + (p.message || '错误') });
  if (conv.id === activeId) updateComposer();
  maybeQuotaPrompt(p && p.message);
});

window.api.on('chat:threadChanged', (p) => {
  if (p && p.staleThreadId) {
    const stale = conversations.get(p.staleThreadId);
    if (stale) stale.busy = false;
  }
  if (p && p.threadId && (!activeId || p.recovered)) setActive(p.threadId);
  refreshSessions();
});

window.api.on('chat:historyLoaded', (p) => {
  const conv = getConv(p.threadId);
  if (!conv) return;
  conv.items = (p.messages || []).map((m) => {
    if (m.kind === 'message') return { kind: 'message', role: m.role, text: m.text };
    if (m.activityKind === 'file') return { kind: 'activity', activityKind: 'file', display: '已修改文件：' + (m.files || []).join(', ') };
    if (m.activityKind === 'mcp') return { kind: 'activity', activityKind: 'mcp', display: '调用工具：' + m.text };
    return { kind: 'activity', activityKind: '', display: m.activityKind === 'command' ? '$ ' + m.text : m.text };
  });
  conv.loaded = true;
  if (conv.id === activeId) renderActive();
});

window.api.on('workspace:changed', (p) => {
  if (p && p.workspaceDir) setWorkspaceHint(p.workspaceDir);
  sessionsLoaded = false;
  conversations.clear();
  activeId = null;
  showWelcome();
  updateComposer();
  refreshSessions();
});

// Bootstrap
(async () => {
  const info = await window.api.bootstrap();
  setWorkspaceHint(info.paths && info.paths.workspaceDir);
  if (info.currentThreadId) {
    getConv(info.currentThreadId);
    activeId = info.currentThreadId;
  }
  setModelTag(info.settings);
  const skillsEl = $('#skills');
  skillsEl.innerHTML = '';
  (info.skills || []).forEach((s) => {
    const b = document.createElement('button');
    b.className = 'skill-btn';
    b.textContent = s.title;
    b.title = s.description || s.title;
    b.addEventListener('click', () => {
      inputEl.value = `使用「${s.title}」技能：`;
      inputEl.focus();
    });
    skillsEl.appendChild(b);
  });
  showWelcome();
})();

// ---------------- Auth / membership ----------------
const loginOverlay = $('#loginOverlay');
const accountModal = $('#accountModal');
const memberEl = $('#member');
let loggedIn = false;
let codeTimer = null;

function setLoggedIn(state) {
  loggedIn = !!(state && state.loggedIn);
  if (loggedIn) {
    loginOverlay.classList.add('hidden');
    if (memberEl) {
      memberEl.textContent = '账户：' + (state.phone || '已登录');
      memberEl.style.cursor = 'pointer';
    }
    refreshAccountBadge();
  } else {
    loginOverlay.classList.remove('hidden');
    if (memberEl) memberEl.textContent = '会员：未登录';
  }
}

async function refreshAccountBadge() {
  try {
    const me = await window.api.auth.me();
    const ent = (me.entitlements || []).reduce((a, e) => a + (e.tokens_remaining || 0), 0);
    if (memberEl) {
      memberEl.textContent = ent > 0
        ? `会员：剩余 ${ent.toLocaleString()} Token`
        : `免费额度：剩余 ${me.free_turns_remaining} 次`;
    }
  } catch (_) {}
}

function maybeQuotaPrompt(message) {
  const m = String(message || '');
  if (/额度不足|quota|402|payment required/i.test(m)) {
    openAccount();
  }
}

const sendCodeBtn = $('#sendCodeBtn');
const loginPhone = $('#loginPhone');
const loginCode = $('#loginCode');
const loginErr = $('#loginErr');
const loginBtn = $('#loginBtn');

sendCodeBtn.addEventListener('click', async () => {
  loginErr.textContent = '';
  const phone = (loginPhone.value || '').trim();
  if (!/^1\d{10}$/.test(phone)) {
    loginErr.textContent = '请输入正确的 11 位手机号';
    return;
  }
  sendCodeBtn.disabled = true;
  try {
    const r = await window.api.auth.sendSms(phone);
    if (r && r.dev_code) loginCode.value = r.dev_code; // mock/dev convenience
    let left = 60;
    sendCodeBtn.textContent = `${left}s`;
    codeTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(codeTimer);
        sendCodeBtn.disabled = false;
        sendCodeBtn.textContent = '获取验证码';
      } else {
        sendCodeBtn.textContent = `${left}s`;
      }
    }, 1000);
  } catch (e) {
    loginErr.textContent = e && e.message ? e.message : '发送失败';
    sendCodeBtn.disabled = false;
  }
});

loginBtn.addEventListener('click', async () => {
  loginErr.textContent = '';
  const phone = (loginPhone.value || '').trim();
  const code = (loginCode.value || '').trim();
  if (!/^1\d{10}$/.test(phone)) {
    loginErr.textContent = '请输入正确的手机号';
    return;
  }
  if (!code) {
    loginErr.textContent = '请输入验证码';
    return;
  }
  loginBtn.disabled = true;
  loginBtn.textContent = '登录中…';
  try {
    await window.api.auth.verifySms(phone, code);
    setLoggedIn({ loggedIn: true, phone });
  } catch (e) {
    loginErr.textContent = e && e.message ? e.message : '登录失败';
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = '登录 / 注册';
  }
});

async function openAccount() {
  if (!loggedIn) return;
  accountModal.classList.remove('hidden');
  const infoEl = $('#accountInfo');
  const listEl = $('#packageList');
  const errEl = $('#accountErr');
  errEl.textContent = '';
  infoEl.textContent = '加载中…';
  listEl.innerHTML = '';
  try {
    const me = await window.api.auth.me();
    const ents = me.entitlements || [];
    let html = `<div>手机号：${me.phone}</div>`;
    html += `<div>免费额度：${me.free_turns_remaining}/${me.free_turns_total} 次</div>`;
    if (ents.length) {
      ents.forEach((e) => {
        const pct = e.token_allowance ? Math.max(0, Math.min(100, (e.tokens_remaining / e.token_allowance) * 100)) : 0;
        const multiplier = Number(e.token_multiplier || 1).toFixed(2);
        html += `<div style="margin-top:8px">套餐(${e.model})：剩余 ${e.tokens_remaining.toLocaleString()} / ${e.token_allowance.toLocaleString()} 积分 · ${multiplier}x（至 ${e.expires_at}）`;
        html += `<div class="quota-bar"><span style="width:${pct}%"></span></div></div>`;
      });
    } else {
      html += `<div style="margin-top:8px;color:#9aa3bd">暂无有效会员套餐</div>`;
    }
    infoEl.innerHTML = html;

    const { packages } = await window.api.auth.packages();
    (packages || []).forEach((p) => {
      const row = document.createElement('div');
      row.className = 'pkg';
      const multiplier = Number(p.token_multiplier || 1).toFixed(2);
      row.innerHTML = `<div><div class="pkg-name">${p.name}</div>` +
        `<div class="pkg-meta">${p.model} · ${p.total_tokens.toLocaleString()} 积分 · ${multiplier}x · ${p.duration_days} 天</div></div>` +
        `<div style="display:flex;align-items:center;gap:10px"><span class="pkg-price">¥${p.price_yuan}</span>` +
        `<button class="send-btn">购买</button></div>`;
      row.querySelector('button').addEventListener('click', () => buyPackage(p, errEl));
      listEl.appendChild(row);
    });
  } catch (e) {
    infoEl.textContent = '';
    errEl.textContent = e && e.message ? e.message : '加载失败';
  }
}

async function buyPackage(p, errEl) {
  errEl.textContent = '';
  try {
    // Manual provider = immediate confirmation (test/demo). Real Alipay/WeChat
    // flows will return a pay_url/QR and grant via webhook.
    const order = await window.api.auth.createOrder(p.id, 'manual');
    await window.api.auth.confirmOrder(order.out_trade_no);
    await openAccount();
    await refreshAccountBadge();
  } catch (e) {
    errEl.textContent = e && e.message ? e.message : '购买失败';
  }
}

if (memberEl) memberEl.addEventListener('click', openAccount);
$('#closeAccount').addEventListener('click', () => accountModal.classList.add('hidden'));
$('#logoutBtn').addEventListener('click', async () => {
  await window.api.auth.logout();
  accountModal.classList.add('hidden');
  setLoggedIn({ loggedIn: false });
});

window.api.on('auth:state', (p) => setLoggedIn(p));
window.api.on('remote:state', renderRemoteState);

// Initialize auth state on load.
window.api.auth.status().then(setLoggedIn).catch(() => setLoggedIn({ loggedIn: false }));
if (window.api.remote && window.api.remote.status) {
  window.api.remote.status().then(renderRemoteState).catch(() => renderRemoteState(null));
}
