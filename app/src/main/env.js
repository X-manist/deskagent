'use strict';
const fs = require('fs');
const path = require('path');

function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnvFiles(candidates) {
  for (const file of candidates) {
    try {
      if (!file || !fs.existsSync(file)) continue;
      const values = parseEnvFile(fs.readFileSync(file, 'utf8'));
      for (const [key, value] of Object.entries(values)) {
        if (!(key in process.env)) process.env[key] = value;
      }
    } catch (_) {}
  }
}

function defaultEnvCandidates(baseDir) {
  return [
    path.join(baseDir, '.env'),
    path.join(baseDir, '..', '.env'),
    process.resourcesPath ? path.join(process.resourcesPath, '.env') : '',
    process.execPath ? path.join(path.dirname(process.execPath), '.env') : '',
  ].filter(Boolean);
}

module.exports = { loadEnvFiles, defaultEnvCandidates };
