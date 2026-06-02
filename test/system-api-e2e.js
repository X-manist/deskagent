'use strict';

const assert = require('assert');
const crypto = require('crypto');
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

function createFakeResponsesServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || (req.url !== '/v1/responses' && req.url !== '/v1/chat/completions')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk.toString(); });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      hits.push({ authorization: req.headers.authorization || '', path: req.url, body });

      if (body.test_mode === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'fake upstream failure' } }));
        return;
      }

      const total = Number(body.test_total_tokens || 1234);
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({
          id: `chatcmpl_${crypto.randomUUID()}`,
          choices: [{ delta: { content: 'hello from fake chat upstream' }, index: 0 }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: `chatcmpl_${crypto.randomUUID()}`,
          choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
          usage: { prompt_tokens: 100, completion_tokens: total - 100, total_tokens: total },
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const payload = {
        type: 'response.completed',
        response: {
          id: `resp_${crypto.randomUUID()}`,
          usage: { input_tokens: 100, output_tokens: total - 100, total_tokens: total },
        },
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: response.output_text.delta\n');
      res.write('data: {"type":"response.output_text.delta","delta":"hello from fake upstream"}\n\n');
      res.write('event: response.completed\n');
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.end();
    });
  });
  return { server, hits };
}

async function listen(server) {
  const port = await freePort();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return port;
}

async function waitForHealth(baseUrl, child, logs) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`server exited early (${child.exitCode}): ${logs.join('\n')}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok && (await res.text()) === 'ok') return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy: ${logs.join('\n')}`);
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

async function streamFetch(baseUrl, pathname, { token, body, expect = 200 } = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assert.strictEqual(res.status, expect, `POST ${pathname} expected ${expect}, got ${res.status}: ${text}`);
  return text;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskagent-api-e2e-'));
  const fake = createFakeResponsesServer();
  const upstreamPort = await listen(fake.server);
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
      GLM_API_KEY: '',
      GLM_BASE_URL: '',
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
      ALLOW_MANUAL_PAY: 'true',
      FREE_TURNS: '2',
      RESERVE_TOKENS: '4000',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      RUST_LOG: 'info,deskagent_server=debug',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logs.push(d.toString().trim()));
  child.stderr.on('data', (d) => logs.push(d.toString().trim()));

  const baseUrl = `http://127.0.0.1:${serverPort}`;
  try {
    await waitForHealth(baseUrl, child, logs);

    await jsonFetch(baseUrl, '/admin/api/login', {
      method: 'POST',
      body: { username: 'admin', password: 'wrong' },
      expect: 401,
    });
    const adminLogin = await jsonFetch(baseUrl, '/admin/api/login', {
      method: 'POST',
      body: { username: 'admin', password: 'admin123' },
    });
    assert.ok(adminLogin.token);
    const adminToken = adminLogin.token;

    const initialStats = await jsonFetch(baseUrl, '/admin/api/stats', { token: adminToken });
    assert.strictEqual(initialStats.users_total, 0);

    const adminPackages = await jsonFetch(baseUrl, '/admin/api/packages', { token: adminToken });
    assert.ok(adminPackages.packages.length >= 3);
    const basePackage = adminPackages.packages[0];

    const createdPkg = await jsonFetch(baseUrl, '/admin/api/packages', {
      method: 'POST',
      token: adminToken,
      body: {
        name: '系统测试临时套餐',
        model: 'system-e2e-model',
        total_tokens: 8888,
        price_cents: 88,
        duration_days: 7,
        active: true,
        sort_order: 99,
      },
    });
    assert.ok(createdPkg.id);
    await jsonFetch(baseUrl, `/admin/api/packages/${createdPkg.id}`, {
      method: 'PUT',
      token: adminToken,
      body: {
        name: '系统测试临时套餐-下架',
        model: 'system-e2e-model',
        total_tokens: 9999,
        price_cents: 99,
        duration_days: 8,
        active: false,
        sort_order: 99,
      },
    });

    await jsonFetch(baseUrl, '/auth/sms/send', {
      method: 'POST',
      body: { phone: '100' },
      expect: 400,
    });
    const sms = await jsonFetch(baseUrl, '/auth/sms/send', {
      method: 'POST',
      body: { phone: '13800138000' },
    });
    assert.strictEqual(sms.mock, true);
    assert.strictEqual(sms.dev_code, '246810');

    await jsonFetch(baseUrl, '/auth/sms/verify', {
      method: 'POST',
      body: { phone: '13800138000', code: '000000' },
      expect: 401,
    });
    const userLogin = await jsonFetch(baseUrl, '/auth/sms/verify', {
      method: 'POST',
      body: { phone: '13800138000', code: '246810' },
    });
    assert.ok(userLogin.token);
    assert.strictEqual(userLogin.is_new, true);
    const userToken = userLogin.token;

    const publicPackages = await jsonFetch(baseUrl, '/api/packages');
    assert.ok(publicPackages.packages.some((p) => p.id === basePackage.id));
    assert.ok(!publicPackages.packages.some((p) => p.id === createdPkg.id));

    const meBefore = await jsonFetch(baseUrl, '/api/me', { token: userToken });
    assert.strictEqual(meBefore.free_turns_remaining, 2);
    assert.deepStrictEqual(meBefore.entitlements, []);

    const order = await jsonFetch(baseUrl, '/api/orders', {
      method: 'POST',
      token: userToken,
      body: { package_id: basePackage.id, provider: 'manual' },
    });
    assert.ok(order.out_trade_no);
    assert.strictEqual(order.provider, 'manual');

    const grant = await jsonFetch(baseUrl, `/api/orders/${order.out_trade_no}/confirm`, {
      method: 'POST',
      token: userToken,
    });
    assert.deepStrictEqual(grant, { ok: true, granted: true });
    const grantAgain = await jsonFetch(baseUrl, `/api/orders/${order.out_trade_no}/confirm`, {
      method: 'POST',
      token: userToken,
    });
    assert.deepStrictEqual(grantAgain, { ok: true, granted: false });

    const mePaid = await jsonFetch(baseUrl, '/api/me', { token: userToken });
    assert.ok(mePaid.entitlements.some((e) => e.model === basePackage.model));

    const stream = await streamFetch(baseUrl, '/v1/responses', {
      token: userToken,
      body: {
        model: basePackage.model,
        stream: true,
        input: 'system e2e metering smoke',
        test_total_tokens: 1234,
      },
    });
    assert.ok(stream.includes('hello from fake upstream'));
    assert.strictEqual(fake.hits.length, 1);
    assert.strictEqual(fake.hits[0].authorization, 'Bearer test-upstream-key');
    assert.strictEqual(fake.hits[0].path, '/v1/responses');

    const meAfterUsage = await jsonFetch(baseUrl, '/api/me', { token: userToken });
    const entitlement = meAfterUsage.entitlements.find((e) => e.model === basePackage.model);
    assert.ok(entitlement);
    assert.strictEqual(entitlement.tokens_used, 1234);

    const failText = await streamFetch(baseUrl, '/v1/responses', {
      token: userToken,
      expect: 500,
      body: { model: basePackage.model, stream: true, input: 'fail', test_mode: 'fail' },
    });
    assert.ok(failText.includes('fake upstream failure'));
    const meAfterFail = await jsonFetch(baseUrl, '/api/me', { token: userToken });
    const entitlementAfterFail = meAfterFail.entitlements.find((e) => e.model === basePackage.model);
    assert.strictEqual(entitlementAfterFail.tokens_used, 1234);

    const chatStream = await streamFetch(baseUrl, '/v1/chat/completions', {
      token: userToken,
      body: {
        model: basePackage.model,
        stream: true,
        messages: [{ role: 'user', content: 'system e2e chat metering smoke' }],
        test_total_tokens: 4321,
      },
    });
    assert.ok(chatStream.includes('hello from fake chat upstream'));
    assert.strictEqual(fake.hits.at(-1).path, '/v1/chat/completions');
    const meAfterChat = await jsonFetch(baseUrl, '/api/me', { token: userToken });
    const entitlementAfterChat = meAfterChat.entitlements.find((e) => e.model === basePackage.model);
    assert.strictEqual(entitlementAfterChat.tokens_used, 1234 + 4321);

    const users = await jsonFetch(baseUrl, '/admin/api/users', { token: adminToken });
    assert.strictEqual(users.users.length, 1);
    assert.strictEqual(users.users[0].phone, '13800138000');
    assert.ok(users.users[0].tokens >= 1234);

    const orders = await jsonFetch(baseUrl, '/admin/api/orders', { token: adminToken });
    assert.ok(orders.orders.some((o) => o.out_trade_no === order.out_trade_no && o.status === 'granted'));

    const audit = await jsonFetch(baseUrl, '/admin/api/audit', { token: adminToken });
    assert.ok(audit.audit.some((a) => a.action === 'create_package'));
    assert.ok(audit.audit.some((a) => a.action === 'update_package'));
    assert.ok(audit.audit.some((a) => a.action === 'grant_order'));

    const finalStats = await jsonFetch(baseUrl, '/admin/api/stats', { token: adminToken });
    assert.strictEqual(finalStats.users_total, 1);
    assert.strictEqual(finalStats.orders_paid, 1);
    assert.ok(finalStats.tokens_total >= 1234);

    console.log(JSON.stringify({
      ok: true,
      server: baseUrl,
      checks: [
        'admin_login_and_auth_guard',
        'admin_stats_users_orders_packages_audit',
        'package_create_update_and_public_visibility',
        'mock_sms_login',
        'manual_payment_idempotent_grant',
        'gateway_streaming_metering',
        'gateway_upstream_failure_refund',
        'gateway_chat_completions_metering',
      ],
    }, null, 2));
  } finally {
    child.kill('SIGTERM');
    fake.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
