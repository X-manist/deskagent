'use strict';
/**
 * Engine: orchestrates the local Responses adapter + bundled agent runtime, owns
 * the JSON-RPC lifecycle as a small state machine, and exposes a simple
 * send()/event API to the Electron main process.
 */
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { JsonRpcStdio } = require('./jsonrpc');
// Single source of truth lives at repo /adapter for dev; build copies it to
// src/vendor for packaged apps. Resolve whichever is present.
let createAdapterServer;
try {
  ({ createAdapterServer } = require('../vendor/responses-adapter'));
} catch (_) {
  ({ createAdapterServer } = require('../../../adapter/responses-adapter'));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function randomToken() {
  return require('crypto').randomBytes(24).toString('hex');
}

function hasCommand(cmd) {
  const probe = process.platform === 'win32' ? ['where', [cmd]] : ['sh', ['-lc', `command -v ${cmd}`]];
  const result = spawnSync(probe[0], probe[1], { stdio: 'ignore' });
  return result.status === 0;
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function sortedFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => !name.startsWith('.') && (!predicate || predicate(name)))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).isFile());
}

function normalizeUpstreamBaseUrl(baseUrl) {
  // The relay/OpenAI-compatible gateway exposes the API under "/v1". The runtime
  // (wire_api=responses) appends "/responses"; the adapter appends
  // "/chat/completions". Normalize to the API root so we never hit the gateway's
  // HTML root or accidentally double an endpoint path.
  try {
    const u = new URL(String(baseUrl));
    u.search = '';
    u.hash = '';
    // Strip a mistakenly-included endpoint suffix so it isn't doubled.
    u.pathname = u.pathname.replace(/\/(responses|chat\/completions)\/?$/i, '');
    if (u.pathname === '' || u.pathname === '/') {
      u.pathname = '/v1';
    }
    return u.toString().replace(/\/$/, '');
  } catch (_) {
    return baseUrl;
  }
}

function resolveAgentRuntimeBin() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  // packaged native runtime binary (branded name; never exposes the upstream name)
  const exe = process.platform === 'win32' ? 'deskagent-core.exe' : 'deskagent-core';
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'bin', exe);
    if (fs.existsSync(bundled)) return bundled;
  }
  // In packaged builds the bundled runtime must exist; fail closed so we never
  // silently fall back to a differently-named binary on PATH (which could
  // re-expose the upstream brand in system permission dialogs).
  const packaged = !!process.resourcesPath && !/[\\/]electron[\\/]/i.test(process.execPath);
  if (packaged) {
    throw new Error('未找到内置 agent runtime（resources/bin/deskagent-core 缺失）');
  }
  // Dev fallback only: resolve the local development binary by either name.
  return process.env.DESKAGENT_DEV_RUNTIME || 'deskagent-core';
}

const STATE = {
  IDLE: 'idle',
  STARTING: 'starting',
  READY: 'ready',
  BUSY: 'busy',
  TURN: 'turn',
  ERROR: 'error',
};

class Engine extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts; // { agentHome, workspaceDir, settings }
    this.state = STATE.IDLE;
    this.adapterServer = null;
    this.adapterPort = null;
    this.adapterToken = null;
    this.proc = null;
    this.rpc = null;
    this.threadId = null;
    this.currentTurnId = null;
    this.deltaItems = new Map(); // itemId -> accumulated text
  }

  _setState(s, extra) {
    this.state = s;
    this.emit('status', { state: s, ...(extra || {}) });
  }

  settings() {
    return this.opts.settings();
  }

  // Whether the configured relay natively speaks the OpenAI Responses API.
  // When true the local proxy forwards /responses verbatim (passthrough) so all
  // native tools — web_search, shell/exec, MCP, skills — work end-to-end. When
  // false (e.g. a chat-only GLM gateway) the proxy translates Responses<->Chat,
  // which can only forward function tools.
  _isResponsesRelay(s) {
    const mode = String((s && s.relayMode) || process.env.RELAY_MODE || 'openai').toLowerCase();
    return !(mode === 'glm' || mode === 'chat' || mode === 'adapter');
  }

  // Build the runtime environment from a curated allowlist rather than splatting
  // the full inherited environment. This is deliberate:
  //   * Security — the runtime's shell/exec tools inherit this env, so the real
  //     upstream key (and any other inherited secret) must never appear here. The
  //     runtime authenticates to the local proxy with an ephemeral loopback token
  //     and the proxy injects the real key only on the upstream hop.
  //   * Robustness — a minimal, well-known env avoids stray host variables that
  //     can break the runtime's unified-exec process spawning.
  // Only generic, non-sensitive shell/locale variables are forwarded.
  _runtimeEnv() {
    const ALLOW = [
      'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM',
      'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'COLORTERM', 'TERM_PROGRAM',
    ];
    const env = {};
    for (const key of ALLOW) {
      if (process.env[key] != null) env[key] = process.env[key];
    }
    if (!env.PATH) env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    return {
      ...env,
      CODEX_HOME: this.opts.agentHome,
      // Ephemeral loopback token the proxy validates; useless off-box.
      RELAY_KEY: this.adapterToken,
      // critical: bypass any system proxy for localhost (common in CN)
      no_proxy: '127.0.0.1,localhost',
      NO_PROXY: '127.0.0.1,localhost',
      RUST_LOG: 'error',
    };
  }

  async start() {
    this._setState(STATE.STARTING, { message: '正在启动本地服务…' });
    const s = this.settings();
    this.passthrough = this._isResponsesRelay(s);
    this.upstreamBaseUrl = normalizeUpstreamBaseUrl(s.baseUrl);

    if (!String(s.apiKey || '').trim()) {
      const msg = '尚未配置会员令牌（API Key）。请在设置中填写中转站会员令牌后重试。';
      this._fail(msg);
      throw new Error(msg);
    }

    this.adapterToken = randomToken();
    this.adapterPort = await freePort();

    // 1) start the local Responses proxy bound to localhost only. In passthrough
    //    mode it forwards verbatim to a Responses-native relay; otherwise it
    //    translates to Chat Completions. Either way the real key stays here.
    this.adapterServer = createAdapterServer({
      upstreamBaseUrl: this.upstreamBaseUrl,
      getApiKey: () => this.settings().apiKey,
      model: s.model,
      token: this.adapterToken,
      passthrough: this.passthrough,
      log: (...a) => this.emit('log', 'adapter', a.join(' ')),
    });
    await new Promise((resolve, reject) => {
      this.adapterServer.once('error', reject);
      this.adapterServer.listen(this.adapterPort, '127.0.0.1', resolve);
    });
    this.emit('log', 'adapter', `listening on 127.0.0.1:${this.adapterPort} (${this.passthrough ? 'passthrough' : 'translate'})`);

    // 2) write a dedicated runtime config (never touches the user's global settings)
    this._writeConfig();

    // 3) spawn the bundled agent runtime
    const env = this._runtimeEnv();
    const bin = resolveAgentRuntimeBin();
    this.emit('log', 'engine', `spawning agent runtime: ${bin}`);
    this.proc = spawn(bin, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.on('error', (e) => this._fail(`无法启动 agent runtime: ${e.message}`));
    this.proc.stderr.on('data', (d) => this.emit('log', 'agent-runtime', d.toString().trim()));
    this.proc.on('exit', (code) => {
      if (this.state !== STATE.ERROR) this._fail(`agent runtime 进程退出 (code ${code})`);
    });

    // 4) JSON-RPC handshake
    this.rpc = new JsonRpcStdio(this.proc);
    this.rpc.on('notification', (m, p) => this._onNotification(m, p));
    this.rpc.on('serverRequest', (msg) => this._onServerRequest(msg));

    await this.rpc.request('initialize', {
      clientInfo: { name: 'deskagent', title: '智界桌面助手', version: '0.1.0' },
      capabilities: {},
    });
    this.rpc.notify('initialized', {});

    // 5) start a thread
    const thread = await this.startNewThread();
    this.emit('log', 'engine', `thread ${thread.threadId}`);
    this._setState(STATE.READY, { message: '已就绪' });
  }

  _writeConfig() {
    fs.mkdirSync(this.opts.agentHome, { recursive: true });
    fs.mkdirSync(path.join(this.opts.agentHome, 'skills'), { recursive: true });
    const cfg = [
      `model = "${this.settings().model}"`,
      'model_provider = "relay"',
      'approval_policy = "never"',
      'sandbox_mode = "workspace-write"',
      // Enable the native live web-search tool. In passthrough mode this reaches
      // the relay's hosted web_search so the model can search the internet
      // automatically with no extra MCP server.
      'web_search = "live"',
      '',
      '[model_providers.relay]',
      'name = "DeskAgent Relay"',
      `base_url = ${tomlString(`http://127.0.0.1:${this.adapterPort}`)}`,
      'env_key = "RELAY_KEY"',
      'wire_api = "responses"',
      '',
      this._bundledMcpConfig(),
      '',
      this._deskagentMcpConfig(),
    ].filter(Boolean).join('\n');
    fs.writeFileSync(path.join(this.opts.agentHome, 'config.toml'), cfg);
    this._writeAgentsMd();
  }

  _bundledMcpConfig() {
    const profile = (this.settings().mcpProfile || process.env.DESKAGENT_MCP_PROFILE || 'core').toLowerCase();
    if (profile !== 'full') {
      return [
        '# Bundled MCP profile: core',
        '# Only the local desktop bridge is enabled by default so core tools stay directly visible.',
        '# Set DESKAGENT_MCP_PROFILE=full for development to merge agentconfig/mcp/*.toml.',
      ].join('\n');
    }

    const fragments = sortedFiles(path.join(this.opts.agentHome, 'mcp'), (name) => name.endsWith('.toml'));
    if (fragments.length) {
      const sqlitePath = path.join(this.opts.workspaceDir, 'deskagent.sqlite');
      return [
        '# Bundled MCP profile: full',
        ...fragments.map((file) => {
          const name = path.basename(file);
          const text = fs.readFileSync(file, 'utf8')
            .replace(/"\/path\/to\/workspace"/g, tomlString(this.opts.workspaceDir))
            .replace(/"\/path\/to\/repo"/g, tomlString(this.opts.workspaceDir))
            .replace(/"\/path\/to\/db\.sqlite"/g, tomlString(sqlitePath))
            .replace(/\/path\/to\/workspace/g, this.opts.workspaceDir)
            .replace(/\/path\/to\/repo/g, this.opts.workspaceDir)
            .replace(/\/path\/to\/db\.sqlite/g, sqlitePath);
          return `\n# --- agentconfig/mcp/${name} ---\n${text.trim()}\n`;
        }),
      ].join('\n');
    }

    return this._legacyMcpConfig();
  }

  _legacyMcpConfig() {
    const workspace = this.opts.workspaceDir;
    const lines = ['# Bundled agentconfig MCP defaults'];
    if (hasCommand('npx')) {
      lines.push(
        '',
        '[mcp_servers.filesystem]',
        'command = "npx"',
        `args = ["-y", "@modelcontextprotocol/server-filesystem", ${tomlString(workspace)}]`,
        '',
        '[mcp_servers.sequential-thinking]',
        'command = "npx"',
        'args = ["-y", "@modelcontextprotocol/server-sequential-thinking"]',
        '',
        '[mcp_servers.memory]',
        'command = "npx"',
        'args = ["-y", "@modelcontextprotocol/server-memory"]',
        '',
        '[mcp_servers.playwright]',
        'command = "npx"',
        'args = ["-y", "@playwright/mcp@latest"]'
      );
    }
    if (hasCommand('uvx')) {
      lines.push(
        '',
        '[mcp_servers.fetch]',
        'command = "uvx"',
        'args = ["mcp-server-fetch"]',
        '',
        '[mcp_servers.time]',
        'command = "uvx"',
        'args = ["mcp-server-time", "--local-timezone=Asia/Shanghai"]'
      );
      if (fs.existsSync(path.join(workspace, '.git'))) {
        lines.push(
          '',
          '[mcp_servers.git]',
          'command = "uvx"',
          `args = ["mcp-server-git", "--repository", ${tomlString(workspace)}]`
        );
      }
    }
    return lines.join('\n');
  }

  _deskagentMcpConfig() {
    const bridge = this.opts.bridgeInfo ? this.opts.bridgeInfo() : null;
    if (!(bridge && bridge.command && bridge.scriptPath && bridge.url && bridge.token)) return '';
    const lines = [
      '# Local desktop bridge MCP',
      '[mcp_servers.deskagent]',
      `command = ${tomlString(bridge.command)}`,
      `args = [${tomlString(bridge.scriptPath)}, ${tomlString(bridge.url)}, ${tomlString(bridge.token)}]`,
    ];
    if (bridge.env && Object.keys(bridge.env).length) {
      lines.push('', '[mcp_servers.deskagent.env]');
      for (const [key, value] of Object.entries(bridge.env)) lines.push(`${key} = ${tomlString(value)}`);
    }
    return lines.join('\n');
  }

  _writeAgentsMd() {
    const files = sortedFiles(path.join(this.opts.agentHome, 'rules'), (name) => name.endsWith('.md'));
    if (!files.length) return;
    const body = files.map((file) => {
      const rel = path.relative(this.opts.agentHome, file);
      return `## ${rel}\n\n${fs.readFileSync(file, 'utf8').trim()}`;
    }).join('\n\n');
    const text = [
      '# 智界桌面助手全局规则',
      '',
      '<!-- Generated from bundled agentconfig/rules/*.md. Do not edit in place. -->',
      '',
      body,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(this.opts.agentHome, 'AGENTS.md'), text);
  }

  _threadStartParams() {
    return {
      model: this.settings().model,
      cwd: this.opts.workspaceDir,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      personality: 'friendly',
    };
  }

  async startNewThread() {
    if (!this.rpc) throw new Error('app-server 尚未初始化');
    this.deltaItems.clear();
    this.currentTurnId = null;
    const thread = await this.rpc.request('thread/start', this._threadStartParams());
    this.threadId = (thread && thread.thread && thread.thread.id) || (thread && thread.id);
    this.emit('threadChanged', { threadId: this.threadId });
    return { threadId: this.threadId };
  }

  async listThreads() {
    if (!this.rpc) return [];
    const result = await this.rpc.request('thread/list', {
      cursor: null,
      limit: 50,
      cwd: [this.opts.workspaceDir],
    });
    return (result.data || []).map((thread) => ({
      id: thread.id,
      preview: thread.preview || '新会话',
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      status: thread.status,
      agentNickname: thread.agentNickname,
      agentRole: thread.agentRole,
    }));
  }

  async resumeThread(threadId) {
    if (!this.rpc) throw new Error('app-server 尚未初始化');
    if (!threadId) throw new Error('缺少会话 ID');
    this._setState(STATE.STARTING, { message: '正在加载历史会话…' });
    this.deltaItems.clear();
    this.currentTurnId = null;
    if (this.threadId && this.threadId !== threadId) {
      try {
        await this.rpc.request('thread/unsubscribe', { threadId: this.threadId });
      } catch (_) {}
    }
    const result = await this.rpc.request('thread/resume', { threadId });
    const thread = (result && result.thread) || result || {};
    let turns = thread.turns || [];
    try {
      const readback = await this.rpc.request('thread/read', { threadId, includeTurns: true });
      turns = (readback.thread && readback.thread.turns) || readback.turns || turns;
    } catch (_) {}
    this.threadId = thread.id || threadId;
    const messages = this._serializeTurns(turns);
    this.emit('historyLoaded', { threadId: this.threadId, messages });
    this.emit('threadChanged', { threadId: this.threadId });
    this._setState(STATE.READY, { message: '已就绪' });
    return { threadId: this.threadId, messages };
  }

  _serializeTurns(turns) {
    const out = [];
    for (const turn of turns || []) {
      const items = turn.items || turn.itemsView || [];
      for (const item of items) {
        const text = item.text || (item.message && item.message.text) || '';
        const contentText = Array.isArray(item.content)
          ? item.content
              .filter((part) => part && part.type === 'text' && part.text)
              .map((part) => part.text)
              .join('\n')
          : '';
        if (item.type === 'userMessage' && contentText) {
          out.push({ kind: 'message', role: 'user', text: contentText });
        } else if (item.type === 'agentMessage' && text) {
          out.push({ kind: 'message', role: 'ai', text });
        } else if (item.type === 'plan' && text) {
          out.push({ kind: 'activity', activityKind: 'reasoning', text });
        } else if (item.type === 'commandExecution') {
          out.push({ kind: 'activity', activityKind: 'command', text: item.command || '' });
        } else if (item.type === 'fileChange') {
          out.push({ kind: 'activity', activityKind: 'file', files: (item.changes || []).map((c) => c.path) });
        } else if (item.type === 'mcpToolCall') {
          out.push({
            kind: 'activity',
            activityKind: 'mcp',
            text: `${item.server || 'mcp'}.${item.tool || ''}`,
            status: item.status,
          });
        } else if (item.type === 'reasoning' && Array.isArray(item.summary) && item.summary.length) {
          out.push({ kind: 'activity', activityKind: 'reasoning', text: item.summary.join('\n') });
        }
      }
    }
    return out;
  }

  _onNotification(method, params) {
    switch (method) {
      case 'turn/started':
        this.currentTurnId = params.turn && params.turn.id;
        break;
      case 'thread/started':
        if (params.thread && params.thread.id) {
          this.threadId = params.thread.id;
          this.emit('threadChanged', { threadId: this.threadId });
        }
        break;
      case 'item/started':
        this._emitItem(params.item, 'started');
        break;
      case 'item/agentMessage/delta': {
        const id = params.itemId || params.item_id;
        const prev = this.deltaItems.get(id) || '';
        const next = prev + (params.delta || '');
        this.deltaItems.set(id, next);
        this.emit('delta', { itemId: id, delta: params.delta || '', text: next });
        break;
      }
      case 'item/completed':
        this._emitItem(params.item, 'completed');
        break;
      case 'turn/completed': {
        const usage = params.turn && params.turn.usage;
        this._setState(STATE.READY);
        this.emit('turnDone', { usage });
        break;
      }
      case 'error':
        this.emit('turnError', { message: (params.error && params.error.message) || '发生错误' });
        this._setState(STATE.READY);
        break;
      case 'event_msg':
        switch (params.type) {
          case 'task_started':
            this._setState(STATE.BUSY, { message: '思考中…' });
            break;
          case 'agent_message':
            if (params.message) this.emit('message', { text: params.message });
            break;
          case 'task_complete':
            this._setState(STATE.READY);
            this.emit('turnDone', {});
            break;
          case 'error':
            this.emit('turnError', { message: params.message || '发生错误' });
            this._setState(STATE.READY);
            break;
          default:
            break;
        }
        break;
      default:
        break;
    }
  }

  _emitItem(item, phase) {
    if (!item) return;
    const t = item.type;
    const itemText =
      item.text ||
      (item.message && item.message.text) ||
      (Array.isArray(item.content)
        ? item.content
            .filter((part) => part && (part.type === 'text' || part.type === 'output_text') && part.text)
            .map((part) => part.text)
            .join('\n')
        : '');
    if (t === 'agentMessage' && phase === 'completed') {
      this.emit('message', { text: itemText || '' });
    } else if (t === 'commandExecution') {
      this.emit('activity', {
        kind: 'command',
        phase,
        text: item.command || '',
        status: item.status,
        output: item.aggregatedOutput,
      });
    } else if (t === 'fileChange') {
      this.emit('activity', {
        kind: 'file',
        phase,
        status: item.status,
        files: (item.changes || []).map((c) => c.path),
      });
    } else if (t === 'mcpToolCall') {
      const result = item.result && Array.isArray(item.result.content)
        ? item.result.content
            .map((part) => {
              if (!part) return '';
              if (typeof part.text === 'string') return part.text;
              if (typeof part.content === 'string') return part.content;
              if (part.type === 'text' && typeof part.text === 'string') return part.text;
              return '';
            })
            .filter(Boolean)
            .join('\n')
        : '';
      this.emit('activity', {
        kind: 'mcp',
        phase,
        status: item.status,
        text: `${item.server || 'mcp'}.${item.tool || ''}`,
        output: result || (item.error && item.error.message) || '',
      });
    } else if (t === 'reasoning' && phase === 'completed') {
      this.emit('activity', { kind: 'reasoning', phase, text: (item.summary || []).join('\n') || itemText });
    }
  }

  _onServerRequest(msg) {
    // With approvalPolicy "never" we should not receive approval requests, but
    // respond safely to anything to avoid deadlocks.
    this.emit('log', 'engine', `server request: ${msg.method}`);
    if (/approval/i.test(msg.method)) {
      this.rpc.respond(msg.id, { decision: 'approved' });
    } else {
      this.rpc.respond(msg.id, {});
    }
  }

  async send(text, attachments) {
    if (this.state !== STATE.READY) throw new Error('引擎未就绪');
    this._setState(STATE.TURN, { message: '思考中…' });
    const input = [];
    const images = [];
    const refs = [];
    for (const att of attachments || []) {
      if (!att || !att.path) continue;
      if (att.kind === 'image') images.push({ type: 'localImage', path: att.path });
      else refs.push(att);
    }
    let body = text || '';
    if (refs.length) {
      const lines = refs.map((r) => `- ${r.kind === 'directory' ? '目录' : '文件'}：${r.path}`);
      const note = `\n\n[用户附带的本地${refs.some((r) => r.kind === 'directory') ? '文件/目录' : '文件'}，请在需要时读取]\n${lines.join('\n')}`;
      body = body ? body + note : note.trim();
    }
    if (body) input.push({ type: 'text', text: body });
    input.push(...images);
    if (!input.length) input.push({ type: 'text', text: '' });
    await this.rpc.request('turn/start', {
      threadId: this.threadId,
      input,
    });
  }

  async interrupt() {
    if (this.currentTurnId && this.threadId) {
      try {
        await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.currentTurnId });
      } catch (_) {}
    }
  }

  _fail(message) {
    this._setState(STATE.ERROR, { message });
    this.emit('log', 'engine', `ERROR ${message}`);
  }

  async stop() {
    try {
      if (this.proc) this.proc.kill();
    } catch (_) {}
    try {
      if (this.adapterServer) this.adapterServer.close();
    } catch (_) {}
    this.proc = null;
    this.rpc = null;
  }
}

module.exports = { Engine, STATE };
