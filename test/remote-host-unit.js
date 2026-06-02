'use strict';
const assert = require('assert');
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
  const engine = {
    async startNewThread() {
      return { threadId: 'thread-remote' };
    },
    async send(text, attachments, threadId) {
      sent.push({ text, attachments, threadId });
      return { threadId };
    },
  };

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

    const command = await post(base, '/api/remote/direct/command', {
      code,
      msg: encryptJson(key, { t: 'chat_message', text: '远程测试', at: Date.now() }),
    });
    const commandPayload = decryptJson(key, command.msg);
    assert.strictEqual(commandPayload.t, 'accepted');
    assert.strictEqual(commandPayload.thread_id, 'thread-remote');
    assert.deepStrictEqual(sent, [{ text: '远程测试', attachments: [], threadId: 'thread-remote' }]);

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
        'remote_encrypted_command_to_engine',
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
