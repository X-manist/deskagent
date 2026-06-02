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
    const headers = opts.headers || {};
    calls.push({ path, method, body, headers, auth: headers.Authorization });
    if (path === '/api/remote/machines' && method === 'POST') {
      return json({ machine_id: body.machine_id, machine_token: 'da_machine_test' });
    }
    if (path.endsWith('/pairing') && method === 'POST') {
      const publicProto = headers['X-Forwarded-Proto'] || 'http';
      const publicHost = headers['X-Forwarded-Host'] || '127.0.0.1:8787';
      return json({
        code: 'ABC23456',
        expires_at: '2026-06-02T12:00:00Z',
        payload: {
          version: 1,
          product: 'deskagent',
          code: 'ABC23456',
          machine_id: 'm1',
          server_url: `${publicProto}://${publicHost}`,
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
      publicBackendUrl: 'https://deskagent.example.com',
      auth: () => ({ token: 'user-token' }),
      engine: () => engine,
      appVersion: '0.1.0',
    });
    await host.start();
    assert.strictEqual(host.info().pairing.code, 'ABC23456');
    assert.strictEqual(host.info().pairing.qrText, 'https://deskagent.example.com/remote?code=ABC23456');
    assert.strictEqual(host.info().pairing.payload.server_url, 'https://deskagent.example.com');
    assert.strictEqual(host.info().remoteLinkIsLocal, false);
    assert(host.info().pairing.qrDataUrl.startsWith('data:image/png;base64,'));
    await host.pollOnce();
    const resultCall = calls.find((c) => c.path === '/api/remote/machine/commands/cmd-1/result');
    assert(resultCall, 'expected result callback');
    assert.strictEqual(resultCall.body.ok, true);
    assert.strictEqual(resultCall.body.result.thread_id, 'thread-remote');
    assert(calls.some((c) => c.path === '/api/remote/machines' && c.auth === 'Bearer user-token'));
    assert(calls.some((c) => c.path === '/api/remote/machine/commands' && c.auth === 'Bearer da_machine_test'));
    assert(calls.some((c) => c.path.endsWith('/pairing') && c.headers['X-Forwarded-Proto'] === 'https'));
    assert(calls.some((c) => c.path.endsWith('/pairing') && c.headers['X-Forwarded-Host'] === 'deskagent.example.com'));
    await host.stop();

    global.fetch = async () => json({ error: { message: 'backend down' } }, 503);
    const failingHost = new RemoteHost({
      baseDir: '/tmp/deskagent-remote-fail-test',
      workspaceDir: '/tmp/workspace',
      backendUrl: 'http://127.0.0.1:8787',
      auth: () => ({ token: 'user-token' }),
      engine: () => engine,
      appVersion: '0.1.0',
    });
    await assert.rejects(() => failingHost.start(), /backend down/);
    assert.strictEqual(failingHost.info().enabled, false);
    assert.strictEqual(failingHost.info().hasMachineToken, false);
    assert.strictEqual(failingHost.info().remoteLinkIsLocal, true);
    assert(failingHost.info().remoteLinkLocalReason.includes('本机地址'));

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'remote_register_pairing_poll_result',
        'remote_public_pairing_headers',
        'remote_failed_start_resets_running_state',
        'remote_local_link_warning',
      ],
    }, null, 2));
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
