'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const electronStub = {
  Notification: class {
    static isSupported() { return false; }
    show() {}
  },
  dialog: {
    async showMessageBox() { return { response: 1 }; },
  },
  shell: {
    opened: [],
    async openExternal(url) { this.opened.push(url); return ''; },
  },
  systemPreferences: {
    isTrustedAccessibilityClient() { return true; },
  },
};

const electronPath = require.resolve('electron', { paths: [path.join(__dirname, '..', 'app')] });
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: electronStub,
};

const { LocalBridge } = require('../app/src/main/bridge');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function listen(server) {
  const port = await freePort();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return port;
}

function createWechatBridge() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk.toString(); });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url, auth: req.headers.authorization || '', body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/send') {
        res.end(JSON.stringify({ ok: true, mode: 'fake-wechat-bridge', to: body.to, text: body.text }));
      } else if (req.url === '/messages') {
        res.end(JSON.stringify({ ok: true, messages: [{ from: body.to || '文件传输助手', text: '测试消息' }] }));
      } else {
        res.end(JSON.stringify({ ok: false }));
      }
    });
  });
  return { server, calls };
}

function createSmtpServer() {
  const messages = [];
  const server = net.createServer((socket) => {
    let data = '';
    let inData = false;
    socket.write('220 fake.smtp ESMTP\r\n');
    socket.on('data', (buf) => {
      const text = buf.toString();
      if (inData) {
        data += text;
        if (data.includes('\r\n.\r\n')) {
          messages.push(data.replace(/\r\n\.\r\n[\s\S]*$/, ''));
          inData = false;
          socket.write('250 queued\r\n');
        }
        return;
      }
      for (const line of text.split(/\r\n/).filter(Boolean)) {
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) socket.write('250-fake.smtp\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (cmd.startsWith('MAIL FROM')) socket.write('250 ok\r\n');
        else if (cmd.startsWith('RCPT TO')) socket.write('250 ok\r\n');
        else if (cmd === 'DATA') { inData = true; data = ''; socket.write('354 end with dot\r\n'); }
        else if (cmd === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  return { server, messages };
}

async function bridgeFetch(info, pathname, { method = 'POST', body, expect = 200 } = {}) {
  const res = await fetch(info.url + pathname, {
    method,
    headers: {
      authorization: `Bearer ${info.token}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  assert.strictEqual(res.status, expect, `${method} ${pathname} expected ${expect}, got ${res.status}: ${text}`);
  return data;
}

async function rpc(mcp, method, params) {
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: cryptoRandom(), method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 5000);
    const onData = (buf) => {
      for (const line of buf.toString().split(/\n/).filter(Boolean)) {
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id) {
          clearTimeout(timeout);
          mcp.stdout.off('data', onData);
          resolve(msg);
        }
      }
    };
    mcp.stdout.on('data', onData);
  });
}

function cryptoRandom() {
  return Math.floor(Math.random() * 1e9);
}

(async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskagent-bridge-e2e-'));
  const workspaceDir = path.join(baseDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const wechat = createWechatBridge();
  const smtp = createSmtpServer();
  const wechatPort = await listen(wechat.server);
  const smtpPort = await listen(smtp.server);

  process.env.WECHAT_BRIDGE_URL = `http://127.0.0.1:${wechatPort}`;
  process.env.WECHAT_BRIDGE_TOKEN = 'wechat-token';
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(smtpPort);
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_USER = 'sender@example.test';
  process.env.SMTP_PASS = 'unused';
  process.env.SMTP_FROM = 'sender@example.test';
  delete process.env.IMAP_HOST;
  delete process.env.IMAP_USER;
  delete process.env.IMAP_PASS;

  const bridge = new LocalBridge({
    baseDir,
    workspaceDir,
    settings: () => ({ baseUrl: 'http://127.0.0.1', apiKey: 'test', model: 'test' }),
    mcpCommand: process.execPath,
    mcpScriptPath: path.join(__dirname, '..', 'app', 'src', 'mcp', 'deskagent-mcp.js'),
    mcpEnv: {},
  });
  await bridge.start();
  const info = bridge.info();

  try {
    await bridgeFetch(info, '/notify', { body: { title: '系统测试通知' } });
    await bridgeFetch(info, '/open-url', { body: { url: 'https://example.test/deskagent' } });
    assert.deepStrictEqual(electronStub.shell.opened, ['https://example.test/deskagent']);

    const openViaDesktop = await bridgeFetch(info, '/desktop/action', {
      body: { action: 'open-url', text: 'https://example.test/from-desktop-action' },
    });
    assert.strictEqual(openViaDesktop.ok, true);
    assert.ok(electronStub.shell.opened.includes('https://example.test/from-desktop-action'));

    const desktopProbe = await bridgeFetch(info, '/desktop/action', {
      body: { action: 'probe' },
    });
    assert.strictEqual(desktopProbe.ok, true);
    assert.ok(['rust-os-tools', 'node-fallback'].includes(desktopProbe.backend));

    const desktopDryRun = await bridgeFetch(info, '/desktop/action', {
      body: {
        action: 'type-text',
        text: '帮我在当前窗口输入这句话',
        dryRun: true,
      },
    });
    assert.strictEqual(desktopDryRun.ok, true);
    if (desktopDryRun.backend === 'rust-os-tools') {
      assert.strictEqual(desktopDryRun.command, 'action');
    }

    await bridgeFetch(info, '/desktop/screenshot', {
      body: { outputPath: '../outside.png' },
      expect: 500,
    });

    const email = await bridgeFetch(info, '/email/send', {
      body: {
        to: 'receiver@example.test',
        subject: 'DeskAgent 系统测试邮件',
        text: '这是一封本地 SMTP 捕获的系统测试邮件。',
      },
    });
    assert.strictEqual(email.ok, true);
    assert.ok(email.messageId);
    assert.ok(smtp.messages.join('\n').includes('DeskAgent'));

    const readMail = await bridgeFetch(info, '/email/read', {
      body: { limit: 2 },
      expect: 500,
    });
    assert.ok(readMail.error.includes('未配置 IMAP_HOST'));

    const wxSend = await bridgeFetch(info, '/wechat/send', {
      body: { to: '文件传输助手', text: 'DeskAgent 微信桥接系统测试' },
    });
    assert.strictEqual(wxSend.mode, 'fake-wechat-bridge');
    const wxRead = await bridgeFetch(info, '/wechat/read', {
      body: { to: '文件传输助手', limit: 3 },
    });
    assert.strictEqual(wxRead.ok, true);
    assert.strictEqual(wechat.calls.length, 2);
    assert.strictEqual(wechat.calls[0].auth, 'Bearer wechat-token');

    const task = await bridgeFetch(info, '/schedule', {
      body: {
        name: '系统测试禁用任务',
        cron: '*/5 * * * *',
        prompt: '不要执行，只验证创建和持久化',
        enabled: false,
      },
    });
    assert.strictEqual(task.ok, true);
    const list = await bridgeFetch(info, '/schedule', { method: 'GET' });
    assert.strictEqual(list.tasks.length, 1);
    assert.strictEqual(list.tasks[0].name, '系统测试禁用任务');
    const deleteResult = await bridgeFetch(info, `/schedule/${encodeURIComponent(task.task.id)}`, { method: 'DELETE' });
    assert.strictEqual(deleteResult.ok, true);
    const empty = await bridgeFetch(info, '/schedule', { method: 'GET' });
    assert.strictEqual(empty.tasks.length, 0);

    const { spawn } = require('child_process');
    const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'app', 'src', 'mcp', 'deskagent-mcp.js'), info.url, info.token], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const init = await rpc(mcp, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bridge-tools-e2e', version: '0.1.0' },
      });
      assert.ok(init.result);
      const tools = await rpc(mcp, 'tools/list', {});
      const names = tools.result.tools.map((t) => t.name);
      for (const expected of [
        'deskagent_notify',
        'deskagent_desktop_action',
        'deskagent_take_screenshot',
        'deskagent_send_email',
        'deskagent_read_email',
        'deskagent_send_wechat_message',
        'deskagent_read_wechat_messages',
        'deskagent_create_schedule',
        'deskagent_list_schedules',
        'deskagent_delete_schedule',
      ]) {
        assert.ok(names.includes(expected), `missing MCP tool: ${expected}`);
      }
      const notify = await rpc(mcp, 'tools/call', {
        name: 'deskagent_notify',
        arguments: { title: 'MCP 通知测试' },
      });
      assert.ok(notify.result.content[0].text.includes('"ok": true'));
      const nativeProbe = await rpc(mcp, 'tools/call', {
        name: 'deskagent_desktop_action',
        arguments: { action: 'probe' },
      });
      assert.ok(nativeProbe.result.content[0].text.includes('"ok": true'));
      assert.ok(/rust-os-tools|node-fallback/.test(nativeProbe.result.content[0].text));
    } finally {
      mcp.kill('SIGTERM');
    }

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'bridge_auth_and_notify',
        'open_url_and_desktop_open_url',
        'native_desktop_probe_and_dry_run',
        'screenshot_path_guard',
        'smtp_send_captured_locally',
        'imap_missing_config_error',
        'wechat_bridge_send_and_read',
        'schedule_create_list_delete',
        'mcp_tool_listing_and_call',
      ],
    }, null, 2));
  } finally {
    await bridge.stop();
    wechat.server.close();
    smtp.server.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
