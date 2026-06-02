'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function jsonFetch(baseUrl, pathname, { method = 'GET', token, body, expect = 200 } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  assert.strictEqual(res.status, expect, `${method} ${pathname} expected ${expect}, got ${res.status}: ${text}`);
  return data;
}

async function waitForHealth(baseUrl, child, logs) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited early (${child.exitCode}): ${logs.join('\n')}`);
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok && (await res.text()) === 'ok') return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy: ${logs.join('\n')}`);
}

function createFakeUpstream() {
  return http.createServer((req, res) => {
    res.writeHead(404);
    res.end('not used');
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskagent-manual-pay-off-'));
  const upstream = createFakeUpstream();
  const upstreamPort = await freePort();
  await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const serverPort = await freePort();
  const serverBin = path.join(ROOT, 'server', 'target', 'debug', 'deskagent-server');
  assert.ok(fs.existsSync(serverBin), `missing built server binary: ${serverBin}`);
  const logs = [];
  const child = spawn(serverBin, [], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      DATABASE_URL: `sqlite://${path.join(tmp, 'deskagent.db')}?mode=rwc`,
      BIND_ADDR: `127.0.0.1:${serverPort}`,
      UPSTREAM_PROVIDER: 'openai',
      OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      OPENAI_API_KEY: 'test-upstream-key',
      USER_JWT_SECRET: 'test-user-secret',
      ADMIN_JWT_SECRET: 'test-admin-secret',
      ADMIN_BOOTSTRAP_USER: 'admin',
      ADMIN_BOOTSTRAP_PASS: 'admin123',
      SMS_PROVIDER: 'mock',
      SMS_EXPOSE_MOCK_CODE: 'true',
      SMS_MOCK_CODE: '246810',
      SMS_SEND_COOLDOWN_SECS: '0',
      FREE_TURNS: '0',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logs.push(d.toString().trim()));
  child.stderr.on('data', (d) => logs.push(d.toString().trim()));
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  try {
    await waitForHealth(baseUrl, child, logs);
    const adminLogin = await jsonFetch(baseUrl, '/admin/api/login', {
      method: 'POST',
      body: { username: 'admin', password: 'admin123' },
    });
    const adminPackages = await jsonFetch(baseUrl, '/admin/api/packages', { token: adminLogin.token });
    const pkg = adminPackages.packages[0];

    await jsonFetch(baseUrl, '/auth/sms/send', {
      method: 'POST',
      body: { phone: '13800138001' },
    });
    const userLogin = await jsonFetch(baseUrl, '/auth/sms/verify', {
      method: 'POST',
      body: { phone: '13800138001', code: '246810' },
    });

    const manual = await jsonFetch(baseUrl, '/api/orders', {
      method: 'POST',
      token: userLogin.token,
      body: { package_id: pkg.id, provider: 'manual' },
      expect: 403,
    });
    assert.strictEqual(manual.error.code, 'manual_pay_disabled');

    const order = await jsonFetch(baseUrl, '/api/orders', {
      method: 'POST',
      token: userLogin.token,
      body: { package_id: pkg.id, provider: 'wechat' },
    });
    assert.strictEqual(order.provider, 'wechat');
    assert.ok(order.out_trade_no);

    const me = await jsonFetch(baseUrl, '/api/me', { token: userLogin.token });
    assert.deepStrictEqual(me.entitlements, []);

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'manual_payment_disabled_by_default',
        'wechat_order_does_not_grant_without_webhook',
      ],
    }, null, 2));
  } finally {
    child.kill('SIGTERM');
    upstream.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
