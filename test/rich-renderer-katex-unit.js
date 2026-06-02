'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rendererPath = path.join(__dirname, '..', 'app', 'src', 'renderer', 'rich-renderer.js');
const source = fs.readFileSync(rendererPath, 'utf8');

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
  contains(name) {
    return this.values.has(name);
  }
}

class Node {
  constructor() {
    this.children = [];
    this.parentNode = null;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  querySelectorAll(selector) {
    const result = [];
    const className = selector.startsWith('.') ? selector.slice(1) : '';
    const visit = (node) => {
      if (className && node.classList && node.classList.contains(className)) result.push(node);
      (node.children || []).forEach(visit);
    };
    visit(this);
    return result;
  }
}

class TextNode extends Node {
  constructor(text) {
    super();
    this.nodeType = 3;
    this.textContent = text;
  }
}

class Element extends Node {
  constructor(tagName = 'div') {
    super();
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.listeners = new Map();
    this.style = {};
    this.attributes = new Map();
    this.classList = new ClassList();
    this._textContent = '';
  }
  set className(value) {
    this._className = value;
    this.classList = new ClassList();
    String(value || '').split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name));
  }
  get className() {
    return this._className || '';
  }
  set textContent(value) {
    this._textContent = String(value || '');
    this.children = [];
  }
  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent || '').join('');
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatchEvent(event) {
    return Promise.all((this.listeners.get(event.type) || []).map((handler) => handler(event)));
  }
}

(async () => {
  const katexCalls = [];
  const copied = [];
  const document = {
    body: new Element('body'),
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => new TextNode(text),
  };
  const window = {
    katex: {
      render(latex, target, options) {
        katexCalls.push({ latex, displayMode: options.displayMode });
        target.classList.add('katex-rendered');
        target.appendChild(document.createTextNode(`rendered:${latex}`));
      },
    },
  };
  const context = {
    window,
    document,
    navigator: { clipboard: { writeText: async (text) => copied.push(text) } },
    setTimeout: (fn) => fn(),
    console,
  };
  context.globalThis = context;

  vm.runInNewContext(source, context, { filename: rendererPath });

  const bubble = document.createElement('div');
  window.DeskAgentRichRenderer.renderMessageContent(
    bubble,
    'ai',
    '行内公式 $a^2+b^2=c^2$\n\n$$\\int_0^1 x\\,dx = \\frac{1}{2}$$'
  );

  assert.strictEqual(katexCalls.length, 2);
  assert.deepStrictEqual(katexCalls.map((call) => call.displayMode), [false, true]);
  assert.strictEqual(bubble.querySelectorAll('.math-copy').length, 2);
  assert.strictEqual(bubble.querySelectorAll('.math-block').length, 1);
  assert.strictEqual(bubble.querySelectorAll('.math-inline').length, 1);

  await bubble.querySelectorAll('.math-copy')[1].dispatchEvent({
    type: 'click',
    preventDefault() {},
    stopPropagation() {},
  });
  assert.strictEqual(copied[0], '\\int_0^1 x\\,dx = \\frac{1}{2}');

  console.log(JSON.stringify({ ok: true, checks: ['katex_render_called', 'math_copy_button', 'latex_copied'] }, null, 2));
})().catch((error) => {
  console.error('RICH_RENDERER_KATEX_UNIT_ERROR', error && error.stack ? error.stack : error);
  process.exit(1);
});
