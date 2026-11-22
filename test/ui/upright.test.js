'use strict';
/* Which way up: a photo stored sideways (as an iPhone stores a portrait
   shot) shows upright, in the grid and the large view, and its frame keeps
   its shape coming back from the large view (no cropped pictures). ` is
   the loupe. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { startServer, openStart } = require('./helpers');
const { writeLibrary, renderScenes } = require('../fixture');

const T0 = Date.UTC(2024, 4, 1, 9, 0, 0);
let browser;
let srv;
let base;
let ids;

test.before(async () => {
  browser = await chromium.launch();
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'uncapture-upright-'));
  const art = await renderScenes(browser, 3);
  // two clusters; the second photo is stored sideways (EXIF orientation 6):
  // its pixels are 2400 × 1600, it's shown 1600 × 2400
  const photos = [0, 1, 2, 3, 4].map((k) => ({
    name: `IMG_${k + 1}.JPG`,
    t: T0 + (k < 3 ? k * 2000 : 600_000 + k * 2000),
    tz: 0,
    image: art[k % 3][0],
    thumb: art[k % 3][1],
    width: 2400,
    height: 1600,
    orientation: k === 1 ? 6 : 1,
  }));
  writeLibrary(lib, photos);
  srv = startServer(lib);
  base = await srv.base;
  ids = photos.map((p) => fnv(p.name));
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.proc.kill();
});

function fnv(s) {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(s)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

async function openViewer() {
  const { page, errors } = await openStart(browser, base);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#viewer:not([hidden])');
  await page.waitForFunction(() => document.querySelectorAll('#stage .frame').length === 3);
  return { page, errors };
}

// a frame's shape, and the shape of the picture in it
const shapes = (page, id) =>
  page.$eval(`#stage .frame[data-id="${id}"]`, (f) => {
    const p = f.querySelector('img, canvas');
    const pw = p ? p.naturalWidth || p.width : 0;
    const ph = p ? p.naturalHeight || p.height : 0;
    return { fw: f.offsetWidth, fh: f.offsetHeight, pw, ph, fit: p ? getComputedStyle(p).objectFit : '' };
  });

test('a photo stored sideways shows upright, and comes back from the large view uncropped', async () => {
  const { page, errors } = await openViewer();
  const side = ids[1];
  await page.waitForFunction((id) => {
    const p = document.querySelector(`#stage .frame[data-id="${id}"] img, #stage .frame[data-id="${id}"] canvas`);
    return p && (p.naturalWidth || p.width) > 0;
  }, side);
  let s = await shapes(page, side);
  assert.ok(s.fh > s.fw, `its frame is upright (portrait): ${s.fw}×${s.fh}`);
  assert.ok(s.ph > s.pw, `and so is its picture: ${s.pw}×${s.ph}`);
  // the thumbnail itself too (the EXIF thumbnail is stored sideways)
  const thumb = await page.evaluate((id) => new Promise((res) => thumbImage(id).then((i) => res([i.naturalWidth, i.naturalHeight]))), side);
  assert.ok(thumb[1] > thumb[0], `thumbnail ${thumb}`);
  // the large view, then back: same frame, same shape, the whole picture
  await page.keyboard.press('Tab');
  await page.keyboard.press(' ');
  await page.waitForFunction(() => ['preview', 'full'].includes(document.querySelector('#solo-frame').dataset.level));
  const big = await page.$eval('#solo-frame', (f) => {
    const n = f.firstElementChild;
    return [n.naturalWidth, n.naturalHeight];
  });
  assert.ok(big[1] > big[0], `large view ${big}`);
  await page.keyboard.press(' ');
  await page.waitForSelector('#solo', { state: 'hidden' });
  await page.waitForTimeout(300);
  for (const id of ids.slice(0, 3)) {
    s = await shapes(page, id);
    assert.equal(s.fit, 'contain', 'never cropped');
    const fr = s.fw / s.fh;
    const pr = s.pw / s.ph;
    assert.ok(Math.abs(fr - pr) < 0.03, `${id}: frame ${s.fw}×${s.fh}, picture ${s.pw}×${s.ph}`);
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('the loupe: ` shows it over a photo, the wheel changes its magnification', async () => {
  const { page, errors } = await openViewer();
  const box = await page.$eval(`#stage .frame[data-id="${ids[0]}"]`, (f) => {
    const r = f.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  assert.equal(await page.$eval('#loupe', (l) => l.hidden), true, 'not until it is asked for');
  await page.keyboard.press('`');
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.waitForSelector('#loupe:not([hidden])');
  assert.equal(await page.evaluate(() => document.body.classList.contains('loupe-on')), true);
  // the original arrives and is drawn at 100 %
  await page.waitForFunction(() => document.querySelector('#loupe .loupe-zoom').textContent === '100 %', null, { timeout: 10000 });
  const lit = await page.$eval('#loupe canvas', (c) => {
    const d = c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data;
    return d[0] + d[1] + d[2];
  });
  assert.ok(lit > 3 * 13 + 10, 'the photo, not the empty background');
  await page.mouse.wheel(0, -100);
  await page.waitForFunction(() => document.querySelector('#loupe .loupe-zoom').textContent === '200 %');
  await page.mouse.wheel(0, 100);
  await page.mouse.wheel(0, 100);
  await page.waitForFunction(() => document.querySelector('#loupe .loupe-zoom').textContent === '50 %');
  // off the photos it hides; ` puts it away
  await page.mouse.move(2, 2);
  await page.waitForSelector('#loupe', { state: 'hidden' });
  await page.keyboard.press('`');
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(100);
  assert.equal(await page.$eval('#loupe', (l) => l.hidden), true);
  assert.deepEqual(errors, []);
  await page.close();
});
