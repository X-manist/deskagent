const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function accountI18nFor(lang) {
  const source = read('app/src/renderer/renderer.js');
  const start = source.indexOf('const EN_PACKAGE_NAMES');
  const end = source.indexOf('\nfunction setLoggedIn', start);
  assert(start > 0 && end > start, 'account i18n helper block is present');

  const context = {
    document: { documentElement: { lang } },
    navigator: { language: lang },
    window: {},
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

const adminApp = read('admin-web/src/App.jsx');
assert(adminApp.includes('body.points = quota'), 'admin test-user form sends points');
assert(adminApp.includes('body.duration_days = days'), 'admin test-user form sends duration_days');
assert(adminApp.includes('body.model = model.trim()'), 'admin test-user form sends model');
assert(adminApp.includes('created.entitlement'), 'admin UI displays created entitlement');
assert(adminApp.includes('会员积分'), 'admin users table shows membership points');

const adminRoutes = read('server/src/routes/admin.rs');
assert(adminRoutes.includes('points: Option<i64>'), 'admin API accepts points');
assert(adminRoutes.includes('INSERT INTO entitlements'), 'admin API grants test-user entitlement');
assert(adminRoutes.includes("status='revoked'"), 'admin API revokes replaced test entitlements');
assert(adminRoutes.includes('"points_remaining": points_remaining.max(0)'), 'admin users API returns remaining points');

console.log('account/admin regression assertions passed');
