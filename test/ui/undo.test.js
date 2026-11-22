'use strict';
/* B (or ⌘Z) goes back through everything, one step at a time: marks, hearts,
   hides; each step back to the photo it was about. Hides are remembered
   across sessions. */

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
  lib = fs.mkdtempSync(path.join(os.tmpdir(), 'uncapture-undo-'));
  await makeLibrary(browser, lib, [3, 2, 4, 3], { scenes: 3 });
  srv = startServer(lib);
  base = await srv.base;
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.proc.kill();
});

// (the server may be writing it just then: read again)
const manifest = () => {
  for (let i = 0; ; i++) {
    try {
      return JSON.parse(fs.readFileSync(path.join(lib, 'fake.json'))).files || {};
    } catch (e) {
      if (i > 20) throw e;
    }
  }
};
const marks = (page) => page.evaluate(() => ({ keep: [...S.keep].sort(), del: [...S.del].sort(), toDelete: S.toDelete }));

async function openViewer() {
  const { page, errors } = await openStart(browser, base);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#stage .frame').length === 3);
  return { page, errors };
}

test('B undoes marks and hearts one at a time, as far back as they go, each on its photo', async () => {
  const { page, errors } = await openViewer();
  const ids = await page.evaluate(() => S.clusters.map((c) => c.slice()));
  const empty = await marks(page);
  // cluster 1: keep the 2nd; D on the 3rd; ♥ on the 1st; cluster 3: keep all
  await page.keyboard.press('2');
  await page.keyboard.press('Tab');
  await page.keyboard.press('d');
  await page.keyboard.press('Tab');
  await page.keyboard.press('s');
  await page.waitForFunction(() => /Favorite/.test(document.querySelector('#toast').textContent));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('a');
  const all = await marks(page);
  assert.deepEqual(all.keep, [ids[0][1], ...ids[2]].sort());
  assert.deepEqual(all.del, [ids[0][2]]);
  assert.equal(manifest()['IMG_0001.JPG'].favorite, true);

  // B: keep all, undone (still on cluster 3)
  await page.keyboard.press('b');
  await page.waitForFunction((k) => S.keep.size === 1, null);
  assert.equal(await page.evaluate(() => S.idx), 2);
  // B: the heart, undone in Photos too, and back on cluster 1, on that photo
  await page.keyboard.press('b');
  await page.waitForFunction(() => S.idx === 0 && !S.byId.get(focusedId()).fav);
  assert.equal(await page.evaluate(() => focusedId()), ids[0][0]);
  await page.waitForFunction(() => /Undone: no longer a favorite/.test(document.querySelector('#toast').textContent));
  assert.equal(manifest()['IMG_0001.JPG'].favorite, false);
  // B: the D mark; B: the keeper
  await page.keyboard.press('b');
  await page.waitForFunction(() => S.del.size === 0);
  assert.equal(await page.evaluate(() => focusedId()), ids[0][2]);
  await page.keyboard.press('b');
  await page.waitForFunction(() => S.keep.size === 0);
  // quick presses while one waits for Photos all count: ♥ twice, then B B
  await page.keyboard.press('s');
  await page.waitForFunction(() => /Favorite/.test(document.querySelector('#toast').textContent));
  await page.keyboard.press('s');
  await page.waitForFunction(() => /No longer a favorite/.test(document.querySelector('#toast').textContent));
  await page.keyboard.press('b');
  await page.keyboard.press('b');
  await page.waitForFunction(() => UNDO.stack.length === 0 && !UNDO.busy && !S.byId.get(focusedId()).fav);
  assert.deepEqual(await marks(page), empty);
  // the server has it so too
  await page.waitForTimeout(400);
  const st = await page.evaluate(() => api('GET', '/api/state'));
  assert.deepEqual(st.marks, { keep: [], del: [] });
  // nothing more: B says so
  await page.keyboard.press('b');
  await page.waitForFunction(() => /Nothing to undo/.test(document.querySelector('#toast').textContent));
  assert.deepEqual(errors, []);
  await page.close();
});

test('hides are kept: a new session can still show them again, newest first', async () => {
  let { page, errors } = await openViewer();
  const first = await page.evaluate(() => focusedId());
  await page.keyboard.press('h');
  await page.waitForFunction(() => /Hidden in Photos/.test(document.querySelector('#toast').textContent));
  const second = await page.evaluate(() => focusedId());
  await page.keyboard.press('h');
  await page.waitForFunction(() => /Hidden in Photos/.test(document.querySelector('#toast').textContent) && document.querySelectorAll('#stage .frame').length === 1);
  await page.waitForTimeout(300);
  assert.equal(Object.values(manifest()).filter((f) => f.hidden).length, 2);
  await page.close();

  // another session: B shows the second again, then the first
  ({ page, errors } = await openViewer().catch(async () => {
    const o = await openStart(browser, base);
    await o.page.keyboard.press('Enter');
    return o;
  }));
  await page.keyboard.press('b');
  await page.waitForFunction((x) => !!S.byId.get(x) && focusedId() === x, second, { timeout: 10000 });
  await page.keyboard.press('b');
  await page.waitForFunction((x) => !!S.byId.get(x) && focusedId() === x, first, { timeout: 10000 });
  assert.equal(Object.values(manifest()).filter((f) => f.hidden).length, 0);
  assert.deepEqual(errors, []);
  await page.close();
});
