'use strict';
// Behavioral regression test for the renderer send path. It executes the real
// renderer script against a tiny DOM/IPC harness and verifies that Send/Enter do
// not no-op when no active conversation has been selected yet.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rendererPath = path.join(__dirname, '..', 'app', 'src', 'renderer', 'renderer.js');
const rendererSource = fs.readFileSync(rendererPath, 'utf8');

class ClassList {
  constructor() {
    this.values = new Set();
  }
  add(...names) {
    names.forEach((name) => this.values.add(name));
  }
  remove(...names) {
    names.forEach((name) => this.values.delete(name));
  }
  toggle(name, force) {
    if (force === true) this.add(name);
    else if (force === false) this.remove(name);
    else if (this.values.has(name)) this.values.delete(name);
    else this.values.add(name);
  }
  contains(name) {
    return this.values.has(name);
  }
}

class Element {
  constructor(id = '') {
    this.id = id;
    this.children = [];
    this.listeners = new Map();
    this.classList = new ClassList();
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._innerHTML = '';
  }
  set innerHTML(value) {
    this._innerHTML = String(value || '');
    this.children = [];
    if (this._innerHTML.includes('class="welcome"')) {
      const welcome = new Element();
      welcome.className = 'welcome';
      this.appendChild(welcome);
    }
    if (this._innerHTML.includes('class="send-btn"')) {
      const button = new Element();
      button.tagName = 'BUTTON';
      button.className = 'send-btn';
      this.appendChild(button);
    }
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set className(value) {
    this._className = value;
    this.classList = new ClassList();
    String(value || '').split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name));
  }
  get className() {
    return this._className || '';
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
  }
  querySelector(selector) {
    const findDeep = (predicate) => {
      const stack = [...this.children];
      while (stack.length) {
        const child = stack.shift();
        if (predicate(child)) return child;
        stack.push(...(child.children || []));
      }
      return null;
    };
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return findDeep((child) => child.classList && child.classList.contains(cls));
    }
    if (selector === 'button') {
      return findDeep((child) => child.tagName === 'BUTTON');
    }
    const tag = selector.toUpperCase();
    if (tag === 'DETAILS' || tag === 'SUMMARY') {
      return findDeep((child) => child.tagName === tag);
    }
    return null;
  }
  querySelectorAll() {
    return [];
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatchEvent(event) {
    const handlers = this.listeners.get(event.type) || [];
    const results = handlers.map((handler) => handler(event));
    return Promise.all(results);
  }
  focus() {}
}

function textOf(el) {
  if (!el) return '';
  return [el.textContent || '', ...el.children.map(textOf)].join('');
}

class TestEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
    this.defaultPrevented = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {}
}

const ids = [
  'messages', 'input', 'sendBtn', 'stopBtn', 'statusDot', 'statusText', 'modelTag',
  'sessions', 'newSessionBtn', 'attachments', 'attachBtn', 'attachMenu', 'openWorkspace',
  'openSettings', 'settingsModal', 'cancelSettings', 'settingsModel', 'settingsWorkspace',
  'skills', 'loginOverlay', 'accountModal', 'member',
  'sendCodeBtn', 'loginPhone', 'loginCode', 'loginErr', 'loginBtn', 'accountInfo',
  'packageList', 'accountErr', 'closeAccount', 'logoutBtn', 'cancelSettings',
];

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function runScenario({ trigger, currentThreadOnSend }) {
  const elements = new Map(ids.map((id) => [id, new Element(id)]));
  const events = new Map();
  let listCalls = 0;
  let newSessionCalls = 0;
  const sendCalls = [];
  const orderCalls = [];
  const confirmCalls = [];

  const document = {
    body: new Element('body'),
    querySelector(selector) {
      if (selector.startsWith('#')) {
        const id = selector.slice(1);
        if (!elements.has(id)) elements.set(id, new Element(id));
        return elements.get(id);
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    createElement(tagName = '') {
      const el = new Element();
      el.tagName = String(tagName || '').toUpperCase();
      return el;
    },
    addEventListener() {},
  };

  const window = {
    addEventListener() {},
    api: {
      bootstrap: async () => ({
        currentThreadId: null,
        settings: { model: 'test-model', baseUrl: '', apiKey: '' },
        skills: [],
      }),
      listSessions: async () => {
        listCalls += 1;
        const id = listCalls >= 2 ? currentThreadOnSend : null;
        return {
          currentThreadId: id,
          sessions: id ? [{ id, preview: '新会话', createdAt: 1, updatedAt: 1 }] : [],
        };
      },
      newSession: async () => {
        newSessionCalls += 1;
        return { ok: true, threadId: 'thread-created' };
      },
      send: async (text, attachments, threadId) => {
        sendCalls.push({ text, attachments, threadId });
        return { ok: true, threadId };
      },
      interrupt: async () => ({ ok: true }),
      resumeSession: async (threadId) => ({ ok: true, threadId, messages: [] }),
      pickAttachments: async () => ({ canceled: true, items: [] }),
      getPathForFile: () => '',
      openWorkspace: async () => ({ ok: true }),
      auth: {
        status: async () => ({ loggedIn: true, phone: '13800138000' }),
        me: async () => ({ entitlements: [], free_turns_remaining: 0 }),
        sendSms: async () => ({}),
        verifySms: async () => ({}),
        packages: async () => ({ packages: [{ id: 7, name: '测试套餐', model: 'glm-5.1', total_tokens: 1000, token_multiplier: 1, duration_days: 30, price_yuan: '9.90' }] }),
        createOrder: async (packageId, provider) => {
          orderCalls.push({ packageId, provider });
          return { out_trade_no: 'ORDER_1', pay_info: { type: provider, pay_url: null } };
        },
        confirmOrder: async (outTradeNo) => {
          confirmCalls.push(outTradeNo);
          return {};
        },
        logout: async () => ({}),
      },
      on: (channel, cb) => events.set(channel, cb),
    },
  };

  const context = {
    window,
    document,
    console,
    Event: TestEvent,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;

  vm.runInNewContext(rendererSource, context, { filename: rendererPath });
  await flush();
  events.get('engine:status')({ state: 'ready' });
  await flush();

  const input = elements.get('input');
  input.value = trigger === 'click' ? 'click send works' : 'enter send works';
  if (trigger === 'click') {
    await elements.get('sendBtn').dispatchEvent(new TestEvent('click'));
  } else {
    await input.dispatchEvent(new TestEvent('keydown', { key: 'Enter', shiftKey: false }));
  }
  await flush();

  return { elements, events, sendCalls, listCalls, newSessionCalls, orderCalls, confirmCalls };
}

(async () => {
  const click = await runScenario({ trigger: 'click', currentThreadOnSend: 'thread-current' });
  assert.strictEqual(click.sendCalls.length, 1, 'click should call chat:send');
  assert.strictEqual(click.sendCalls[0].text, 'click send works');
  assert.strictEqual(click.sendCalls[0].threadId, 'thread-current');
  assert.strictEqual(click.newSessionCalls, 0, 'click path should reuse runtime current thread');

  const enter = await runScenario({ trigger: 'enter', currentThreadOnSend: null });
  assert.strictEqual(enter.sendCalls.length, 1, 'Enter should call chat:send');
  assert.strictEqual(enter.sendCalls[0].text, 'enter send works');
  assert.strictEqual(enter.sendCalls[0].threadId, 'thread-created');
  assert.strictEqual(enter.newSessionCalls, 1, 'Enter path should create thread when runtime has none');

  const purchase = await runScenario({ trigger: 'click', currentThreadOnSend: 'thread-current' });
  await purchase.elements.get('member').dispatchEvent(new TestEvent('click'));
  await flush();
  const buyButton = purchase.elements.get('packageList').querySelector('button');
  assert.ok(buyButton, 'account package should render buy button');
  await buyButton.dispatchEvent(new TestEvent('click'));
  await flush();
  assert.deepStrictEqual(purchase.orderCalls, [{ packageId: 7, provider: 'wechat' }]);
  assert.deepStrictEqual(purchase.confirmCalls, [], 'renderer must not grant quota before real payment confirmation');

  const activity = await runScenario({ trigger: 'click', currentThreadOnSend: 'thread-current' });
  const activityEvent = activity.events.get('chat:activity');
  activityEvent({ threadId: 'thread-current', kind: 'mcp', phase: 'started', text: 'codex.list_mcp_resource_templates' });
  activityEvent({ threadId: 'thread-current', kind: 'command', phase: 'started', text: 'internal command' });
  activityEvent({ threadId: 'thread-current', kind: 'reasoning', phase: 'completed', text: '内部思考摘要' });
  await flush();
  const messagesText = textOf(activity.elements.get('messages'));
  assert.ok(!messagesText.includes('codex.list_mcp_resource_templates'), 'internal tool names must stay hidden');
  assert.ok(!messagesText.includes('internal command'), 'internal commands must stay hidden');
  assert.ok(messagesText.includes('思考中'), 'reasoning should render as a collapsed details label');
  assert.ok(messagesText.includes('内部思考摘要'), 'reasoning body should remain available after expanding');
  assert.ok(activity.elements.get('messages').querySelector('details'), 'reasoning should use a details element');

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'click_send_without_active_conversation',
      'enter_send_without_active_conversation',
      'current_thread_reused',
      'new_thread_created_when_missing',
      'purchase_creates_wechat_order',
      'purchase_does_not_manual_confirm',
      'internal_tools_hidden_from_transcript',
      'reasoning_rendered_as_collapsed_details',
    ],
  }, null, 2));
})().catch((error) => {
  console.error('RENDERER_FIRST_SEND_BEHAVIOR_ERROR', error && error.stack ? error.stack : error);
  process.exit(1);
});
