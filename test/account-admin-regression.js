const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function accountI18nFor(lang, options = {}) {
  const source = read('app/src/renderer/renderer.js');
  const start = source.indexOf('const EN_PACKAGE_NAMES');
  const end = source.indexOf('\nfunction setLoggedIn', start);
  assert(start > 0 && end > start, 'account i18n helper block is present');

  const store = options.store || {};
  const context = {
    document: {
      documentElement: { lang, dataset: options.documentDataset || {} },
      body: { dataset: options.bodyDataset || {} },
    },
    window: {
      localStorage: {
        getItem(key) {
          return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
        },
      },
    },
  };
  vm.runInNewContext(source.slice(start, end), context);
  return context.window.__deskagentAccountI18n;
}

const en = accountI18nFor('en-US');
assert.strictEqual(en.packageDisplayName({ id: 1, name: '月度会员' }), 'Monthly Plan');
assert.strictEqual(en.packageDisplayName({ id: 2, name: '年度会员' }), 'Annual Plan');
assert.strictEqual(en.packageDisplayName({ id: 9, name: '内部中文测试' }), 'Plan #9');
assert.strictEqual(en.packageDisplayName({ id: 3, name: 'Team Plan' }), 'Team Plan');

const zh = accountI18nFor('zh-CN');
assert.strictEqual(zh.packageDisplayName({ id: 1, name: '月度会员' }), '月度会员');

const zhPageWithEnglishPreference = accountI18nFor('zh-CN', {
  store: { 'deskagent.locale': 'en-US' },
});
assert.strictEqual(
  zhPageWithEnglishPreference.packageDisplayName({ id: 1, name: '月度会员' }),
  '月度会员',
);

const adminApp = read('admin-web/src/App.jsx');
assert(adminApp.includes('body.points = quota'), 'admin test-user form sends points');
assert(adminApp.includes('body.duration_days = days'), 'admin test-user form sends duration_days');
assert(adminApp.includes('body.models = selectedModels.length'), 'admin test-user form sends selected models');
assert(adminApp.includes('created.entitlement'), 'admin UI displays created entitlement');
assert(adminApp.includes('积分余额'), 'admin users table shows membership points');
assert(adminApp.includes('可用模型额度'), 'admin users table shows entitlement models');
assert(adminApp.includes("useState('100')"), 'admin test-user default is 100 integer points');
assert(adminApp.includes('function formatPoints'), 'admin UI formats points as integer display values');
assert(adminApp.includes('积分/百万 token'), 'admin model pricing uses million-token point units');
assert(adminApp.includes('1 元 = 100 积分'), 'admin package form documents yuan-to-points mapping');
assert(adminApp.includes('6 位精度'), 'admin model pricing explains precise internal metering');

const adminRoutes = read('server/src/routes/admin.rs');
assert(adminRoutes.includes('points: Option<i64>'), 'admin API accepts points');
assert(adminRoutes.includes('INSERT INTO entitlements'), 'admin API grants test-user entitlement');
assert(adminRoutes.includes("status='revoked'"), 'admin API revokes replaced test entitlements');
assert(adminRoutes.includes('display_points_from_micros(point_micros_remaining)'), 'admin users API returns integer remaining points');

const userRoutes = read('server/src/routes/user.rs');
assert(userRoutes.includes('points_used_micros'), 'user API preserves precise metering for diagnostics');
assert(userRoutes.includes('points_remaining_micros'), 'user API aggregates remaining balance before integer display');
assert(userRoutes.includes('display_points_from_micros(remaining_micros)'), 'user API returns integer remaining points');

const rendererHtml = read('app/src/renderer/index.html');
const rendererSource = read('app/src/renderer/renderer.js');
const preloadSource = read('app/src/preload/preload.js');
const mainSource = read('app/src/main/index.js');
assert(!rendererHtml.includes('打开工作目录'), 'desktop sidebar removes ambiguous open-workspace action');
assert(!preloadSource.includes('openWorkspace'), 'preload no longer exposes open-workspace IPC');
assert(!mainSource.includes('app:openWorkspace'), 'main process no longer registers open-workspace IPC');
assert(rendererHtml.includes('shareRemoteFile'), 'desktop sidebar exposes send-file action');
assert(preloadSource.includes('remote:shareFiles'), 'preload exposes remote file sharing IPC');
assert(mainSource.includes('remote:shareFiles'), 'main process registers remote file sharing IPC');
assert(rendererSource.includes('startAccountBadgePolling'), 'account badge refreshes on an interval');
assert(rendererSource.includes("window.api.on('chat:turnDone'"), 'account badge refreshes after a completed turn');
assert(rendererSource.includes('scheduleRemoteAutoRefresh'), 'remote pairing is scheduled for automatic refresh');

console.log('account/admin regression assertions passed');
