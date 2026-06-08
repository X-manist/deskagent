const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function fakeElement(tagName) {
  return {
    tagName,
    className: '',
    textContent: '',
    children: [],
    parentElement: null,
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    closest(selector) {
      if (selector !== '.activity') return null;
      let node = this;
      while (node) {
        if (String(node.className || '').split(/\s+/).includes('activity')) return node;
        node = node.parentElement;
      }
      return null;
    },
  };
}

function rendererHelpers() {
  const source = read('app/src/renderer/renderer.js');
  const start = source.indexOf('function activitySummary');
  const end = source.indexOf('\n// Push an item to a conversation buffer', start);
  assert(start > 0 && end > start, 'renderer helper block is present');
  const context = {
    document: { createElement: fakeElement },
    activeId: 'thread-1',
    activeBubbles: new Map(),
    scrollToBottom() {},
    renderMessageContent() {},
    renderActive() {},
  };
  vm.runInNewContext(
    `${source.slice(start, end)}
this.helpers = {
  activitySummary,
  makeActivityEl,
  updateActivityEl,
  findMessageByItemId,
  shouldAppendMessageContinuation,
  makeMessageContinuation,
};`,
    context,
  );
  return { helpers: context.helpers, source };
}

const { helpers, source: rendererSource } = rendererHelpers();

const toolDisplay = '正在调用工具\nmcp.read_file\n结果：{"ok":true}';
const toolEl = helpers.makeActivityEl('tool', toolDisplay, true);
assert.strictEqual(toolEl.children[0].tagName, 'details', 'tool activity uses collapsed details');
assert.strictEqual(toolEl._activitySummary.textContent, '正在调用工具');
assert.strictEqual(toolEl._activityBody.textContent, toolDisplay);
assert(String(toolEl.className).includes('running'), 'running tool activity exposes spinner state');
assert.strictEqual(toolEl.children[0].children[0].children[0].className, 'activity-spinner', 'tool activity has spinner element');
helpers.updateActivityEl(toolEl, 'tool', '工具调用完成\nmcp.read_file', false);
assert.strictEqual(toolEl._activitySummary.textContent, '工具调用完成');
assert(!String(toolEl.className).includes('running'), 'completed tool activity clears spinner state');

const commandEl = helpers.makeActivityEl('command', '正在执行命令\nnpm test');
assert.strictEqual(commandEl.children[0].tagName, 'details', 'command activity uses collapsed details');
assert.strictEqual(commandEl._activitySummary.textContent, '正在执行命令');

const reasoningEl = helpers.makeActivityEl('reasoning', '内部推理摘要');
assert.strictEqual(reasoningEl._activitySummary.textContent, '思考中');

const oldAi = {
  kind: 'message',
  role: 'ai',
  text: '我先查一下',
  itemId: 'turn-1:agentMessage-1',
  streamText: '我先查一下',
  streaming: true,
};
const conv = {
  id: 'thread-1',
  items: [
    { kind: 'message', role: 'user', text: '问题' },
    oldAi,
    { kind: 'activity', activityKind: 'tool', display: toolDisplay, itemId: 'turn-1:mcpToolCall-1' },
  ],
};
const found = helpers.findMessageByItemId(conv, oldAi.itemId);
assert.strictEqual(found, oldAi, 'finds the previous AI item by id');
assert.strictEqual(helpers.shouldAppendMessageContinuation(conv, found), true, 'activity after an AI item starts a continuation');
const continuation = helpers.makeMessageContinuation(
  { itemId: oldAi.itemId, text: '我先查一下\n最终结果在工具后面' },
  oldAi,
  false,
);
assert.strictEqual(continuation.text, '最终结果在工具后面');
assert.strictEqual(continuation.streaming, false);

const noActivityConv = { id: 'thread-1', items: [{ ...oldAi }] };
assert.strictEqual(
  helpers.shouldAppendMessageContinuation(noActivityConv, noActivityConv.items[0]),
  false,
  'same message id still updates in place when no activity split exists',
);

const messageHandler = rendererSource.slice(
  rendererSource.indexOf("window.api.on('chat:message'"),
  rendererSource.indexOf("window.api.on('chat:activity'"),
);
assert(!messageHandler.includes("role === 'ai' && it.streaming"), 'final message no longer falls back to an older streaming bubble');

const engineSource = read('app/src/main/engine.js');
assert(engineSource.includes('syntheticItemSeq'), 'engine creates stable synthetic item ids');
assert(engineSource.includes('function hasRuntimeItemId'), 'engine distinguishes missing runtime item ids');
assert(!engineSource.includes("params.itemId || params.item_id || 'mcp'"), 'mcp progress does not collapse into a fixed fallback id');
assert(!engineSource.includes("params.itemId || params.item_id || 'command'"), 'command output does not collapse into a fixed fallback id');

console.log('renderer turn-order regression assertions passed');
