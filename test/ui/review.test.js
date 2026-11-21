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
  assert.match(await page.$eval('#c-del', (e) => e.textContent), /^5 to delete so far/);

  await page.keyboard.press('r');
  await page.waitForFunction(() => /^Delete 5 photos · frees about \d+ (KB|MB)$/.test(document.querySelector('#review-title').textContent));
  assert.equal(await page.$$eval('#review-grid .rgroup', (g) => g.length), 2);
  // take one back: X on the first that goes (IMG_0001) keeps it instead
  await page.keyboard.press('x');
  await page.waitForFunction(() => /^Delete 4 photos/.test(document.querySelector('#review-title').textContent));
  // the cursor is now on IMG_0003; → and X keep IMG_0004
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('x');
  await page.waitForFunction(() => /^Delete 3 photos/.test(document.querySelector('#review-title').textContent));
  // a click on a keeper (IMG_0004: keepers are 1, 2, 4, 7) lets it go again
  await page.click('#review-grid .rtile.keep >> nth=2');
  await page.waitForFunction(() => /^Delete 4 photos/.test(document.querySelector('#review-title').textContent));

  // the first delete explains itself once; Esc backs out with nothing deleted
  await page.keyboard.press('Enter');
  await page.waitForSelector('#first:not([hidden])');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#first', (f) => f.hidden), true);
  assert.deepEqual(trash(), []);

  await page.keyboard.press('Enter');
  await page.waitForSelector('#first:not([hidden])');
  await page.keyboard.press('Enter');
  // done: straight back to the clusters, the result over them
  await page.waitForFunction(() => document.querySelector('#review').hidden && /Deleted 4 photos\./.test(document.querySelector('#cleared').textContent), null, { timeout: 10000 });
  const result = await page.$eval('#cleared', (e) => e.textContent);
  assert.match(result, /Recently Deleted in Photos for 30 days: iCloud gets the space back then, or as soon as you empty it there\./);
  // the space cleared, first and large: the files' sizes here
  const cleared = ['IMG_0003.JPG', 'IMG_0004.JPG', 'IMG_0005.JPG', 'IMG_0006.JPG'].reduce((t, n) => t + fs.statSync(path.join(lib, '.trash', n)).size, 0);
  const big = await page.$eval('#cleared .cleared .amount', (e) => e.textContent);
  assert.equal(big, cleared >= 1e6 ? `${Math.round(cleared / 1e6)} MB` : `${Math.round(cleared / 1e3)} KB`);
  assert.match(await page.$eval('#cleared .cleared', (e) => e.textContent), / cleared$/);
  assert.deepEqual(trash(), ['IMG_0003.JPG', 'IMG_0004.JPG', 'IMG_0005.JPG', 'IMG_0006.JPG']);
  for (const kept of ['IMG_0001.JPG', 'IMG_0002.JPG', 'IMG_0007.JPG']) assert.ok(fs.existsSync(path.join(lib, kept)), kept);
  assert.equal(await page.evaluate(() => S.assets.length), photos.length - 4);

  // where you were: cluster 2 is down to its keeper (a single, hidden by
  // "clusters only"), so the same point in time is the next cluster, IMG_0009–10
  assert.equal(await page.$eval('#viewer', (v) => v.hidden), false);
  assert.equal(await page.evaluate(() => S.settings.clustersOnly), true, 'the same filters');
  assert.equal(await page.evaluate(() => S.byId.get(cur()[0]).t), photos[8].t);
  await page.click('#cleared');
  assert.equal(await page.$eval('#cleared', (c) => c.hidden), true);
  // the start screen keeps the running total, with its sparkline
  await page.keyboard.press('o');
  await page.waitForSelector('#start:not([hidden])');
  assert.equal(await page.$eval('#saved-row', (r) => r.hidden), false);
  assert.equal(await page.$eval('#saved-n', (e) => e.textContent), big);
  assert.match(await page.$eval('#saved-sub', (e) => e.textContent), /^4 photos since /);
  assert.ok(await page.$eval('#saved-spark path', (p) => p.getAttribute('d').includes('V')));
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
  await page.waitForFunction(() => /^Delete 1 photo · frees about /.test(document.querySelector('#review-title').textContent));
  fs.writeFileSync(path.join(lib, '.cancel-delete'), '');
  try {
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /cancelled/.test(document.querySelector('#review-result').textContent));
    assert.equal(await page.$eval('#first', (f) => f.hidden), true, 'the explanation only shows before the first delete');
    assert.equal(await page.$eval('#review-result', (e) => e.textContent), 'Nothing was deleted: the confirmation was cancelled.');
    assert.equal(trash().length, 4);
    assert.match(await page.$eval('#review-title', (e) => e.textContent), /^Delete 1 photo/, 'still marked');
  } finally {
    fs.unlinkSync(path.join(lib, '.cancel-delete'));
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('a delete from the large view comes back to the large view, on the same photo', async () => {
  const { page, errors } = await openStart(browser, base);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#viewer:not([hidden])');
  // single photos too, so the keeper's cluster stays on screen when it's alone
  await page.keyboard.press('c');
  // (once the clusters are in: a key pressed meanwhile would be undone)
  await page.waitForFunction(() => !S.settings.clustersOnly && S.clusters.length === 4);
  await page.keyboard.press('End');
  await page.waitForFunction(() => cur().length === 2);
  const keeper = await page.evaluate(() => cur()[0]);
  await page.keyboard.press('1');
  await page.keyboard.press(' ');
  await page.waitForSelector('#solo:not([hidden])');
  await page.keyboard.press('r');
  await page.waitForFunction(() => /^Delete 1 photo/.test(document.querySelector('#review-title').textContent));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#review').hidden && !document.querySelector('#cleared').hidden, null, { timeout: 10000 });
  await page.waitForSelector('#solo:not([hidden])');
  assert.equal(await page.$eval('#solo-frame', (f) => f.dataset.id), keeper);
  assert.equal(await page.evaluate(() => S.settings.clustersOnly), false, 'the same filters');
  assert.deepEqual(errors, []);
  await page.close();
});
