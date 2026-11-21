'use strict';
// A folder of made-up photos to try Uncapture without touching Photos:
//   node scripts/demo-library.js build/demo
//   uncapture --serve --fake build/demo        (or: npm run demo)
// Clusters of 1–12 photos over a year and a half, a burst, favorites, a
// video, and some taken on today's date in earlier years (daily cleanup).

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { writeLibrary, renderScenes } = require('../test/fixture');

(async () => {
  const dir = path.resolve(process.argv[2] || 'build/demo');
  if (fs.existsSync(path.join(dir, 'fake.json'))) {
    console.log(`  ${dir} is already there`);
    return;
  }
  const browser = await chromium.launch();
  const art = await renderScenes(browser, 10, [[1600, 1067], [320, 213]]);
  await browser.close();
  const photos = [];
  let n = 1;
  const now = new Date();
  const start = Date.UTC(now.getFullYear() - 1, 0, 3, 9, 0, 0);
  const sizes = [3, 1, 5, 2, 9, 4, 1, 7, 2, 6, 12, 3, 1, 4, 2, 8];
  let t = start;
  for (let ci = 0; ci < 140; ci++) {
    // every ~3 days, a few clusters an hour or so apart; some on this day last year
    t += ci % 4 === 0 ? 3 * 864e5 : 3600_000 + (ci % 5) * 600_000;
    if (ci === 70) t = Date.UTC(now.getFullYear() - 1, now.getMonth(), now.getDate(), 10, 0, 0);
    const size = sizes[ci % sizes.length];
    for (let k = 0; k < size; k++) {
      const sc = art[(ci * 3 + k) % art.length];
      const extra = {};
      if (ci % 9 === 4 && k === 1) extra.favorite = true;
      if (ci === 10) extra.burst = 'demo-burst';
      photos.push({ name: `IMG_${String(n++).padStart(4, '0')}.JPG`, t: t + k * 2500, tz: 60, image: sc[0], thumb: sc[1], width: 1600, height: 1067, extra: Object.keys(extra).length ? extra : undefined });
    }
    if (ci === 20) photos.push({ name: `IMG_${String(n++).padStart(4, '0')}.MOV`, t: t + 10_000, extra: { duration: 6 } });
  }
  writeLibrary(dir, photos);
  console.log(`  ${photos.length} demo photos in ${dir}`);
})();
