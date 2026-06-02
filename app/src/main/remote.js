'use strict';
const { EventEmitter } = require('events');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');

const HEARTBEAT_MS = 25_000;
const POLL_MS = 2_500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableMachineId(baseDir) {
  return 'deskagent-' + crypto.createHash('sha256').update(String(baseDir || os.hostname())).digest('hex').slice(0, 24);
}

function isAbortError(error) {
  return error && (error.name === 'AbortError' || /aborted/i.test(String(error.message || '')));
}

function localBackendReason(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return '当前远程服务地址是本机地址，手机或其他设备无法直接打开扫码链接';
    }
  } catch (_) {}
  return '';
}

function forwardedPublicHeaders(value) {
  if (!value) return {};
  try {
    const url = new URL(String(value).replace(/\/+$/, ''));
    return {
      'X-Forwarded-Proto': url.protocol.replace(':', ''),
      'X-Forwarded-Host': url.host,
    };
  } catch (_) {
    return {};
  }
}

function remoteWebUrl(baseUrl, code) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base || !code) return '';
  try {
    const url = new URL('/remote', `${base}/`);
    url.searchParams.set('code', code);
    return url.toString();
  } catch (_) {
    return `${base}/remote?code=${encodeURIComponent(code)}`;
  }
}

class RemoteHost extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.machineId = stableMachineId(opts.baseDir);
    this.machineToken = '';
    this.running = false;
    this.polling = false;
    this.heartbeatTimer = null;
    this.pairing = null;
    this.lastError = '';
    this.inFlight = new Set();
  }

  auth() {
    return this.opts.auth ? this.opts.auth() : {};
  }

  backendUrl() {
    return String(this.opts.backendUrl || '').replace(/\/+$/, '');
  }

  publicBackendUrl() {
    return String(this.opts.publicBackendUrl || '').replace(/\/+$/, '');
  }

  engine() {
    return this.opts.engine ? this.opts.engine() : null;
  }

  isLoggedIn() {
    const auth = this.auth();
    return !!(auth && auth.token);
  }

  headers(machine = false) {
    const headers = {
      'Content-Type': 'application/json',
      ...forwardedPublicHeaders(this.publicBackendUrl()),
    };
    if (machine) {
      if (this.machineToken) headers.Authorization = `Bearer ${this.machineToken}`;
    } else {
      const auth = this.auth();
      if (auth && auth.token) headers.Authorization = `Bearer ${auth.token}`;
    }
    return headers;
  }

  async request(path, { method = 'GET', body, machine = false, timeoutMs = 15_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.backendUrl()}${path}`, {
        method,
        headers: this.headers(machine),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = (data && data.error && data.error.message) || `请求失败 (${res.status})`;
        const err = new Error(message);
        err.status = res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  machineMetadata() {
    return {
      homeDir: os.homedir(),
      arch: os.arch(),
      release: os.release(),
      workspaceDir: this.opts.workspaceDir,
      agentRuntime: 'deskagent-core',
    };
  }

  async start() {
    if (this.running || !this.isLoggedIn()) return;
    this.running = true;
    this.emitState();
    try {
      await this.register();
      await this.refreshPairing();
      this.startHeartbeat();
      this.pollLoop();
      this.emitState();
    } catch (e) {
      this.running = false;
      this.machineToken = '';
      this.lastError = (e && e.message) || String(e);
      this.emitState();
      throw e;
    }
  }

  async stop() {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.emitState();
  }

  async restart() {
    await this.stop();
    if (this.isLoggedIn()) await this.start();
  }

  async register() {
    const res = await this.request('/api/remote/machines', {
      method: 'POST',
      body: {
        machine_id: this.machineId,
        label: os.hostname() || '我的电脑',
        hostname: os.hostname() || 'localhost',
        platform: process.platform,
        app_version: this.opts.appVersion || '0.1.0',
        metadata: this.machineMetadata(),
      },
    });
    this.machineId = res.machine_id || this.machineId;
    this.machineToken = res.machine_token || '';
    this.lastError = '';
    this.emitState();
  }

  async refreshPairing() {
    if (!this.machineId || !this.isLoggedIn()) return this.info();
    const res = await this.request(`/api/remote/machines/${encodeURIComponent(this.machineId)}/pairing`, {
      method: 'POST',
      body: {},
    });
    const publicBackendUrl = this.publicBackendUrl();
    this.pairing = {
      code: res.code,
      expiresAt: res.expires_at,
      payload: {
        ...(res.payload || {}),
        server_url: publicBackendUrl || (res.payload && res.payload.server_url) || this.backendUrl(),
        ...(publicBackendUrl ? { web_url: remoteWebUrl(publicBackendUrl, res.code) } : {}),
      },
    };
    if (this.pairing.payload) {
      this.pairing.qrText = this.pairing.payload.web_url || JSON.stringify(this.pairing.payload);
      this.pairing.rawPayloadText = JSON.stringify(this.pairing.payload);
      this.pairing.qrDataUrl = await QRCode.toDataURL(this.pairing.qrText, {
        margin: 1,
        width: 220,
        errorCorrectionLevel: 'M',
      });
    }
    this.lastError = '';
    this.emitState();
    return this.info();
  }

  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const beat = async () => {
      if (!this.running || !this.machineToken) return;
      try {
        await this.request('/api/remote/machine/heartbeat', {
          method: 'POST',
          machine: true,
          body: { status: 'active', metadata: this.machineMetadata() },
          timeoutMs: 8_000,
        });
        this.lastError = '';
      } catch (e) {
        if (!isAbortError(e)) this.lastError = e.message || String(e);
      }
      this.emitState();
    };
    this.heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
    beat();
  }

  async pollLoop() {
    if (this.polling) return;
    this.polling = true;
    while (this.running) {
      try {
        if (this.machineToken) await this.pollOnce();
        this.lastError = '';
      } catch (e) {
        if (!isAbortError(e)) this.lastError = e.message || String(e);
      }
      this.emitState();
      await sleep(POLL_MS);
    }
    this.polling = false;
  }

  async pollOnce() {
    const res = await this.request('/api/remote/machine/commands', {
      machine: true,
      timeoutMs: 20_000,
    });
    for (const command of res.commands || []) {
      this.handleCommand(command).catch((e) => {
        this.reportResult(command.id, false, {}, e.message || String(e)).catch(() => {});
      });
    }
  }

  async handleCommand(command) {
    if (!command || !command.id || this.inFlight.has(command.id)) return;
    this.inFlight.add(command.id);
    try {
      if (command.command_type !== 'chat_message') {
        throw new Error(`不支持的远程命令：${command.command_type}`);
      }
      const engine = this.engine();
      if (!engine) throw new Error('本地 agent 引擎未初始化');
      const payload = command.payload || {};
      const text = String(payload.text || payload.prompt || '').trim();
      if (!text) throw new Error('远程消息为空');
      let threadId = payload.thread_id || payload.threadId || null;
      if (!threadId) {
        const created = await engine.startNewThread();
        threadId = created.threadId;
      }
      const result = await engine.send(text, [], threadId);
      await this.reportResult(command.id, true, {
        thread_id: result.threadId || threadId,
        accepted_at: new Date().toISOString(),
      });
    } finally {
      this.inFlight.delete(command.id);
    }
  }

  async reportResult(commandId, ok, result = {}, error = '') {
    await this.request(`/api/remote/machine/commands/${encodeURIComponent(commandId)}/result`, {
      method: 'POST',
      machine: true,
      body: { ok, result, error },
      timeoutMs: 10_000,
    });
  }

  info() {
    const backendLocalReason = localBackendReason(this.backendUrl());
    const hasPublicBackend = !!this.publicBackendUrl();
    return {
      enabled: this.running,
      loggedIn: this.isLoggedIn(),
      backendUrl: this.backendUrl(),
      publicBackendUrl: this.publicBackendUrl(),
      backendIsLocal: !!backendLocalReason,
      remoteLinkIsLocal: !!backendLocalReason && !hasPublicBackend,
      remoteLinkLocalReason: backendLocalReason && !hasPublicBackend
        ? `${backendLocalReason}；请配置 DESKAGENT_PUBLIC_BACKEND_URL 为公网地址`
        : '',
      machineId: this.machineId,
      hasMachineToken: !!this.machineToken,
      pairing: this.pairing,
      lastError: this.lastError,
      inFlight: this.inFlight.size,
    };
  }

  emitState() {
    this.emit('state', this.info());
  }
}

module.exports = { RemoteHost };
