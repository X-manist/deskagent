const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
  RemoteHost,
  PAIRING_TTL_MS,
  contentDispositionAttachment,
} = require('../app/src/main/remote');

async function main() {
  assert(PAIRING_TTL_MS >= 23 * 60 * 60 * 1000, 'remote pairing lasts about a full day');
  assert(
    contentDispositionAttachment('中文 文件.txt').includes("filename*=UTF-8''%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.txt"),
    'download header preserves UTF-8 Chinese filename',
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskagent-remote-share-'));
  const engine = new EventEmitter();
  engine.listThreads = async () => [];
  engine.threadId = 'thread-test';
  const host = new RemoteHost({
    baseDir: tmp,
    auth: () => ({ token: 'test-token' }),
    engine: () => engine,
  });

  try {
    await host.start();
    const info = host.info();
    assert(info.pairing, 'pairing is created');
    assert(new Date(info.pairing.expiresAt).getTime() - Date.now() > 23 * 60 * 60 * 1000, 'pairing expiry is near 24h');

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
  } finally {
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
