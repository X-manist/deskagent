'use strict';
// Live integration test: uses the configured relay/model from .env, but captures
// mail and WeChat side effects locally. It protects the product-critical task
// boundary where a short follow-up like "给文件传输助手发一句..." must not inherit
// previous mail/read-mail tasks from conversation context.
//
// Usage:
//   node test/live-relay-task-boundary-e2e.js
//
// Set LIVE_BOUNDARY_E2E_ALLOW=1 to enable. This consumes real relay tokens.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

if (process.env.LIVE_BOUNDARY_E2E_ALLOW !== '1') {
  console.log(JSON.stringify({ skipped: true, reason: 'set LIVE_BOUNDARY_E2E_ALLOW=1 to run live relay boundary test' }, null, 2));
  process.exit(0);
}

const { loadEnvFiles, defaultEnvCandidates } = require('../app/src/main/env');
loadEnvFiles(defaultEnvCandidates(path.resolve(__dirname, '..')));

// Stub Electron before requiring bridge modules.
const electronStub = {
  Notification: class { static isSupported() { return false; } show() {} },
  dialog: { async showMessageBox() { return { response: 1 }; } },
  shell: { async openExternal() { return ''; } },
  systemPreferences: { isTrustedAccessibilityClient() { return true; } },
  app: { getPath: () => os.tmpdir(), getName: () => 'deskagent' },
};
const electronPath = require.resolve('electron', { paths: [path.join(__dirname, '..', 'app')] });
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electronStub };

const { LocalBridge } = require('../app/src/main/bridge');
const { Engine, STATE } = require('../app/src/main/engine');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk.toString(); });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/send') {
        res.end(JSON.stringify({ ok: true, mode: 'fake-wechat-bridge', to: body.to, text: body.text }));
      } else if (req.url === '/messages') {
        res.end(JSON.stringify({ ok: true, messages: [] }));
      } else {
        res.end(JSON.stringify({ ok: false }));
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return { server, calls, sockets };
}

function createSmtpServer() {
  const messages = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
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
  return { server, messages, sockets };
}

async function waitTurn(engine, timeoutMs = 90000) {
  return Promise.race([
    new Promise((resolve) => {
      const done = (p) => {
        engine.off('turnError', err);
        resolve({ ok: true, payload: p });
      };
      const err = (p) => {
        engine.off('turnDone', done);
        resolve({ ok: false, payload: p });
      };
      engine.once('turnDone', done);
      engine.once('turnError', err);
    }),
    sleep(timeoutMs).then(() => ({ ok: false, payload: { message: 'timeout' } })),
  ]);
}

async function sendAndCapture(engine, prompt, observed) {
  const start = observed.activities.length;
  await engine.send(prompt);
  const outcome = await waitTurn(engine);
  return {
    prompt,
    outcome,
    activities: observed.activities.slice(start),
    messages: observed.messages.slice(),
  };
}

(async () => {
  const apiKey = process.env.OPENAI_API_KEY || process.env.GLM_API_KEY || '';
  const baseUrl = process.env.OPENAI_BASE_URL || process.env.GLM_BASE_URL || '';
  assert.ok(apiKey && apiKey !== 'replace-with-your-relay-key', 'OPENAI_API_KEY/GLM_API_KEY must be configured');
  assert.ok(baseUrl, 'OPENAI_BASE_URL/GLM_BASE_URL must be configured');

  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskagent-live-boundary-'));
  const agentHome = path.join(baseDir, 'agent');
  const workspaceDir = path.join(baseDir, 'workspace');
  fs.mkdirSync(agentHome, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.cpSync(path.join(__dirname, '..', 'agentconfig'), agentHome, { recursive: true });

  const wechat = createWechatBridge();
  const smtp = createSmtpServer();
  const wechatPort = await listen(wechat.server);
  const smtpPort = await listen(smtp.server);

  process.env.WECHAT_BRIDGE_URL = `http://127.0.0.1:${wechatPort}`;
  process.env.WECHAT_BRIDGE_TOKEN = 'fake-token';
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
    mcpCommand: process.execPath,
    mcpScriptPath: path.join(__dirname, '..', 'app', 'src', 'mcp', 'deskagent-mcp.js'),
    mcpEnv: {},
  });
  await bridge.start();

  process.env.CODEX_BIN = path.join(__dirname, '..', 'app', 'resources', 'bin', 'deskagent-core');
  process.env.RUST_LOG = 'error';

  const settings = {
    model: process.env.ADAPTER_MODEL || process.env.OPENAI_MODEL || process.env.GLM_MODEL || 'test-relay-model',
    apiKey,
    baseUrl,
    relayMode: process.env.RELAY_MODE || (process.env.OPENAI_BASE_URL ? 'openai' : 'glm'),
    mcpProfile: 'core',
  };
  const engine = new Engine({
    agentHome,
    workspaceDir,
    settings: () => settings,
    bridgeInfo: () => bridge.info(),
  });

  const observed = { activities: [], messages: [], logs: [] };
  engine.on('activity', (a) => observed.activities.push(a));
  engine.on('message', (m) => observed.messages.push(m));
  engine.on('log', (src, line) => observed.logs.push(`[${src}] ${line}`));

  try {
    await engine.start();
    assert.strictEqual(engine.state, STATE.READY, 'engine should be ready');

    const r1 = await sendAndCapture(engine, '帮我给 receiver@example.test 发封测试邮件，就说我在试桌面助手。', observed);
    const r2 = await sendAndCapture(engine, '看看我邮箱里有没有关于测试的邮件。', observed);
    const beforeFinal = observed.activities.length;
    const smtpBeforeFinal = smtp.messages.length;
    const wxBeforeFinal = wechat.calls.length;
    const r3 = await sendAndCapture(engine, '给文件传输助手发一句：桌面助手微信测试。只处理这一件事，不要处理前面的邮件或查邮。', observed);

    const finalActivities = observed.activities.slice(beforeFinal);
    const finalToolTexts = finalActivities.map((a) => a.text || '');
    const finalEmailTools = finalToolTexts.filter((t) => /send_email|read_email/.test(t));
    const finalWechatTools = finalToolTexts.filter((t) => /wechat/.test(t));

    assert.strictEqual(finalEmailTools.length, 0, `final turn must not call email tools: ${finalEmailTools.join(', ')}`);
    assert.ok(finalWechatTools.length > 0, `final turn should call WeChat tool; saw: ${finalToolTexts.join(', ')}`);
    assert.strictEqual(smtp.messages.length, smtpBeforeFinal, 'final turn must not send another email');
    assert.strictEqual(wechat.calls.length, wxBeforeFinal + 1, 'final turn should make exactly one WeChat bridge call');
    assert.deepStrictEqual(wechat.calls[wechat.calls.length - 1].body, {
      to: '文件传输助手',
      text: '桌面助手微信测试',
    });

    console.log(JSON.stringify({
      ok: true,
      relayBase: baseUrl.replace(/:\/\/[^/@]+@/, '://***@'),
      model: settings.model,
      turnOutcomes: [r1.outcome, r2.outcome, r3.outcome],
      finalToolTexts,
      smtpMessages: smtp.messages.length,
      wechatCalls: wechat.calls,
    }, null, 2));
  } finally {
    await engine.stop();
    await bridge.stop();
    for (const socket of [...wechat.sockets, ...smtp.sockets]) socket.destroy();
    await Promise.all([
      new Promise((resolve) => wechat.server.close(resolve)),
      new Promise((resolve) => smtp.server.close(resolve)),
    ]);
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((error) => {
  console.error('LIVE_BOUNDARY_E2E_ERROR', error && error.stack ? error.stack : error);
  process.exit(1);
});
