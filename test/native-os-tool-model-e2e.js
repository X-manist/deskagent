'use strict';
// System integration test: a normal user prompt reaches the real bundled agent
// runtime, a simulated LLM Responses stream asks for deskagent_desktop_action,
// and the local MCP bridge executes the Rust OS helper in dry-run mode.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function sseLines(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function allToolNames(body) {
  return ((body && body.tools) || [])
    .map((tool) => tool && (tool.name || (tool.function && tool.function.name)))
    .filter(Boolean);
}

function findDesktopActionToolName(body) {
  const names = allToolNames(body);
  return (
    names.find((name) => /^mcp__deskagent$/i.test(name)) ||
    names.find((name) => /deskagent_desktop_action/i.test(name)) ||
    names.find((name) => /desktop_action/i.test(name)) ||
    null
  );
}

(async () => {
  let exitCode = 0;
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskagent-os-model-e2e-'));
  const agentHome = path.join(baseDir, 'agent');
  const workspaceDir = path.join(baseDir, 'workspace');
  fs.mkdirSync(agentHome, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const observed = {
    requests: [],
    logs: [],
    mcpActivity: [],
    desktopCalls: [],
    desktopResults: [],
    desktopToolName: null,
  };

  const bridge = new LocalBridge({
    baseDir,
    workspaceDir,
    mcpCommand: process.execPath,
    mcpScriptPath: path.join(__dirname, '..', 'app', 'src', 'mcp', 'deskagent-mcp.js'),
    mcpEnv: {},
  });
  const originalDesktopAction = bridge.desktopAction.bind(bridge);
  bridge.desktopAction = async (args) => {
    observed.desktopCalls.push(args);
    const result = await originalDesktopAction(args);
    observed.desktopResults.push(result);
    return result;
  };
  await bridge.start();

  let requestCount = 0;
  const upstream = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/\/responses$/.test(req.url.split('?')[0])) {
      res.writeHead(404).end('not found');
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requestCount += 1;
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      observed.requests.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });

      if (requestCount === 1) {
        const toolName = findDesktopActionToolName(body);
        observed.desktopToolName = toolName;
        if (!toolName) {
          res.end(sseLines([
            { type: 'response.created', response: { id: 'resp-no-tool' } },
            { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'm0', content: [{ type: 'output_text', text: '没有看到桌面操作工具。' }] } },
            { type: 'response.completed', response: { id: 'resp-no-tool', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
          ]));
          return;
        }
        res.end(sseLines([
          { type: 'response.created', response: { id: 'resp-tool' } },
          {
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: 'call-desktop-action',
              namespace: toolName,
              name: 'deskagent_desktop_action',
              arguments: JSON.stringify({
                action: 'type-text',
                text: '这是桌面助手 OS 工具链路测试',
                dryRun: true,
              }),
            },
          },
          { type: 'response.completed', response: { id: 'resp-tool', usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 } } },
        ]));
        return;
      }

      res.end(sseLines([
        { type: 'response.created', response: { id: 'resp-final' } },
        { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: '已完成桌面输入能力检查，没有真的改动当前窗口。' }] } },
        { type: 'response.completed', response: { id: 'resp-final', usage: { input_tokens: 6, output_tokens: 6, total_tokens: 12 } } },
      ]));
    });
  });
  const upstreamPort = await freePort();
  await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));

  const engine = new Engine({
    agentHome,
    workspaceDir,
    settings: () => ({
      model: 'test-relay-model',
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      mcpProfile: 'core',
      relayMode: 'openai',
    }),
    bridgeInfo: () => bridge.info(),
  });
  engine.on('log', (src, line) => observed.logs.push(`[${src}] ${line}`));
  engine.on('activity', (activity) => {
    if (activity && activity.kind === 'mcp') observed.mcpActivity.push(activity);
  });

  process.env.CODEX_BIN = path.join(__dirname, '..', 'app', 'resources', 'bin', 'deskagent-core');
  process.env.RUST_LOG = 'error';

  try {
    await engine.start();
    assert.strictEqual(engine.state, STATE.READY, 'engine should be ready');

    const done = new Promise((resolve) => {
      engine.on('turnDone', () => resolve('done'));
      engine.on('turnError', (error) => resolve(`error:${error && error.message}`));
    });
    await engine.send('帮我在当前窗口输入一段测试文字，先别真的操作，先检查一下能不能做。');
    const outcome = await Promise.race([done, sleep(45000).then(() => 'timeout')]);
    await sleep(800);

    const approvalPopup = observed.logs.some((line) => /requestUserInput|elicitation|approval/i.test(line));
    const nativeResult = observed.desktopResults.find((result) => result && result.backend === 'rust-os-tools');

    console.log(JSON.stringify({
      ok: outcome === 'done',
      outcome,
      upstreamRequests: requestCount,
      advertisedDesktopTool: observed.desktopToolName,
      desktopCalls: observed.desktopCalls,
      desktopResults: observed.desktopResults,
      mcpActivity: observed.mcpActivity,
      approvalPopup,
    }, null, 2));

    assert.strictEqual(outcome, 'done', 'turn should complete');
    assert.ok(observed.desktopToolName, 'desktop action MCP tool should be advertised');
    assert.strictEqual(observed.desktopCalls.length, 1, 'LLM tool response should execute one desktop action');
    assert.deepStrictEqual(observed.desktopCalls[0], {
      action: 'type-text',
      text: '这是桌面助手 OS 工具链路测试',
      dryRun: true,
    });
    assert.ok(nativeResult, 'desktop action should be handled by Rust OS helper');
    assert.strictEqual(nativeResult.command, 'action');
    assert.ok(!approvalPopup, 'first-party desktop MCP tool should not trigger approval popup');
  } finally {
    await engine.stop();
    await bridge.stop();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(baseDir, { recursive: true, force: true });
    process.exitCode = exitCode;
    setImmediate(() => process.exit(process.exitCode));
  }
})().catch((error) => {
  console.error('TEST ERROR', error);
  process.exit(1);
});
