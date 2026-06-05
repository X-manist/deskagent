'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_REPO = 'https://github.com/X-manist/deskagent.git';
const DEFAULT_REF = 'main';
const DEFAULT_SUBDIR = 'agentconfig';
const MANIFEST_FILE = '.deskagent-agentconfig-managed.json';
const STATUS_FILE = '.deskagent-agentconfig-status.json';

function disabled(value) {
  return ['0', 'false', 'off', 'none', 'disabled', 'no'].includes(String(value || '').trim().toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeRelativePath(value, fallback) {
  const raw = String(value || fallback || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!raw || raw.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')) {
    return fallback;
  }
  return raw;
}

function remoteAgentConfigSettings(env = process.env) {
  const repo = String(env.DESKAGENT_AGENTCONFIG_REPO || DEFAULT_REPO).trim();
  const enabled = !disabled(env.DESKAGENT_AGENTCONFIG_UPDATE) && !!repo && !disabled(repo);
  return {
    enabled,
    repo,
    ref: String(env.DESKAGENT_AGENTCONFIG_REF || DEFAULT_REF).trim() || DEFAULT_REF,
    subdir: safeRelativePath(env.DESKAGENT_AGENTCONFIG_SUBDIR, DEFAULT_SUBDIR),
    intervalMs: positiveInt(env.DESKAGENT_AGENTCONFIG_UPDATE_INTERVAL_MS, 6 * 60 * 60 * 1000),
    startupWaitMs: positiveInt(env.DESKAGENT_AGENTCONFIG_STARTUP_WAIT_MS, 2500),
    gitTimeoutMs: positiveInt(env.DESKAGENT_AGENTCONFIG_GIT_TIMEOUT_MS, 60_000),
  };
}

function manifestPath(agentHome) {
  return path.join(agentHome, MANIFEST_FILE);
}

function statusPath(agentHome) {
  return path.join(agentHome, STATUS_FILE);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readManifest(agentHome) {
  const raw = readJson(manifestPath(agentHome), {});
  return {
    version: 1,
    files: raw && raw.files && typeof raw.files === 'object' ? raw.files : {},
  };
}

function writeManifest(agentHome, manifest) {
  writeJsonAtomic(manifestPath(agentHome), {
    version: 1,
    updatedAt: new Date().toISOString(),
    files: manifest.files || {},
  });
}

function readAgentConfigStatus(agentHome) {
  return readJson(statusPath(agentHome), { ok: false, reason: 'not-yet-synced' });
}

function writeStatus(agentHome, status) {
  const next = { updatedAt: new Date().toISOString(), ...status };
  writeJsonAtomic(statusPath(agentHome), next);
  return next;
}

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function walkFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const visit = (dir) => {
    for (const name of fs.readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
      if (name === '.git') continue;
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(file);
      } else if (stat.isFile()) {
        out.push(file);
      }
    }
  };
  visit(root);
  return out;
}

function relativeFrom(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function isRegularFile(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch (_) {
    return false;
  }
}

function copyManagedFile({ sourceFile, targetFile, rel, source, manifest, nextFiles }) {
  const sourceHash = fileSha256(sourceFile);
  const previous = manifest.files[rel];
  const targetPathExists = fs.existsSync(targetFile);
  if (targetPathExists && !isRegularFile(targetFile)) {
    if (previous) nextFiles[rel] = previous;
    return { copied: false, skipped: 'non-regular-target' };
  }
  const targetExists = targetPathExists && isRegularFile(targetFile);
  const targetHash = targetExists ? fileSha256(targetFile) : '';

  if (source === 'bundled' && previous && previous.source === 'remote' && targetExists) {
    nextFiles[rel] = previous;
    return { copied: false, skipped: 'remote-managed' };
  }

  if (!targetExists) {
    ensureDir(targetFile);
    fs.copyFileSync(sourceFile, targetFile);
    nextFiles[rel] = { sha256: sourceHash, source };
    return { copied: true };
  }

  if (previous) {
    if (targetHash === previous.sha256) {
      ensureDir(targetFile);
      fs.copyFileSync(sourceFile, targetFile);
      nextFiles[rel] = { sha256: sourceHash, source };
      return { copied: true };
    }
    if (targetHash === sourceHash) {
      nextFiles[rel] = { sha256: sourceHash, source };
      return { copied: false, skipped: 'already-current' };
    }
    nextFiles[rel] = previous;
    return { copied: false, skipped: 'local-change' };
  }

  if (targetHash === sourceHash) {
    nextFiles[rel] = { sha256: sourceHash, source };
    return { copied: false, skipped: 'already-current' };
  }

  return { copied: false, skipped: 'unmanaged-existing' };
}

function removeEmptyParents(root, startDir) {
  let current = startDir;
  while (current && current.startsWith(root) && current !== root) {
    try {
      fs.rmdirSync(current);
    } catch (_) {
      break;
    }
    current = path.dirname(current);
  }
}

function installAgentConfigFromDir({ sourceDir, agentHome, source = 'bundled', log = () => {} }) {
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    return { ok: false, skipped: true, reason: 'source-missing', sourceDir };
  }
  const manifest = readManifest(agentHome);
  const nextFiles = { ...manifest.files };
  const result = {
    ok: true,
    source,
    sourceDir,
    copied: 0,
    removed: 0,
    tracked: 0,
    skipped: 0,
    skippedLocalChanges: 0,
    skippedUnmanaged: 0,
  };
  const seen = new Set();

  for (const sourceFile of walkFiles(sourceDir)) {
    const rel = relativeFrom(sourceDir, sourceFile);
    seen.add(rel);
    const targetFile = path.join(agentHome, ...rel.split('/'));
    const item = copyManagedFile({ sourceFile, targetFile, rel, source, manifest, nextFiles });
    if (item.copied) result.copied += 1;
    if (item.skipped) {
      result.skipped += 1;
      if (item.skipped === 'local-change') result.skippedLocalChanges += 1;
      if (item.skipped === 'unmanaged-existing') result.skippedUnmanaged += 1;
    }
    if (nextFiles[rel]) result.tracked += 1;
  }

  for (const [rel, previous] of Object.entries(manifest.files)) {
    if (!previous || previous.source !== source || seen.has(rel)) continue;
    const targetFile = path.join(agentHome, ...rel.split('/'));
    if (!fs.existsSync(targetFile)) {
      delete nextFiles[rel];
      continue;
    }
    if (!isRegularFile(targetFile)) continue;
    const targetHash = fileSha256(targetFile);
    if (targetHash === previous.sha256) {
      fs.rmSync(targetFile, { force: true });
      removeEmptyParents(agentHome, path.dirname(targetFile));
      delete nextFiles[rel];
      result.removed += 1;
    } else {
      result.skipped += 1;
      result.skippedLocalChanges += 1;
    }
  }

  writeManifest(agentHome, { files: nextFiles });
  if (result.skippedLocalChanges || result.skippedUnmanaged) {
    log(`agentconfig ${source} 同步完成，保留了 ${result.skippedLocalChanges + result.skippedUnmanaged} 个本地文件`);
  }
  return result;
}

function gitAvailable() {
  return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
}

function gitEnv(env) {
  const out = { ...process.env };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    if (env[key]) out[key] = env[key];
  }
  const proxy = String(env.DESKAGENT_HTTP_PROXY || '').trim();
  if (proxy) {
    out.HTTP_PROXY = out.HTTP_PROXY || proxy;
    out.HTTPS_PROXY = out.HTTPS_PROXY || proxy;
    out.http_proxy = out.http_proxy || proxy;
    out.https_proxy = out.https_proxy || proxy;
  }
  out.GIT_TERMINAL_PROMPT = '0';
  return out;
}

function trimOutput(text) {
  const value = String(text || '').trim();
  return value.length > 4000 ? `${value.slice(0, 4000)}...` : value;
}

function runGit(args, { cwd, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: gitEnv(env || process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args.join(' ')} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: trimOutput(stdout), stderr: trimOutput(stderr) });
      } else {
        reject(new Error(`git ${args.join(' ')} failed (${code}): ${trimOutput(stderr || stdout)}`));
      }
    });
  });
}

async function prepareGitCache({ cacheDir, settings, env, log }) {
  const parent = path.dirname(cacheDir);
  fs.mkdirSync(parent, { recursive: true });
  const timeoutMs = settings.gitTimeoutMs;
  const gitDir = path.join(cacheDir, '.git');
  if (!fs.existsSync(gitDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    log(`正在克隆远程 agentconfig: ${settings.repo}`);
    await runGit(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', settings.repo, cacheDir], {
      cwd: parent,
      timeoutMs,
      env,
    });
  } else {
    await runGit(['remote', 'set-url', 'origin', settings.repo], { cwd: cacheDir, timeoutMs, env });
  }

  try {
    await runGit(['sparse-checkout', 'init', '--cone'], { cwd: cacheDir, timeoutMs, env });
    await runGit(['sparse-checkout', 'set', settings.subdir], { cwd: cacheDir, timeoutMs, env });
  } catch (error) {
    log(`git sparse-checkout 不可用，改用普通 checkout: ${error.message}`);
  }
  await runGit(['fetch', '--depth', '1', 'origin', settings.ref], { cwd: cacheDir, timeoutMs, env });
  await runGit(['checkout', '--detach', 'FETCH_HEAD'], { cwd: cacheDir, timeoutMs, env });
  const commit = (await runGit(['rev-parse', 'HEAD'], { cwd: cacheDir, timeoutMs, env })).stdout.trim();
  return { commit, sourceDir: path.join(cacheDir, ...settings.subdir.split('/')) };
}

async function updateAgentConfigFromGit({ agentHome, cacheDir, env = process.env, log = () => {} }) {
  const settings = remoteAgentConfigSettings(env);
  if (!settings.enabled) {
    return writeStatus(agentHome, { ok: true, skipped: true, reason: 'disabled' });
  }
  if (!gitAvailable()) {
    return writeStatus(agentHome, { ok: false, skipped: true, reason: 'git-not-found' });
  }
  try {
    const { commit, sourceDir } = await prepareGitCache({ cacheDir, settings, env, log });
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`远程仓库中没有 ${settings.subdir}/ 目录`);
    }
    const install = installAgentConfigFromDir({ sourceDir, agentHome, source: 'remote', log });
    return writeStatus(agentHome, {
      ok: true,
      repo: settings.repo,
      ref: settings.ref,
      subdir: settings.subdir,
      commit,
      install,
    });
  } catch (error) {
    log(`远程 agentconfig 更新失败：${error.message}`);
    return writeStatus(agentHome, {
      ok: false,
      repo: settings.repo,
      ref: settings.ref,
      subdir: settings.subdir,
      error: error.message,
    });
  }
}

module.exports = {
  installAgentConfigFromDir,
  readAgentConfigStatus,
  remoteAgentConfigSettings,
  updateAgentConfigFromGit,
};
