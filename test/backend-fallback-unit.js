'use strict';
// Static/behavioral guard for the localhost backend fallback that prevents
// "unexpected status 502 Bad Gateway: connect ECONNREFUSED 127.0.0.1:8787" when
// developers run the desktop app with a logged-in token but without starting
// deskagent-server.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mainPath = path.join(__dirname, '..', 'app', 'src', 'main', 'index.js');
const text = fs.readFileSync(mainPath, 'utf8');

assert.ok(text.includes('let directRelayFallbackActive = false;'), 'fallback state should exist');
assert.ok(text.includes('function isLocalBackendUrl'), 'fallback should be limited to localhost backend URLs');
assert.ok(text.includes('function hasDirectRelaySettings'), 'fallback should require direct relay settings');
assert.ok(text.includes('async function backendAvailable'), 'startup should probe backend health');
assert.ok(text.includes('async function prepareEngineSettings'), 'startup should prepare effective engine settings');
assert.ok(text.includes('DESKAGENT_DIRECT_RELAY_FALLBACK'), 'fallback should be explicitly disableable');
assert.ok(
  /if \(isLoggedIn\(\) && !directRelayFallbackActive\)/.test(text),
  'logged-in settings should skip backend only when fallback is active'
);
assert.ok(
  /await prepareEngineSettings\(\);[\s\S]*new Engine/.test(text),
  'backend availability should be checked before Engine construction'
);
assert.ok(
  text.includes('本地会员服务未启动，开发模式直连模型通道'),
  'fallback status should explain the localhost backend condition'
);
assert.ok(
  text.includes('会员服务未连接：${BACKEND_URL}'),
  'non-local/production backend failures should fail closed'
);

console.log(JSON.stringify({ ok: true, checks: [
  'localhost_backend_fallback_is_present',
  'direct_relay_settings_required',
  'fallback_can_be_disabled',
  'production_backend_fails_closed',
  'engine_starts_after_backend_probe',
] }, null, 2));
