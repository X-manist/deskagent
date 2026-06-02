'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  attachmentInputDir,
  downloadUrlAttachment,
  extractPptxText,
  importLocalAttachments,
  sanitizeAttachmentFilename,
} = require('../app/src/main/attachments');

function makeHeaders(values) {
  return {
    get(name) {
      return values[String(name || '').toLowerCase()] || '';
    },
  };
}

function zipStoredEntry(name, content, offset) {
  const nameBuf = Buffer.from(name);
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);
  return {
    local: Buffer.concat([local, nameBuf, body]),
    central: Buffer.concat([central, nameBuf]),
  };
}

function makePptx(slides) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  slides.forEach((text, idx) => {
    const xml = `<p:sld xmlns:p="x" xmlns:a="x"><p:cSld><p:spTree><a:t>${text}</a:t></p:spTree></p:cSld></p:sld>`;
    const entry = zipStoredEntry(`ppt/slides/slide${idx + 1}.xml`, xml, offset);
    locals.push(entry.local);
    centrals.push(entry.central);
    offset += entry.local.length;
  });
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(slides.length, 8);
  eocd.writeUInt16LE(slides.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskagent-url-attachment-'));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/chart')) {
      return {
        ok: true,
        status: 200,
        headers: makeHeaders({
          'content-type': 'image/png',
          'content-length': '7',
          'content-disposition': 'attachment; filename="chart.png"',
        }),
        arrayBuffer: async () => Buffer.from('pngdata'),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: makeHeaders({
        'content-type': 'application/pdf',
        'content-disposition': "attachment; filename*=UTF-8''report%20final.pdf",
      }),
      arrayBuffer: async () => Buffer.from('%PDF-1.7'),
    };
  };

  const image = await downloadUrlAttachment('https://example.com/chart', { workspaceDir: tmp, fetchImpl });
  assert.strictEqual(image.kind, 'image');
  assert.strictEqual(image.name, 'chart.png');
  assert.strictEqual(path.dirname(image.path), attachmentInputDir(tmp));
  assert.strictEqual(fs.readFileSync(image.path, 'utf8'), 'pngdata');

  const pdf = await downloadUrlAttachment('https://example.com/files/latest', { workspaceDir: tmp, fetchImpl });
  assert.strictEqual(pdf.kind, 'file');
  assert.strictEqual(pdf.name, 'report final.pdf');
  assert.strictEqual(path.dirname(pdf.path), attachmentInputDir(tmp));
  assert.strictEqual(fs.readFileSync(pdf.path, 'utf8'), '%PDF-1.7');

  const sourceDir = path.join(tmp, 'source');
  const workspaceDir = path.join(tmp, 'workspace');
  fs.mkdirSync(sourceDir, { recursive: true });
  const pptxPath = path.join(sourceDir, 'demo.pptx');
  fs.writeFileSync(pptxPath, makePptx(['标题 &amp; 数据', '第二页公式 x^2']));
  assert.ok(extractPptxText(pptxPath).includes('标题 & 数据'));
  const [pptx] = importLocalAttachments([{ kind: 'file', path: pptxPath }], { workspaceDir });
  assert.strictEqual(path.dirname(pptx.path), attachmentInputDir(workspaceDir));
  assert.ok(fs.existsSync(pptx.path));
  assert.ok(fs.existsSync(pptx.summaryPath));
  assert.ok(pptx.extractedText.includes('幻灯片 2'));

  assert.strictEqual(sanitizeAttachmentFilename('../a:b?.pdf'), '..-a-b-.pdf');
  assert.deepStrictEqual(calls, ['https://example.com/chart', 'https://example.com/files/latest']);

  console.log(JSON.stringify({
    ok: true,
    checks: ['url_download_image', 'url_download_pdf', 'filename_sanitize', 'local_import_input_dir', 'pptx_text_extract'],
  }, null, 2));
})().catch((error) => {
  console.error('URL_ATTACHMENT_DOWNLOAD_UNIT_ERROR', error && error.stack ? error.stack : error);
  process.exit(1);
});
