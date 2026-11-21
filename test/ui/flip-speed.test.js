'use strict';
/* Flip-speed budget (Brackit's): pressing an arrow key must change the screen
   within 50 ms, always — warm, on a cold slow library, with the key held,
   in the grid (up to 9 photos and a scrolling burst of 12) and in the large
   view.

   Measured with the browser's own Event Timing API: for each keydown,
   `duration` runs from the key event to the next frame painted after it was
   handled. Real JPEGs are made in the browser, so decoding costs are real.

   Run: npm run build:cli && npm run test:ui */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { makeLibrary, startServer } = require('./helpers');

const BUDGET_MS = 50;
// cluster sizes: singles are hidden ("clusters only"), so ~50 clusters, up to 12
const SIZES = Array.from({ length: 60 }, (_, i) => [3, 1, 5, 2, 9, 4, 7, 1, 6, 9, 12, 3][i % 12]);

let browser;
let srv;
let base;

test.before(async () => {
  browser = await chromium.launch(process.env.UNCAPTURE_CHROMIUM ? { executablePath: process.env.UNCAPTURE_CHROMIUM } : {});
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'uncapture-flip-'));
  await makeLibrary(browser, lib, SIZES);
  // "today" is the library's anniversary, so daily cleanup holds all of it;
  // each sharp copy takes a moment, as from iCloud
  srv = startServer(lib, { env: { UNCAPTURE_TODAY: '2025-05-01', UNCAPTURE_FAKE_DOWNLOAD_MS: '400' } });
  base = await srv.base;
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.proc.kill();
});

// The viewer in a fresh page; optionally a slow "library" (iCloud, a busy Mac).
async function openViewer({ slow = false, settle = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (slow) {
    await page.route('**/api/**', async (route) => {
      const u = route.request().url();
      if (u.includes('/api/img/')) await new Promise((r) => setTimeout(r, 300));
      else if (u.includes('/api/thumbs')) await new Promise((r) => setTimeout(r, 120));
      route.continue();
    });
  }
  await page.addInitScript(() => {
    window.__keyDurations = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === 'keydown') window.__keyDurations.push(e.duration);
    }).observe({ type: 'event', durationThreshold: 0, buffered: true });
  });
  await page.goto(base + '/');
  await page.waitForSelector('#start:not([hidden])');
  await page.waitForFunction(() => !document.querySelector('#start-open').disabled && /cluster/.test(document.querySelector('#big-n').textContent));
  await page.keyboard.press('Enter');
  await page.waitForSelector('#viewer:not([hidden])');
  if (settle) await page.waitForTimeout(settle);
  await page.evaluate(() => (window.__keyDurations = []));
  return { page, errors };
}

// After each press: did the screen change, and does every frame hold a picture?
async function flip(page, { presses, gapMs, large = false, keys = ['ArrowRight'] }) {
  const screens = [];
  for (let i = 0; i < presses; i++) {
    const before = await page.evaluate(() => [document.querySelector('#counter').textContent, document.querySelector('#solo-frame').dataset.id]);
    await page.keyboard.press(keys[i % keys.length]);
    screens.push(
      await page.evaluate(
        ([before, large]) =>
          new Promise((res) =>
            requestAnimationFrame(() => {
              const sf = document.querySelector('#solo-frame');
              res(
                large
                  ? { changed: sf.dataset.id !== before[1], filled: !!sf.firstElementChild }
                  : {
                      changed: document.querySelector('#counter').textContent !== before[0],
                      filled: [...document.querySelectorAll('#stage .frame')].every((f) => f.querySelector('img, canvas') || f.querySelector('.badge')),
                    }
              );
            })
          ),
        [before, large]
      )
    );
    if (gapMs) await page.waitForTimeout(gapMs);
  }
  await page.waitForTimeout(300); // let the last event entries arrive
  const durations = await page.evaluate(() => window.__keyDurations.slice());
  return { screens, durations };
}

function report(name, durations) {
  const sorted = durations.slice().sort((a, b) => a - b);
  const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  console.log(`  ${name}: ${durations.length} presses took ≥16 ms · median of those ${pct(0.5) ?? '-'} ms · p95 ${pct(0.95) ?? '-'} ms · max ${sorted.at(-1) ?? '-'} ms (budget ${BUDGET_MS} ms)`);
}

function assertFast(name, { screens, durations }) {
  report(name, durations);
  // (browsers only report events of 16 ms or more; unreported presses were faster)
  const slow = durations.filter((d) => d > BUDGET_MS);
  assert.deepEqual(slow, [], `${name}: keypresses slower than ${BUDGET_MS} ms to next paint`);
  assert.ok(screens.every((s) => s.changed), `${name}: the counter didn't change on every press`);
}

test('warm: every arrow press paints within 50 ms, frames already filled (1–12 photos)', async () => {
  const { page, errors } = await openViewer({ settle: 2500 });
  const r = await flip(page, { presses: 25, gapMs: 120 });
  assertFast('warm', r);
  assert.ok(r.screens.every((s) => s.filled), 'some frame was empty after a press');
  assert.deepEqual(errors, []);
  await page.close();
});

test('cold, slow library: the page still changes within 50 ms of every press', async () => {
  const { page, errors } = await openViewer({ slow: true });
  const r = await flip(page, { presses: 20, gapMs: 60 });
  assertFast('cold + slow', r);
  assert.deepEqual(errors, []);
  await page.close();
});

test('holding the arrow key: every repeat paints within 50 ms', async () => {
  const { page, errors } = await openViewer({ slow: true, settle: 1500 });
  const r = await flip(page, { presses: 40, gapMs: 0 });
  assertFast('held key', r);
  assert.deepEqual(errors, []);
  await page.close();
});

test('large view (space): arrow presses paint within 50 ms, warm', async () => {
  const { page, errors } = await openViewer({ settle: 2500 });
  await page.keyboard.press(' ');
  await page.waitForTimeout(800);
  await page.evaluate(() => (window.__keyDurations = []));
  const r = await flip(page, { presses: 25, gapMs: 120, large: true });
  assertFast('large view, warm', r);
  assert.ok(r.screens.every((s) => s.filled), 'the large view was empty after a press');
  assert.deepEqual(errors, []);
  await page.close();
});

test('large view (space): arrow presses paint within 50 ms, cold slow library, quick presses', async () => {
  const { page, errors } = await openViewer({ slow: true });
  await page.keyboard.press(' ');
  await page.waitForTimeout(300);
  await page.evaluate(() => (window.__keyDurations = []));
  const r = await flip(page, { presses: 30, gapMs: 30, large: true });
  assertFast('large view, cold + slow', r);
  assert.deepEqual(errors, []);
  await page.close();
});

test('j held down through photos and clusters: every step paints within 50 ms', async () => {
  const { page, errors } = await openViewer({ settle: 1500 });
  await page.evaluate(() => (window.__keyDurations = []));
  for (let i = 0; i < 40; i++) await page.keyboard.press('j');
  await page.waitForTimeout(300);
  const d = await page.evaluate(() => window.__keyDurations.slice());
  report('j held', d);
  assert.deepEqual(d.filter((x) => x > BUDGET_MS), []);
  assert.ok((await page.evaluate(() => S.idx)) > 3, 'moved on through several clusters');
  assert.deepEqual(errors, []);
  await page.close();
});

test('locations shown: arrow presses paint within 50 ms', async () => {
  const { page, errors } = await openViewer({ settle: 1500 });
  await page.evaluate(() => (window.__keyDurations = []));
  const r = await flip(page, { presses: 25, gapMs: 120 });
  assertFast('locations shown', r);
  assert.ok(await page.evaluate(() => document.querySelectorAll('#stage .geo').length > 0));
  assert.deepEqual(errors, []);
  await page.close();
});

test('marking (1–9, Tab, Enter) paints within 50 ms', async () => {
  const { page, errors } = await openViewer({ settle: 1500 });
  await page.evaluate(() => (window.__keyDurations = []));
  for (const k of ['1', '2', 'Tab', 'Enter', '0', 'a', '0', '3', 'd', 'd', 'j', 'd', '0']) {
    await page.keyboard.press(k);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
  const d = await page.evaluate(() => window.__keyDurations.slice());
  report('marking', d);
  assert.deepEqual(d.filter((x) => x > BUDGET_MS), []);
  assert.deepEqual(errors, []);
  await page.close();
});

// Clusters: → ↓ forward, ← ↑ back; photos: j forward, k back, across
// clusters. In the grid and in the large view alike.
test('every flip key moves, within 50 ms', async () => {
  const { page, errors } = await openViewer({ settle: 1500 });
  const pos = () => page.evaluate(() => S.idx);
  for (const large of [false, true]) {
    if (large) {
      await page.keyboard.press(' ');
      await page.waitForTimeout(500);
    }
    for (const [key, d] of [['ArrowRight', 1], ['ArrowDown', 1], ['ArrowLeft', -1], ['ArrowUp', -1]]) {
      const before = await pos();
      await page.keyboard.press(key);
      assert.equal(await pos(), before + d, `${key} ${large ? 'in the large view ' : ''}should move ${d}`);
    }
  }
  const before = await pos();
  await page.keyboard.press('Shift+ArrowRight');
  assert.equal(await pos(), before + 10, 'Shift jumps ten');
  await page.evaluate(() => (window.__keyDurations = []));
  // j / k move a photo; at a cluster's end, on to the next cluster
  const at = () => page.evaluate(() => [S.idx, S.focus]);
  const [i0] = await at();
  const n = await page.evaluate(() => cur().length);
  for (let p = 0; p < n; p++) await page.keyboard.press('j');
  assert.deepEqual(await at(), [i0 + 1, 0]);
  await page.keyboard.press('k');
  assert.deepEqual(await at(), [i0, n - 1]);
  await page.evaluate(() => (window.__keyDurations = []));
  const r = await flip(page, { presses: 24, gapMs: 120, large: true, keys: ['j', 'ArrowDown', 'k', 'j', 'ArrowUp', 'j'] });
  report('j / k / ↑ / ↓', r.durations);
  assert.deepEqual(r.durations.filter((d) => d > BUDGET_MS), []);
  assert.deepEqual(errors, []);
  await page.close();
});

// Daily cleanup fetches sharp copies of the day's photos and swaps them in
// as they arrive: flipping meanwhile stays within budget.
test('daily cleanup: flipping while sharp copies arrive paints within 50 ms', async () => {
  const put = (body) => fetch(base + '/api/settings', { method: 'PUT', headers: { 'X-Uncapture': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await put({ daily: true });
  try {
    const { page, errors } = await openViewer({ settle: 300 });
    await page.waitForFunction(() => /sharper copies/.test(document.querySelector('#c-sharp').textContent));
    await page.evaluate(() => (window.__keyDurations = []));
    const r = await flip(page, { presses: 30, gapMs: 100 });
    assertFast('daily, sharp copies arriving', r);
    assert.ok(await page.evaluate(() => SH.seen.size > 0), 'some sharp copies arrived while flipping');
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await put({ daily: false });
  }
});
