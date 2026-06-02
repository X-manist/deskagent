'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function snapshotDir(workspaceDir) {
  return path.join(workspaceDir, '.deskagent-snapshots');
}

function gitDir(workspaceDir) {
  return path.join(snapshotDir(workspaceDir), 'git');
}

function runGit(workspaceDir, args, options = {}) {
  return new Promise((resolve, reject) => {
    const finalArgs = [
      `--git-dir=${gitDir(workspaceDir)}`,
      `--work-tree=${workspaceDir}`,
      ...args,
    ];
    execFile('git', finalArgs, { cwd: workspaceDir, timeout: options.timeout || 30_000 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function ensureSnapshotRepo(workspaceDir) {
  if (!workspaceDir) throw new Error('工作区目录未初始化');
  ensureDir(workspaceDir);
  ensureDir(snapshotDir(workspaceDir));
  ensureDir(gitDir(workspaceDir));
  await runGit(workspaceDir, ['init']);
  await runGit(workspaceDir, ['config', 'user.name', 'DeskAgent']);
  await runGit(workspaceDir, ['config', 'user.email', 'deskagent@local']);
  await runGit(workspaceDir, ['config', 'core.autocrlf', 'false']);
  const infoDir = path.join(gitDir(workspaceDir), 'info');
  ensureDir(infoDir);
  fs.writeFileSync(path.join(infoDir, 'exclude'), [
    '.deskagent-snapshots/',
    '.git/',
    'node_modules/',
    '.DS_Store',
    '',
  ].join('\n'));
}

async function hasCommit(workspaceDir, ref = 'HEAD') {
  try {
    await runGit(workspaceDir, ['rev-parse', '--verify', ref]);
    return true;
  } catch (_) {
    return false;
  }
}

async function createWorkspaceCheckpoint(workspaceDir, label = 'Manual checkpoint') {
  await ensureSnapshotRepo(workspaceDir);
  await runGit(workspaceDir, ['add', '-A'], { timeout: 120_000 });
  try {
    await runGit(workspaceDir, ['diff', '--cached', '--quiet']);
    return { ok: true, created: false, message: '工作区没有新的变化' };
  } catch (e) {
    if (e && e.code !== 1) throw e;
  }
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  await runGit(workspaceDir, ['commit', '-m', `${label} (${timestamp})`], { timeout: 120_000 });
  const { stdout } = await runGit(workspaceDir, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, created: true, revision: stdout.trim(), message: '已保存工作区快照' };
}

async function rollbackWorkspace(workspaceDir) {
  await ensureSnapshotRepo(workspaceDir);
  if (!(await hasCommit(workspaceDir, 'HEAD'))) {
    throw new Error('请先保存一次工作区快照');
  }
  const status = await runGit(workspaceDir, ['status', '--porcelain'], { timeout: 120_000 });
  if (String(status.stdout || '').trim()) {
    await runGit(workspaceDir, ['reset', '--hard', 'HEAD'], { timeout: 120_000 });
    await runGit(workspaceDir, ['clean', '-fd', '-e', '.deskagent-snapshots/'], { timeout: 120_000 });
    const { stdout } = await runGit(workspaceDir, ['rev-parse', '--short', 'HEAD']);
    return { ok: true, revision: stdout.trim(), message: '已撤销到最近一次快照' };
  }
  if (!(await hasCommit(workspaceDir, 'HEAD~1'))) {
    throw new Error('没有可回退的上一个快照');
  }
  await runGit(workspaceDir, ['reset', '--hard', 'HEAD~1'], { timeout: 120_000 });
  await runGit(workspaceDir, ['clean', '-fd', '-e', '.deskagent-snapshots/'], { timeout: 120_000 });
  const { stdout } = await runGit(workspaceDir, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, revision: stdout.trim(), message: '已回退到上一个快照' };
}

module.exports = {
  createWorkspaceCheckpoint,
  ensureSnapshotRepo,
  rollbackWorkspace,
  snapshotDir,
};
