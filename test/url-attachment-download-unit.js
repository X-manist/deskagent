'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadUrlAttachment, sanitizeAttachmentFilename } = require('../app/src/main/attachments');

function makeHeaders(values) {
  return {
    get(name) {
      return values[String(name || '').toLowerCase()] || '';
    },
  };
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
  assert.strictEqual(fs.readFileSync(image.path, 'utf8'), 'pngdata');

  const pdf = await downloadUrlAttachment('https://example.com/files/latest', { workspaceDir: tmp, fetchImpl });
  assert.strictEqual(pdf.kind, 'file');
  assert.strictEqual(pdf.name, 'report final.pdf');
  assert.strictEqual(fs.readFileSync(pdf.path, 'utf8'), '%PDF-1.7');

  assert.strictEqual(sanitizeAttachmentFilename('../a:b?.pdf'), '..-a-b-.pdf');
  assert.deepStrictEqual(calls, ['https://example.com/chart', 'https://example.com/files/latest']);

  console.log(JSON.stringify({ ok: true, checks: ['url_download_image', 'url_download_pdf', 'filename_sanitize'] }, null, 2));
})().catch((error) => {
  console.error('URL_ATTACHMENT_DOWNLOAD_UNIT_ERROR', error && error.stack ? error.stack : error);
  process.exit(1);
});
