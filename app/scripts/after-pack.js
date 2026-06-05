'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const entitlements = path.join(appRoot, 'build', 'entitlements.mac.plist');

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function findAppBundle(appOutDir) {
  const direct = fs.readdirSync(appOutDir)
    .filter((name) => name.endsWith('.app'))
    .map((name) => path.join(appOutDir, name));
  if (direct.length > 0) return direct[0];
  return '';
}

function hasDeveloperIdSigningConfig() {
  if (
    (process.env.DESKAGENT_SIGN_IDENTITY && process.env.DESKAGENT_SIGN_IDENTITY !== '-') ||
    process.env.CSC_LINK ||
    process.env.CSC_NAME
  ) {
    return true;
  }
  try {
    const output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /Developer ID Application:/.test(output);
  } catch (_) {
    return false;
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appBundle = findAppBundle(context.appOutDir);
  if (!appBundle) {
    throw new Error(`[after-pack] macOS app bundle not found in ${context.appOutDir}`);
  }

  if (!hasDeveloperIdSigningConfig() || process.env.DESKAGENT_ADHOC_SIGN_MAC === '1') {
    console.log(`[after-pack] ad-hoc signing ${path.relative(appRoot, appBundle)}`);
    run('codesign', [
      '--force',
      '--deep',
      '--sign',
      '-',
      '--options',
      'runtime',
      '--entitlements',
      entitlements,
      appBundle,
    ]);
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]);
  } else {
    console.log('[after-pack] signing identity detected; electron-builder will handle macOS signing');
  }
};
