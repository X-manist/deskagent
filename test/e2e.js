'use strict';
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (_) {
  ({ chromium } = require('../app/node_modules/playwright-core'));
}
const fs = require('fs');
const path = require('path');

const OUT = '/Volumes/macsoftware/codes/agentscompany/deskagent/test/shots';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  // find the app window (not devtools)
  let page = ctx.pages().find((p) => !p.url().startsWith('devtools://'));
  for (let i = 0; i < 20 && !page; i++) { await sleep(500); page = ctx.pages().find((p) => !p.url().startsWith('devtools://')); }
  if (!page) throw new Error('no app page found');
  await page.bringToFront();
  console.log('page url:', page.url());

  // wait for ready status (engine boot)
  const statusText = page.locator('#statusText');
  for (let i = 0; i < 60; i++) {
    const t = await statusText.textContent();
    console.log('status:', t);
    if (t && t.includes('就绪')) break;
    await sleep(2000);
  }
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, '01-ready.png') });
  console.log('shot 01 ready');

  // send a chat message
  await page.fill('#input', '你好！请用一句话介绍你自己，然后帮我把这句话润色得更专业：今天天气不错我们去公园玩吧。');
  await page.click('#sendBtn');
  // capture mid-stream
  await sleep(3500);
  await page.screenshot({ path: path.join(OUT, '02-chat-streaming.png') });
  console.log('shot 02 streaming');

  // wait for turn done (status back to 就绪)
  for (let i = 0; i < 60; i++) {
    const t = await statusText.textContent();
    if (t && t.includes('就绪')) break;
    await sleep(2000);
  }
  await sleep(1000);
  await page.screenshot({ path: path.join(OUT, '03-chat-reply.png') });
  console.log('shot 03 reply');

  // tool-call test: ask to create a file in the workspace
  await page.fill('#input', '请在当前工作目录创建一个名为 hello.txt 的文件，内容是“你好，智界助手”。完成后告诉我。');
  await page.click('#sendBtn');
  await sleep(6000);
  await page.screenshot({ path: path.join(OUT, '04-tool-activity.png') });
  console.log('shot 04 tool activity');
  for (let i = 0; i < 90; i++) {
    const t = await statusText.textContent();
    if (t && t.includes('就绪')) break;
    await sleep(2000);
  }
  await sleep(1000);
  await page.screenshot({ path: path.join(OUT, '05-tool-done.png') });
  console.log('shot 05 tool done');

  // open settings modal
  await page.click('#openSettings');
  await sleep(600);
  await page.screenshot({ path: path.join(OUT, '06-settings.png') });
  console.log('shot 06 settings');
  await page.click('#cancelSettings');

  // ask the bundled bridge to take a real OS screenshot into the workspace
  await page.fill('#input', '请调用内置桌面工具截取当前屏幕，保存到工作目录 screenshots 目录，并告诉我截图路径。');
  await page.click('#sendBtn');
  await sleep(5000);
  await page.screenshot({ path: path.join(OUT, '07-desktop-screenshot-tool.png') });
  console.log('shot 07 desktop screenshot tool');
  for (let i = 0; i < 90; i++) {
    const t = await statusText.textContent();
    if (t && t.includes('就绪')) break;
    await sleep(2000);
  }
  await sleep(1000);
  await page.screenshot({ path: path.join(OUT, '08-desktop-screenshot-done.png') });
  console.log('shot 08 desktop screenshot done');

  // dump visible message text for verification
  const txt = await page.locator('#messages').innerText();
  fs.writeFileSync(path.join(OUT, 'transcript.txt'), txt);
  console.log('--- transcript ---\n' + txt.slice(0, 1200));

  await browser.close();
  console.log('DONE');
})().catch((e) => { console.error('E2E ERROR', e); process.exit(1); });
