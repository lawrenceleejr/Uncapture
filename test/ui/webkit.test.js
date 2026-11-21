'use strict';
/* WebKit (the Mac app is WebKit): after every flip, every frame holds a
   picture that is drawn, in colour, right away.

   Pictures are loaded with decoding="async". In WebKit an element marked so
   isn't painted with the page: it's painted later, blank or half-done at
   first, and copies of an element inherit the setting. Pictures put on
   screen are marked "sync" (onScreen() in app.js); this catches a path that
   forgets. (Ported from Brackit's test of the same name.)

   Run: npm run build:cli && npm run test:ui (needs Playwright's WebKit:
   npx playwright install --with-deps webkit) */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webkit, chromium } = require('playwright');
const { makeLibrary, startServer } = require('./helpers');

let browser;
let srv;
let base;

test.before(async () => {
  // colourful scenes, made in a browser (any engine will do)
  const maker = await chromium.launch();
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'uncapture-webkit-'));
  await makeLibrary(maker, lib, Array.from({ length: 16 }, (_, i) => [3, 2, 5, 9][i % 4]));
  await maker.close();
  browser = await webkit.launch();
  srv = startServer(lib);
  base = await srv.base;
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.proc.kill();
});

// What each frame shows, read back: 'blank' if nothing is drawn yet, else its
// colourfulness (0 = grey).
const shown = (page) =>
  page.evaluate(() => {
    const read = (node) => {
      if (!node) return 'none';
      const c = document.createElement('canvas');
      c.width = 40;
      c.height = 30;
      try {
        c.getContext('2d').drawImage(node, 0, 0, 40, 30);
      } catch {
        return 'blank';
      }
      const d = c.getContext('2d').getImageData(0, 0, 40, 30).data;
      let chroma = 0;
      let alpha = 0;
      for (let i = 0; i < d.length; i += 4) {
        chroma += Math.abs(d[i] - d[i + 1]) + Math.abs(d[i + 1] - d[i + 2]);
        alpha += d[i + 3];
      }
      return alpha / (d.length / 4) < 10 ? 'blank' : Math.round(chroma / (d.length / 4));
    };
    const nodes = S.solo ? [$('#solo-frame').firstElementChild] : [...document.querySelectorAll('#stage .frame')].map((f) => f.querySelector('img, canvas'));
    return nodes.map(read);
  });

test('WebKit: every flip shows drawn, colour pictures at once (grid and large view)', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/');
  await page.waitForSelector('#start:not([hidden])');
  await page.waitForFunction(() => !document.querySelector('#start-open').disabled);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#viewer:not([hidden])');
  await page.waitForTimeout(1000);
  const bad = [];
  for (const view of ['grid', 'large view']) {
    if (view === 'large view') {
      await page.keyboard.press(' ');
      await page.waitForTimeout(500);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('ArrowRight');
      const now = await shown(page);
      if (now.some((v) => v === 'blank' || v === 'none' || v < 8)) bad.push(`${view}, flip ${i + 1}: ${now.join(' ')}`);
    }
  }
  assert.deepEqual(bad, [], 'frames without a drawn colour picture right after the key');
  assert.deepEqual(errors, []);
  await page.close();
});
