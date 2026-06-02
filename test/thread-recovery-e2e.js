'use strict';
// Regression test: if the renderer sends a stale threadId after engine restart
// or app-server state cleanup, Engine.send should create a fresh thread and
// retry once instead of surfacing "thread not found" to the user.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

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

function sseLines(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

(async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-recovery-'));
  const agentHome = path.join(baseDir, 'agent');
  const workspaceDir = path.join(baseDir, 'ws');
  fs.mkdirSync(agentHome, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  let upstreamRequests = 0;
  const sockets = new Set();
  const upstream = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/\/responses$/.test(req.url.split('?')[0])) {
      res.writeHead(404).end('not found');
      return;
    }
    req.on('data', () => {});
    req.on('end', () => {
      upstreamRequests += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.end(sseLines([
        { type: 'response.created', response: { id: `resp-${upstreamRequests}` } },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            role: 'assistant',
            id: `m${upstreamRequests}`,
            content: [{ type: 'output_text', text: 'fresh thread ok' }],
          },
        },
        {
          type: 'response.completed',
          response: {
            id: `resp-${upstreamRequests}`,
            usage: { input_tokens: 3, output_tokens: 3, total_tokens: 6 },
          },
        },
      ]));
    });
  });
  upstream.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const upstreamPort = await freePort();
  await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));

  process.env.CODEX_BIN = path.join(__dirname, '..', 'app', 'resources', 'bin', 'deskagent-core');
  process.env.RUST_LOG = 'error';

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
    bridgeInfo: () => null,
  });

  const observed = { threadChanged: [], messages: [], errors: [] };
  engine.on('threadChanged', (p) => observed.threadChanged.push(p));
  engine.on('message', (p) => observed.messages.push(p));
  engine.on('turnError', (p) => observed.errors.push(p));

  try {
    await engine.start();
    assert.strictEqual(engine.state, STATE.READY, 'engine should be ready');
    const firstThreadId = engine.threadId;
    assert.ok(firstThreadId, 'engine should create initial thread');

    const done = new Promise((resolve) => {
      engine.once('turnDone', (p) => resolve({ ok: true, payload: p }));
      engine.once('turnError', (p) => resolve({ ok: false, payload: p }));
    });
    const result = await engine.send('hello after stale thread', [], '019e7c73-caea-75f3-841f-2591422cad77');
    const outcome = await Promise.race([done, sleep(45000).then(() => ({ ok: false, payload: { message: 'timeout' } }))]);

    assert.strictEqual(result.recovered, true, 'send should report recovery');
    assert.ok(result.threadId, 'send should return fresh threadId');
    assert.notStrictEqual(result.threadId, '019e7c73-caea-75f3-841f-2591422cad77');
    assert.notStrictEqual(result.threadId, firstThreadId);
    assert.strictEqual(outcome.ok, true, `turn should complete after recovery: ${JSON.stringify(outcome)}`);
    assert.strictEqual(upstreamRequests, 1, 'only recovered fresh-thread turn should reach upstream');
    assert.ok(
      observed.threadChanged.some((p) => p.recovered && p.staleThreadId === '019e7c73-caea-75f3-841f-2591422cad77'),
      'threadChanged should include recovered staleThreadId payload'
    );
    assert.ok(observed.messages.some((m) => m.text === 'fresh thread ok'), 'assistant message should arrive');
    assert.ok(!observed.errors.some((e) => /thread not found/i.test(e.message || '')), 'thread not found should not surface');

    console.log(JSON.stringify({
      ok: true,
      firstThreadId,
      recoveredThreadId: result.threadId,
      upstreamRequests,
      threadChanged: observed.threadChanged,
    }, null, 2));
  } finally {
    await engine.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((error) => {
  console.error('THREAD_RECOVERY_E2E_ERROR', error && error.stack ? error.stack : error);
  process.exit(1);
});
