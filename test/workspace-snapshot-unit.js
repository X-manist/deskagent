'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createWorkspaceCheckpoint,
  rollbackWorkspace,
  snapshotDir,
} = require('../app/src/main/workspace');

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deskagent-workspace-snapshot-'));
  const file = path.join(workspace, 'note.txt');
  fs.writeFileSync(file, 'v1\n');

  const first = await createWorkspaceCheckpoint(workspace, 'first');
  assert.strictEqual(first.created, true);
  assert.ok(fs.existsSync(snapshotDir(workspace)));

  fs.writeFileSync(file, 'v2\n');
  const undoDirty = await rollbackWorkspace(workspace);
  assert.ok(undoDirty.ok);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'v1\n');

  fs.writeFileSync(file, 'v2\n');
  const second = await createWorkspaceCheckpoint(workspace, 'second');
  assert.strictEqual(second.created, true);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'v2\n');

  const rollback = await rollbackWorkspace(workspace);
  assert.ok(rollback.ok);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'v1\n');

  console.log(JSON.stringify({ ok: true, checks: ['checkpoint', 'undo_dirty', 'rollback_previous_snapshot'] }, null, 2));
})().catch((error) => {
  console.error('WORKSPACE_SNAPSHOT_UNIT_ERROR', error && error.stack ? error.stack : error);
  process.exit(1);
});
