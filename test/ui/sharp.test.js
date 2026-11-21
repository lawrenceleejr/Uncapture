'use strict';
/* Coming back from the large view, the grid shows the sharp picture you just
   saw there, at once: not the thumbnail (or a blurry copy) it had before. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { makeLibrary, startServer, openStart } = require('./helpers');

let browser;
let srv;
let base;

test.before(async () => {
  browser = await chromium.launch();
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'uncapture-sharp-'));
  await makeLibrary(browser, lib, [3, 2, 4], { scenes: 3 });
  srv = startServer(lib);
  base = await srv.base;
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.proc.kill();
});

test('back from the large view, the grid shows its sharp picture at once', async () => {
  const { page, errors } = await openStart(browser, base, {
    // the grid's sizes are slow to come (as a Mac with only small copies
    // would be); the large view's size isn't
    init: (p) =>
      p.route('**/api/img/**', async (route) => {
        if (!/px=1600\b/.test(route.request().url())) await new Promise((r) => setTimeout(r, 6000));
        route.continue();
      }),
  });
  await page.keyboard.press('Enter');
  await page.waitForSelector('#viewer:not([hidden])');
  await page.waitForTimeout(400);
  const shown = () => page.$eval('#stage .look.focus .frame', (f) => {
    const n = f.querySelector('img, canvas');
    return n ? { low: n.classList.contains('lowres'), w: n.naturalWidth || +n.dataset.srcw || 0 } : null;
  });
  assert.equal((await shown()).low, true, 'before: the thumbnail, waiting for its picture');
  await page.keyboard.press(' ');
  await page.waitForFunction(() => document.querySelector('#solo-frame').dataset.level === 'preview');
  await page.keyboard.press(' ');
  await page.waitForTimeout(150);
  const after = await shown();
  assert.equal(after.low, false, 'after: not the thumbnail');
  assert.ok(after.w >= 1500, `after: the large view's sharp picture (${after.w} px)`);
  assert.deepEqual(errors, []);
  await page.close();
});
