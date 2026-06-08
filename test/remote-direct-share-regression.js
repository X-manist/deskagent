const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const {
  RemoteHost,
  PAIRING_TTL_MS,
  contentDispositionAttachment,
} = require('../app/src/main/remote');

function loadLocalBridgeWithElectronStub() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        Notification: { isSupported: () => false },
        dialog: {},
        shell: { openExternal: async () => {} },
        systemPreferences: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../app/src/main/bridge').LocalBridge;
  } finally {
    Module._load = originalLoad;
  }
}

async function main() {
  assert(PAIRING_TTL_MS >= 300 * 24 * 60 * 60 * 1000, 'remote pairing is long lived');
  assert(
    contentDispositionAttachment('中文 文件.txt').includes("filename*=UTF-8''%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.txt"),
    'download header preserves UTF-8 Chinese filename',
  );
  const mcpSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'src', 'mcp', 'deskagent-mcp.js'), 'utf8');
  const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'src', 'main', 'bridge.js'), 'utf8');
  assert(mcpSource.includes('deskagent_send_file_to_phone'), 'MCP exposes explicit send-file-to-phone tool');
  assert(mcpSource.includes('/remote/share-file'), 'MCP tool calls explicit remote share route');
  assert(bridgeSource.includes("url.pathname === '/remote/share-file'"), 'bridge exposes explicit remote share route');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskagent-remote-share-'));
  const engine = new EventEmitter();
  engine.listThreads = async () => [];
  engine.threadId = 'thread-test';
  const host = new RemoteHost({
    baseDir: tmp,
    workspaceDir: tmp,
    auth: () => ({ token: 'test-token' }),
    engine: () => engine,
  });
  let bridge;

  try {
    await host.start();
    const info = host.info();
    assert(info.pairing, 'pairing is created');
    assert(new Date(info.pairing.expiresAt).getTime() - Date.now() > 300 * 24 * 60 * 60 * 1000, 'pairing expiry is long lived');

    const filePath = path.join(tmp, '中文 文件.txt');
    fs.writeFileSync(filePath, 'hello phone', 'utf8');
    const shared = await host.sharePaths([filePath]);
    assert(shared.share.download_path, 'share returns direct download path');
    assert.strictEqual(shared.share.packaged, false, 'single file is streamed directly');

    const url = `http://127.0.0.1:${host.port}${shared.share.download_path}`;
    const res = await fetch(url);
    assert.strictEqual(res.status, 200);
    assert(res.headers.get('content-disposition').includes("filename*=UTF-8''%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.txt"));
    assert.strictEqual(await res.text(), 'hello phone');

    const range = await fetch(url, { headers: { Range: 'bytes=0-4' } });
    assert.strictEqual(range.status, 206);
    assert.strictEqual(await range.text(), 'hello');

    const dir = path.join(tmp, '资料目录');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '说明.txt'), 'zip ok', 'utf8');
    const zipped = await host.sharePaths([dir]);
    assert.strictEqual(zipped.share.packaged, true, 'directory share is packaged');
    const zipRes = await fetch(`http://127.0.0.1:${host.port}${zipped.share.download_path}`);
    const bytes = Buffer.from(await zipRes.arrayBuffer());
    assert.strictEqual(bytes.slice(0, 2).toString('ascii'), 'PK', 'directory share downloads as zip');

    const agentFile = path.join(tmp, 'agent-result.txt');
    fs.writeFileSync(agentFile, 'agent output', 'utf8');
    host.remoteTurns.set('turn-file', {
      id: 'turn-file',
      threadId: 'thread-test',
      seq: 0,
      events: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      done: false,
    });
    host.captureRemoteEngineEvent('activity', {
      threadId: 'thread-test',
      kind: 'file',
      phase: 'completed',
      files: ['agent-result.txt'],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const autoShared = host.info().fileShares.find((share) => share.name === 'agent-result.txt');
    assert(!autoShared, 'agent file activity is not automatically exposed to phone downloads');
    const turn = host.remoteTurns.get('turn-file');
    assert(
      turn.events.some((event) => event.type === 'activity' && event.kind === 'file' && event.phase === 'completed'),
      'agent file activity is still rendered as running/completed activity',
    );
    assert(
      !turn.events.some((event) => event.type === 'files_changed' && event.files.some((file) => file.name === 'agent-result.txt')),
      'files_changed is reserved for explicit user-requested sends',
    );

    const LocalBridge = loadLocalBridgeWithElectronStub();
    bridge = new LocalBridge({
      baseDir: tmp,
      workspaceDir: tmp,
      settings: () => ({}),
      shareRemoteFile: async ({ paths }) => host.sharePaths(paths),
    });
    await bridge.start();
    const bridgeInfo = bridge.info();
    const sendRes = await fetch(`${bridgeInfo.url}/remote/share-file`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bridgeInfo.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: 'agent-result.txt' }),
    });
    assert.strictEqual(sendRes.status, 200);
    const sent = await sendRes.json();
    assert.strictEqual(sent.share.name, 'agent-result.txt');
    const explicitShared = host.info().fileShares.find((share) => share.name === 'agent-result.txt');
    assert(explicitShared, 'explicit send-file tool exposes the requested file to phone downloads');
    assert(
      turn.events.some((event) => event.type === 'files_changed' && event.files.some((file) => file.name === 'agent-result.txt')),
      'explicit send-file tool notifies the remote phone page immediately',
    );
    const agentRes = await fetch(`http://127.0.0.1:${host.port}${explicitShared.download_path}`);
    assert.strictEqual(await agentRes.text(), 'agent output');
  } finally {
    if (bridge) await bridge.stop();
    await host.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log('remote direct share regression assertions passed'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
