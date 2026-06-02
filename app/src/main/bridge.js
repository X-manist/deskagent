'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { Notification, dialog, shell, systemPreferences } = require('electron');
const { Engine } = require('./engine');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function spawnDetached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function spawnJsonAsync(command, args, body, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    const maxBuffer = options.maxBuffer || 8 * 1024 * 1024;
    const timeoutMs = options.timeoutMs || 30000;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const error = new Error(`native OS tool timed out after ${timeoutMs}ms`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    }, timeoutMs);
    const append = (target, chunk) => {
      const next = target + chunk.toString();
      if (next.length > maxBuffer) {
        child.kill('SIGKILL');
        throw new Error('native OS tool output exceeded buffer limit');
      }
      return next;
    };
    child.stdout.on('data', (chunk) => {
      try { stdout = append(stdout, chunk); } catch (error) { reject(error); }
    });
    child.stderr.on('data', (chunk) => {
      try { stderr = append(stderr, chunk); } catch (error) { reject(error); }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(stderr.trim() || `native OS tool exited with ${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      error.code = code;
      reject(error);
    });
    child.stdin.end(body || '');
  });
}

function hasCommand(command) {
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32' ? [command] : ['-lc', `command -v ${command}`]);
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function boolValue(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !/^(false|0|no)$/i.test(String(value));
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function clipText(text, max = 180) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function osToolsExeName() {
  return process.platform === 'win32' ? 'deskagent-os-tools.exe' : 'deskagent-os-tools';
}

function parseEmailList(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value).split(/[;,]/).map((x) => x.trim()).filter(Boolean);
}

class LocalBridge {
  constructor(opts) {
    this.opts = {
      ...opts,
      workspaceDir: opts.workspaceDir || path.join(opts.baseDir, 'workspace'),
    };
    this.server = null;
    this.port = null;
    this.token = crypto.randomBytes(24).toString('hex');
    this.tasksFile = path.join(opts.baseDir, 'schedules.json');
    this.tasks = new Map();
    this.jobs = new Map();
    this.running = new Set();
    this.osToolsCommand = null;
  }

  async start() {
    this.port = await freePort();
    this.server = http.createServer((req, res) => this._handle(req, res));
    await new Promise((resolve) => this.server.listen(this.port, '127.0.0.1', resolve));
    this._loadTasks();
  }

  async stop() {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
    await new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve()));
  }

  info() {
    return {
      url: `http://127.0.0.1:${this.port}`,
      token: this.token,
      command: this.opts.mcpCommand,
      scriptPath: this.opts.mcpScriptPath,
      env: this.opts.mcpEnv || {},
    };
  }

  _auth(req) {
    const header = req.headers.authorization || '';
    return header === `Bearer ${this.token}`;
  }

  async _readBody(req) {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    return raw ? JSON.parse(raw) : {};
  }

  async _handle(req, res) {
    if (!this._auth(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (req.method === 'POST' && url.pathname === '/notify') return json(res, 200, await this.notify(await this._readBody(req)));
      if (req.method === 'POST' && url.pathname === '/open-url') return json(res, 200, await this.openUrl(await this._readBody(req)));
      if (req.method === 'POST' && url.pathname === '/open-app') return json(res, 200, await this.openApp(await this._readBody(req)));
      if (req.method === 'POST' && url.pathname === '/desktop/action') return json(res, 200, await this.desktopAction(await this._readBody(req)));
      if (req.method === 'POST' && url.pathname === '/desktop/screenshot') return json(res, 200, await this.takeScreenshot(await this._readBody(req)));
      if (req.method === 'POST' && url.pathname === '/email/send') return json(res, 200, await this.sendEmail(await this._readBody(req)));
      if (req.method === 'POST' && url.pathname === '/email/read') return json(res, 200, await this.readEmail(await this._readBody(req)));
      if (req.method === 'POST' && url.pathname === '/wechat/send') return json(res, 200, await this.sendWeChat(await this._readBody(req)));
      if (req.method === 'POST' && url.pathname === '/wechat/read') return json(res, 200, await this.readWeChat(await this._readBody(req)));
      if (req.method === 'GET' && url.pathname === '/schedule') return json(res, 200, { tasks: Array.from(this.tasks.values()) });
      if (req.method === 'POST' && url.pathname === '/schedule') return json(res, 200, await this.createTask(await this._readBody(req)));
      if (req.method === 'DELETE' && url.pathname.startsWith('/schedule/')) return json(res, 200, await this.deleteTask(url.pathname.split('/').pop()));
      return json(res, 404, { error: 'not-found' });
    } catch (error) {
      return json(res, 500, { error: error.message || String(error) });
    }
  }

  async notify({ title, body }) {
    if (Notification.isSupported()) new Notification({ title, body: body || '' }).show();
    return { ok: true };
  }

  async openUrl({ url }) {
    if (!url) throw new Error('缺少 url');
    await shell.openExternal(url);
    return { ok: true, url };
  }

  async openApp({ name }) {
    if (!name) throw new Error('缺少应用名称');
    const native = await this._runOsTool('open-app', { app: name, name });
    if (native) return { ...native, ok: true, name };
    if (process.platform === 'darwin') spawnDetached('open', ['-a', name]);
    else if (process.platform === 'win32') spawnDetached('cmd', ['/c', 'start', '', name]);
    else spawnDetached('xdg-open', [name]);
    return { ok: true, name };
  }

  _resolveOsToolsCommand() {
    if (this.osToolsCommand !== null) return this.osToolsCommand;
    const exe = osToolsExeName();
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const candidates = [
      this.opts.osToolsCommand,
      process.env.DESKAGENT_OS_TOOLS_BIN,
      process.resourcesPath ? path.join(process.resourcesPath, 'bin', exe) : '',
      path.join(repoRoot, 'native', 'os-tools', 'target', 'release', exe),
      path.join(repoRoot, 'native', 'os-tools', 'target', 'debug', exe),
      path.join(repoRoot, 'app', 'resources', 'bin', exe),
    ].filter(Boolean);
    this.osToolsCommand = candidates.find((candidate) => {
      try {
        return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
      } catch (_) {
        return false;
      }
    }) || '';
    return this.osToolsCommand;
  }

  async _runOsTool(command, payload = {}, options = {}) {
    const osToolsCommand = this._resolveOsToolsCommand();
    if (!osToolsCommand) return null;
    const request = {
      ...payload,
      workspaceRoot: this.opts.workspaceDir,
    };
    try {
      const { stdout } = await spawnJsonAsync(osToolsCommand, [command], JSON.stringify(request));
      const text = stdout.trim();
      if (!text) return { ok: true, backend: 'rust-os-tools', command };
      return JSON.parse(text);
    } catch (error) {
      const detail = (error.stderr || error.stdout || error.message || '').trim();
      if (options.screenCapture) {
        const message = await this._showScreenCapturePrompt(detail);
        throw new Error(message);
      }
      if (options.permissionFeature && /not allowed|assistive|accessibility|permission|denied|not authorized|1002/i.test(detail)) {
        const message = await this._showPermissionPrompt(options.permissionFeature, detail);
        throw new Error(message);
      }
      throw new Error(detail || error.message || 'native OS tool failed');
    }
  }

  _actionNeedsDesktopPermission(action) {
    return [
      'activate-app',
      'type-text',
      'shortcut',
      'click',
      'double-click',
      'move-mouse',
      'scroll',
    ].includes(action);
  }

  _permissionMessage(feature) {
    if (process.platform === 'darwin') {
      return [
        `${feature || '这个操作'}需要系统授权后才能继续。`,
        '请打开：系统设置 -> 隐私与安全性 -> 辅助功能，允许“智界桌面助手”控制电脑。',
        '如果当前是开发模式启动，请同时允许 Terminal 或 Electron。授权后回到这里重试即可。',
      ].join('\n');
    }
    if (process.platform === 'win32') {
      return `${feature || '这个操作'}需要 Windows 允许应用控制当前桌面窗口；请确认没有被安全软件拦截，然后重试。`;
    }
    return `${feature || '这个操作'}需要桌面自动化依赖与窗口系统权限；Linux 请确认已安装 xdotool，并处于可控制的 X11 会话。`;
  }

  async _showPermissionPrompt(feature, detail) {
    const message = this._permissionMessage(feature);
    if (dialog && dialog.showMessageBox) {
      const buttons = process.platform === 'darwin' ? ['打开系统设置', '知道了'] : ['知道了'];
      const result = await dialog.showMessageBox({
        type: 'warning',
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        title: '需要系统权限',
        message: '需要开启电脑控制权限',
        detail: detail ? `${message}\n\n错误信息：${clipText(detail, 260)}` : message,
        noLink: true,
      });
      if (process.platform === 'darwin' && result.response === 0) {
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
      }
    }
    return message;
  }

  async _showScreenCapturePrompt(detail) {
    const message = process.platform === 'darwin'
      ? [
          '截图需要系统授权后才能继续。',
          '请打开：系统设置 -> 隐私与安全性 -> 屏幕与系统音频录制，允许“智界桌面助手”。',
          '如果当前是开发模式启动，请同时允许 Terminal 或 Electron。授权后回到这里重试即可。',
        ].join('\n')
      : '截图需要当前桌面会话允许读取屏幕；请确认系统授权和显示器会话正常后重试。';
    if (dialog && dialog.showMessageBox) {
      const buttons = process.platform === 'darwin' ? ['打开系统设置', '知道了'] : ['知道了'];
      const result = await dialog.showMessageBox({
        type: 'warning',
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        title: '需要系统权限',
        message: '需要开启截图权限',
        detail: detail ? `${message}\n\n错误信息：${clipText(detail, 260)}` : message,
        noLink: true,
      });
      if (process.platform === 'darwin' && result.response === 0) {
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      }
    }
    return message;
  }

  _macAccessibilityTrusted() {
    if (process.platform !== 'darwin') return true;
    try {
      return systemPreferences.isTrustedAccessibilityClient(false);
    } catch (_) {
      return false;
    }
  }

  async _ensureDesktopPermission(feature) {
    if (process.platform !== 'darwin') return;
    if (this._macAccessibilityTrusted()) return;
    const prompt = boolValue(process.env.DESKAGENT_PROMPT_ACCESSIBILITY, true);
    if (prompt) {
      try {
        systemPreferences.isTrustedAccessibilityClient(true);
      } catch (_) {}
    }
    const message = await this._showPermissionPrompt(feature);
    throw new Error(message);
  }

  // Post native mouse events on macOS via JXA (osascript -l JavaScript) and the
  // CoreGraphics ObjC bridge. This needs zero extra dependencies (no pyobjc),
  // unlike the previous `python3 + Quartz` path which crashed ("Python quit
  // unexpectedly") on stock macs where the Quartz module is unavailable.
  // repeat=0 → move only; repeat>=1 → move then click that many times.
  async _macMouse({ x, y, button = 'left', repeat = 1 }) {
    const px = Number(x) || 0;
    const py = Number(y) || 0;
    // CGEvent type codes: mouseMoved=5; left down/up=1/2; right=3/4; other=25/26.
    const map = {
      left: { btn: 0, down: 1, up: 2 },
      right: { btn: 1, down: 3, up: 4 },
      middle: { btn: 2, down: 25, up: 26 },
    };
    const b = map[button] || map[button === 2 || button === 'right' ? 'right' : button === 3 || button === 'middle' ? 'middle' : 'left'] || map.left;
    const n = Math.max(0, Math.min(Number(repeat) || 0, 3));
    const script = [
      "ObjC.import('CoreGraphics');",
      `var pt = $.CGPointMake(${px}, ${py});`,
      `$.CGEventPost(0, $.CGEventCreateMouseEvent($(), 5, pt, ${b.btn}));`,
      ...(n > 0
        ? [
            'delay(0.05);',
            `for (var i = 0; i < ${n}; i++) {`,
            `  $.CGEventPost(0, $.CGEventCreateMouseEvent($(), ${b.down}, pt, ${b.btn}));`,
            `  $.CGEventPost(0, $.CGEventCreateMouseEvent($(), ${b.up}, pt, ${b.btn}));`,
            '  delay(0.08);',
            '}',
          ]
        : []),
      "'OK';",
    ].join('\n');
    return this._jxa(script);
  }

  async _jxa(source) {
    try {
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', source]);
      return stdout.trim();
    } catch (error) {
      const stderr = (error.stderr || error.message || '').trim();
      if (/not allowed|assistive|accessibility|1002|osascript is not allowed/i.test(stderr)) {
        const message = await this._showPermissionPrompt('电脑控制', stderr);
        throw new Error(message);
      }
      throw new Error(stderr || 'osascript(JavaScript) 执行失败');
    }
  }

  async _osascript(lines) {
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', lines.join('\n')]);
      return stdout.trim();
    } catch (error) {
      const stderr = (error.stderr || error.message || '').trim();
      if (/not allowed assistive access|assistive access|not allowed to send keystrokes|System Events got an error/i.test(stderr)) {
        const message = await this._showPermissionPrompt('电脑控制', stderr);
        throw new Error(message);
      }
      throw new Error(stderr || 'osascript 执行失败');
    }
  }

  async _powershell(script) {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-STA', '-Command', script]);
    return stdout.trim();
  }

  async _xdotool(args) {
    if (!(await hasCommand('xdotool'))) {
      const message = await this._showPermissionPrompt('电脑控制', 'Linux 缺少 xdotool');
      throw new Error(message);
    }
    const { stdout } = await execFileAsync('xdotool', args);
    return stdout.trim();
  }

  _sendKeysWindows(shortcut) {
    const send = shortcut
      .split('+')
      .map((x) => x.trim().toLowerCase())
      .map((key) => {
        if (key === 'ctrl' || key === 'control') return '^';
        if (key === 'alt') return '%';
        if (key === 'shift') return '+';
        if (key === 'meta' || key === 'win' || key === 'command') return '#';
        if (key === 'enter') return '{ENTER}';
        return key;
      })
      .join('');
    return this._powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${send.replace(/'/g, "''")}')`);
  }

  _mouseButtonDarwin(button) {
    if (button === 'right' || button === 2) return '2';
    if (button === 'middle' || button === 3) return '3';
    return '1';
  }

  _mouseButtonLinux(button) {
    if (button === 'right' || button === 3) return '3';
    if (button === 'middle' || button === 2) return '2';
    return '1';
  }

  _mouseButtonWindows(button) {
    if (button === 'right' || button === 3) return { down: 0x0008, up: 0x0010 };
    if (button === 'middle' || button === 2) return { down: 0x0020, up: 0x0040 };
    return { down: 0x0002, up: 0x0004 };
  }

  async _windowsMouseClick(x, y, button, doubleClick = false) {
    const b = this._mouseButtonWindows(button);
    const repeat = doubleClick ? 2 : 1;
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$sig = "[DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);"',
      'Add-Type -MemberDefinition $sig -Name U32 -Namespace Win32',
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Number(x) || 0}, ${Number(y) || 0})`,
      ...Array.from({ length: repeat }).flatMap(() => [
        `[Win32.U32]::mouse_event(${b.down}, 0, 0, 0, [UIntPtr]::Zero)`,
        `[Win32.U32]::mouse_event(${b.up}, 0, 0, 0, [UIntPtr]::Zero)`,
      ]),
    ].join('; ');
    await this._powershell(script);
  }

  _dryRunFallback(action, details = {}) {
    return {
      ok: true,
      backend: 'node-fallback',
      platform: process.platform,
      action,
      message: 'dry-run: no OS side effect executed',
      details,
    };
  }

  async desktopAction({ action, app, text, shortcut, x, y, button = 'left', amount = 5, dryRun = false }) {
    if (!action) throw new Error('缺少 action');
    if (action === 'probe') {
      const native = await this._runOsTool('probe', { dryRun: true });
      return native || { ok: true, backend: 'node-fallback', platform: process.platform, action: 'probe' };
    }
    if (action === 'open-app' && !dryRun) return this.openApp({ name: app });
    if (action === 'open-url' && !dryRun) return this.openUrl({ url: text });
    if (action === 'screenshot') return this.takeScreenshot({ dryRun });

    if (!dryRun && this._actionNeedsDesktopPermission(action)) {
      await this._ensureDesktopPermission('电脑控制');
    }
    const native = await this._runOsTool('action', { action, app, text, shortcut, x, y, button, amount, dryRun }, {
      permissionFeature: this._actionNeedsDesktopPermission(action) ? '电脑控制' : '',
    });
    if (native) return native;
    if (dryRun) {
      return this._dryRunFallback(action, {
        app,
        textChars: text ? String(text).length : 0,
        shortcut,
        x: Number(x) || 0,
        y: Number(y) || 0,
        button,
        amount: Number(amount) || 0,
      });
    }

    if (process.platform === 'darwin') {
      if (action === 'activate-app') {
        await this._osascript([`tell application "${app}" to activate`]);
        return { ok: true, action, app };
      }
      if (action === 'type-text') {
        await this._osascript([
          'set oldClip to the clipboard',
          `set the clipboard to ${JSON.stringify(text || '')}`,
          'tell application "System Events" to keystroke "v" using command down',
          'delay 0.1',
          'set the clipboard to oldClip',
        ]);
        return { ok: true, action };
      }
      if (action === 'shortcut') {
        const parts = String(shortcut || '').split('+').map((x) => x.trim().toLowerCase());
        const key = parts.pop();
        const mods = [];
        if (parts.includes('command') || parts.includes('cmd') || parts.includes('meta')) mods.push('command down');
        if (parts.includes('shift')) mods.push('shift down');
        if (parts.includes('option') || parts.includes('alt')) mods.push('option down');
        if (parts.includes('control') || parts.includes('ctrl')) mods.push('control down');
        const keyExpr = key === 'enter' ? 'return' : key;
        await this._osascript([
          `tell application "System Events" to keystroke ${JSON.stringify(keyExpr)}${mods.length ? ` using {${mods.join(', ')}}` : ''}`,
        ]);
        return { ok: true, action, shortcut };
      }
      if (action === 'click' || action === 'double-click') {
        await this._macMouse({ x, y, button, repeat: action === 'double-click' ? 2 : 1 });
        return { ok: true, action, x: Number(x) || 0, y: Number(y) || 0, button };
      }
      if (action === 'move-mouse') {
        await this._macMouse({ x, y, button, repeat: 0 });
        return { ok: true, action, x: Number(x) || 0, y: Number(y) || 0 };
      }
      if (action === 'scroll') {
        const direction = Number(amount) < 0 ? 'down' : 'up';
        const count = Math.max(1, Math.min(Math.abs(Number(amount) || 1), 30));
        await this._osascript([
          'tell application "System Events"',
          `  scroll ${direction} ${count}`,
          'end tell',
        ]);
        return { ok: true, action, amount: Number(amount) || 0 };
      }
    }

    if (process.platform === 'win32') {
      if (action === 'activate-app') {
        await this._powershell(`Start-Process ${JSON.stringify(app || '')}`);
        return { ok: true, action, app };
      }
      if (action === 'type-text') {
        await this._powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(String(text || ''))})`);
        return { ok: true, action };
      }
      if (action === 'shortcut') {
        await this._sendKeysWindows(shortcut || '');
        return { ok: true, action, shortcut };
      }
      if (action === 'click' || action === 'double-click') {
        await this._windowsMouseClick(x, y, button, action === 'double-click');
        return { ok: true, action, x: Number(x) || 0, y: Number(y) || 0, button };
      }
      if (action === 'move-mouse') {
        await this._powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Number(x) || 0}, ${Number(y) || 0})`);
        return { ok: true, action, x: Number(x) || 0, y: Number(y) || 0 };
      }
      if (action === 'scroll') {
        await this._powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${Number(amount) < 0 ? '{PGDN}' : '{PGUP}'}')`);
        return { ok: true, action, amount: Number(amount) || 0 };
      }
    }

    if (process.platform === 'linux') {
      if (action === 'activate-app') {
        spawnDetached(app, []);
        return { ok: true, action, app };
      }
      if (action === 'type-text') {
        await this._xdotool(['type', '--delay', '1', text || '']);
        return { ok: true, action };
      }
      if (action === 'shortcut') {
        await this._xdotool(['key', shortcut || '']);
        return { ok: true, action, shortcut };
      }
      if (action === 'click' || action === 'double-click') {
        await this._xdotool(['mousemove', String(Number(x) || 0), String(Number(y) || 0)]);
        const args = ['click'];
        if (action === 'double-click') args.push('--repeat', '2');
        args.push(this._mouseButtonLinux(button));
        await this._xdotool(args);
        return { ok: true, action, x: Number(x) || 0, y: Number(y) || 0, button };
      }
      if (action === 'move-mouse') {
        await this._xdotool(['mousemove', String(Number(x) || 0), String(Number(y) || 0)]);
        return { ok: true, action, x: Number(x) || 0, y: Number(y) || 0 };
      }
      if (action === 'scroll') {
        const click = Number(amount) < 0 ? '5' : '4';
        const count = Math.max(1, Math.min(Math.abs(Number(amount) || 1), 30));
        await this._xdotool(['click', '--repeat', String(count), click]);
        return { ok: true, action, amount: Number(amount) || 0 };
      }
    }

    throw new Error(`当前平台暂不支持动作: ${action}`);
  }

  async takeScreenshot({ outputPath, dryRun = false } = {}) {
    const shotsDir = path.join(this.opts.workspaceDir, 'screenshots');
    fs.mkdirSync(shotsDir, { recursive: true });
    const workspaceRoot = path.resolve(this.opts.workspaceDir);
    const file = outputPath
      ? path.resolve(workspaceRoot, outputPath)
      : path.join(shotsDir, `screen-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    if (file !== workspaceRoot && !file.startsWith(workspaceRoot + path.sep)) {
      throw new Error('截图只能保存到工作目录内');
    }
    const native = await this._runOsTool('screenshot', { outputPath: file, dryRun }, { screenCapture: true });
    if (native) return { ...native, ok: true, path: native.path || file };
    if (dryRun) return this._dryRunFallback('screenshot', { path: file });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (process.platform === 'darwin') {
      try {
        await execFileAsync('screencapture', ['-x', file]);
      } catch (error) {
        const detail = (error.stderr || error.message || '').trim();
        const message = await this._showScreenCapturePrompt(detail);
        throw new Error(message);
      }
      return { ok: true, path: file };
    }
    if (process.platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
        '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
        '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
        '$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
        `$bitmap.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
        '$graphics.Dispose()',
        '$bitmap.Dispose()',
      ].join('; ');
      await this._powershell(script);
      return { ok: true, path: file };
    }
    if (process.platform === 'linux') {
      if (await hasCommand('gnome-screenshot')) {
        await execFileAsync('gnome-screenshot', ['-f', file]);
        return { ok: true, path: file };
      }
      if (await hasCommand('import')) {
        await execFileAsync('import', ['-window', 'root', file]);
        return { ok: true, path: file };
      }
      throw new Error('当前 Linux 环境缺少截图工具，请安装 gnome-screenshot 或 ImageMagick。');
    }
    throw new Error('当前平台暂不支持截图');
  }

  _mailConfig(prefix) {
    return {
      host: process.env[`${prefix}_HOST`] || '',
      port: Number(process.env[`${prefix}_PORT`] || (prefix === 'SMTP' ? 465 : 993)),
      secure: boolValue(process.env[`${prefix}_SECURE`], true),
      user: process.env[`${prefix}_USER`] || '',
      pass: process.env[`${prefix}_PASS`] || '',
      from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
    };
  }

  async sendEmail({ to, subject, text, html, cc, bcc }) {
    const cfg = this._mailConfig('SMTP');
    if (!cfg.host || !cfg.user || !cfg.pass) {
      throw new Error('未配置 SMTP_HOST / SMTP_USER / SMTP_PASS，请在 .env 中设置后重启应用。');
    }
    const recipients = parseEmailList(to);
    if (!recipients || !recipients.length) throw new Error('缺少邮件收件人');
    if (!text && !html) throw new Error('缺少邮件正文');
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
    });
    const info = await transport.sendMail({
      from: cfg.from,
      to: recipients,
      cc: parseEmailList(cc),
      bcc: parseEmailList(bcc),
      subject: subject || '(无主题)',
      text,
      html,
    });
    return { ok: true, messageId: info.messageId };
  }

  async readEmail({ folder = 'INBOX', limit = 10, unseenOnly = false, query, includeBody = false }) {
    const cfg = this._mailConfig('IMAP');
    if (!cfg.host || !cfg.user || !cfg.pass) {
      throw new Error('未配置 IMAP_HOST / IMAP_USER / IMAP_PASS，请在 .env 中设置后重启应用。');
    }
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
    });
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      const rows = [];
      let search = {};
      if (unseenOnly) search.seen = false;
      if (query) {
        const q = String(query);
        const querySearch = { or: [{ subject: q }, { body: q }, { from: q }] };
        search = unseenOnly ? { and: [{ seen: false }, querySearch] } : querySearch;
      }
      const ids = await client.search(search, { uid: true });
      const wanted = Array.isArray(ids) ? ids.slice(-safeLimit) : [];
      if (!wanted.length) return { ok: true, messages: [] };
      const fetchQuery = { uid: true, envelope: true, flags: true, internalDate: true };
      if (includeBody) fetchQuery.source = { start: 0, maxLength: 6000 };
      for await (const msg of client.fetch(wanted, fetchQuery, { uid: true })) {
        const row = {
          uid: msg.uid,
          subject: msg.envelope && msg.envelope.subject,
          from: ((msg.envelope && msg.envelope.from) || []).map((x) => x.address).join(', '),
          to: ((msg.envelope && msg.envelope.to) || []).map((x) => x.address).join(', '),
          date: (msg.envelope && msg.envelope.date) || msg.internalDate,
          seen: msg.flags instanceof Set ? msg.flags.has('\\Seen') : Array.isArray(msg.flags) ? msg.flags.includes('\\Seen') : false,
        };
        if (includeBody && msg.source) row.preview = clipText(msg.source.toString('utf8').replace(/\s+/g, ' '), 1200);
        rows.push(row);
      }
      return { ok: true, messages: rows.sort((a, b) => (b.uid || 0) - (a.uid || 0)) };
    } finally {
      lock.release();
      await client.logout();
    }
  }

  async sendWeChat(payload) {
    const base = process.env.WECHAT_BRIDGE_URL || '';
    if (base) return this._callWechatBridge('/send', payload || {});
    if (process.platform !== 'darwin') {
      throw new Error('当前未配置 WECHAT_BRIDGE_URL，且仅 macOS 提供本地微信自动发送兜底。Windows/Linux 请配置自有微信 bridge。');
    }
    const to = payload && payload.to;
    const text = payload && payload.text;
    if (!to || !text) throw new Error('微信发送缺少 to / text');
    await this._ensureDesktopPermission('微信发送');
    await this._osascript([
      'tell application "WeChat" to activate',
      'delay 0.6',
      'tell application "System Events"',
      '  keystroke "f" using command down',
      '  delay 0.2',
      `  keystroke ${JSON.stringify(String(to))}`,
      '  delay 0.4',
      '  key code 36',
      'end tell',
      'delay 0.6',
      'set oldClip to the clipboard',
      `set the clipboard to ${JSON.stringify(String(text))}`,
      'tell application "System Events" to keystroke "v" using command down',
      'delay 0.2',
      'tell application "System Events" to key code 36',
      'delay 0.2',
      'set the clipboard to oldClip',
    ]);
    return {
      ok: true,
      mode: 'macos-ui-automation',
      message: '已尝试通过 macOS 本地 UI 自动化发送微信。如未成功，请先确认 WeChat 已登录，并授予辅助功能权限。',
    };
  }

  async readWeChat(payload) {
    const base = process.env.WECHAT_BRIDGE_URL || '';
    if (base) return this._callWechatBridge('/messages', payload || {});
    if (process.platform !== 'darwin') {
      throw new Error('当前未配置 WECHAT_BRIDGE_URL，且仅 macOS 提供本地微信读取兜底。Windows/Linux 请配置自有微信 bridge。');
    }
    await this._ensureDesktopPermission('微信读取');
    const to = payload && payload.to;
    const content = await this._osascript([
      `display dialog "将从当前 WeChat 窗口复制可见消息。\\n${to ? `目标联系人：${to}\\n` : ''}请确保 WeChat 已登录、对话已打开，并已授予辅助功能权限。" buttons {"继续"} default button "继续"`,
      'tell application "WeChat" to activate',
      'delay 0.5',
      ...(to
        ? [
            'tell application "System Events"',
            '  keystroke "f" using command down',
            '  delay 0.2',
            `  keystroke ${JSON.stringify(String(to))}`,
            '  delay 0.4',
            '  key code 36',
            'end tell',
            'delay 0.6',
          ]
        : []),
      'set oldClip to the clipboard',
      'tell application "System Events"',
      '  keystroke "a" using command down',
      '  delay 0.2',
      '  keystroke "c" using command down',
      'end tell',
      'delay 0.5',
      'set copiedText to the clipboard',
      'set the clipboard to oldClip',
      'return copiedText',
    ]);
    return {
      ok: true,
      mode: 'macos-ui-automation',
      content,
      message: '已尝试读取当前 WeChat 窗口的可见消息；若结果不完整，请先手动聚焦到目标对话再重试。',
    };
  }

  async _callWechatBridge(pathname, payload) {
    const res = await fetch((process.env.WECHAT_BRIDGE_URL || '').replace(/\/$/, '') + pathname, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: process.env.WECHAT_BRIDGE_TOKEN ? `Bearer ${process.env.WECHAT_BRIDGE_TOKEN}` : '',
      },
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) throw new Error(`微信桥接调用失败: ${res.status}`);
    return await res.json();
  }

  _loadTasks() {
    try {
      const rows = JSON.parse(fs.readFileSync(this.tasksFile, 'utf8'));
      for (const task of rows) {
        if (task.enabled === undefined) task.enabled = true;
        this.tasks.set(task.id, task);
        if (task.enabled) this._schedule(task);
      }
    } catch (_) {}
  }

  _saveTasks() {
    fs.mkdirSync(path.dirname(this.tasksFile), { recursive: true });
    fs.writeFileSync(this.tasksFile, JSON.stringify(Array.from(this.tasks.values()), null, 2));
  }

  _schedule(task) {
    const old = this.jobs.get(task.id);
    if (old) old.stop();
    const job = cron.schedule(task.cron, () => this._runTask(task), {
      timezone: task.timezone || 'Asia/Shanghai',
    });
    this.jobs.set(task.id, job);
  }

  async createTask({ name, cron: expr, prompt, timezone = 'Asia/Shanghai', enabled = true }) {
    if (!name || !expr || !prompt) throw new Error('缺少 name / cron / prompt');
    if (!cron.validate(expr)) throw new Error('cron 表达式不合法');
    const task = {
      id: crypto.randomUUID(),
      name,
      cron: expr,
      prompt,
      timezone,
      enabled: Boolean(enabled),
      createdAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    if (task.enabled) this._schedule(task);
    this._saveTasks();
    return { ok: true, task };
  }

  async deleteTask(id) {
    const job = this.jobs.get(id);
    if (job) job.stop();
    this.jobs.delete(id);
    this.tasks.delete(id);
    this._saveTasks();
    return { ok: true };
  }

  async _runTask(task) {
    if (this.running.has(task.id)) return;
    this.running.add(task.id);
    const bgHome = path.join(this.opts.baseDir, 'background', task.id);
    let summary = '';
    const engine = new Engine({
      agentHome: bgHome,
      workspaceDir: this.opts.workspaceDir,
      settings: this.opts.settings,
      bridgeInfo: () => this.info(),
    });
    engine.on('message', (p) => {
      if (p && p.text) summary = p.text;
    });
    try {
      await engine.start();
      await engine.send(task.prompt);
      await new Promise((resolve, reject) => {
        engine.once('turnDone', resolve);
        engine.once('turnError', (e) => reject(new Error((e && e.message) || '后台任务失败')));
        engine.on('status', (s) => {
          if (s && s.state === 'error') reject(new Error(s.message || '后台任务失败'));
        });
      });
      await this.notify({ title: `定时任务完成：${task.name}`, body: summary || '任务已完成' });
    } catch (error) {
      await this.notify({ title: `定时任务失败：${task.name}`, body: error.message || String(error) });
    } finally {
      await engine.stop();
      this.running.delete(task.id);
    }
  }
}

module.exports = { LocalBridge };
