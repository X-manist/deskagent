'use strict';

const assert = require('assert');
const http = require('http');
const net = require('net');
const { createAdapterServer } = require('../adapter/responses-adapter');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
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

(async () => {
  const upstream = http.createServer((req, res) => {
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.url, '/v1/chat/completions');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"完成"}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const upstreamPort = await listen(upstream);

  const adapter = createAdapterServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    getApiKey: () => 'test-key',
    model: 'glm-5.1',
    token: 'adapter-token',
    passthrough: false,
  });
  const adapterPort = await listen(adapter);

  try {
    const res = await fetch(`http://127.0.0.1:${adapterPort}/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer adapter-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.1', input: 'adapter glm smoke', stream: true }),
    });
    const text = await res.text();
    assert.strictEqual(res.status, 200);
    assert.ok(text.includes('思考'));
    assert.ok(text.includes('完成'));
    assert.ok(text.includes('"total_tokens":3'));
    console.log(JSON.stringify({ ok: true, checks: ['glm_reasoning_content_stream', 'chat_usage_to_responses_usage'] }, null, 2));
  } finally {
    adapter.close();
    upstream.close();
  }
})().catch((error) => {
  console.error('RESPONSES_ADAPTER_GLM_UNIT_ERROR', error && error.stack ? error.stack : error);
  process.exit(1);
});
