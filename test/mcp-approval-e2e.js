'use strict';
// Integration test: drives the REAL bundled deskagent-core app-server through the
// Engine with a fake Responses upstream that forces one MCP tool call
// (deskagent_notify). Verifies the tool auto-executes (hits the local bridge)
// and that codex does NOT emit any approval / elicitation server-request popup.
//
// Usage:
//   node test/mcp-approval-e2e.js          # uses default approve config (fixed)
//   APPROVAL_OVERRIDE=auto node ...        # forces the OLD broken behaviour to contrast
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

// --- stub electron before requiring app modules ---
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
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

function sseLines(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

// Find a deskagent notify tool name in the codex request body's tools array.
function allToolNames(body) {
  const tools = (body && body.tools) || [];
  return tools.map((t) => t && (t.name || (t.function && t.function.name))).filter(Boolean);
}
function findNotifyToolName(body) {
  const names = allToolNames(body);
  return names.find((n) => /notify/i.test(n)) || names.find((n) => /deskagent/i.test(n)) || null;
}

(async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-approval-'));
  const agentHome = path.join(baseDir, 'agent');
  const workspaceDir = path.join(baseDir, 'ws');
  fs.mkdirSync(agentHome, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const observed = { serverRequests: [], mcpActivity: [], logs: [], notifyCallName: null };

  // --- real local bridge + real deskagent-mcp ---
  const bridge = new LocalBridge({
    baseDir,
    mcpCommand: process.execPath,
    mcpScriptPath: path.join(__dirname, '..', 'app', 'src', 'mcp', 'deskagent-mcp.js'),
    mcpEnv: {},
  });
  await bridge.start();

  // --- fake Responses upstream ---
  let reqCount = 0;
  const upstream = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/\/responses$/.test(req.url.split('?')[0])) {
      res.writeHead(404).end('nope'); return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      reqCount += 1;
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (reqCount === 1) {
        const toolName = findNotifyToolName(body);
        observed.notifyCallName = toolName;
        observed.allTools = allToolNames(body);
        if (!toolName) {
          // No deskagent tool advertised -> just finish so the test fails clearly.
          res.end(sseLines([
            { type: 'response.created', response: { id: 'resp-1' } },
            { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'm0', content: [{ type: 'output_text', text: 'no tool advertised' }] } },
            { type: 'response.completed', response: { id: 'resp-1', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
          ]));
          return;
        }
        res.end(sseLines([
          { type: 'response.created', response: { id: 'resp-1' } },
          { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call-1', namespace: toolName, name: 'deskagent_notify', arguments: JSON.stringify({ title: 'MCP 审批测试通知' }) } },
          { type: 'response.completed', response: { id: 'resp-1', usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } },
        ]));
      } else {
        res.end(sseLines([
          { type: 'response.created', response: { id: 'resp-2' } },
          { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: '已通过桌面工具发送通知。' }] } },
          { type: 'response.completed', response: { id: 'resp-2', usage: { input_tokens: 6, output_tokens: 6, total_tokens: 12 } } },
        ]));
      }
    });
  });
  const upstreamPort = await freePort();
  await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));

  // --- engine ---
  const eng = new Engine({
    agentHome,
    workspaceDir,
    settings: () => ({ model: 'gpt-5.4-mini', apiKey: 'test-key', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, mcpProfile: 'core', relayMode: 'openai' }),
    bridgeInfo: () => bridge.info(),
  });

  eng.on('log', (src, line) => {
    observed.logs.push(`[${src}] ${line}`);
    if (src === 'engine' && /server request:/.test(line)) observed.serverRequests.push(line);
  });
  eng.on('activity', (a) => { if (a && a.kind === 'mcp') observed.mcpActivity.push(a); });

  // Optionally override approval mode to demonstrate the OLD broken behaviour.
  const override = process.env.APPROVAL_OVERRIDE; // e.g. "auto" or "prompt"
  if (override) {
    const orig = eng._deskagentMcpConfig.bind(eng);
    eng._deskagentMcpConfig = () => orig().replace('default_tools_approval_mode = "approve"', `default_tools_approval_mode = "${override}"`);
  }

  process.env.CODEX_BIN = path.join(__dirname, '..', 'app', 'resources', 'bin', 'deskagent-core');
  process.env.RUST_LOG = 'error';

  try {
    await eng.start();
    assert.strictEqual(eng.state, STATE.READY, 'engine should be READY');

    const done = new Promise((resolve) => {
      eng.on('turnDone', () => resolve('done'));
      eng.on('turnError', (e) => resolve('error:' + (e && e.message)));
    });
    await eng.send('请调用内置桌面工具发送一条通知，标题写“MCP 审批测试通知”。');
    const outcome = await Promise.race([done, sleep(45000).then(() => 'timeout')]);

    await sleep(800);
    const bridgeHit = observed.logs.some((l) => /deskagent_notify|mcp.*deskagent|\.deskagent_notify/i.test(l)) || observed.mcpActivity.length > 0;
    const approvalPopup = observed.serverRequests.some((l) => /requestUserInput|elicitation/i.test(l));

    console.log(JSON.stringify({
      override: override || '(default approve)',
      outcome,
      upstreamRequests: reqCount,
      advertisedNotifyTool: observed.notifyCallName,
      allAdvertisedTools: observed.allTools,
      mcpActivity: observed.mcpActivity,
      serverRequests: observed.serverRequests,
      bridgeHit,
      approvalPopup,
    }, null, 2));

    console.log('\n--- engine logs (tail) ---');
    console.log(observed.logs.slice(-40).join('\n'));

    if (!override) {
      assert.ok(reqCount >= 2, 'codex should round-trip a 2nd request after running the tool');
      assert.ok(!approvalPopup, 'should NOT emit an approval/elicitation popup');
      assert.ok(observed.mcpActivity.length > 0, 'should observe MCP tool activity (tool executed)');
      console.log('\n✅ PASS: MCP tool auto-executed with no approval popup.');
    }
  } finally {
    await eng.stop();
    await bridge.stop();
    upstream.close();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
