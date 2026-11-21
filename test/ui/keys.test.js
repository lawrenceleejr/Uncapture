'use strict';
/* A walk through every key: the start screen, the viewer, the large view,
   Review, the Menu and the ? sheet; and the Mac menu bar's items all exist in
   the page's MENU. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { startServer, openStart } = require('./helpers');
const { writeLibrary, renderScenes } = require('../fixture');

// 20 clusters a week apart from 15 January 2024 (four singles among them)
const DAY = 864e5;
const T0 = Date.UTC(2024, 0, 15, 10, 0, 0);
let browser;
let srv;
let base;
let photos;

test.before(async () => {
  browser = await chromium.launch();
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'uncapture-keys-'));
  const art = await renderScenes(browser, 4, [[960, 640], [240, 160]]);
  photos = [];
  let n = 1;
  // [size, day offset]: 20 clusters, one a single photo, one with a favorite
  const spec = Array.from({ length: 20 }, (_, i) => [[3, 2, 4, 1, 5][i % 5], i * 7]);
  spec.forEach(([size, day], ci) => {
    for (let k = 0; k < size; k++) {
      const sc = art[(ci + k) % art.length];
      photos.push({ name: `P${String(n++).padStart(3, '0')}.JPG`, t: T0 + day * DAY + ci * 60_000 + k * 3000, tz: 0, image: sc[0], thumb: sc[1], width: 960, height: 640, extra: ci === 2 && k === 3 ? { favorite: true } : undefined });
    }
  });
  writeLibrary(lib, photos);
  // daily cleanup "today" is the anniversary of the first cluster's day
  srv = startServer(lib, { env: { UNCAPTURE_TODAY: '2025-01-15' } });
  base = await srv.base;
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.proc.kill();
});

const text = (page, sel) => page.$eval(sel, (e) => e.textContent);

// each test starts from the defaults, nothing marked
test.beforeEach(async () => {
  const put = (u, body) => fetch(base + u, { method: 'PUT', headers: { 'X-Uncapture': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await put('/api/settings', { window: 60, clustersOnly: true, daily: false, from: null, to: null });
  await put('/api/marks', { keep: [], del: [] });
});
const settle = (page, ms = 150) => page.waitForTimeout(ms);

test('start screen: window, filters, dates, open', async () => {
  const { page, errors } = await openStart(browser, base);
  assert.match(await text(page, '#big-n'), /^16 clusters · 56 photos$/);
  assert.equal(await text(page, '#windows .on'), '1 min');
  await page.keyboard.press(']');
  await settle(page);
  assert.equal(await text(page, '#windows .on'), '2 min');
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  await settle(page);
  assert.equal(await text(page, '#windows .on'), '30 s');
  await page.keyboard.press(']');
  // clusters only (C)
  await page.keyboard.press('c');
  await settle(page, 300);
  assert.equal(await page.$eval('#opt-clusters', (e) => e.checked), false);
  assert.match(await text(page, '#big-n'), /^20 clusters · 60 photos$/);
  await page.keyboard.press('c');
  await settle(page, 300);
  // daily cleanup (D): 15 January in earlier years
  await page.keyboard.press('d');
  await settle(page, 300);
  assert.equal(await page.$eval('#opt-daily', (e) => e.checked), true);
  assert.match(await text(page, '#big-sub'), /^On this day: 2024/);
  assert.match(await text(page, '#big-n'), /^1 cluster · 3 photos$/);
  await page.keyboard.press('d');
  await settle(page, 300);
  // dates: one month at a time, widen with shift, all again
  assert.equal(await text(page, '#chart-title'), 'Photos per month');
  await page.keyboard.press('ArrowRight');
  await settle(page, 300);
  assert.match(await text(page, '#big-sub'), /^Jan 2024 ·/);
  await page.keyboard.press('Shift+ArrowRight');
  await settle(page, 300);
  assert.match(await text(page, '#big-sub'), /^Jan 2024 – Feb 2024 ·/);
  // a step after widening moves on from the end of the range
  await page.keyboard.press('ArrowRight');
  await settle(page, 300);
  assert.match(await text(page, '#big-sub'), /^Mar 2024 ·/);
  await page.keyboard.press('ArrowLeft');
  await settle(page, 300);
  assert.match(await text(page, '#big-sub'), /^Feb 2024 ·/);
  // the last 30 days (to the last photo); the last 12 months is all of it here
  await page.keyboard.press('l');
  await settle(page, 300);
  assert.match(await text(page, '#big-sub'), /^28 Apr – 27 May 2024 ·/);
  await page.keyboard.press('y');
  await settle(page, 300);
  assert.match(await text(page, '#big-sub'), /^All dates/);
  await page.keyboard.press('ArrowRight');
  await settle(page, 300);
  await page.keyboard.press('a');
  await settle(page, 300);
  assert.match(await text(page, '#big-sub'), /^All dates/);
  // open
  await page.keyboard.press('Enter');
  await page.waitForSelector('#viewer:not([hidden])');
  assert.match(await text(page, '#counter'), /^1 \/ 16$/);
  assert.deepEqual(errors, []);
  await page.close();
});

async function openViewer() {
  const { page, errors } = await openStart(browser, base);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#viewer:not([hidden])');
  await settle(page, 400);
  return { page, errors };
}
const looks = (page) => page.$$eval('#stage .look', (ls) => ls.map((l) => (l.classList.contains('keep') ? 'K' : l.classList.contains('del') ? 'x' : '-') + (l.classList.contains('focus') ? '*' : '')).join(' '));

test('viewer: flip, keep, focus, clear, explicit marks, favorites', async () => {
  const { page, errors } = await openViewer();
  const idx = () => page.evaluate(() => S.idx);
  await page.keyboard.press('End');
  assert.equal(await idx(), 15);
  await page.keyboard.press('Home');
  assert.equal(await idx(), 0);
  await page.keyboard.press('Shift+ArrowRight');
  assert.equal(await idx(), 10);
  await page.keyboard.press('Shift+ArrowLeft');
  assert.equal(await idx(), 0);

  // cluster 1: three photos
  assert.equal(await looks(page), '-* - -');
  await page.keyboard.press('2');
  assert.equal(await looks(page), 'x K* x', '2 keeps the second; the rest are marked');
  await settle(page, 500);
  assert.match(await text(page, '#c-del'), /^2 to delete so far/);
  assert.match(await text(page, '#review-count'), /^2$/);
  await page.keyboard.press('2');
  assert.equal(await looks(page), '- -* -', 'again: undone');
  await page.keyboard.press('Tab');
  assert.equal(await looks(page), '- - -*');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await looks(page), '-* - -');
  await page.keyboard.press('Enter');
  assert.equal(await looks(page), 'K* x x', 'Enter keeps the focused photo');
  await page.keyboard.press('a');
  assert.equal(await looks(page), 'K* K K', 'A keeps all');
  await page.keyboard.press('0');
  assert.equal(await looks(page), '-* - -', '0 clears');
  await page.keyboard.press('x');
  assert.equal(await looks(page), 'x* - -', 'X marks one without a keeper');
  await page.keyboard.press('0');

  // cluster 3 has a favorite (its 4th photo): protected unless marked with X
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.$$eval('#stage .look', (l) => l.length), 4);
  await page.keyboard.press('1');
  assert.equal(await looks(page), 'K* x x -', 'the favorite stays');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('x');
  assert.equal(await looks(page), 'K x x x*', 'X marks the favorite');
  assert.match(await text(page, '#toast'), /favorite/);
  await page.keyboard.press('x');
  assert.equal(await looks(page), 'K x x -*');

  // U: the next cluster without a keeper
  await page.keyboard.press('Home');
  await page.keyboard.press('1');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('1');
  await page.keyboard.press('Home');
  await page.keyboard.press('u');
  assert.equal(await idx(), 3, 'clusters 1–3 have keepers');
  assert.deepEqual(errors, []);
  // leave nothing marked for the next tests
  await page.evaluate(() => {
    S.keep.clear();
    S.del.clear();
    saveMarks();
  });
  await settle(page, 500);
  await page.close();
});

test('viewer: the window and filters re-cluster and keep your place', async () => {
  const { page, errors } = await openViewer();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Tab');
  const before = await page.evaluate(() => focusedId());
  await page.keyboard.press('[');
  await page.waitForFunction(() => S.settings.window === 30 && !document.querySelector('#toast').hidden);
  await settle(page, 300);
  assert.equal(await page.evaluate(() => focusedId()), before, 'still on the same photo');
  assert.match(await text(page, '#c-window'), /30 s/);
  await page.keyboard.press(']');
  await page.waitForFunction(() => S.settings.window === 60);
  // clusters only off: the single photo shows
  await page.keyboard.press('c');
  await page.waitForFunction(() => S.clusters.length === 20);
  await page.keyboard.press('c');
  await page.waitForFunction(() => S.clusters.length === 16);
  // daily cleanup from the viewer: the header names the years
  await page.keyboard.press('d');
  await page.waitForFunction(() => S.settings.daily && S.clusters.length === 1);
  assert.match(await text(page, '#where'), /^On this day: 2024 \(1 cluster\)$/);
  await settle(page, 400);
  assert.equal(await page.evaluate(() => S.server.dailyDone), '2025-01-15', 'reaching the end finishes daily cleanup');
  await page.keyboard.press('d');
  await page.waitForFunction(() => !S.settings.daily && S.clusters.length === 16);
  assert.deepEqual(errors, []);
  await page.close();
});

test('large view: switch photo, keep, actual pixels, back', async () => {
  const { page, errors } = await openViewer();
  await page.keyboard.press(' ');
  await page.waitForSelector('#solo:not([hidden])');
  const shownId = () => page.$eval('#solo-frame', (f) => f.dataset.id);
  const first = await shownId();
  await page.keyboard.press('2');
  await settle(page);
  assert.notEqual(await shownId(), first, '2 shows the second photo');
  assert.equal(await page.evaluate(() => S.keep.size), 0, 'and keeps nothing (switching only)');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => S.keep.has(focusedId())), true, 'Enter keeps it');
  assert.ok(await page.$eval('#solo-caption .key.on', (k) => k.textContent === '2'));
  await page.keyboard.press('z');
  await page.waitForFunction(() => document.querySelector('#solo').classList.contains('zoom') && document.querySelector('#solo-frame').dataset.level === 'full');
  await page.keyboard.press('z');
  await page.waitForFunction(() => !document.querySelector('#solo').classList.contains('zoom'));
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => S.idx), 1, 'arrows flip clusters in the large view');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#solo', (s) => s.hidden), true);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press(' ');
  await page.keyboard.press(' ');
  assert.equal(await page.$eval('#solo', (s) => s.hidden), true, 'Space again goes back');
  await page.keyboard.press('0');
  assert.deepEqual(errors, []);
  await settle(page, 500);
  await page.close();
});

test('Review, start screen, Menu and the ? sheet open and close from the keyboard', async () => {
  const { page, errors } = await openViewer();
  await page.keyboard.press('r');
  await page.waitForSelector('#review:not([hidden])');
  await page.waitForFunction(() => /Nothing to delete|Delete/.test(document.querySelector('#review-title').textContent));
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#review', (s) => s.hidden), true);
  await page.keyboard.press('o');
  await page.waitForSelector('#start:not([hidden])');
  assert.equal(await page.$eval('#start-return', (b) => b.hidden), false);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#viewer:not([hidden])');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#start:not([hidden])', { timeout: 2000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#viewer:not([hidden])');
  await page.keyboard.press('m');
  assert.equal(await page.$eval('#menu', (m) => m.hidden), false);
  await page.keyboard.press('ArrowDown');
  assert.ok(await page.evaluate(() => document.activeElement.classList.contains('menu-item')));
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#menu', (m) => m.hidden), true);
  await page.keyboard.press('?');
  assert.equal(await page.$eval('#help', (m) => m.hidden), false);
  const sheet = await text(page, '#help');
  for (const word of ['Flip and keep', 'Look closely', 'Clusters and filters', 'Review and delete']) assert.ok(sheet.includes(word), word);
  await page.keyboard.press('a');
  assert.equal(await page.$eval('#help', (m) => m.hidden), true);
  assert.deepEqual(await page.evaluate(() => [...S.keep]), [], 'the key that closed the sheet did nothing else');
  assert.deepEqual(errors, []);
  await page.close();
});

test('every Mac menu bar item is a Menu command, and every command runs', async () => {
  const gui = fs.readFileSync(path.join(__dirname, '..', '..', 'src-tauri', 'src', 'gui.rs'), 'utf8');
  const barIds = [...gui.matchAll(/item\("([a-z0-9]+)"/g)].map((m) => m[1]);
  const { page, errors } = await openViewer();
  const menuIds = await page.evaluate(() => MENU.flatMap(([, items]) => items.map((i) => i.id)));
  assert.deepEqual(barIds.filter((id) => !menuIds.includes(id)), [], 'menu bar items missing from MENU');
  assert.deepEqual(menuIds.filter((id) => !barIds.includes(id)), [], 'MENU items missing from the menu bar');
  // the same names, grouped the same way
  const groups = await page.evaluate(() => MENU.map(([t]) => t.toLowerCase()));
  for (const g of groups) assert.ok(gui.toLowerCase().includes(`"${g}"`), `menu bar group ${g}`);
  // run each from the Menu, as the menu bar does
  for (const id of ['next', 'prev', 'next10', 'prev10', 'last', 'first', 'focus', 'keep', 'keepall', 'clear', 'mark', 'clear', 'nextopen', 'large', 'zoom', 'large', 'longer', 'shorter', 'clustersonly', 'clustersonly', 'review', 'review', 'keys']) {
    await page.evaluate((id) => window.uncaptureCommand(id), id);
    await settle(page, 60);
  }
  assert.equal(await page.$eval('#help', (m) => m.hidden), false, 'keys opened the sheet');
  assert.deepEqual(errors, []);
  await page.close();
});
