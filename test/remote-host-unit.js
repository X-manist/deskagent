'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { RemoteHost, decryptJson, encryptJson } = require('../app/src/main/remote');

async function post(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function main() {
  const sent = [];
  const engine = new EventEmitter();
  Object.assign(engine, {
    threadId: 'thread-existing',
    async listThreads() {
      return [
        { id: 'thread-existing', preview: '历史任务', createdAt: '2026-06-01T10:00:00Z', updatedAt: '2026-06-01T10:10:00Z', status: 'ready' },
      ];
    },
    async startNewThread() {
      this.threadId = 'thread-remote';
      return { threadId: 'thread-remote' };
    },
    async resumeThread(threadId) {
      this.threadId = threadId;
      return {
        threadId,
        messages: [
          { kind: 'message', role: 'user', text: '之前的问题' },
          { kind: 'message', role: 'ai', text: '<think>internal history</think>之前的回复' },
          { kind: 'activity', activityKind: 'reasoning', text: '内部过程不应该给手机端历史' },
        ],
      };
    },
    async send(text, attachments, threadId) {
      sent.push({ text, attachments, threadId });
      setTimeout(() => {
        this.emit('delta', { threadId, itemId: 'msg_0', delta: '<think>internal streaming', text: '<think>internal streaming' });
        this.emit('delta', { threadId, itemId: 'msg_0', delta: '</think>远程回复', text: '<think>internal streaming</think>远程回复' });
        this.emit('message', { threadId, itemId: 'msg_0', text: '<think>internal final</think>远程回复' });
        this.emit('turnDone', { threadId, usage: { total_tokens: 12 } });
      }, 10);
      return { threadId };
    },
  });

  const host = new RemoteHost({
    baseDir: '/tmp/deskagent-remote-test',
    workspaceDir: '/tmp/workspace',
    auth: () => ({ token: 'user-token' }),
    engine: () => engine,
    appVersion: '0.1.0',
  });

  try {
    await host.start();
    const info = host.info();
    assert.strictEqual(info.enabled, true);
    assert.strictEqual(info.loggedIn, true);
    assert.strictEqual(info.mode, 'direct-encrypted');
    assert.strictEqual(info.remoteLinkIsLocal, false);
    assert.strictEqual(info.hasMachineToken, false);
    assert(info.pairing.code);
    assert(info.pairing.qrText.startsWith('http://'));
    assert(info.pairing.qrText.includes('/remote?'));
    assert(info.pairing.qrDataUrl.startsWith('data:image/png;base64,'));
    assert.strictEqual(info.pairing.payload.mode, 'direct-encrypted');
    assert.strictEqual(info.pairing.payload.crypto, 'xsalsa20-poly1305');

    const qr = new URL(info.pairing.qrText);
    const hashParams = new URLSearchParams(qr.hash.replace(/^#/, ''));
    const code = qr.searchParams.get('code');
    const keyText = hashParams.get('k');
    const key = Buffer.from(keyText, 'base64url');
    assert.strictEqual(code, info.pairing.code);
    assert.strictEqual(qr.searchParams.has('k'), false);
    assert.strictEqual(key.length, 32);
    const base = `http://127.0.0.1:${host.port}`;

    const pageRes = await fetch(`${base}/remote?code=${code}#k=${keyText}`);
    assert.strictEqual(pageRes.status, 200);
    const pageHtml = await pageRes.text();
    assert(pageHtml.includes('/vendor/tweetnacl.min.js'));
    assert(pageHtml.includes('/api/remote/direct/command'));
    assert(pageHtml.includes('/api/remote/direct/events'));
    assert(pageHtml.includes('/api/remote/direct/sessions'));
    assert(pageHtml.includes('新建会话'));

    const vendorRes = await fetch(`${base}/vendor/tweetnacl.min.js`);
    assert.strictEqual(vendorRes.status, 200);
    assert((await vendorRes.text()).includes('nacl'));

    const hello = await post(base, '/api/remote/direct/hello', {
      code,
      msg: encryptJson(key, { t: 'hello', at: Date.now() }),
    });
    const helloPayload = decryptJson(key, hello.msg);
    assert.strictEqual(helloPayload.t, 'hello');
    assert.strictEqual(helloPayload.message, '已直连这台电脑');

    const sessions = await post(base, '/api/remote/direct/sessions', {
      code,
      msg: encryptJson(key, { t: 'list_sessions', at: Date.now() }),
    });
    const sessionsPayload = decryptJson(key, sessions.msg);
    assert.strictEqual(sessionsPayload.t, 'sessions');
    assert.strictEqual(sessionsPayload.current_thread_id, 'thread-existing');
    assert.strictEqual(sessionsPayload.sessions[0].id, 'thread-existing');

    const newSession = await post(base, '/api/remote/direct/new-session', {
      code,
      msg: encryptJson(key, { t: 'new_session', at: Date.now() }),
    });
    assert.strictEqual(decryptJson(key, newSession.msg).thread_id, 'thread-remote');

    const history = await post(base, '/api/remote/direct/history', {
      code,
      msg: encryptJson(key, { t: 'history', thread_id: 'thread-existing', at: Date.now() }),
    });
    const historyPayload = decryptJson(key, history.msg);
    assert.strictEqual(historyPayload.t, 'history');
    assert.deepStrictEqual(historyPayload.messages, [
      { role: 'user', text: '之前的问题' },
      { role: 'assistant', text: '之前的回复' },
    ]);

    const command = await post(base, '/api/remote/direct/command', {
      code,
      msg: encryptJson(key, { t: 'chat_message', text: '远程测试', at: Date.now() }),
    });
    const commandPayload = decryptJson(key, command.msg);
    assert.strictEqual(commandPayload.t, 'accepted');
    assert.ok(commandPayload.turn_id);
    assert.strictEqual(commandPayload.thread_id, 'thread-remote');
    assert.deepStrictEqual(sent, [{ text: '远程测试', attachments: [], threadId: 'thread-remote' }]);

    await new Promise((resolve) => setTimeout(resolve, 40));
    const events = await post(base, '/api/remote/direct/events', {
      code,
      msg: encryptJson(key, { t: 'events', turn_id: commandPayload.turn_id, since_seq: 0, at: Date.now() }),
    });
    const eventsPayload = decryptJson(key, events.msg);
    assert.strictEqual(eventsPayload.t, 'events');
    assert.strictEqual(eventsPayload.thread_id, 'thread-remote');
    assert.strictEqual(eventsPayload.done, true);
    assert.ok(eventsPayload.events.some((e) => e.type === 'accepted'));
    assert.ok(eventsPayload.events.some((e) => e.type === 'delta' && e.text === '远程回复'));
    assert.ok(eventsPayload.events.some((e) => e.type === 'message' && e.text === '远程回复'));
    assert.ok(eventsPayload.events.some((e) => e.type === 'done'));

    await assert.rejects(() => post(base, '/api/remote/direct/hello', {
      code,
      msg: encryptJson(Buffer.alloc(32, 1), { t: 'hello' }),
    }), /加密消息校验失败/);

    await host.stop();

    const loggedOut = new RemoteHost({
      baseDir: '/tmp/deskagent-remote-logged-out-test',
      workspaceDir: '/tmp/workspace',
      auth: () => ({ token: '' }),
      engine: () => engine,
      appVersion: '0.1.0',
    });
    await loggedOut.start();
    assert.strictEqual(loggedOut.info().enabled, false);
    assert.strictEqual(loggedOut.info().loggedIn, false);

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'remote_direct_pairing_qr',
        'remote_tweetnacl_vendor_page',
        'remote_encrypted_hello',
        'remote_encrypted_sessions',
        'remote_encrypted_new_session',
        'remote_encrypted_history',
        'remote_encrypted_command_to_engine',
        'remote_streaming_events_to_mobile',
        'remote_rejects_wrong_key',
        'remote_logged_out_no_server',
      ],
    }, null, 2));
  } finally {
    await host.stop().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
