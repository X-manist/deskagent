const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { RemoteHost } = require('../app/src/main/remote');

function json(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
  });
  res.end(bytes);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskagent-relay-host-'));
  const received = { files: [], results: [], registered: null, pairings: [], paths: [] };
  const queue = [];
  let machineToken = 'machine-token-test';
  let pairingCode = 'RELAY123';
  let server;
  const baseUrl = await new Promise((resolve) => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const routePath = url.pathname.replace(/^\/relay-e2e/, '') || '/';
      received.paths.push(url.pathname);
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (req.method === 'POST' && routePath === '/api/remote/machines') {
          received.registered = body;
          return json(res, 200, { machine_id: body.machine_id, machine_token: machineToken });
        }
        if (req.method === 'POST' && routePath.endsWith('/pairing')) {
          received.pairings.push(body);
          return json(res, 200, {
            pairing_id: 'pairing-test',
            relay_session_id: 'relay-session-test',
            code: pairingCode,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            payload: {
              mode: 'relay-encrypted',
              web_url: `${baseUrlValue}/relay-e2e/remote?code=${pairingCode}#k=${body.client_key}`,
            },
          });
        }
        if (req.method === 'POST' && routePath === '/api/remote/machine/heartbeat') {
          return json(res, 200, { ok: true });
        }
        if (req.method === 'GET' && routePath === '/api/remote/machine/commands') {
          return json(res, 200, { commands: queue.splice(0) });
        }
        if (req.method === 'POST' && routePath.includes('/api/remote/machine/commands/')) {
          received.results.push({ path: url.pathname, body });
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && routePath === '/api/remote/machine/files') {
          received.files.push(body);
          return json(res, 200, {
            ok: true,
            file: { id: `file-${received.files.length}`, name: body.name, size: body.size },
          });
        }
        return json(res, 404, { error: { message: 'not found' } });
      });
    });
    let baseUrlValue = '';
    server.listen(0, '127.0.0.1', () => {
      baseUrlValue = `http://127.0.0.1:${server.address().port}`;
      resolve(baseUrlValue);
    });
  });

  const engine = new EventEmitter();
  engine.threadId = 'thread-relay';
  engine.listThreads = async () => [{ id: 'thread-relay', preview: 'Relay' }];
  engine.send = async (_text, _attachments, threadId) => {
    setTimeout(() => {
      engine.emit('message', { threadId, text: '公网回复' });
      engine.emit('turnDone', { threadId });
    }, 20);
    return { threadId };
  };

  const host = new RemoteHost({
    baseDir: tmp,
    workspaceDir: tmp,
    appVersion: '0.1.0-test',
    auth: () => ({ token: 'user-token-test' }),
    engine: () => engine,
    backendUrl: () => `${baseUrl}/relay-e2e`,
  });

  try {
    await host.start();
    assert(received.registered, 'machine is registered with backend');
    assert(received.paths.some((p) => p === '/relay-e2e/api/remote/machines'), 'backend prefix is preserved');
    assert.strictEqual(host.info().pairing.code, pairingCode);
    assert.strictEqual(host.info().pairing.payload.mode, 'relay-encrypted');
    assert(host.info().pairing.qrText.includes('/relay-e2e/remote?code=RELAY123'), 'relay web url keeps prefix');

    queue.push({
      id: 'cmd-1',
      command_type: 'chat_message',
      payload: { text: '公网任务', thread_id: 'thread-relay' },
      created_at: new Date().toISOString(),
    });
    await host.pollRelayCommands();
    assert.strictEqual(received.results.length, 1, 'command result was posted');
    assert.strictEqual(received.results[0].body.ok, true);
    const replyEvent = received.results[0].body.result.events.find((event) => event.type === 'message');
    assert.strictEqual(replyEvent.text, '公网回复');

    const filePath = path.join(tmp, 'hello.txt');
    fs.writeFileSync(filePath, 'hello phone', 'utf8');
    const shared = await host.sharePaths([filePath]);
    assert.strictEqual(received.files.length, 1, 'file metadata uploaded');
    assert.strictEqual(received.files[0].content_base64, Buffer.from('hello phone').toString('base64'));
    assert(shared.share.cloud_download_url.includes('/relay-e2e/api/remote/files/file-1/hello.txt'));
  } finally {
    await host.stop();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log('remote relay host regression assertions passed'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
