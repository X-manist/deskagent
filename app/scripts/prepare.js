'use strict';
// Copies the single-source adapter into src/vendor so packaged builds bundle it.
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.resolve(__dirname, '..');
const src = path.resolve(root, '..', 'adapter', 'responses-adapter.js');
const destDir = path.join(root, 'src', 'vendor');
const dest = path.join(destDir, 'responses-adapter.js');
const envSrc = path.resolve(root, '..', '.env');
const envDest = path.join(root, 'resources', '.env');
const mcpSrc = path.join(root, 'src', 'mcp', 'deskagent-mcp.js');
const mcpDest = path.join(root, 'resources', 'deskagent-mcp.js');

function cliValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

const targetPlatform = cliValue('platform') || process.env.DESKAGENT_TARGET_PLATFORM || process.platform;
const targetArch = cliValue('arch') || process.env.DESKAGENT_TARGET_ARCH || process.arch;

function targetKey() {
  return `${targetPlatform}:${targetArch}`;
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`[prepare] copied adapter -> ${path.relative(root, dest)}`);
if (fs.existsSync(envSrc)) {
  fs.mkdirSync(path.dirname(envDest), { recursive: true });
  fs.copyFileSync(envSrc, envDest);
  console.log(`[prepare] copied .env -> ${path.relative(root, envDest)}`);
}
if (fs.existsSync(mcpSrc)) {
  fs.mkdirSync(path.dirname(mcpDest), { recursive: true });
  fs.copyFileSync(mcpSrc, mcpDest);
  console.log(`[prepare] copied deskagent-mcp -> ${path.relative(root, mcpDest)}`);
}

// Bundle the agent runtime binary for the current platform so the packaged app is
// self-contained (one-click install). For cross-platform release builds,
// download/copy the matching native runtime binary into app/resources/bin/.
const { execSync } = require('child_process');
const binDir = path.join(root, 'resources', 'bin');
fs.mkdirSync(binDir, { recursive: true });
const exe = targetPlatform === 'win32' ? 'deskagent-core.exe' : 'deskagent-core';
const target = path.join(binDir, exe);

const TRIPLE_BY_PLATFORM = {
  'darwin:arm64': 'aarch64-apple-darwin',
  'darwin:x64': 'x86_64-apple-darwin',
  'linux:x64': 'x86_64-unknown-linux-musl',
  'linux:arm64': 'aarch64-unknown-linux-musl',
  'win32:x64': 'x86_64-pc-windows-msvc',
  'win32:arm64': 'aarch64-pc-windows-msvc',
};
const PKG_BY_PLATFORM = {
  'darwin:arm64': 'codex-darwin-arm64',
  'darwin:x64': 'codex-darwin-x64',
  'linux:x64': 'codex-linux-x64',
  'linux:arm64': 'codex-linux-arm64',
  'win32:x64': 'codex-win32-x64',
  'win32:arm64': 'codex-win32-arm64',
};

function resolveNativeRuntime() {
  // Highest priority: an explicitly provided branded runtime binary.
  if (process.env.DESKAGENT_RUNTIME_BIN && fs.existsSync(process.env.DESKAGENT_RUNTIME_BIN)) {
    return process.env.DESKAGENT_RUNTIME_BIN;
  }
  // Next: a from-source branded build produced by core/codex/codex-rs.
  const builtName = targetPlatform === 'win32' ? 'deskagent-core.exe' : 'deskagent-core';
  const triple = TRIPLE_BY_PLATFORM[targetKey()];
  const builtCandidates = [
    path.join(binDir, builtName),
    triple ? path.resolve(root, '..', 'core', 'codex', 'codex-rs', 'target', triple, 'release', builtName) : '',
    targetPlatform === process.platform && targetArch === process.arch
      ? path.resolve(root, '..', 'core', 'codex', 'codex-rs', 'target', 'release', builtName)
      : '',
    path.join(root, 'release', 'win-unpacked', 'resources', 'bin', builtName),
  ].filter(Boolean);
  const builtPath = builtCandidates.find((candidate) => fs.existsSync(candidate));
  if (builtPath) return builtPath;

  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  let launcher = '';
  try {
    launcher = execSync(process.platform === 'win32' ? 'where codex' : 'command -v codex')
      .toString().trim().split(/\r?\n/)[0];
  } catch (_) { return ''; }
  if (!launcher) return '';
  try { launcher = fs.realpathSync(launcher); } catch (_) {}
  // If it's already a real (large) binary, use it directly.
  try {
    if (fs.statSync(launcher).size > 5 * 1024 * 1024) return launcher;
  } catch (_) {}
  // Otherwise it's the npm JS launcher: derive the native platform package.
  const key = targetKey();
  const packageTriple = TRIPLE_BY_PLATFORM[key];
  const platPkg = PKG_BY_PLATFORM[key];
  if (!packageTriple || !platPkg) return '';
  const pkgRoot = path.dirname(path.dirname(launcher));
  const nativeExe = targetPlatform === 'win32' ? 'codex.exe' : 'codex';
  const candidate = path.join(
    pkgRoot, 'node_modules', '@openai', platPkg, 'vendor', packageTriple, 'bin', nativeExe
  );
  return fs.existsSync(candidate) ? candidate : '';
}

function cleanManagedBinaries() {
  for (const name of ['deskagent-core', 'deskagent-core.exe', 'deskagent-os-tools', 'deskagent-os-tools.exe']) {
    try { fs.rmSync(path.join(binDir, name), { force: true }); } catch (_) {}
  }
}

cleanManagedBinaries();

// On macOS, re-sign the bundled runtime under the product identity so neither
// the code-signing identifier nor the signing authority reveal the upstream
// runtime name in system (TCC) permission dialogs. Uses DESKAGENT_SIGN_IDENTITY
// when provided (recommended for release/notarization), otherwise ad-hoc.
function rebrandMacSignature(binPath) {
  if (process.platform !== 'darwin') return;
  const identity = process.env.DESKAGENT_SIGN_IDENTITY || '-';
  const identifier = process.env.DESKAGENT_BUNDLE_ID || 'com.zhijie.deskagent.core';
  const entPath = path.join(os.tmpdir(), `deskagent-ent-${process.pid}.plist`);
  let entArgs = '';
  try {
    execSync(`codesign -d --entitlements "${entPath}" --xml "${binPath}"`, { stdio: 'ignore' });
    if (fs.existsSync(entPath) && fs.statSync(entPath).size > 0) {
      entArgs = ` --entitlements "${entPath}"`;
    }
  } catch (_) { /* binary may be unsigned; continue without entitlements */ }
  try {
    execSync(
      `codesign --force --options runtime${entArgs} --identifier "${identifier}" ` +
      `--sign "${identity}" "${binPath}"`,
      { stdio: 'inherit' }
    );
    console.log(`[prepare] re-signed runtime as ${identifier} (identity: ${identity})`);
  } catch (e) {
    console.warn(`[prepare] WARNING: failed to re-sign runtime: ${e.message}`);
  } finally {
    try { fs.unlinkSync(entPath); } catch (_) {}
  }
}

const runtimePath = resolveNativeRuntime();
if (runtimePath && fs.existsSync(runtimePath)) {
  fs.copyFileSync(runtimePath, target);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
  rebrandMacSignature(target);
  const mb = (fs.statSync(target).size / 1048576).toFixed(0);
  console.log(`[prepare] bundled agent runtime (${runtimePath}, ${mb}MB) -> ${path.relative(root, target)}`);
} else {
  console.warn('[prepare] WARNING: native agent runtime binary not found; packaged app will not start until resources/bin/deskagent-core is provided.');
}

// Bundle the Rust OS automation helper used by the local desktop bridge. It is
// intentionally separate from the agent runtime: the MCP surface stays stable,
// while OS-level permission handling remains in the desktop app boundary.
function resolveOsToolsBinary() {
  const osToolsExe = targetPlatform === 'win32' ? 'deskagent-os-tools.exe' : 'deskagent-os-tools';
  if (process.env.DESKAGENT_OS_TOOLS_BIN && fs.existsSync(process.env.DESKAGENT_OS_TOOLS_BIN)) {
    return process.env.DESKAGENT_OS_TOOLS_BIN;
  }
  const crateDir = path.resolve(root, '..', 'native', 'os-tools');
  const triple = TRIPLE_BY_PLATFORM[targetKey()];
  const releaseBin = targetPlatform === process.platform && targetArch === process.arch
    ? path.join(crateDir, 'target', 'release', osToolsExe)
    : path.join(crateDir, 'target', triple || '', 'release', osToolsExe);
  if (!fs.existsSync(releaseBin)) {
    try {
      const targetArg = targetPlatform === process.platform && targetArch === process.arch ? '' : ` --target ${triple}`;
      if (!triple && targetPlatform !== process.platform) throw new Error(`unsupported target ${targetKey()}`);
      execSync(`cargo build --release${targetArg}`, { cwd: crateDir, stdio: 'inherit' });
    } catch (e) {
      console.warn(`[prepare] WARNING: failed to build Rust OS helper: ${e.message}`);
    }
  }
  return fs.existsSync(releaseBin) ? releaseBin : '';
}

const osToolsPath = resolveOsToolsBinary();
if (osToolsPath) {
  const osToolsTarget = path.join(binDir, targetPlatform === 'win32' ? 'deskagent-os-tools.exe' : 'deskagent-os-tools');
  fs.copyFileSync(osToolsPath, osToolsTarget);
  if (targetPlatform !== 'win32') fs.chmodSync(osToolsTarget, 0o755);
  const mb = (fs.statSync(osToolsTarget).size / 1048576).toFixed(1);
  console.log(`[prepare] bundled OS helper (${osToolsPath}, ${mb}MB) -> ${path.relative(root, osToolsTarget)}`);
} else {
  const message = `[prepare] Rust OS helper not found for ${targetKey()}; packaged desktop automation would be incomplete.`;
  if (process.env.DESKAGENT_ALLOW_MISSING_OS_TOOLS === '1') {
    console.warn(`${message} Continuing because DESKAGENT_ALLOW_MISSING_OS_TOOLS=1.`);
  } else {
    throw new Error(message);
  }
}
