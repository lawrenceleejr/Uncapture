'use strict';
/* Review and delete, end to end on the fake library: keep the best of two
   clusters, review, take one back, delete (the first time with the short
   explanation), and check exactly those files went. A cancelled
   confirmation deletes nothing. */

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
let lib;
let photos;

test.before(async () => {
  browser = await chromium.launch();
  lib = fs.mkdtempSync(path.join(os.tmpdir(), 'uncapture-review-'));
  photos = await makeLibrary(browser, lib, [4, 3, 1, 2], { scenes: 3 });
  srv = startServer(lib);
  base = await srv.base;
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.proc.kill();
});

const trash = () => (fs.existsSync(path.join(lib, '.trash')) ? fs.readdirSync(path.join(lib, '.trash')).sort() : []);

test('review and delete: exactly what is marked goes, after the confirmation', async () => {
  const { page, errors } = await openStart(browser, base);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#viewer:not([hidden])');
  // cluster 1 (IMG_0001–4): keep the 2nd; cluster 2 (IMG_0005–7): keep the 3rd
  await page.keyboard.press('2');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('3');
  await page.waitForTimeout(500);
  assert.match(await page.$eval('#c-del', (e) => e.textContent), /^4 to delete so far/);

  await page.keyboard.press('r');
  await page.waitForFunction(() => /^Delete 4 photos · about /.test(document.querySelector('#review-title').textContent));
  assert.equal(await page.$$eval('#review-grid .rgroup', (g) => g.length), 2);
  // take one back: the first photo that goes (IMG_0001) is kept instead
  await page.keyboard.press('x');
  await page.waitForFunction(() => /^Delete 3 photos/.test(document.querySelector('#review-title').textContent));
  // the cursor moves; X on the next takes IMG_0003 back, X again (now a keeper) lets it go
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('x');
  await page.waitForFunction(() => /^Delete 2 photos/.test(document.querySelector('#review-title').textContent));
  await page.click('#review-grid .rtile.keep >> nth=2');
  await page.waitForFunction(() => /^Delete 3 photos/.test(document.querySelector('#review-title').textContent));

  // the first delete explains itself once; Esc backs out with nothing deleted
  await page.keyboard.press('Enter');
  await page.waitForSelector('#first:not([hidden])');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#first', (f) => f.hidden), true);
  assert.deepEqual(trash(), []);

  await page.keyboard.press('Enter');
  await page.waitForSelector('#first:not([hidden])');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /^Deleted 3\./.test(document.querySelector('#review-result').textContent), null, { timeout: 10000 });
  const result = await page.$eval('#review-result', (e) => e.textContent);
  assert.match(result, /Recently Deleted in Photos for 30 days; empty it there to free the iCloud space now\./);
  assert.deepEqual(trash(), ['IMG_0003.JPG', 'IMG_0005.JPG', 'IMG_0006.JPG']);
  for (const kept of ['IMG_0001.JPG', 'IMG_0002.JPG', 'IMG_0004.JPG', 'IMG_0007.JPG']) assert.ok(fs.existsSync(path.join(lib, kept)), kept);

  // the library was read again: nothing left to delete, the photos gone
  await page.waitForFunction(() => document.querySelector('#review-title').textContent === 'Nothing to delete');
  assert.equal(await page.evaluate(() => S.assets.length), photos.length - 3);
  assert.equal(await page.$eval('#open-photos', (b) => b.hidden), false);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a cancelled confirmation deletes nothing, and says so; no explanation the second time', async () => {
  const { page, errors } = await openStart(browser, base);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#viewer:not([hidden])');
  await page.keyboard.press('End');
  await page.keyboard.press('1');
  await page.keyboard.press('r');
  await page.waitForFunction(() => /^Delete 1 photo · about /.test(document.querySelector('#review-title').textContent));
  fs.writeFileSync(path.join(lib, '.cancel-delete'), '');
  try {
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /cancelled/.test(document.querySelector('#review-result').textContent));
    assert.equal(await page.$eval('#first', (f) => f.hidden), true, 'the explanation only shows before the first delete');
    assert.equal(await page.$eval('#review-result', (e) => e.textContent), 'Nothing was deleted: the confirmation was cancelled.');
    assert.equal(trash().length, 3);
    assert.match(await page.$eval('#review-title', (e) => e.textContent), /^Delete 1 photo/, 'still marked');
  } finally {
    fs.unlinkSync(path.join(lib, '.cancel-delete'));
  }
  assert.deepEqual(errors, []);
  await page.close();
});
