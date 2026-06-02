'use strict';
const assert = require('assert');
const { Engine } = require('../app/src/main/engine');

function runTurn(engine, threadId, turnId, text) {
  engine._onNotification('turn/started', { threadId, turn: { id: turnId } });
  engine._onNotification('item/agentMessage/delta', { threadId, itemId: 'msg_0', delta: text.slice(0, 2) });
  engine._onNotification('item/agentMessage/delta', { threadId, itemId: 'msg_0', delta: text.slice(2) });
  engine._onNotification('item/completed', {
    threadId,
    item: { id: 'msg_0', type: 'agentMessage', text },
  });
  engine._onNotification('turn/completed', { threadId, turn: { id: turnId } });
}

const engine = new Engine({
  agentHome: '/tmp/deskagent-engine-stream-scope',
  workspaceDir: '/tmp',
  settings: () => ({}),
});

const observed = { deltas: [], messages: [] };
engine.on('delta', (payload) => observed.deltas.push(payload));
engine.on('message', (payload) => observed.messages.push(payload));

runTurn(engine, 'thread-1', 'turn-1', '第一轮回复');
runTurn(engine, 'thread-1', 'turn-2', '第二轮回复');

assert.strictEqual(observed.deltas.length, 4);
assert.strictEqual(observed.messages.length, 2);
assert.notStrictEqual(observed.messages[0].itemId, observed.messages[1].itemId);
assert.strictEqual(observed.messages[0].itemId, 'turn-1:msg_0');
assert.strictEqual(observed.messages[1].itemId, 'turn-2:msg_0');
assert.strictEqual(observed.messages[0].text, '第一轮回复');
assert.strictEqual(observed.messages[1].text, '第二轮回复');
assert.strictEqual(observed.deltas[1].itemId, observed.messages[0].itemId);
assert.strictEqual(observed.deltas[3].itemId, observed.messages[1].itemId);
assert.strictEqual(observed.deltas[1].text, '第一轮回复');
assert.strictEqual(observed.deltas[3].text, '第二轮回复');

console.log(JSON.stringify({
  ok: true,
  checks: [
    'same_upstream_item_id_scoped_by_turn',
    'second_turn_does_not_overwrite_first_bubble',
    'completed_message_reuses_delta_bubble',
  ],
}, null, 2));
