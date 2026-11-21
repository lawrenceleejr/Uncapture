'use strict';
// Builds JPEGs for tests: an EXIF APP1 with DateTimeOriginal,
// OffsetTimeOriginal, SubSecTimeOriginal, the pixel size and an IFD1
// thumbnail, the way a camera or phone writes them. FakeSource reads these.

const fs = require('fs');
const path = require('path');

// Minimal stand-in for JPEG image data when no real picture is given.
const FAKE_IMAGE = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 1, 2, 3, 4, 0xff, 0xd9]);
const FAKE_THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function ifd(entries, extraStart) {
  entries.sort((a, b) => a.tag - b.tag);
  const head = Buffer.alloc(2 + entries.length * 12 + 4);
  head.writeUInt16LE(entries.length, 0);
  const extras = [];
  let ex = extraStart;
  entries.forEach((e, i) => {
    const o = 2 + i * 12;
    head.writeUInt16LE(e.tag, o);
    head.writeUInt16LE(e.type, o + 2);
    head.writeUInt32LE(e.count, o + 4);
    if (Buffer.isBuffer(e.value)) {
      if (e.value.length <= 4) e.value.copy(head, o + 8);
      else {
        head.writeUInt32LE(ex, o + 8);
        extras.push(e.value);
        ex += e.value.length + (e.value.length % 2);
        if (e.value.length % 2) extras.push(Buffer.alloc(1));
      }
    } else if (e.type === 3) head.writeUInt16LE(e.value, o + 8);
    else head.writeUInt32LE(e.value, o + 8);
  });
  return { buf: head, extra: Buffer.concat(extras), end: ex };
}

const ascii = (s) => Buffer.from(s + '\0', 'latin1');

function exifApp1({ dateTime, offset, subSec, orientation = 1, width = 4032, height = 3024, thumb = FAKE_THUMB }) {
  // tiff offsets: 8 IFD0 | IFD0 extra | ExifIFD | Exif extra | IFD1 | thumbnail
  const ifd0Entries = [
    { tag: 0x010f, type: 2, count: 6, value: ascii('Apple') },
    { tag: 0x0112, type: 3, count: 1, value: orientation },
    { tag: 0x8769, type: 4, count: 1, value: 0 }, // patched below
  ];
  const ifd0Size = 2 + ifd0Entries.length * 12 + 4;
  let d0 = ifd(ifd0Entries.map((e) => ({ ...e })), 8 + ifd0Size);
  const exifStart = d0.end + (d0.end % 2);
  ifd0Entries.find((e) => e.tag === 0x8769).value = exifStart;
  d0 = ifd(ifd0Entries, 8 + ifd0Size);
  const exifEntries = [
    { tag: 0x9003, type: 2, count: 20, value: ascii(dateTime) },
    { tag: 0xa002, type: 4, count: 1, value: width },
    { tag: 0xa003, type: 4, count: 1, value: height },
  ];
  if (offset) exifEntries.push({ tag: 0x9011, type: 2, count: 7, value: ascii(offset) });
  if (subSec) exifEntries.push({ tag: 0x9291, type: 2, count: subSec.length + 1, value: ascii(subSec) });
  const exifSize = 2 + exifEntries.length * 12 + 4;
  const de = ifd(exifEntries, exifStart + exifSize);
  const tiffHead = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);
  const pad0 = Buffer.alloc(exifStart - (8 + d0.buf.length + d0.extra.length));
  let ifd1Start = exifStart + de.buf.length + de.extra.length;
  ifd1Start += ifd1Start % 2;
  const ifd1Size = 2 + 2 * 12 + 4;
  const d1 = ifd(
    [
      { tag: 0x0201, type: 4, count: 1, value: ifd1Start + ifd1Size },
      { tag: 0x0202, type: 4, count: 1, value: thumb.length },
    ],
    ifd1Start + ifd1Size
  );
  d0.buf.writeUInt32LE(ifd1Start, d0.buf.length - 4);
  const pad1 = Buffer.alloc(ifd1Start - (exifStart + de.buf.length + de.extra.length));
  const tiff = Buffer.concat([tiffHead, d0.buf, d0.extra, pad0, de.buf, de.extra, pad1, d1.buf, thumb]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  if (payload.length + 2 > 0xffff) throw new Error('thumbnail too big for one APP1 segment');
  const seg = Buffer.from([0xff, 0xe1, 0, 0]);
  seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([seg, payload]);
}

// image: a real JPEG (Buffer) for the picture itself, else a stand-in.
function buildJpeg(meta, { image, thumb } = {}) {
  const app1 = exifApp1({ ...meta, ...(thumb ? { thumb } : {}) });
  const body = image ? image.subarray(2) : FAKE_IMAGE; // drop the image's own SOI
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, body]);
}

// "2024:05:01 09:00:00" for a wall-clock time in a zone `offMin` east of UTC
function exifTime(ms, offMin = 0) {
  const d = new Date(ms + offMin * 60000);
  const z = (v, n = 2) => String(v).padStart(n, '0');
  return `${d.getUTCFullYear()}:${z(d.getUTCMonth() + 1)}:${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`;
}
function exifOffset(offMin) {
  const s = offMin < 0 ? '-' : '+';
  const a = Math.abs(offMin);
  return `${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/* A library folder from a list of photos:
   [{ name, t (ms UTC), tz (min), image?, thumb?, width?, height?, extra? }]
   `extra` goes to fake.json (favorite, burst, hidden, shared, …). */
function writeLibrary(dir, photos, manifest = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  for (const p of photos) {
    const f = path.join(dir, p.name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (/\.(mov|mp4)$/i.test(p.name)) {
      fs.writeFileSync(f, p.data || Buffer.from(Array.from({ length: 4000 }, (_, i) => i % 256)));
      files[p.name] = { time: p.t, ...(p.extra || {}) };
    } else {
      const tz = p.tz ?? 0;
      const ms = p.t % 1000;
      fs.writeFileSync(
        f,
        buildJpeg(
          { dateTime: exifTime(p.t - ms, tz), offset: exifOffset(tz), subSec: ms ? String(ms).padStart(3, '0') : undefined, width: p.width || 4032, height: p.height || 3024 },
          { image: p.image, thumb: p.thumb }
        )
      );
      if (p.extra) files[p.name] = p.extra;
    }
  }
  fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify({ ...manifest, files }, null, 1));
}

/* Colourful scenes as real JPEGs, made in a browser page (any engine). */
async function renderScenes(browser, count, sizes = [[2400, 1600], [320, 213]]) {
  const page = await browser.newPage();
  const out = await page.evaluate(
    ([count, sizes]) => {
      const render = (w, h, seed) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const x = c.getContext('2d');
        const g = x.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, `hsl(${seed * 47},55%,62%)`);
        g.addColorStop(1, `hsl(${seed * 47 + 120},45%,28%)`);
        x.fillStyle = g;
        x.fillRect(0, 0, w, h);
        for (let i = 0; i < 50; i++) {
          x.fillStyle = `hsla(${(seed * 31 + i * 17) % 360},65%,${30 + (i % 5) * 10}%,.75)`;
          x.fillRect((((i * 97) % 100) * w) / 100, (((i * 61 + seed * 13) % 100) * h) / 100, w / 9, h / 7);
        }
        return c.toDataURL('image/jpeg', 0.82).split(',')[1];
      };
      const scenes = [];
      for (let s = 0; s < count; s++) scenes.push(sizes.map(([w, h]) => render(w, h, s)));
      return scenes;
    },
    [count, sizes]
  );
  await page.close();
  return out.map((sz) => sz.map((b) => Buffer.from(b, 'base64')));
}

module.exports = { buildJpeg, exifApp1, exifTime, exifOffset, writeLibrary, renderScenes };
