'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || headers.get(name.toLowerCase()) || '';
  return headers[name] || headers[name.toLowerCase()] || '';
}

function decodeHeaderValue(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function filenameFromDisposition(header) {
  const value = String(header || '');
  const encoded = value.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
  if (encoded) return decodeHeaderValue(encoded[1].trim().replace(/^"|"$/g, ''));
  const plain = value.match(/filename\s*=\s*("?)([^";]+)\1/i);
  return plain ? plain[2].trim() : '';
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const raw = path.basename(parsed.pathname || '');
    return decodeHeaderValue(raw);
  } catch (_) {
    return '';
  }
}

function sanitizeAttachmentFilename(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const fallback = cleaned && !/^\.+$/.test(cleaned) ? cleaned : 'download';
  const ext = path.extname(fallback).slice(0, 16);
  const stem = path.basename(fallback, ext).slice(0, 96) || 'download';
  return stem + ext;
}

function extensionForContentType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'text/csv': '.csv',
    'application/json': '.json',
    'application/zip': '.zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  };
  return map[type] || '';
}

function ensureExtension(filename, contentType) {
  if (path.extname(filename)) return filename;
  return filename + (extensionForContentType(contentType) || '');
}

function uniqueDestination(dir, filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let counter = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${counter}${ext}`);
    counter += 1;
  }
  return candidate;
}

function inferAttachmentKind(filename, contentType) {
  const type = String(contentType || '').toLowerCase();
  const ext = path.extname(filename || '').toLowerCase();
  return type.startsWith('image/') || IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file';
}

async function downloadUrlAttachment(rawUrl, options = {}) {
  const workspaceDir = options.workspaceDir;
  if (!workspaceDir) throw new Error('工作区目录未初始化');
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持下载 URL 附件');

  const url = new URL(String(rawUrl || '').trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 http 或 https 附件链接');
  }

  const maxBytes = Number(options.maxBytes || process.env.DESKAGENT_URL_ATTACHMENT_MAX_BYTES || DEFAULT_MAX_BYTES);
  const res = await fetchImpl(url.toString(), { redirect: 'follow' });
  if (!res || !res.ok) {
    const status = res && res.status ? ` (${res.status})` : '';
    throw new Error(`URL 附件下载失败${status}`);
  }

  const contentLength = Number(headerValue(res.headers, 'content-length') || 0);
  if (contentLength > maxBytes) throw new Error(`URL 附件超过大小限制 (${Math.round(maxBytes / 1024 / 1024)} MB)`);

  const contentType = headerValue(res.headers, 'content-type');
  const disposition = headerValue(res.headers, 'content-disposition');
  let filename = filenameFromDisposition(disposition) || filenameFromUrl(url.toString()) || 'download';
  filename = ensureExtension(sanitizeAttachmentFilename(filename), contentType);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`URL 附件超过大小限制 (${Math.round(maxBytes / 1024 / 1024)} MB)`);

  const dir = path.join(workspaceDir, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const destination = uniqueDestination(dir, filename);
  fs.writeFileSync(destination, buffer);

  return {
    kind: inferAttachmentKind(destination, contentType),
    path: destination,
    name: path.basename(destination),
    sourceUrl: url.toString(),
    size: buffer.length,
    contentType,
  };
}

module.exports = {
  downloadUrlAttachment,
  inferAttachmentKind,
  sanitizeAttachmentFilename,
};
