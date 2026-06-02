'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const electronStub = {
  Notification: class {
    static isSupported() { return false; }
    show() {}
  },
  dialog: {
    async showMessageBox() { return { response: 1 }; },
  },
  shell: {
    async openExternal() { return ''; },
  },
  systemPreferences: {
    isTrustedAccessibilityClient() { return true; },
  },
};

const electronPath = require.resolve('electron', { paths: [path.join(__dirname, '..', 'app')] });
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: electronStub,
};

const { LocalBridge } = require('../app/src/main/bridge');

async function post(url, token, pathname, body) {
  const res = await fetch(url + pathname, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

(async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskagent-bridge-'));
  const workspaceDir = path.join(baseDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const bridge = new LocalBridge({
    baseDir,
    workspaceDir,
    settings: () => ({ baseUrl: 'http://127.0.0.1', apiKey: 'test', model: 'test' }),
    mcpCommand: process.execPath,
    mcpScriptPath: path.join(__dirname, '..', 'app', 'src', 'mcp', 'deskagent-mcp.js'),
    mcpEnv: {},
  });
  await bridge.start();
  try {
    const info = bridge.info();
    assert.ok(info.url.startsWith('http://127.0.0.1:'));
    assert.ok(info.token);

    const notify = await post(info.url, info.token, '/notify', { title: 'smoke' });
    assert.deepStrictEqual(notify, { ok: true });

    const probe = await post(info.url, info.token, '/desktop/action', { action: 'probe' });
    assert.strictEqual(probe.ok, true);
    assert.ok(['rust-os-tools', 'node-fallback'].includes(probe.backend));
    if (probe.backend === 'rust-os-tools') {
      assert.strictEqual(probe.command, 'probe');
      assert.strictEqual(probe.platform, process.platform === 'darwin' ? 'macos' : process.platform);
    }

    const dryType = await post(info.url, info.token, '/desktop/action', {
      action: 'type-text',
      text: '真实用户会说：帮我在当前窗口输入这句话',
      dryRun: true,
    });
    assert.strictEqual(dryType.ok, true);
    if (dryType.backend === 'rust-os-tools') assert.strictEqual(dryType.command, 'action');

    const task = await post(info.url, info.token, '/schedule', {
      name: 'disabled smoke',
      cron: '0 9 * * *',
      prompt: 'noop',
      enabled: false,
    });
    assert.strictEqual(task.ok, true);
    assert.strictEqual(task.task.enabled, false);
    assert.ok(task.task.id);

    const listRes = await fetch(info.url + '/schedule', {
      headers: { authorization: `Bearer ${info.token}` },
    });
    const list = await listRes.json();
    assert.strictEqual(list.tasks.length, 1);
    assert.strictEqual(list.tasks[0].name, 'disabled smoke');

    const screenshotPath = path.join(workspaceDir, 'shots', 'smoke.png');
    if (process.env.DESKAGENT_SMOKE_SCREENSHOT === '1') {
      const screenshot = await post(info.url, info.token, '/desktop/screenshot', { outputPath: 'shots/smoke.png' });
      assert.strictEqual(screenshot.ok, true);
      assert.ok(screenshot.path.startsWith(workspaceDir));
      assert.ok(fs.existsSync(screenshot.path));
    } else {
      assert.strictEqual(path.resolve(workspaceDir, 'shots/smoke.png'), screenshotPath);
    }

    console.log('bridge smoke ok');
  } finally {
    await bridge.stop();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
