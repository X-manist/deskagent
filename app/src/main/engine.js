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

function reasoningSummaryText(summary) {
  if (!Array.isArray(summary)) return '';
  return summary
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function compactJson(value, max = 500) {
  if (value == null) return '';
  let text = '';
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch (_) {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function hasRuntimeItemId(value) {
  return value !== undefined && value !== null && String(value) !== '';
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
    this.deltaItems = new Map(); // `${threadId}:${itemId}` -> accumulated text
    this.itemUiIds = new Map(); // `${threadId}:${sourceItemId}` -> current-turn UI item id
    this.syntheticItemSeq = new Map(); // `${threadId}:${itemType}` -> counter for missing runtime ids
    this.syntheticActiveItems = new Map(); // `${threadId}:${itemType}` -> synthetic source id
    // Per-thread turn bookkeeping for concurrent conversations. The engine's
    // global `this.state` only reflects app-server lifecycle (starting/ready/
    // error); whether a given conversation is mid-turn lives here so multiple
    // threads can run turns in parallel without a shared busy flag.
    this.threadTurns = new Map(); // threadId -> { state:'turn'|'ready', turnId }
    this.turnScopes = new Map(); // threadId -> local unique scope for current turn
    this.pendingInterrupt = new Set(); // threadIds asked to stop before turnId known
    this.subscribedThreads = new Set(); // threads we still want notifications for
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

  // Resolve CN-friendly runtime knobs (GitHub mirror, pip index, optional HTTP
  // proxy) from settings with sensible defaults. These let the agent install
  // packages and download skills from inside mainland China without manual setup.
  _runtimeSupport() {
    const s = this.settings() || {};
    const ghMirror = String(s.ghMirror || process.env.DESKAGENT_GH_MIRROR || 'https://gh-proxy.com/').replace(/\/?$/, '/');
    const pipIndex = String(s.pipIndex || process.env.DESKAGENT_PIP_INDEX || 'https://pypi.tuna.tsinghua.edu.cn/simple');
    const httpProxy = String(s.httpProxy || process.env.DESKAGENT_HTTP_PROXY || '').trim();
    return { ghMirror, pipIndex, httpProxy };
  }

  // Write runtime support files into the agent home: a persistent matplotlib
  // config (fixes the Chinese-font "卡住"/tofu issue and the first-run cache
  // hang by giving it a writable, reused cache dir + bundled CJK font list) and
  // a git config that transparently rewrites github.com to a CN mirror.
  _writeRuntimeSupport() {
    const runtimeDir = path.join(this.opts.agentHome, 'runtime');
    const mplDir = path.join(runtimeDir, 'mpl');
    fs.mkdirSync(mplDir, { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, 'npm-cache'), { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, 'uv-cache'), { recursive: true });
    const matplotlibrc = [
      'font.family: sans-serif',
      // Common CJK-capable fonts across macOS / Windows / Linux. matplotlib uses
      // the first one actually installed, so charts render Chinese, not tofu.
      'font.sans-serif: Arial Unicode MS, Hiragino Sans GB, PingFang SC, STHeiti, Songti SC, Heiti SC, Microsoft YaHei, SimHei, WenQuanYi Zen Hei, Noto Sans CJK SC, DejaVu Sans',
      'axes.unicode_minus: False',
      'figure.max_open_warning: 0',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(mplDir, 'matplotlibrc'), matplotlibrc);

    const { ghMirror, httpProxy } = this._runtimeSupport();
    const gitLines = [
      '[url "' + ghMirror + 'https://github.com/"]',
      '\tinsteadOf = https://github.com/',
      '[url "' + ghMirror + 'https://raw.githubusercontent.com/"]',
      '\tinsteadOf = https://raw.githubusercontent.com/',
      '[http]',
      '\tsslVerify = true',
    ];
    if (httpProxy) gitLines.push('\tproxy = ' + httpProxy);
    fs.writeFileSync(path.join(runtimeDir, 'gitconfig'), gitLines.join('\n') + '\n');
    return { runtimeDir, mplDir };
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
    const runtimeDir = path.join(this.opts.agentHome, 'runtime');
    const { pipIndex, httpProxy } = this._runtimeSupport();
    const extra = {
      CODEX_HOME: this.opts.agentHome,
      // Ephemeral loopback token the proxy validates; useless off-box.
      RELAY_KEY: this.adapterToken,
      // critical: bypass any system proxy for localhost (common in CN)
      no_proxy: '127.0.0.1,localhost',
      NO_PROXY: '127.0.0.1,localhost',
      RUST_LOG: 'error',
      // Charts: persistent writable cache dir (built once, reused) + headless
      // backend so the agent never hangs rebuilding the font cache.
      MPLCONFIGDIR: path.join(runtimeDir, 'mpl'),
      MPLBACKEND: 'Agg',
      PYTHONUNBUFFERED: '1',
      // CN-friendly Python installs without manual config.
      PIP_INDEX_URL: pipIndex,
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      NPM_CONFIG_CACHE: path.join(runtimeDir, 'npm-cache'),
      npm_config_cache: path.join(runtimeDir, 'npm-cache'),
      UV_CACHE_DIR: path.join(runtimeDir, 'uv-cache'),
      // Transparent github.com -> CN mirror rewrite for git clone/download.
      GIT_CONFIG_GLOBAL: path.join(runtimeDir, 'gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
    };
    const bundledPathDir = this._bundledRuntimePathDir();
    if (bundledPathDir) {
      const sep = process.platform === 'win32' ? ';' : ':';
      extra.PATH = [bundledPathDir, env.PATH].filter(Boolean).join(sep);
    }
    if (httpProxy) {
      extra.HTTP_PROXY = httpProxy;
      extra.HTTPS_PROXY = httpProxy;
      extra.http_proxy = httpProxy;
      extra.https_proxy = httpProxy;
    }
    return { ...env, ...extra };
  }

  _bundledRuntimePathDir() {
    if (!process.resourcesPath) return '';
    const dir = path.join(process.resourcesPath, 'codex-path');
    return fs.existsSync(dir) ? dir : '';
  }

  async start() {
    this._setState(STATE.STARTING, { message: '正在启动本地服务…' });
    const s = this.settings();
    this.passthrough = this._isResponsesRelay(s);
    this.upstreamBaseUrl = normalizeUpstreamBaseUrl(s.baseUrl);

    if (!String(s.apiKey || '').trim()) {
      const msg = '当前账户授权不可用，请重新登录后重试。';
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
      preferWebSocket: !this.passthrough && process.env.DESKAGENT_DISABLE_BACKEND_WS !== '1',
      log: (...a) => this.emit('log', 'adapter', a.join(' ')),
    });
    await new Promise((resolve, reject) => {
      this.adapterServer.once('error', reject);
      this.adapterServer.listen(this.adapterPort, '127.0.0.1', resolve);
    });
    this.emit('log', 'adapter', `listening on 127.0.0.1:${this.adapterPort} (${this.passthrough ? 'passthrough' : 'translate'})`);

    // 2) write a dedicated runtime config (never touches the user's global settings)
    this._writeConfig();
    // 2b) write runtime support files (matplotlib CJK font config + CN git mirror)
    try {
      this._writeRuntimeSupport();
    } catch (e) {
      this.emit('log', 'engine', `runtime support 写入失败（忽略）：${e.message}`);
    }

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
    fs.mkdirSync(path.join(this.opts.agentHome, 'memories'), { recursive: true });
    fs.mkdirSync(path.join(this.opts.agentHome, 'runtime'), { recursive: true });
    const cfg = [
      `model = "${this.settings().model}"`,
      'model_provider = "relay"',
      'approval_policy = "never"',
      // The desktop app already constrains the working directory and keeps
      // provider keys out of the runtime env. Do not add Codex's command
      // sandbox on top; on Windows it blocks normal local workflows such as
      // python, pip, and binary file reads.
      'sandbox_mode = "danger-full-access"',
      // Enable the native live web-search tool. In passthrough mode this reaches
      // the relay's hosted web_search so the model can search the internet
      // automatically with no extra MCP server.
      'web_search = "live"',
      '',
      '[features]',
      'memories = true',
      '',
      '[memories]',
      'use_memories = true',
      'generate_memories = true',
      'dedicated_tools = true',
      'disable_on_external_context = false',
      '',
      '[sandbox_workspace_write]',
      `writable_roots = [${tomlString(path.join(this.opts.agentHome, 'skills'))}, ${tomlString(path.join(this.opts.agentHome, 'memories'))}, ${tomlString(path.join(this.opts.agentHome, 'runtime'))}]`,
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
      const lines = [
        '# Bundled MCP profile: core',
        '# The local desktop bridge stays directly visible; memory is enabled for cross-session recall.',
        '# Set DESKAGENT_MCP_PROFILE=full for development to merge agentconfig/mcp/*.toml.',
      ];
      if (hasCommand('npx')) {
        lines.push(
          '',
          '[mcp_servers.memory]',
          'default_tools_approval_mode = "approve"',
          'command = "npx"',
          'args = ["-y", "@modelcontextprotocol/server-memory"]',
          '',
          '[mcp_servers.memory.env]',
          `MEMORY_FILE_PATH = ${tomlString(path.join(this.opts.agentHome, 'memory.json'))}`
        );
      }
      return lines.join('\n');
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
          const extra = name === 'general.toml'
            ? `\n\n[mcp_servers.memory.env]\nMEMORY_FILE_PATH = ${tomlString(path.join(this.opts.agentHome, 'memory.json'))}`
            : '';
          return `\n# --- agentconfig/mcp/${name} ---\n${text.trim()}${extra}\n`;
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
        'default_tools_approval_mode = "approve"',
        'command = "npx"',
        `args = ["-y", "@modelcontextprotocol/server-filesystem", ${tomlString(workspace)}]`,
        '',
        '[mcp_servers.sequential-thinking]',
        'default_tools_approval_mode = "approve"',
        'command = "npx"',
        'args = ["-y", "@modelcontextprotocol/server-sequential-thinking"]',
        '',
        '[mcp_servers.memory]',
        'default_tools_approval_mode = "approve"',
        'command = "npx"',
        'args = ["-y", "@modelcontextprotocol/server-memory"]',
        '',
        '[mcp_servers.playwright]',
        'default_tools_approval_mode = "approve"',
        'command = "npx"',
        'args = ["-y", "@playwright/mcp@latest"]'
      );
    }
    if (hasCommand('uvx')) {
      lines.push(
        '',
        '[mcp_servers.fetch]',
        'default_tools_approval_mode = "approve"',
        'command = "uvx"',
        'args = ["mcp-server-fetch"]',
        '',
        '[mcp_servers.time]',
        'default_tools_approval_mode = "approve"',
        'command = "uvx"',
        'args = ["mcp-server-time", "--local-timezone=Asia/Shanghai"]'
      );
      if (fs.existsSync(path.join(workspace, '.git'))) {
        lines.push(
          '',
          '[mcp_servers.git]',
          'default_tools_approval_mode = "approve"',
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
      // Built-in desktop tools are first-party and trusted; auto-approve every
      // call so the runtime executes them directly instead of (with
      // approval_policy="never" + workspace-write sandbox) silently declining
      // the approval/elicitation request and never reaching the local bridge.
      'default_tools_approval_mode = "approve"',
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
      this._deskagentDynamicCapabilityRules(),
      '',
    ].join('\n');
    fs.writeFileSync(path.join(this.opts.agentHome, 'AGENTS.md'), text);
  }

  _deskagentDynamicCapabilityRules() {
    const skillsDir = path.join(this.opts.agentHome, 'skills');
    const memoriesDir = path.join(this.opts.agentHome, 'memories');
    return [
      '## DeskAgent 动态能力与记忆',
      '',
      '- 技能选择不由用户手动操作。每次遇到专门任务时，先自动查看本地可用 skills，优先复用 `skills/<name>/SKILL.md` 中最匹配的技能。',
      '- 当用户询问“能不能做某类事”、需要新领域能力、或本地没有合适技能时，优先按 `skills/find-skills/SKILL.md` 的流程处理：先用本地与已知来源判断，再在需要联网时搜索 skills.sh / `npx skills find`，确认来源质量后再建议或安装。',
      '- 在线安装技能前要说明来源、用途和风险；只有在用户同意后，才运行 `npx skills add <package> -g -y` 或等价安装命令。安装后必须确认新的 `SKILL.md` 已落在本地 `skills/` 下；如果安装器写到了其他位置，需要复制/整理到本地 `skills/<slug>/SKILL.md` 后才算完成。',
      `- 如果用户在对话中反复形成了稳定主题、固定流程、写作风格、业务规则或工具步骤，并明确表示“记住/以后都这样/做成技能/沉淀下来”，可以创建或更新本地主题 skill：写入 \`${skillsDir}/<slug>/SKILL.md\`。slug 使用小写英文、数字和连字符；内容至少包含 frontmatter 的 \`name\`、\`description\`，以及清晰触发条件、步骤、输出格式和约束。`,
      '- 动态写入 skill 后，回复用户新 skill 的名称和保存位置；后续会话会自动扫描该目录并按需触发，无需左侧技能栏。',
      '- 使用跨 session memory：任务涉及用户长期偏好、项目上下文、反复出现的业务规则、上次未完事项或用户问“之前/上次/以后”时，先查 memory，再回答。不要把一次性闲聊、敏感凭据、支付信息或无关个人隐私写入 memory。',
      `- 记忆文件位于 \`${memoriesDir}\`；只有在用户明确要求记忆或信息显然属于长期偏好/项目事实时才沉淀。`,
    ].join('\n');
  }

  _threadStartParams() {
    return {
      model: this.settings().model,
      cwd: this.opts.workspaceDir,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      personality: 'friendly',
    };
  }

  async startNewThread() {
    if (!this.rpc) throw new Error('app-server 尚未初始化');
    const thread = await this.rpc.request('thread/start', this._threadStartParams());
    const id = (thread && thread.thread && thread.thread.id) || (thread && thread.id);
    this.threadId = id;
    if (id) {
      this.threadTurns.set(id, { state: 'ready' });
      this.subscribedThreads.add(id);
    }
    this.emit('threadChanged', { threadId: this.threadId });
    return { threadId: this.threadId };
  }

  _isThreadNotFoundError(error) {
    return /thread not found/i.test(String((error && error.message) || error || ''));
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
    // Switching to a historical conversation must not disturb other threads:
    // do NOT change global lifecycle state and do NOT unsubscribe whichever
    // thread was active (it may still be streaming a turn in the background).
    const result = await this.rpc.request('thread/resume', { threadId });
    const thread = (result && result.thread) || result || {};
    let turns = thread.turns || [];
    try {
      const readback = await this.rpc.request('thread/read', { threadId, includeTurns: true });
      turns = (readback.thread && readback.thread.turns) || readback.turns || turns;
    } catch (_) {}
    this.threadId = thread.id || threadId;
    if (!this.threadTurns.has(this.threadId)) this.threadTurns.set(this.threadId, { state: 'ready' });
    this.subscribedThreads.add(this.threadId);
    const messages = this._serializeTurns(turns);
    this.emit('historyLoaded', { threadId: this.threadId, messages });
    this.emit('threadChanged', { threadId: this.threadId });
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
        } else if (item.type === 'reasoning') {
          const summaryText = reasoningSummaryText(item.summary);
          if (summaryText) out.push({ kind: 'activity', activityKind: 'reasoning', text: summaryText });
        } else if (item.type === 'mcpToolCall') {
          const text = [
            item.status === 'completed' ? '工具调用完成' : '正在调用工具',
            `${item.server || 'tool'}.${item.tool || ''}`,
            item.error ? `结果：${compactJson(item.error)}` : (item.result ? `结果：${compactJson(item.result)}` : ''),
          ].filter(Boolean).join('\n');
          out.push({ kind: 'activity', activityKind: 'tool', text });
        } else if (item.type === 'dynamicToolCall') {
          const name = [item.namespace, item.tool].filter(Boolean).join('.') || item.tool || 'tool';
          const output = compactJson(item.contentItems);
          out.push({
            kind: 'activity',
            activityKind: 'tool',
            text: ['工具调用完成', name, output ? `结果：${output}` : ''].filter(Boolean).join('\n'),
          });
        } else if (item.type === 'webSearch') {
          out.push({
            kind: 'activity',
            activityKind: 'tool',
            text: ['搜索完成', item.query || 'web search'].filter(Boolean).join('\n'),
          });
        }
      }
    }
    return out;
  }

  // Resolve which conversation a notification belongs to. Every turn/item
  // notification from the app-server carries a top-level threadId; fall back to
  // the embedded thread object, then to the currently active thread.
  _threadOf(params) {
    return (
      (params && params.threadId) ||
      (params && params.thread && params.thread.id) ||
      this.threadId
    );
  }

  _markTurn(threadId, state, turnId) {
    if (!threadId) return;
    const prev = this.threadTurns.get(threadId) || {};
    this.threadTurns.set(threadId, {
      state,
      turnId: turnId || (state === 'turn' ? prev.turnId : undefined),
    });
    if (state === 'turn' && prev.state !== 'turn') this._clearThreadItemIds(threadId);
    if (state !== 'turn') this.turnScopes.delete(threadId);
    this.emit('turnState', { threadId, state });
  }

  _clearThreadItemIds(threadId) {
    const prefix = `${threadId}:`;
    for (const key of this.itemUiIds.keys()) {
      if (key.startsWith(prefix)) this.itemUiIds.delete(key);
    }
    for (const key of this.deltaItems.keys()) {
      if (key.startsWith(prefix)) this.deltaItems.delete(key);
    }
    for (const key of this.syntheticItemSeq.keys()) {
      if (key.startsWith(prefix)) this.syntheticItemSeq.delete(key);
    }
    for (const key of this.syntheticActiveItems.keys()) {
      if (key.startsWith(prefix)) this.syntheticActiveItems.delete(key);
    }
  }

  _sourceItemId(threadId, itemType, itemId, phase = '') {
    if (hasRuntimeItemId(itemId)) return itemId;
    const key = `${threadId}:${itemType || 'item'}`;
    if (phase === 'started' || !this.syntheticActiveItems.has(key)) {
      const next = (this.syntheticItemSeq.get(key) || 0) + 1;
      this.syntheticItemSeq.set(key, next);
      this.syntheticActiveItems.set(key, `${itemType || 'item'}-${next}`);
    }
    const syntheticId = this.syntheticActiveItems.get(key);
    if (phase === 'completed') this.syntheticActiveItems.delete(key);
    return syntheticId;
  }

  _turnScope(threadId, turnId) {
    if (!threadId) return turnId || 'global';
    let scope = this.turnScopes.get(threadId);
    if (!scope) {
      scope = turnId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      this.turnScopes.set(threadId, scope);
    }
    return scope;
  }

  _uiItemId(threadId, itemId) {
    const raw = itemId || 'message';
    const mapKey = `${threadId}:${raw}`;
    const existing = this.itemUiIds.get(mapKey);
    if (existing) return existing;
    const turn = this.threadTurns.get(threadId) || {};
    const scope = this._turnScope(threadId, turn.turnId);
    const uiItemId = `${scope}:${raw}`;
    this.itemUiIds.set(mapKey, uiItemId);
    return uiItemId;
  }

  _onNotification(method, params) {
    const threadId = this._threadOf(params);
    switch (method) {
      case 'turn/started': {
        const turnId = params.turn && params.turn.id;
        if (threadId === this.threadId) this.currentTurnId = turnId;
        if (threadId) this.turnScopes.set(threadId, turnId || this._turnScope(threadId));
        this._markTurn(threadId, 'turn', turnId);
        // Honor a Stop pressed before the turnId was known.
        if (this.pendingInterrupt.has(threadId)) {
          this.pendingInterrupt.delete(threadId);
          this.rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        }
        break;
      }
      case 'thread/started':
        // Do NOT auto-switch the active conversation here: the renderer owns
        // active selection (via startNewThread/resumeThread return values).
        if (threadId && !this.threadTurns.has(threadId)) this._markTurn(threadId, 'ready');
        break;
      case 'item/started':
        this._emitItem(params.item, 'started', threadId);
        break;
      case 'item/agentMessage/delta': {
        const itemId = params.itemId || params.item_id;
        const sourceItemId = this._sourceItemId(threadId, 'agentMessage', itemId, 'delta');
        const syntheticItemId = !hasRuntimeItemId(itemId);
        const uiItemId = this._uiItemId(threadId, sourceItemId);
        const key = `${threadId}:${uiItemId}`;
        const prev = this.deltaItems.get(key) || '';
        const next = prev + (params.delta || '');
        this.deltaItems.set(key, next);
        this.emit('delta', { threadId, itemId: uiItemId, sourceItemId, syntheticItemId, delta: params.delta || '', text: next });
        break;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const itemId = params.itemId || params.item_id;
        const sourceItemId = this._sourceItemId(threadId, 'reasoning', itemId, 'delta');
        const syntheticItemId = !hasRuntimeItemId(itemId);
        const uiItemId = this._uiItemId(threadId, sourceItemId);
        const key = `${threadId}:${uiItemId}:reasoning`;
        const delta = params.delta || '';
        const prev = this.deltaItems.get(key) || '';
        const next = prev + delta;
        this.deltaItems.set(key, next);
        this.emit('activity', {
          threadId,
          kind: 'reasoning',
          phase: 'delta',
          itemId: uiItemId,
          sourceItemId,
          syntheticItemId,
          delta,
          text: next,
        });
        break;
      }
      case 'item/commandExecution/outputDelta': {
        const itemId = params.itemId || params.item_id;
        const sourceItemId = this._sourceItemId(threadId, 'commandExecution', itemId, 'delta');
        const syntheticItemId = !hasRuntimeItemId(itemId);
        const uiItemId = this._uiItemId(threadId, sourceItemId);
        const key = `${threadId}:${uiItemId}:command`;
        const delta = params.delta || '';
        const prev = this.deltaItems.get(key) || '';
        const next = prev + delta;
        this.deltaItems.set(key, next);
        this.emit('activity', {
          threadId,
          kind: 'command',
          phase: 'delta',
          itemId: uiItemId,
          sourceItemId,
          syntheticItemId,
          delta,
          output: next,
          text: next,
        });
        break;
      }
      case 'item/mcpToolCall/progress': {
        const itemId = params.itemId || params.item_id;
        const sourceItemId = this._sourceItemId(threadId, 'mcpToolCall', itemId, 'progress');
        const syntheticItemId = !hasRuntimeItemId(itemId);
        const uiItemId = this._uiItemId(threadId, sourceItemId);
        this.emit('activity', {
          threadId,
          kind: 'tool',
          phase: 'progress',
          itemId: uiItemId,
          sourceItemId,
          syntheticItemId,
          text: params.message || '工具执行中…',
        });
        break;
      }
      case 'item/completed':
        this._emitItem(params.item, 'completed', threadId);
        break;
      case 'turn/completed': {
        const usage = params.turn && params.turn.usage;
        this._markTurn(threadId, 'ready');
        this.emit('turnDone', { threadId, usage });
        break;
      }
      case 'error':
        this.emit('turnError', { threadId, message: (params.error && params.error.message) || '发生错误' });
        this._markTurn(threadId, 'ready');
        break;
      case 'event_msg': {
        // Legacy event stream. It may not carry a threadId; only route it when
        // unambiguous (single running thread) and never touch global state.
        const running = [...this.threadTurns.entries()].filter(([, v]) => v.state === 'turn');
        const legacyThread = params.threadId || (running.length === 1 ? running[0][0] : this.threadId);
        switch (params.type) {
          case 'task_started':
            this._markTurn(legacyThread, 'turn');
            break;
          case 'agent_message':
            if (params.message) this.emit('message', { threadId: legacyThread, text: params.message });
            break;
          case 'task_complete':
            this._markTurn(legacyThread, 'ready');
            this.emit('turnDone', { threadId: legacyThread });
            break;
          case 'error':
            this.emit('turnError', { threadId: legacyThread, message: params.message || '发生错误' });
            this._markTurn(legacyThread, 'ready');
            break;
          default:
            break;
        }
        break;
      }
      default:
        break;
    }
  }

  _emitItem(item, phase, threadId) {
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
    if (t === 'agentMessage' && phase === 'started') {
      this._sourceItemId(threadId, 'agentMessage', item.id, phase);
    } else if (t === 'agentMessage' && phase === 'completed') {
      const sourceItemId = this._sourceItemId(threadId, 'agentMessage', item.id, phase);
      this.emit('message', {
        threadId,
        itemId: this._uiItemId(threadId, sourceItemId),
        sourceItemId,
        syntheticItemId: !hasRuntimeItemId(item.id),
        text: itemText || '',
      });
    } else if (t === 'commandExecution') {
      const command = item.command || '';
      const status = item.status || phase;
      const output = item.aggregatedOutput || '';
      const sourceItemId = this._sourceItemId(threadId, 'commandExecution', item.id, phase);
      const syntheticItemId = !hasRuntimeItemId(item.id);
      this.emit('activity', {
        threadId,
        kind: 'command',
        phase,
        itemId: this._uiItemId(threadId, sourceItemId),
        sourceItemId,
        syntheticItemId,
        text: command,
        status,
        output,
        display: [
          phase === 'started' ? '正在执行命令' : '命令执行完成',
          command,
          output ? `输出：${output}` : '',
        ].filter(Boolean).join('\n'),
      });
    } else if (t === 'fileChange') {
      this.emit('activity', {
        threadId,
        kind: 'file',
        phase,
        status: item.status,
        files: (item.changes || []).map((c) => c.path),
      });
    } else if (t === 'reasoning') {
      const text = reasoningSummaryText(item.summary) || itemText;
      const sourceItemId = this._sourceItemId(threadId, 'reasoning', item.id, phase);
      const syntheticItemId = !hasRuntimeItemId(item.id);
      this.emit('activity', {
        threadId,
        kind: 'reasoning',
        phase,
        itemId: this._uiItemId(threadId, sourceItemId),
        sourceItemId,
        syntheticItemId,
        text,
      });
    } else if (t === 'mcpToolCall') {
      const status = item.status || phase;
      const text = `${item.server || 'tool'}.${item.tool || ''}`;
      const result = item.error ? compactJson(item.error) : compactJson(item.result);
      const sourceItemId = this._sourceItemId(threadId, 'mcpToolCall', item.id, phase);
      const syntheticItemId = !hasRuntimeItemId(item.id);
      this.emit('activity', {
        threadId,
        kind: 'tool',
        phase,
        itemId: this._uiItemId(threadId, sourceItemId),
        sourceItemId,
        syntheticItemId,
        text,
        status,
        output: result,
        display: [
          phase === 'started' ? '正在调用工具' : '工具调用完成',
          text,
          result ? `结果：${result}` : '',
        ].filter(Boolean).join('\n'),
      });
    } else if (t === 'dynamicToolCall') {
      const text = [item.namespace, item.tool].filter(Boolean).join('.') || item.tool || 'tool';
      const output = compactJson(item.contentItems);
      const sourceItemId = this._sourceItemId(threadId, 'dynamicToolCall', item.id, phase);
      const syntheticItemId = !hasRuntimeItemId(item.id);
      this.emit('activity', {
        threadId,
        kind: 'tool',
        phase,
        itemId: this._uiItemId(threadId, sourceItemId),
        sourceItemId,
        syntheticItemId,
        text,
        status: item.status || phase,
        output,
        display: [
          phase === 'started' ? '正在调用工具' : '工具调用完成',
          text,
          output ? `结果：${output}` : '',
        ].filter(Boolean).join('\n'),
      });
    } else if (t === 'webSearch') {
      const sourceItemId = this._sourceItemId(threadId, 'webSearch', item.id, phase);
      const syntheticItemId = !hasRuntimeItemId(item.id);
      this.emit('activity', {
        threadId,
        kind: 'tool',
        phase,
        itemId: this._uiItemId(threadId, sourceItemId),
        sourceItemId,
        syntheticItemId,
        text: item.query || 'web search',
        status: phase,
        display: `${phase === 'started' ? '正在搜索' : '搜索完成'}\n${item.query || ''}`,
      });
    }
  }

  _onServerRequest(msg) {
    // With approvalPolicy "never" and trusted MCP servers set to
    // default_tools_approval_mode="approve" we should not receive approval
    // requests. Respond safely to anything to avoid deadlocks, but handle the
    // known approval/elicitation shapes explicitly so a stray request can never
    // be silently parsed as a decline (which would block built-in tools).
    this.emit('log', 'engine', `server request: ${msg.method}`);
    const method = msg.method || '';

    // Classic approval requests (command/file/permission): approve.
    if (/approval/i.test(method)) {
      this.rpc.respond(msg.id, { decision: 'approved' });
      return;
    }

    // request_user_input is used to prompt for MCP tool-call approval. Answer
    // any mcp_tool_call_approval_* question with "Allow" so the runtime runs the
    // tool; leave unrelated questions empty.
    if (method === 'item/tool/requestUserInput') {
      const questions = (msg.params && Array.isArray(msg.params.questions)) ? msg.params.questions : [];
      const answers = {};
      for (const q of questions) {
        if (q && typeof q.id === 'string' && q.id.startsWith('mcp_tool_call_approval')) {
          answers[q.id] = { answers: ['Allow'] };
        }
      }
      this.rpc.respond(msg.id, { answers });
      return;
    }

    // MCP server elicitation for tool approval: accept.
    if (method === 'mcpServer/elicitation/request') {
      this.rpc.respond(msg.id, { action: 'accept', content: {} });
      return;
    }

    this.emit('log', 'engine', `unhandled server request (responding empty): ${method}`);
    this.rpc.respond(msg.id, {});
  }

  async send(text, attachments, threadId) {
    if (this.state !== STATE.READY) throw new Error('引擎未就绪');
    let tid = threadId || this.threadId;
    if (!tid) throw new Error('缺少会话 ID');
    const turn = this.threadTurns.get(tid);
    if (turn && turn.state === 'turn') throw new Error('当前会话正在回复中');
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
      const lines = refs.map((r) => {
        const kindLabel = r.kind === 'directory' ? '目录' : '文件';
        const details = [`- ${kindLabel}：${r.path}`];
        if (r.originalPath && r.originalPath !== r.path) details.push(`  原始路径：${r.originalPath}`);
        if (r.summaryPath) details.push(`  文本摘录：${r.summaryPath}`);
        if (r.extractionError) details.push(`  附件解析提示：${r.extractionError}`);
        if (r.extractedText) {
          details.push(`  附件内容摘录：\n${String(r.extractedText).split('\n').map((line) => `    ${line}`).join('\n')}`);
          if (r.extractedTextTruncated) details.push('  附件内容摘录已截断，请按需读取文本摘录文件。');
        }
        return details.join('\n');
      });
      const note = `\n\n[用户附带的本地${refs.some((r) => r.kind === 'directory') ? '文件/目录' : '文件'}，请在需要时读取]\n${lines.join('\n')}`;
      body = body ? body + note : note.trim();
    }
    if (body) input.push({ type: 'text', text: body });
    input.push(...images);
    if (!input.length) input.push({ type: 'text', text: '' });
    this._markTurn(tid, 'turn');
    try {
      await this.rpc.request('turn/start', { threadId: tid, input });
    } catch (e) {
      if (this._isThreadNotFoundError(e)) {
        const staleThreadId = tid;
        this._markTurn(staleThreadId, 'ready');
        this.pendingInterrupt.delete(staleThreadId);
        const next = await this.startNewThread();
        tid = next.threadId;
        this.emit('threadChanged', { threadId: tid, staleThreadId, recovered: true });
        this._markTurn(tid, 'turn');
        try {
          await this.rpc.request('turn/start', { threadId: tid, input });
          return { threadId: tid, recovered: true };
        } catch (retryError) {
          this._markTurn(tid, 'ready');
          this.pendingInterrupt.delete(tid);
          this.emit('turnError', { threadId: tid, message: (retryError && retryError.message) || '发送失败' });
          throw retryError;
        }
      }
      // Roll back the optimistic busy flag so the conversation isn't stuck.
      this._markTurn(tid, 'ready');
      this.pendingInterrupt.delete(tid);
      this.emit('turnError', { threadId: tid, message: (e && e.message) || '发送失败' });
      throw e;
    }
    return { threadId: tid };
  }

  async interrupt(threadId) {
    const tid = threadId || this.threadId;
    if (!tid) return;
    const turn = this.threadTurns.get(tid);
    const turnId = (turn && turn.turnId) || (tid === this.threadId ? this.currentTurnId : null);
    if (turnId) {
      try {
        await this.rpc.request('turn/interrupt', { threadId: tid, turnId });
      } catch (_) {}
    } else if (turn && turn.state === 'turn') {
      // Turn started but turnId not yet observed — interrupt once it arrives.
      this.pendingInterrupt.add(tid);
    }
  }

  _fail(message) {
    this._setState(STATE.ERROR, { message });
    this.emit('log', 'engine', `ERROR ${message}`);
  }

  async stop() {
    const proc = this.proc;
    const adapterServer = this.adapterServer;
    this.proc = null;
    this.rpc = null;
    this.adapterServer = null;
    if (proc && !proc.killed) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, 1500);
        if (timer && typeof timer.unref === 'function') timer.unref();
        proc.once('exit', finish);
        proc.once('error', finish);
        try {
          proc.kill();
        } catch (_) {
          finish();
        }
      });
    }
    if (adapterServer && adapterServer.listening) {
      await new Promise((resolve) => {
        try {
          adapterServer.close(() => resolve());
        } catch (_) {
          resolve();
        }
      });
    }
  }
}

module.exports = { Engine, STATE, reasoningSummaryText };
