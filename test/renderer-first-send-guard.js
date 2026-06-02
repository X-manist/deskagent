'use strict';
// Static guard for the first-send UX: clicking Send or pressing Enter must not
// silently no-op when the renderer has not selected an active conversation yet.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const files = [
  path.join(__dirname, '..', 'app', 'src', 'renderer', 'renderer.js'),
  path.join(__dirname, '..', 'app', 'renderer.js'),
];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('async function ensureActiveConversation()'), `${file}: missing active conversation fallback`);
  assert.ok(text.includes('const data = await window.api.listSessions();'), `${file}: should reuse runtime currentThreadId`);
  assert.ok(text.includes('await window.api.newSession();'), `${file}: should create a thread if none exists`);
  assert.ok(text.includes('preparingSend'), `${file}: should guard duplicate sends while creating conversation`);
  assert.ok(
    !/if \(\(!text && !attachments\.length\) \|\| !engineReady \|\| !conv\) return;/.test(text),
    `${file}: send path still silently returns when activeConv is missing`
  );
  assert.ok(
    /inputEl\.addEventListener\('keydown'[\s\S]*return doSend\(\);/.test(text),
    `${file}: Enter key should execute the same send path`
  );
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    'renderer_ensures_active_conversation_before_send',
    'renderer_reuses_current_runtime_thread',
    'renderer_creates_new_thread_when_missing',
    'click_and_enter_share_send_path',
  ],
}, null, 2));
