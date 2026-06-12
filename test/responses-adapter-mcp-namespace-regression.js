const assert = require('assert');
const http = require('http');

const {
  buildChatMessages,
  buildChatRequest,
  buildChatToolMap,
  createAdapterServer,
  flattenToolName,
} = require('../adapter/responses-adapter');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk.toString();
  return raw;
}

function parseSse(text) {
  return text
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const data = block.split(/\n/).find((line) => line.startsWith('data:'));
      return data ? JSON.parse(data.slice(5).trim()) : null;
    })
    .filter(Boolean);
}

async function main() {
  const requestBody = {
    model: 'glm-test',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '发到手机' }] }],
    tools: [
      {
        type: 'namespace',
        name: 'mcp__deskagent',
        description: 'Local desktop bridge MCP',
        tools: [
          {
            type: 'function',
            name: 'deskagent_send_file_to_phone',
            description: 'Send a local file to phone',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ],
      },
    ],
  };
  const flatName = 'mcp__deskagent__deskagent_send_file_to_phone';
  assert.strictEqual(flattenToolName('mcp__deskagent', 'deskagent_send_file_to_phone'), flatName);
  assert.strictEqual(buildChatToolMap(requestBody).get(flatName).namespace, 'mcp__deskagent');

  const chatReq = buildChatRequest(requestBody);
  assert.deepStrictEqual(
    chatReq.tools.map((tool) => tool.function.name),
    [flatName],
  );

  const chatMessages = buildChatMessages({
    input: [
      {
        type: 'function_call',
        namespace: 'mcp__deskagent',
        name: 'deskagent_send_file_to_phone',
        arguments: '{"path":"demo.pdf"}',
        call_id: 'call_1',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ],
  });
  assert.strictEqual(chatMessages[0].tool_calls[0].function.name, flatName);

  let upstreamBody = null;
  const upstream = http.createServer(async (req, res) => {
    assert.strictEqual(req.url, '/v1/chat/completions');
    upstreamBody = JSON.parse(await readBody(req));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_2',
            function: {
              name: flatName,
              arguments: '{"path":"demo.pdf"}',
            },
          }],
        },
      }],
    })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const upstreamPort = await listen(upstream);

  const adapter = createAdapterServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    getApiKey: () => 'test-key',
    token: 'local-token',
    passthrough: false,
    preferWebSocket: false,
  });
  const adapterPort = await listen(adapter);

  try {
    const res = await fetch(`http://127.0.0.1:${adapterPort}/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    assert.strictEqual(res.status, 200);
    const events = parseSse(await res.text());
    assert(upstreamBody, 'adapter called upstream chat backend');
    assert.deepStrictEqual(upstreamBody.tools.map((tool) => tool.function.name), [flatName]);
    const done = events.find(
      (event) => event.type === 'response.output_item.done'
        && event.item
        && event.item.type === 'function_call',
    );
    assert(done, 'adapter emitted a Responses function_call item');
    assert.strictEqual(done.item.namespace, 'mcp__deskagent');
    assert.strictEqual(done.item.name, 'deskagent_send_file_to_phone');
    assert.strictEqual(done.item.arguments, '{"path":"demo.pdf"}');
  } finally {
    await close(adapter);
    await close(upstream);
  }
}

main()
  .then(() => console.log('responses adapter MCP namespace regression assertions passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
