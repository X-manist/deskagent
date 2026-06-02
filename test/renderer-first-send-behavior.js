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
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return this.children.find((child) => child.classList && child.classList.contains(cls)) || null;
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
    createElement() {
      return new Element();
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
        status: async () => ({ loggedIn: false }),
        me: async () => ({ entitlements: [], free_turns_remaining: 0 }),
        sendSms: async () => ({}),
        verifySms: async () => ({}),
        packages: async () => ({ packages: [] }),
        createOrder: async () => ({}),
        confirmOrder: async () => ({}),
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

  return { sendCalls, listCalls, newSessionCalls };
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

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'click_send_without_active_conversation',
      'enter_send_without_active_conversation',
      'current_thread_reused',
      'new_thread_created_when_missing',
    ],
  }, null, 2));
})().catch((error) => {
  console.error('RENDERER_FIRST_SEND_BEHAVIOR_ERROR', error && error.stack ? error.stack : error);
  process.exit(1);
});
