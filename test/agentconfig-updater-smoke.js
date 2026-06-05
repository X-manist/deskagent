'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { installAgentConfigFromDir } = require('../app/src/main/agentconfig-updater');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskagent-agentconfig-smoke-'));
const bundled = path.join(root, 'bundled');
const remote = path.join(root, 'remote');
const home = path.join(root, 'home');

write(path.join(bundled, 'skills', 'find-skills', 'SKILL.md'), 'bundled find');
write(path.join(bundled, 'rules', 'base.md'), 'bundled rule');

let result = installAgentConfigFromDir({ sourceDir: bundled, agentHome: home, source: 'bundled' });
assert.equal(result.ok, true);
assert.equal(read(path.join(home, 'skills', 'find-skills', 'SKILL.md')), 'bundled find');

write(path.join(home, 'skills', 'user-flow', 'SKILL.md'), 'user dynamic skill');
write(path.join(remote, 'skills', 'find-skills', 'SKILL.md'), 'remote find');
write(path.join(remote, 'skills', 'new-skill', 'SKILL.md'), 'remote new');
write(path.join(remote, 'rules', 'base.md'), 'remote rule');

result = installAgentConfigFromDir({ sourceDir: remote, agentHome: home, source: 'remote' });
assert.equal(result.ok, true);
assert.equal(read(path.join(home, 'skills', 'find-skills', 'SKILL.md')), 'remote find');
assert.equal(read(path.join(home, 'skills', 'new-skill', 'SKILL.md')), 'remote new');
assert.equal(read(path.join(home, 'skills', 'user-flow', 'SKILL.md')), 'user dynamic skill');

write(path.join(home, 'skills', 'new-skill', 'SKILL.md'), 'locally edited remote skill');
fs.rmSync(path.join(remote, 'skills', 'new-skill', 'SKILL.md'));
result = installAgentConfigFromDir({ sourceDir: remote, agentHome: home, source: 'remote' });
assert.equal(result.ok, true);
assert.equal(read(path.join(home, 'skills', 'new-skill', 'SKILL.md')), 'locally edited remote skill');

write(path.join(remote, 'skills', 'temporary', 'SKILL.md'), 'remote temp');
installAgentConfigFromDir({ sourceDir: remote, agentHome: home, source: 'remote' });
assert.equal(read(path.join(home, 'skills', 'temporary', 'SKILL.md')), 'remote temp');
fs.rmSync(path.join(remote, 'skills', 'temporary', 'SKILL.md'));
installAgentConfigFromDir({ sourceDir: remote, agentHome: home, source: 'remote' });
assert.equal(fs.existsSync(path.join(home, 'skills', 'temporary', 'SKILL.md')), false);

console.log(JSON.stringify({ ok: true, root }));
