'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const EXTRACTED_TEXT_MAX_CHARS = 60 * 1024;
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

function attachmentInputDir(workspaceDir) {
  return path.join(workspaceDir, 'input');
}

function inferAttachmentKind(filename, contentType) {
  const type = String(contentType || '').toLowerCase();
  const ext = path.extname(filename || '').toLowerCase();
  return type.startsWith('image/') || IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file';
}

function xmlDecode(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function findZipEnd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('无法读取 PPTX 文件结构');
}

function readZipEntry(buf, entry) {
  const offset = entry.localHeaderOffset;
  if (buf.readUInt32LE(offset) !== 0x04034b50) throw new Error('PPTX 文件头异常');
  const localNameLen = buf.readUInt16LE(offset + 26);
  const localExtraLen = buf.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + localNameLen + localExtraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) return raw;
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(raw);
  return Buffer.alloc(0);
}

function listZipEntries(buf) {
  const eocd = findZipEnd(buf);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < totalEntries; i += 1) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    entries.push({ name, compressionMethod, compressedSize, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractTextFromSlideXml(xml) {
  const out = [];
  const textRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let match;
  while ((match = textRe.exec(xml))) {
    const text = xmlDecode(match[1]).replace(/\s+/g, ' ').trim();
    if (text) out.push(text);
  }
  return out.join('\n');
}

function slideNumber(name) {
  const match = String(name || '').match(/slide(\d+)\.xml$/i);
  return match ? Number(match[1]) : 0;
}

function extractPptxText(filePath) {
  const buf = fs.readFileSync(filePath);
  const slides = listZipEntries(buf)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .sort((a, b) => slideNumber(a.name) - slideNumber(b.name));
  const parts = [];
  for (const slide of slides) {
    const xml = readZipEntry(buf, slide).toString('utf8');
    const text = extractTextFromSlideXml(xml);
    if (text) parts.push(`幻灯片 ${slideNumber(slide.name)}\n${text}`);
  }
  return parts.join('\n\n').trim();
}

function enrichAttachment(item) {
  if (!item || item.kind === 'directory' || !item.path) return item;
  const ext = path.extname(item.path).toLowerCase();
  if (ext !== '.pptx') return item;
  try {
    const extracted = extractPptxText(item.path);
    if (!extracted) return item;
    const textPath = uniqueDestination(path.dirname(item.path), `${path.basename(item.path)}.txt`);
    fs.writeFileSync(textPath, extracted);
    return {
      ...item,
      extractedText: extracted.slice(0, EXTRACTED_TEXT_MAX_CHARS),
      extractedTextTruncated: extracted.length > EXTRACTED_TEXT_MAX_CHARS,
      summaryPath: textPath,
    };
  } catch (e) {
    return {
      ...item,
      extractionError: (e && e.message) || 'PPTX 文本提取失败',
    };
  }
}

function copyLocalAttachment(sourcePath, kind, workspaceDir) {
  if (!workspaceDir) throw new Error('工作区目录未初始化');
  const source = path.resolve(String(sourcePath || ''));
  if (!source || !fs.existsSync(source)) throw new Error(`附件不存在：${sourcePath}`);
  const stat = fs.statSync(source);
  const dir = attachmentInputDir(workspaceDir);
  fs.mkdirSync(dir, { recursive: true });
  const safeName = sanitizeAttachmentFilename(path.basename(source));
  const destination = uniqueDestination(dir, safeName);
  if (stat.isDirectory()) {
    fs.cpSync(source, destination, { recursive: true });
    return {
      kind: 'directory',
      path: destination,
      name: path.basename(destination),
      originalPath: source,
    };
  }
  fs.copyFileSync(source, destination);
  const finalKind = kind === 'image' || kind === 'file'
    ? inferAttachmentKind(destination, kind === 'image' ? 'image/*' : '')
    : inferAttachmentKind(destination, '');
  return enrichAttachment({
    kind: finalKind,
    path: destination,
    name: path.basename(destination),
    originalPath: source,
    size: stat.size,
  });
}

function importLocalAttachments(items, options = {}) {
  const workspaceDir = options.workspaceDir;
  return (items || [])
    .filter((item) => item && item.path)
    .map((item) => copyLocalAttachment(item.path, item.kind, workspaceDir));
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

  const dir = attachmentInputDir(workspaceDir);
  fs.mkdirSync(dir, { recursive: true });
  const destination = uniqueDestination(dir, filename);
  fs.writeFileSync(destination, buffer);

  return enrichAttachment({
    kind: inferAttachmentKind(destination, contentType),
    path: destination,
    name: path.basename(destination),
    sourceUrl: url.toString(),
    size: buffer.length,
    contentType,
  });
}

module.exports = {
  attachmentInputDir,
  downloadUrlAttachment,
  extractPptxText,
  inferAttachmentKind,
  importLocalAttachments,
  sanitizeAttachmentFilename,
};
