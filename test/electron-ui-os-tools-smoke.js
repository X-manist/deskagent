'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _electron: electron } = require('../app/node_modules/playwright-core');

(async () => {
  const outDir = path.join(__dirname, '..', 'artifacts', 'os-tools');
  fs.mkdirSync(outDir, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskagent-electron-ui-'));
  const appDir = path.join(__dirname, '..', 'app');
  const env = {
    ...process.env,
    DESKAGENT_BACKEND_URL: 'http://127.0.0.1:9',
    DESKAGENT_DIRECT_RELAY_FALLBACK: 'true',
    DESKAGENT_MCP_PROFILE: 'core',
    DESKAGENT_OS_TOOLS_BIN: path.join(appDir, 'resources', 'bin', process.platform === 'win32' ? 'deskagent-os-tools.exe' : 'deskagent-os-tools'),
    ELECTRON_ENABLE_LOGGING: '0',
  };

  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    cwd: appDir,
    env,
    timeout: 30000,
  });

  try {
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForSelector('#app', { timeout: 30000 });
    await page.screenshot({ path: path.join(outDir, 'electron-login-clean.png') });
    const modelTag = await page.locator('#modelTag').textContent();
    assert.ok(modelTag.includes('glm-5.1'), `model tag should show glm-5.1, got: ${modelTag}`);

    assert.strictEqual(await page.locator('.rightbar').count(), 0, 'right sidebar should not exist');
    assert.strictEqual(await page.locator('#loginOverlay').count(), 1, 'login overlay should exist on first launch');
    assert.strictEqual(await page.locator('#loginOverlay').isVisible(), true, 'login overlay should be visible on clean first launch');
    assert.strictEqual(
      await page.evaluate(() => document.querySelector('#loginOverlay').classList.contains('hidden')),
      false,
      'login overlay should not be hidden before auth state is known'
    );
    await page.evaluate(() => document.querySelector('#loginOverlay').classList.add('hidden'));

    await page.click('[data-theme-choice="dark"]');
    await page.waitForTimeout(200);
    assert.strictEqual(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');

    await page.click('[data-theme-choice="eye"]');
    await page.waitForTimeout(200);
    assert.strictEqual(await page.evaluate(() => document.documentElement.dataset.theme), 'eye');

    await page.click('#openSettings');
    await page.waitForSelector('#settingsModal:not(.hidden)', { timeout: 5000 });
    assert.strictEqual(await page.locator('#setBaseUrl').count(), 0, 'manual base URL input should not exist');
    assert.strictEqual(await page.locator('#setApiKey').count(), 0, 'manual API key input should not exist');
    assert.strictEqual(await page.locator('#setModel').count(), 0, 'manual model input should not exist');
    assert.strictEqual(await page.locator('#saveSettings').count(), 0, 'manual settings save button should not exist');
    await page.screenshot({ path: path.join(outDir, 'electron-settings-modal.png') });
    await page.click('#cancelSettings');

    await page.click('#attachBtn');
    await page.waitForSelector('#attachMenu:not(.hidden)', { timeout: 5000 });
    const attachOptions = await page.locator('#attachMenu button').allTextContents();
    assert.ok(attachOptions.includes('URL 附件'), 'URL attachment option should exist');
    await page.click('button[data-attach="url"]');
    await page.waitForSelector('#urlModal:not(.hidden)', { timeout: 5000 });
    await page.fill('#urlInput', 'https://example.com/file.pdf');
    await page.screenshot({ path: path.join(outDir, 'electron-url-modal.png') });
    await page.click('#cancelUrl');

    await page.fill('#input', 'OS 工具链路 UI smoke');
    assert.strictEqual(await page.inputValue('#input'), 'OS 工具链路 UI smoke');
    await page.screenshot({ path: path.join(outDir, 'electron-input-ready.png') });

    const win = await app.browserWindow(page);
    await win.evaluate((window) => window.setSize(820, 560));
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      document.querySelector('#member').textContent = '会员：剩余 123,456 Token';
      document.querySelector('#remoteStateNote').textContent = '本机直连';
      document.querySelector('#remoteCode').textContent = 'ABC23456';
      document.querySelector('#remoteMeta').textContent = '同一 Wi-Fi/VPN 下扫码连接，10:30 过期';
    });
    await page.screenshot({ path: path.join(outDir, 'electron-compact-window.png') });

    const metrics = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      overflowX: document.documentElement.scrollWidth > innerWidth,
      theme: document.documentElement.dataset.theme,
      hasRightbar: !!document.querySelector('.rightbar'),
      urlModalHidden: document.querySelector('#urlModal').classList.contains('hidden'),
      loginOverlayVisible: !document.querySelector('#loginOverlay').classList.contains('hidden'),
      sidebarBottomScrollable: document.querySelector('.sidebar-bottom').scrollHeight >= document.querySelector('.sidebar-bottom').clientHeight,
      remoteMetaScrollable: document.querySelector('#remoteMeta').scrollHeight >= document.querySelector('#remoteMeta').clientHeight,
    }));
    assert.strictEqual(metrics.overflowX, false, 'compact window should not create horizontal overflow');

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'electron_window_opened',
        'glm_model_label',
        'login_overlay_present',
        'theme_buttons_clickable',
        'settings_modal_clickable',
        'url_attachment_modal_clickable',
        'composer_accepts_input',
        'rightbar_absent',
        'clean_launch_login_visible',
        'compact_window_no_horizontal_overflow',
      ],
      metrics,
      screenshots: [
        path.join(outDir, 'electron-login-clean.png'),
        path.join(outDir, 'electron-settings-modal.png'),
        path.join(outDir, 'electron-url-modal.png'),
        path.join(outDir, 'electron-input-ready.png'),
        path.join(outDir, 'electron-compact-window.png'),
      ],
    }, null, 2));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('ELECTRON_UI_OS_TOOLS_SMOKE_ERROR', error && error.stack ? error.stack : error);
  process.exit(1);
});
