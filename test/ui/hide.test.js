'use strict';
/* H hides the photo in focus in Photos at once and takes it off the screen
   in the same key press; B shows it again, on it. */

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

test.before(async () => {
  browser = await chromium.launch();
  lib = fs.mkdtempSync(path.join(os.tmpdir(), 'uncapture-hide-'));
  await makeLibrary(browser, lib, [3, 2, 4], { scenes: 3 });
  srv = startServer(lib);
  base = await srv.base;
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.proc.kill();
});

const hiddenIn = () => {
  const m = JSON.parse(fs.readFileSync(path.join(lib, 'fake.json')));
  return Object.entries(m.files || {}).filter(([, v]) => v.hidden).map(([k]) => k);
};

test('H hides the photo in Photos and off the screen at once; B shows it again', async () => {
  const { page, errors } = await openStart(browser, base);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#stage .frame').length === 3);
  await page.keyboard.press('Tab');
  const id = await page.evaluate(() => focusedId());
  // gone from the screen within the key press's frame
  await page.keyboard.press('h');
  await page.waitForFunction((x) => !document.querySelector(`#stage .frame[data-id="${x}"]`) && document.querySelectorAll('#stage .frame').length === 2, id, { timeout: 500 });
  await page.waitForFunction(() => /Hidden in Photos/.test(document.querySelector('#toast').textContent));
  assert.deepEqual(hiddenIn(), ['IMG_0002.JPG'], 'hidden in the library');
  assert.equal(await page.evaluate(() => focusedId()), await page.evaluate(() => cur()[1]), 'the next photo has the focus');
  // the library read again: still gone, still here in this cluster
  await page.evaluate(() => recluster(null));
  await page.waitForTimeout(300);
  assert.equal(await page.$$eval('#stage .frame', (f) => f.length), 2);
  // B: shown again, and back on it
  await page.keyboard.press('b');
  await page.waitForFunction((x) => !!document.querySelector(`#stage .frame[data-id="${x}"]`), id, { timeout: 10000 });
  assert.deepEqual(hiddenIn(), []);
  assert.equal(await page.evaluate(() => focusedId()), id);
  // hiding the last photo of a cluster: on to the next cluster
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => cur().length === 2);
  const n = await page.evaluate(() => S.clusters.length);
  await page.keyboard.press('h');
  await page.keyboard.press('h');
  await page.waitForFunction((k) => S.clusters.length === k - 1 && cur().length === 4, n);
  await page.waitForFunction(() => /Hidden in Photos/.test(document.querySelector('#toast').textContent));
  await page.waitForTimeout(300);
  assert.equal(hiddenIn().length, 2);
  assert.deepEqual(errors, []);
  await page.close();
});
