'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const electronStub = {
  Notification: class { static isSupported() { return false; } show() {} },
  dialog: { async showMessageBox() { return { response: 1 }; } },
  shell: {
    opened: [],
    async openExternal(url) {
      this.opened.push(url);
      return '';
    },
  },
  systemPreferences: { isTrustedAccessibilityClient() { return true; } },
  app: { getPath: () => os.tmpdir(), getName: () => 'deskagent' },
};
const electronPath = require.resolve('electron', { paths: [path.join(__dirname, '..', 'app')] });
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electronStub };

const { LocalBridge } = require('../app/src/main/bridge');

function requestJson(bridge, pathname, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body || {});
    const req = http.request({
      hostname: '127.0.0.1',
      port: bridge.port,
      path: pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${bridge.token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(raw),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const parsed = data ? JSON.parse(data) : {};
        if (res.statusCode >= 400) reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
        else resolve(parsed);
      });
    });
    req.on('error', reject);
    req.end(raw);
  });
}

(async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskagent-bridge-os-tools-'));
  const workspaceDir = path.join(baseDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const helper = path.join(baseDir, 'deskagent-os-tools-stub.js');
  const logFile = path.join(baseDir, 'calls.jsonl');
  fs.writeFileSync(helper, `#!/usr/bin/env node
const fs = require('fs');
const command = process.argv[2];
let raw = '';
process.stdin.on('data', (chunk) => raw += chunk);
process.stdin.on('end', () => {
  const payload = raw ? JSON.parse(raw) : {};
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ command, payload }) + '\\n');
  console.log(JSON.stringify({ ok: true, backend: 'rust-os-tools', platform: process.platform, command, action: payload.action, path: payload.outputPath, message: payload.dryRun ? 'dry-run: no OS side effect executed' : undefined }));
});
`);
  fs.chmodSync(helper, 0o755);

  const bridge = new LocalBridge({
    baseDir,
    workspaceDir,
    osToolsCommand: helper,
  });

  try {
    await bridge.start();
    const openUrl = await requestJson(bridge, '/open-url', { url: 'https://example.com/a' });
    const openApp = await requestJson(bridge, '/open-app', { name: 'TextEdit' });
    const probe = await requestJson(bridge, '/desktop/action', { action: 'probe' });
    const dryClick = await requestJson(bridge, '/desktop/action', { action: 'click', x: 1, y: 2, dryRun: true });

    assert.strictEqual(openUrl.backend, 'rust-os-tools');
    assert.strictEqual(openUrl.command, 'open-url');
    assert.strictEqual(openApp.backend, 'rust-os-tools');
    assert.strictEqual(openApp.command, 'open-app');
    assert.strictEqual(probe.command, 'probe');
    assert.strictEqual(dryClick.backend, 'rust-os-tools');
    assert.strictEqual(dryClick.command, 'action');
    assert.deepStrictEqual(electronStub.shell.opened, [], 'Rust helper should prevent open-url fallback');

    const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepStrictEqual(calls.map((call) => call.command), ['open-url', 'open-app', 'probe', 'action']);
    assert.strictEqual(calls[0].payload.workspaceRoot, workspaceDir);
    assert.strictEqual(calls[3].payload.dryRun, true);

    console.log(JSON.stringify({
      ok: true,
      checks: ['bridge_open_url_uses_rust_helper', 'bridge_open_app_uses_rust_helper', 'bridge_dryrun_uses_rust_helper'],
      calls,
    }, null, 2));
  } finally {
    await bridge.stop();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('OS_TOOLS_BRIDGE_UNIT_ERROR', error && error.stack ? error.stack : error);
  process.exit(1);
});
