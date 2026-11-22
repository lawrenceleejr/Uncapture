'use strict';
// Black-box tests of the server (`uncapture --serve --fake FOLDER`), on a
// folder of JPEGs standing in for the Photos library. Build first:
// npm run build:cli

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, keyed, pageUrl, KEYS } = require('./ui/helpers');
const { writeLibrary } = require('./fixture');

const H = 3600_000;
const D = 24 * H;
// 2024-07-15T10:00:00Z (not on 1 June: the daily test uses that)
const T0 = Date.UTC(2024, 6, 15, 10, 0, 0);
const thumbOf = (n) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(`thumb-${n}`), Buffer.from([0xff, 0xd9])]);

/* The library:
   A  3 photos, 2 s apart                     (a cluster)
   B  1 photo, 10 min later                   (single)
   C  2 photos 45 s apart + a favorite        (a cluster of 3 at 60 s)
   D  a burst of 3 with an 8-minute gap inside (one cluster, whatever the window)
   E  2 photos exactly 60 s apart             (together at 60 s, apart at 30 s)
   hidden and shared photos never show; a video clusters with photos
   on-this-day: 1 June 2022 and 1 June 2023, a photo from 2 June 2023, and one
   from 1 June 2025 (this year: not "earlier") with UNCAPTURE_TODAY=2025-06-01 */
function library(dir) {
  const p = [];
  const add = (name, t, extra, tz = 0, gps) => p.push({ name, t, tz, thumb: thumbOf(name), extra, gps });
  add('A1.JPG', T0, undefined, 0, [35.96061, -83.92074]);
  add('A2.JPG', T0 + 2000);
  add('A3.JPG', T0 + 4000);
  add('B1.JPG', T0 + 10 * 60_000);
  add('C1.JPG', T0 + H);
  add('C2.JPG', T0 + H + 45_000);
  add('C3.JPG', T0 + H + 50_000, { favorite: true });
  add('D1.JPG', T0 + 2 * H, { burst: 'BURST1' });
  add('D2.JPG', T0 + 2 * H + 8 * 60_000, { burst: 'BURST1' });
  add('D3.JPG', T0 + 2 * H + 8 * 60_000 + 500, { burst: 'BURST1' });
  add('E1.JPG', T0 + 3 * H);
  add('E2.JPG', T0 + 3 * H + 60_000);
  add('HIDDEN.JPG', T0 + 3 * H + 1000, { hidden: true });
  add('SHARED.JPG', T0 + 3 * H + 2000, { shared: true });
  p.push({ name: 'F1.MOV', t: T0 + 4 * H, extra: { duration: 4.5 } });
  add('F2.JPG', T0 + 4 * H + 3000);
  add('Y22.JPG', Date.UTC(2022, 5, 1, 12, 0, 0));
  add('Y22b.JPG', Date.UTC(2022, 5, 1, 12, 0, 20));
  add('Y23.JPG', Date.UTC(2023, 5, 1, 8, 0, 0));
  // 23:30 on 1 June in Tokyo is 14:30 UTC: on this day by its own clock
  add('TOKYO.JPG', Date.UTC(2023, 5, 1, 14, 30, 0), null, 540);
  add('JUNE2.JPG', Date.UTC(2023, 5, 2, 8, 0, 0));
  add('THISYEAR.JPG', Date.UTC(2025, 5, 1, 8, 0, 0));
  add('SOUTH.JPG', Date.UTC(2023, 0, 9, 8, 0, 0), undefined, 0, [-33.8568, 151.2153]);
  add('SHOT1.PNG.JPG', Date.UTC(2023, 8, 10, 9, 0, 0), { screenshot: true });
  add('SHOT2.PNG.JPG', Date.UTC(2023, 8, 10, 9, 0, 20), { screenshot: true });
  add('SHOT3.PNG.JPG', Date.UTC(2023, 8, 11, 9, 0, 0), { screenshot: true });
  writeLibrary(dir, p, { places: { '35.96,-83.92': 'Knoxville, Tennessee' } });
}

let srv;
let base;
let lib;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uncapture-test-'));

async function api(method, url, body, headers = {}) {
  const r = await fetch(base + url, {
    method,
    headers: keyed(base, { 'X-Uncapture': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }),
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: ct.startsWith('application/json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}

let ASSETS = [];
const byName = {};
const idOf = (name) => byName[name];
const names = (ids) => ids.map((id) => Object.keys(byName).find((n) => byName[n] === id));
const clusterNames = (lib) => lib.clusters.map((c) => c.map((i) => names([ASSETS[i][0]])[0]));

test.before(async () => {
  lib = path.join(tmp, 'library');
  library(lib);
  srv = startServer(lib, { env: { UNCAPTURE_TODAY: '2025-06-01' }, home: path.join(tmp, 'home') });
  base = await srv.base;
  // wait for the first read of the library
  for (let i = 0; i < 50; i++) {
    const st = (await api('GET', '/api/state')).data;
    if (st.library.loaded) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // the fake source's ids are hashes of the file's path in the folder
  const st = await api('GET', '/api/assets');
  ASSETS = st.data.assets;
  for (const f of fs.readdirSync(lib)) byName[f] = fnv(f);
});

test.after(() => srv && srv.proc.kill());

// the same short id as source.rs short_id (FNV-1a 64)
function fnv(s) {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(s)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

test('state: the fake library, allowed, with the default settings', async () => {
  const { data } = await api('GET', '/api/state');
  assert.equal(data.source, 'fake');
  assert.equal(data.auth, 'authorized');
  assert.equal(data.settings.window, 60);
  assert.equal(data.settings.clustersOnly, true);
  assert.equal(data.settings.daily, false);
  assert.deepEqual(data.windows, [5, 10, 30, 60, 120, 300, 600, 1800]);
  assert.equal(data.today, '2025-06-01');
});

test('assets: sorted by time, stable ids, hidden and shared left out', async () => {
  const ids = ASSETS.map((a) => a[0]);
  assert.ok(ids.every((id) => /^[0-9a-f]{16}$/.test(id)));
  assert.ok(!ids.includes(idOf('HIDDEN.JPG')), 'hidden photos never show');
  assert.ok(!ids.includes(idOf('SHARED.JPG')), 'Shared Library photos are left out by default');
  assert.equal(ids.length, 24);
  const times = ASSETS.map((a) => a[1]);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  const a1 = ASSETS.find((a) => a[0] === idOf('A1.JPG'));
  assert.equal(a1[1], T0, 'capture time from EXIF, its offset applied');
  assert.equal(a1[2], 0);
  const tokyo = ASSETS.find((a) => a[0] === idOf('TOKYO.JPG'));
  assert.equal(tokyo[1], Date.UTC(2023, 5, 1, 14, 30, 0));
  assert.equal(tokyo[2], 540, 'its own time zone');
  const fav = ASSETS.find((a) => a[0] === idOf('C3.JPG'));
  assert.equal(fav[7] & 1, 1, 'favorite flag');
  const mov = ASSETS.find((a) => a[0] === idOf('F1.MOV'));
  assert.equal(mov[3], 1, 'a video');
  assert.equal(mov[6], 4.5);
});

test('locations: from EXIF GPS, and place names asked once per spot', async () => {
  const a1 = ASSETS.find((a) => a[0] === idOf('A1.JPG'));
  assert.ok(Math.abs(a1[8] - 35.96061) < 1e-4 && Math.abs(a1[9] + 83.92074) < 1e-4, `A1 at ${a1[8]}, ${a1[9]}`);
  const south = ASSETS.find((a) => a[0] === idOf('SOUTH.JPG'));
  assert.ok(south[8] < -33.8 && south[9] > 151.2, 'south and east');
  assert.equal(ASSETS.find((a) => a[0] === idOf('A2.JPG')).length, 8, 'no geotag: no location');
  assert.deepEqual((await api('GET', '/api/place?lat=35.9606&lon=-83.9207')).data, { place: 'Knoxville, Tennessee' });
  assert.deepEqual((await api('GET', '/api/place?lat=1&lon=2')).data, { place: null });
  assert.equal((await api('GET', '/api/place?lat=x')).status, 400);
  assert.equal((await api('GET', '/api/place?lat=NaN&lon=2')).status, 400, 'only places on Earth');
  assert.equal((await api('GET', '/api/place?lat=91&lon=2')).status, 400);
  assert.equal((await api('GET', '/api/place?lat=1&lon=-181')).status, 400);
  const cache = JSON.parse(fs.readFileSync(path.join(tmp, 'home', '.uncapture', 'places.json')));
  assert.deepEqual(cache, { '35.96,-83.92': 'Knoxville, Tennessee' }, 'found names are kept on disk');
});

test('library: videos only shows every video, alone or not', async () => {
  const v = (await api('GET', '/api/library?videosOnly=1&clustersOnly=1')).data;
  assert.deepEqual(clusterNames(v), [['F1.MOV']]);
});

test('library: screenshots only shows every screenshot, alone or not', async () => {
  const v = (await api('GET', '/api/library?screenshotsOnly=1&clustersOnly=1')).data;
  assert.deepEqual(clusterNames(v), [['SHOT1.PNG.JPG', 'SHOT2.PNG.JPG'], ['SHOT3.PNG.JPG']]);
  assert.equal(ASSETS.find((a) => a[0] === idOf('SHOT1.PNG.JPG'))[7] & 2, 2, 'the screenshot flag');
});

test('a photo\'s own file: to save, and (in a browser) Share and drag answer so', async () => {
  const f = await fetch(`${base}/api/original/${idOf('B1.JPG')}`, { headers: keyed(base) });
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-disposition'), `attachment; filename="B1.JPG"; filename*=UTF-8''B1.JPG`);
  assert.deepEqual(Buffer.from(await f.arrayBuffer()), fs.readFileSync(path.join(lib, 'B1.JPG')));
  assert.ok(fs.existsSync(path.join(tmp, 'home', '.uncapture', 'share', idOf('B1.JPG'), 'B1.JPG')), 'written once, kept for a drag or share');
  assert.equal((await fetch(`${base}/api/original/0000000000000000`, { headers: keyed(base) })).status, 404);
  // no app window here: Share is a download, drag isn't offered
  assert.deepEqual((await api('POST', '/api/share', { id: idOf('B1.JPG'), x: 10, y: 10 })).data, { download: `/api/original/${idOf('B1.JPG')}` });
  assert.deepEqual((await api('POST', '/api/drag', { id: idOf('B1.JPG') })).data, { unavailable: true });
  assert.equal((await api('POST', '/api/share', { id: 'nope' })).status, 404);
  assert.equal((await fetch(base + '/api/share', { method: 'POST', headers: keyed(base), body: '{}' })).status, 403, 'its own page only');
});

test('library: clusters at 60 s, singles hidden by "clusters only"', async () => {
  const all = (await api('GET', '/api/library?window=60&clustersOnly=0')).data;
  const cs = clusterNames(all).filter((c) => c[0] < 'G');
  assert.deepEqual(cs, [['A1.JPG', 'A2.JPG', 'A3.JPG'], ['B1.JPG'], ['C1.JPG', 'C2.JPG', 'C3.JPG'], ['D1.JPG', 'D2.JPG', 'D3.JPG'], ['E1.JPG', 'E2.JPG'], ['F1.MOV', 'F2.JPG']]);
  const only = (await api('GET', '/api/library?window=60&clustersOnly=1')).data;
  assert.ok(!clusterNames(only).some((c) => c.length === 1), 'no single photos');
  assert.equal(only.photos, clusterNames(only).flat().length);
});

test('library: the window changes the clusters; a burst stays together', async () => {
  const at30 = clusterNames((await api('GET', '/api/library?window=30&clustersOnly=0')).data);
  assert.ok(at30.some((c) => c.join() === 'E1.JPG'), 'exactly-60 s apart splits at 30 s');
  assert.ok(at30.some((c) => c.join() === 'C1.JPG'), 'C1 apart from C2 at 30 s');
  assert.ok(at30.some((c) => c.join() === 'D1.JPG,D2.JPG,D3.JPG'), 'the burst holds across its 8-minute gap');
  const at5 = clusterNames((await api('GET', '/api/library?window=5&clustersOnly=0')).data);
  assert.ok(at5.some((c) => c.join() === 'D1.JPG,D2.JPG,D3.JPG'));
  const at30min = clusterNames((await api('GET', '/api/library?window=1800&clustersOnly=0')).data);
  assert.ok(at30min.some((c) => c.join() === 'A1.JPG,A2.JPG,A3.JPG,B1.JPG'));
  // windows snap to the steps
  assert.equal((await api('GET', '/api/library?window=70')).data.window, 60);
});

test('library: daily cleanup is this day in earlier years, by each photo\'s own clock', async () => {
  const d = (await api('GET', '/api/library?onThisDay=1&clustersOnly=0')).data;
  assert.deepEqual(clusterNames(d), [['Y22.JPG', 'Y22b.JPG'], ['Y23.JPG'], ['TOKYO.JPG']]);
  assert.deepEqual(d.years, [[2022, 1], [2023, 2]]);
  const only = (await api('GET', '/api/library?onThisDay=1&clustersOnly=1')).data;
  assert.deepEqual(clusterNames(only), [['Y22.JPG', 'Y22b.JPG']]);
});

test('library: daily cleanup on a chosen day of the year', async () => {
  const d = (await api('GET', '/api/library?onThisDay=1&clustersOnly=0&day=06-02')).data;
  assert.deepEqual(clusterNames(d), [['JUNE2.JPG']]);
  const bad = (await api('GET', '/api/library?onThisDay=1&clustersOnly=0&day=02-30')).data;
  assert.equal(bad.years.length, 2, 'a day that does not exist: today');
});

test('library: a date range keeps the clusters that start in it', async () => {
  const r = (await api('GET', '/api/library?from=2023-06-01&to=2023-06-02&clustersOnly=0')).data;
  assert.deepEqual(clusterNames(r), [['Y23.JPG'], ['TOKYO.JPG'], ['JUNE2.JPG']]);
});

test('thumbs: one response, an index line then the JPEGs', async () => {
  const ids = [idOf('A1.JPG'), idOf('C2.JPG'), 'unknown', idOf('F1.MOV')];
  const { status, data } = await api('GET', `/api/thumbs?ids=${ids.join(',')}`);
  assert.equal(status, 200);
  const nl = data.indexOf(10);
  const index = JSON.parse(data.subarray(0, nl).toString());
  assert.deepEqual(index.map(([id]) => id), [idOf('A1.JPG'), idOf('C2.JPG')], 'unknown ids and videos without a poster are skipped');
  let off = nl + 1;
  const got = index.map(([, len]) => {
    const b = data.subarray(off, off + len);
    off += len;
    return b;
  });
  assert.deepEqual(got[0], thumbOf('A1.JPG'));
  assert.deepEqual(got[1], thumbOf('C2.JPG'));
});

test('images: display size, full size, video with byte ranges, progress', async () => {
  const img = await api('GET', `/api/img/${idOf('A1.JPG')}?px=1600`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(img.data, fs.readFileSync(path.join(lib, 'A1.JPG')));
  assert.equal((await api('GET', `/api/img/${idOf('A1.JPG')}?full=1`)).status, 200);
  assert.equal((await api('GET', '/api/img/0000000000000000')).status, 404);
  assert.equal((await api('GET', `/api/img/${idOf('HIDDEN.JPG')}`)).status, 404, 'hidden photos are not served');
  const v = await api('GET', `/api/video/${idOf('F1.MOV')}`, null, { Range: 'bytes=10-19' });
  assert.equal(v.status, 206);
  assert.equal(v.headers.get('content-range'), 'bytes 10-19/4000');
  assert.deepEqual([...v.data], Array.from({ length: 10 }, (_, i) => (i + 10) % 256));
  const p = (await api('GET', `/api/progress/${idOf('A1.JPG')}`)).data;
  assert.deepEqual(p, { downloading: false, progress: 1 });
});

test('sharp copies: downloaded in the background, kept on disk, served for the page', async () => {
  const ids = [idOf('C1.JPG'), idOf('C2.JPG'), idOf('F1.MOV'), 'unknown'];
  const start = (await api('POST', '/api/sharp', { ids })).data;
  assert.equal(start.total, 2, 'videos and unknown ids are left out');
  let st;
  for (let i = 0; i < 50; i++) {
    st = (await api('GET', '/api/sharp')).data;
    if (!st.running) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(st.job, start.job);
  assert.equal(st.done, 2);
  assert.deepEqual([...st.ready].sort(), [idOf('C1.JPG'), idOf('C2.JPG')].sort());
  const dir = path.join(tmp, 'home', '.uncapture', 'sharp-v2');
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${idOf('C1.JPG')}.jpg`, `${idOf('C2.JPG')}.jpg`].sort());
  // served for display sizes from the copy
  fs.writeFileSync(path.join(dir, `${idOf('C1.JPG')}.jpg`), Buffer.from('sharp copy'));
  const img = await api('GET', `/api/img/${idOf('C1.JPG')}?px=2048`);
  assert.equal(img.data.toString(), 'sharp copy');
  // a second day: what's already there counts as done at once
  const again = (await api('POST', '/api/sharp', { ids: [idOf('C2.JPG')] })).data;
  st = (await api('GET', '/api/sharp')).data;
  assert.equal(st.job, again.job);
  assert.deepEqual(st.ready, [idOf('C2.JPG')]);
  assert.equal(st.running, false);
  // and the page's header rule holds
  assert.equal((await fetch(base + '/api/sharp', { method: 'POST', headers: keyed(base), body: '{}' })).status, 403);
});

test('the API takes changes only from its own page', async () => {
  const put = (headers) => fetch(base + '/api/marks', { method: 'PUT', headers: keyed(base, { 'Content-Type': 'application/json', ...headers }), body: '{}' });
  assert.equal((await put({})).status, 403, 'no X-Uncapture header');
  assert.equal((await put({ 'X-Uncapture': '1', Origin: 'https://evil.example' })).status, 403, 'a foreign Origin');
  assert.equal((await fetch(base + '/api/state', { headers: keyed(base, { Origin: 'https://evil.example' }) })).status, 403, 'even reads');
  assert.equal((await put({ 'X-Uncapture': '1', Origin: base })).status, 200, 'its own origin');
  const port = new URL(base).port;
  const rebind = await new Promise((resolve) => {
    require('http').get({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: `evil.example:${port}` } }, (r) => resolve(r.statusCode));
  });
  assert.equal(rebind, 403, 'a foreign Host (DNS rebinding)');
});

test('marks: one keeper marks the rest of its cluster; favorites are protected', async () => {
  // keep A2 and C1
  let r = await api('PUT', '/api/marks', { keep: [idOf('A2.JPG'), idOf('C1.JPG')], del: [], window: 60 });
  assert.equal(r.data.toDelete, 3, 'A1, A3 and C2 (not the favorite C3)');
  const rv = (await api('GET', '/api/review?window=60')).data;
  const dels = rv.clusters.flatMap((c) => c.del);
  assert.deepEqual(names(dels).sort(), ['A1.JPG', 'A3.JPG', 'C2.JPG']);
  assert.equal(rv.count, 3);
  assert.ok(rv.bytes > 0);
  assert.equal(Object.keys(rv.sizes).length, 3);
  // marking the favorite explicitly
  r = await api('PUT', '/api/marks', { keep: [idOf('A2.JPG'), idOf('C1.JPG')], del: [idOf('C3.JPG')], window: 60 });
  assert.equal(r.data.toDelete, 4);
  // the window changes what's in a cluster, so what goes
  r = await api('PUT', '/api/marks', { keep: [idOf('A2.JPG'), idOf('C1.JPG')], del: [], window: 30 });
  assert.equal(r.data.toDelete, 2, 'at 30 s C1 is alone: only A1 and A3');
  // saved on disk by localIdentifier
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'home', '.uncapture', 'state.json')));
  assert.deepEqual(saved.keep.sort(), ['A2.JPG', 'C1.JPG']);
  // and back in /api/state as ids
  const st = (await api('GET', '/api/state')).data;
  assert.deepEqual(st.marks.keep.sort(), [idOf('A2.JPG'), idOf('C1.JPG')].sort());
});

test('settings are saved; the window snaps to a step', async () => {
  const r = await api('PUT', '/api/settings', { window: 100, clustersOnly: false });
  assert.equal(r.data.settings.window, 120);
  assert.equal(r.data.settings.clustersOnly, false);
  const st = (await api('GET', '/api/state')).data;
  assert.equal(st.settings.window, 120);
  await api('PUT', '/api/settings', { window: 60, clustersOnly: true });
});

test('delete: a cancelled confirmation deletes nothing', async () => {
  await api('PUT', '/api/marks', { keep: [idOf('A2.JPG')], del: [], window: 60 });
  fs.writeFileSync(path.join(lib, '.cancel-delete'), '');
  try {
    const r = (await api('POST', '/api/delete', { ids: [idOf('A1.JPG'), idOf('A3.JPG')], window: 60 })).data;
    assert.equal(r.cancelled, true);
    assert.equal(r.deleted, 0);
    assert.ok(fs.existsSync(path.join(lib, 'A1.JPG')) && fs.existsSync(path.join(lib, 'A3.JPG')));
  } finally {
    fs.unlinkSync(path.join(lib, '.cancel-delete'));
  }
});

test('delete: exactly the marked photos go, and only what is still marked', async () => {
  await api('PUT', '/api/marks', { keep: [idOf('A2.JPG')], del: [], window: 60 });
  // B1 isn't marked: asking for it anyway must not delete it
  const r = (await api('POST', '/api/delete', { ids: [idOf('A1.JPG'), idOf('A3.JPG'), idOf('B1.JPG')], window: 60 })).data;
  assert.equal(r.deleted, 2);
  assert.equal(r.skipped, 1);
  assert.equal(r.cancelled, false);
  assert.deepEqual(fs.readdirSync(path.join(lib, '.trash')).sort(), ['A1.JPG', 'A3.JPG']);
  assert.ok(fs.existsSync(path.join(lib, 'B1.JPG')) && fs.existsSync(path.join(lib, 'A2.JPG')));
  // the space it cleared, logged for "cleared so far"
  const size = (n) => fs.statSync(path.join(lib, '.trash', n)).size;
  assert.equal(r.bytes, size('A1.JPG') + size('A3.JPG'));
  assert.equal(r.allBytes, r.bytes);
  assert.equal(r.allPhotos, 2);
  assert.deepEqual((await api('GET', '/api/state')).data.deletions, [{ date: '2025-06-01', photos: 2, bytes: r.bytes }]);
  // the library is read again without them; the keeper's mark stays
  for (let i = 0; i < 50; i++) {
    const st = (await api('GET', '/api/state')).data;
    if (!st.library.loading && st.library.count === ASSETS.length - 2) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  const ids = (await api('GET', '/api/assets')).data.assets.map((a) => a[0]);
  assert.ok(!ids.includes(idOf('A1.JPG')) && !ids.includes(idOf('A3.JPG')));
  const st = (await api('GET', '/api/state')).data;
  assert.equal(st.firstDeleteSeen, true);
  assert.deepEqual(st.marks.keep, [idOf('A2.JPG')]);
});

test('delete from daily cleanup logs the day of the year, with how many of its photos went', async () => {
  await api('PUT', '/api/marks', { keep: [idOf('Y22.JPG')], del: [idOf('JUNE2.JPG')], window: 60 });
  const r = (await api('POST', '/api/delete', { ids: [idOf('Y22b.JPG'), idOf('JUNE2.JPG')], window: 60, day: '06-01' })).data;
  assert.equal(r.deleted, 2);
  const st = (await api('GET', '/api/state')).data;
  assert.deepEqual(st.dailyLog, { '06-01': [{ date: '2025-06-01', deleted: 1 }] }, 'only Y22b was taken on 1 June');
  // a delete that removes nothing of that day logs nothing
  await api('PUT', '/api/marks', { keep: [idOf('C1.JPG')], del: [], window: 60 });
  await api('POST', '/api/delete', { ids: [idOf('C2.JPG')], window: 60, day: '03-03' });
  assert.deepEqual((await api('GET', '/api/state')).data.dailyLog, { '06-01': [{ date: '2025-06-01', deleted: 1 }] });
});

test('favorite: the heart is written to the library and protects the photo', async () => {
  await api('PUT', '/api/marks', { keep: [idOf('D1.JPG')], del: [], window: 60 });
  assert.equal((await api('GET', '/api/review?window=60')).data.clusters.find((c) => c.ids.includes(idOf('D2.JPG'))).del.length, 2);
  const r = await api('POST', '/api/favorite', { ids: [idOf('D2.JPG')], on: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.favorite, true);
  const g = (await api('GET', '/api/review?window=60')).data.clusters.find((c) => c.ids.includes(idOf('D2.JPG')));
  assert.deepEqual(names(g.del), ['D3.JPG'], 'a favorite is not marked by a keeper');
  assert.equal(JSON.parse(fs.readFileSync(path.join(lib, 'fake.json'))).files['D2.JPG'].favorite, true);
  await api('POST', '/api/favorite', { ids: [idOf('D2.JPG')], on: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(lib, 'fake.json'))).files['D2.JPG'].favorite, false);
  assert.equal((await api('POST', '/api/favorite', { ids: ['0000000000000000'], on: true })).status, 404);
  await api('PUT', '/api/marks', { keep: [], del: [], window: 60 });
});

test('delete: a photo gone from the library meanwhile is skipped and reported', async () => {
  await api('PUT', '/api/marks', { keep: [idOf('E1.JPG')], del: [], window: 60 });
  // E2 disappears (deleted on another device) before the delete
  fs.renameSync(path.join(lib, 'E2.JPG'), path.join(tmp, 'E2.JPG'));
  const r = (await api('POST', '/api/delete', { ids: [idOf('E2.JPG')], window: 60 })).data;
  assert.equal(r.deleted, 0);
  assert.equal(r.missing, 1);
});

test('undo: the last delete is put back from copies kept before it', async () => {
  const dir = path.join(tmp, 'undo');
  const t = Date.UTC(2023, 5, 1, 9, 0, 0);
  const p = [];
  const add = (name, dt, extra, gps) => p.push({ name, t: t + dt, tz: 0, thumb: thumbOf(name), extra, gps });
  add('U1.JPG', 0);
  add('U2.JPG', 2000, undefined, [35.96061, -83.92074]);
  add('U3.JPG', 4000, { favorite: true });
  add('V1.JPG', H);
  add('V2.JPG', H + 2000);
  writeLibrary(dir, p);
  const home = path.join(tmp, 'home-undo');
  const s = startServer(dir, { env: { UNCAPTURE_TODAY: '2025-06-01' }, home });
  const b = await s.base;
  const call = async (m, u, body) => {
    const r = await fetch(b + u, { method: m, headers: keyed(b, { 'X-Uncapture': '1', 'Content-Type': 'application/json' }), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  const id = (n) => fnv(n);
  const undoDir = path.join(home, '.uncapture', 'undo');
  try {
    for (let i = 0; i < 50 && !(await call('GET', '/api/state')).data.library.loaded; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await call('GET', '/api/state')).data.undo, null, 'nothing to undo yet');
    assert.equal((await call('POST', '/api/undo')).status, 404);
    // U1 kept; U2 goes, and U3 (a favorite, marked D)
    await call('PUT', '/api/marks', { keep: [id('U1.JPG')], del: [id('U3.JPG')], window: 60 });
    const r = (await call('POST', '/api/delete', { ids: [id('U2.JPG'), id('U3.JPG')], window: 60, day: '06-01' })).data;
    assert.equal(r.deleted, 2);
    assert.deepEqual(r.undo, { photos: 2, bytes: r.bytes, date: '2025-06-01', notKept: 0 });
    assert.deepEqual(fs.readdirSync(undoDir).sort(), ['batch.json', id('U2.JPG'), id('U3.JPG')].sort(), 'a copy of each');
    assert.ok(!fs.existsSync(path.join(dir, 'U2.JPG')));
    // a delete that's cancelled keeps the undo there was
    await call('PUT', '/api/marks', { keep: [id('U1.JPG'), id('V1.JPG')], del: [], window: 60 });
    fs.writeFileSync(path.join(dir, '.cancel-delete'), '');
    assert.equal((await call('POST', '/api/delete', { ids: [id('V2.JPG')], window: 60 })).data.cancelled, true);
    fs.unlinkSync(path.join(dir, '.cancel-delete'));
    assert.equal((await call('GET', '/api/state')).data.undo.photos, 2);
    assert.ok(!fs.existsSync(path.join(home, '.uncapture', 'undo-new')), 'its copies are dropped');
    // undo: back in the library, with the heart, and no longer counted as cleared
    const u = (await call('POST', '/api/undo')).data;
    assert.equal(u.restored, 2);
    assert.equal(u.failed, 0);
    assert.equal(u.bytes, r.bytes);
    assert.equal(u.allPhotos, 0);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'U2.JPG')), fs.readFileSync(path.join(dir, '.trash', 'U2.JPG')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'fake.json'))).files['U3.JPG'].favorite, true);
    const st = (await call('GET', '/api/state')).data;
    assert.equal(st.undo, null);
    assert.deepEqual(st.deletions, []);
    assert.deepEqual(st.dailyLog, {}, 'the cleanup of 1 June is undone too');
    assert.deepEqual(st.marks.keep.sort(), [id('U1.JPG'), id('V1.JPG'), id('U2.JPG'), id('U3.JPG')].sort(), 'what came back is kept, not marked to go again');
    assert.ok(!fs.existsSync(undoDir));
    for (let i = 0; i < 50; i++) {
      const ids = (await call('GET', '/api/assets')).data.assets.map((a) => a[0]);
      if (ids.includes(id('U2.JPG')) && ids.includes(id('U3.JPG'))) break;
      assert.ok(i < 49, 'the library has them again');
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal((await call('POST', '/api/undo')).status, 404, 'once');
    // the next delete makes the next undo
    const r2 = (await call('POST', '/api/delete', { ids: [id('V2.JPG')], window: 60 })).data;
    assert.equal(r2.undo.photos, 1);
    assert.deepEqual(fs.readdirSync(undoDir).sort(), ['batch.json', id('V2.JPG')].sort());
    // and a delete asked without undo keeps no copies (and leaves no undo)
    await call('PUT', '/api/marks', { keep: [id('U2.JPG')], del: [], window: 60 });
    const r3 = (await call('POST', '/api/delete', { ids: [id('U1.JPG')], window: 60, undo: false })).data;
    assert.equal(r3.deleted, 1);
    assert.equal(r3.undo, null);
  } finally {
    s.proc.kill();
  }
});

test('access: not asked yet, then asked and allowed; or denied', async () => {
  const dir = path.join(tmp, 'ask');
  writeLibrary(dir, [{ name: 'X.JPG', t: T0 }], { auth: 'notDetermined' });
  const s = startServer(dir, { home: path.join(tmp, 'home-ask') });
  const b = await s.base;
  try {
    const call = (m, u) => fetch(b + u, { method: m, headers: keyed(b, { 'X-Uncapture': '1' }) }).then((r) => r.json());
    let st = await call('GET', '/api/state');
    assert.equal(st.auth, 'notDetermined');
    assert.equal((await call('GET', '/api/assets')).assets.length, 0, 'nothing before access');
    assert.equal((await call('POST', '/api/authorize')).auth, 'authorized');
    for (let i = 0; i < 50 && !st.library.count; i++) {
      await new Promise((r) => setTimeout(r, 100));
      st = await call('GET', '/api/state');
    }
    assert.equal(st.library.count, 1);
  } finally {
    s.proc.kill();
  }
  const dir2 = path.join(tmp, 'deny');
  writeLibrary(dir2, [{ name: 'X.JPG', t: T0 }], { auth: 'notDetermined', answer: 'deny' });
  const s2 = startServer(dir2, { home: path.join(tmp, 'home-deny') });
  const b2 = await s2.base;
  try {
    const r = await fetch(b2 + '/api/authorize', { method: 'POST', headers: keyed(b2, { 'X-Uncapture': '1' }) }).then((x) => x.json());
    assert.equal(r.auth, 'denied');
  } finally {
    s2.proc.kill();
  }
});

test('other programs and web pages can\'t use the API: it takes the launch\'s key', async () => {
  const get = (headers) => fetch(base + '/api/assets', { headers }).then((r) => r.status);
  assert.equal(await get({}), 401, 'no key: not even a read');
  assert.equal(await get({ 'X-Uncapture-Key': '0'.repeat(32) }), 401, 'a wrong key');
  assert.equal(await get({ Cookie: `uncapture_${new URL(base).port}=nope` }), 401, 'a wrong cookie');
  assert.equal(await get(keyed(base)), 200, 'the key as a header');
  assert.equal(await get(keyed(base, { 'Sec-Fetch-Site': 'cross-site' })), 403, 'from another site, even with the key');
  assert.equal(await get(keyed(base, { 'Sec-Fetch-Site': 'same-site' })), 403, 'from another port');
  // the page, opened with the key, gets it as a cookie its scripts can't read
  const page = await fetch(pageUrl(base));
  const set = page.headers.get('set-cookie');
  assert.match(set, new RegExp(`^uncapture_${new URL(base).port}=${KEYS[base]}; Path=/; HttpOnly; SameSite=Strict$`));
  assert.equal(await get({ Cookie: set.split(';')[0], 'Sec-Fetch-Site': 'same-origin' }), 200, 'the cookie');
  assert.equal((await fetch(base + '/?key=nope')).headers.get('set-cookie'), null, 'no cookie for a wrong key');
  assert.equal((await fetch(base + '/')).headers.get('set-cookie'), null);
});

test('the page is served with a strict policy; paths outside it are not', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await r.text(), /<title>Uncapture<\/title>/);
  assert.equal((await fetch(base + '/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(base + '/nope.txt')).status, 404);
});

test('hide: H hides a photo in the library and takes it out of the clusters at once; B shows it again', async () => {
  const id = idOf('SOUTH.JPG');
  const inLibrary = async () => (await api('GET', '/api/library?window=60&clustersOnly=0')).data.clusters.flat().map((i) => ASSETS[i] && ASSETS[i][0]);
  assert.ok((await inLibrary()).includes(id));
  assert.equal((await api('POST', '/api/unhide')).status, 404, 'nothing hidden yet');
  const r = await api('POST', '/api/hide', { ids: [id] });
  assert.equal(r.status, 200);
  assert.equal(r.data.hidden, 1);
  assert.ok(!(await inLibrary()).includes(id), 'out of the clusters straight away');
  assert.equal(JSON.parse(fs.readFileSync(path.join(lib, 'fake.json'))).files['SOUTH.JPG'].hidden, true, 'hidden in the library');
  for (let i = 0; i < 50; i++) {
    const ids = (await api('GET', '/api/assets')).data.assets.map((a) => a[0]);
    if (!ids.includes(id)) break;
    assert.ok(i < 49, 'and gone from the assets once read again');
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal((await api('POST', '/api/hide', { ids: [id] })).status, 404, 'a hidden photo is no longer there to hide');
  const u = await api('POST', '/api/unhide');
  assert.deepEqual(u.data, { unhidden: 1, ids: [id] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(lib, 'fake.json'))).files['SOUTH.JPG'].hidden, false);
  for (let i = 0; i < 50; i++) {
    const ids = (await api('GET', '/api/assets')).data.assets.map((a) => a[0]);
    if (ids.includes(id)) break;
    assert.ok(i < 49, 'back in the assets');
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal((await api('POST', '/api/unhide')).status, 404, 'once');
});
