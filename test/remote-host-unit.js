'use strict';
const assert = require('assert');
const { RemoteHost } = require('../app/src/main/remote');

async function main() {
  const calls = [];
  const commands = [{ id: 'cmd-1', command_type: 'chat_message', payload: { text: '远程测试' } }];
  const oldFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ path, method, body, auth: opts.headers && opts.headers.Authorization });
    if (path === '/api/remote/machines' && method === 'POST') {
      return json({ machine_id: body.machine_id, machine_token: 'da_machine_test' });
    }
    if (path.endsWith('/pairing') && method === 'POST') {
      return json({
        code: 'ABC23456',
        expires_at: '2026-06-02T12:00:00Z',
        payload: {
          version: 1,
          product: 'deskagent',
          code: 'ABC23456',
          machine_id: 'm1',
          web_url: 'http://127.0.0.1:8787/remote?code=ABC23456',
        },
      });
    }
    if (path === '/api/remote/machine/heartbeat') return json({ ok: true });
    if (path === '/api/remote/machine/commands') return json({ commands: commands.splice(0) });
    if (path === '/api/remote/machine/commands/cmd-1/result') return json({ ok: true });
    return json({}, 404);
  };

  const engine = {
    async startNewThread() {
      return { threadId: 'thread-remote' };
    },
    async send(text, attachments, threadId) {
      assert.strictEqual(text, '远程测试');
      assert.deepStrictEqual(attachments, []);
      assert.strictEqual(threadId, 'thread-remote');
      return { threadId };
    },
  };

  try {
    const host = new RemoteHost({
      baseDir: '/tmp/deskagent-remote-test',
      workspaceDir: '/tmp/workspace',
      backendUrl: 'http://127.0.0.1:8787',
      auth: () => ({ token: 'user-token' }),
      engine: () => engine,
      appVersion: '0.1.0',
    });
    await host.start();
    assert.strictEqual(host.info().pairing.code, 'ABC23456');
    assert.strictEqual(host.info().pairing.qrText, 'http://127.0.0.1:8787/remote?code=ABC23456');
    assert(host.info().pairing.qrDataUrl.startsWith('data:image/png;base64,'));
    await host.pollOnce();
    const resultCall = calls.find((c) => c.path === '/api/remote/machine/commands/cmd-1/result');
    assert(resultCall, 'expected result callback');
    assert.strictEqual(resultCall.body.ok, true);
    assert.strictEqual(resultCall.body.result.thread_id, 'thread-remote');
    assert(calls.some((c) => c.path === '/api/remote/machines' && c.auth === 'Bearer user-token'));
    assert(calls.some((c) => c.path === '/api/remote/machine/commands' && c.auth === 'Bearer da_machine_test'));
    await host.stop();
    console.log(JSON.stringify({ ok: true, checks: ['remote_register_pairing_poll_result'] }, null, 2));
  } finally {
    global.fetch = oldFetch;
  }
}

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
