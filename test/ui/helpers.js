'use strict';
// Shared by the browser tests: a library of real JPEGs, a server on it, a page.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { writeLibrary, renderScenes } = require('../fixture');

const BIN = process.env.UNCAPTURE_BIN || path.join(__dirname, '..', '..', 'src-tauri', 'target', 'release', 'uncapture');

// 2024-05-01T09:00:00Z
const T0 = Date.UTC(2024, 4, 1, 9, 0, 0);

/* Clusters of these sizes (1 to 12 photos), 2 s apart inside a cluster and
   10 minutes apart between clusters, as real 2400×1600 JPEGs with a 320 px
   thumbnail, in a few distinct scenes. */
async function makeLibrary(browser, dir, sizes, { scenes = 6 } = {}) {
  const art = await renderScenes(browser, scenes);
  const photos = [];
  let n = 1;
  sizes.forEach((size, ci) => {
    for (let k = 0; k < size; k++) {
      const sc = art[(ci + k) % art.length];
      photos.push({ name: `IMG_${String(n++).padStart(4, '0')}.JPG`, t: T0 + ci * 600_000 + k * 2000, tz: 120, image: sc[0], thumb: sc[1], width: 2400, height: 1600 });
    }
  });
  writeLibrary(dir, photos);
  return photos;
}

function startServer(lib, { env = {}, home } = {}) {
  const tmp = home || fs.mkdtempSync(path.join(os.tmpdir(), 'uncapture-home-'));
  const proc = spawn(BIN, ['--serve', '--no-open', '--port', '0', '--fake', lib], { env: { ...process.env, HOME: tmp, TZ: 'UTC', ...env } });
  const base = new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    proc.stderr.on('data', (d) => (out += d));
    proc.on('error', reject);
    setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
  });
  return { proc, base, home: tmp };
}

// A page on the start screen, the library loaded.
async function openStart(browser, base, { viewport = { width: 1440, height: 900 }, init } = {}) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (init) await init(page);
  await page.goto(base + '/');
  await page.waitForSelector('#start:not([hidden])');
  await page.waitForFunction(() => /cluster/.test(document.querySelector('#big-n').textContent));
  return { page, errors };
}

module.exports = { BIN, T0, makeLibrary, startServer, openStart };
