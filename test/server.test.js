'use strict';
// Black-box tests of the server (`uncapture --serve --fake FOLDER`), on a
// folder of JPEGs standing in for the Photos library. Build first:
// npm run build:cli

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('./ui/helpers');
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
  const add = (name, t, extra, tz = 0) => p.push({ name, t, tz, thumb: thumbOf(name), extra });
  add('A1.JPG', T0);
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
  writeLibrary(dir, p);
}

let srv;
let base;
let lib;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uncapture-test-'));

async function api(method, url, body, headers = {}) {
  const r = await fetch(base + url, {
    method,
    headers: { 'X-Uncapture': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
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
  assert.equal(ids.length, 20);
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

test('the API takes changes only from its own page', async () => {
  const put = (headers) => fetch(base + '/api/marks', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await put({})).status, 403, 'no X-Uncapture header');
  assert.equal((await put({ 'X-Uncapture': '1', Origin: 'https://evil.example' })).status, 403, 'a foreign Origin');
  assert.equal((await fetch(base + '/api/state', { headers: { Origin: 'https://evil.example' } })).status, 403, 'even reads');
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
  // the library is read again without them; the keeper's mark stays
  for (let i = 0; i < 50; i++) {
    const st = (await api('GET', '/api/state')).data;
    if (!st.library.loading && st.library.count === 18) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  const ids = (await api('GET', '/api/assets')).data.assets.map((a) => a[0]);
  assert.ok(!ids.includes(idOf('A1.JPG')) && !ids.includes(idOf('A3.JPG')));
  const st = (await api('GET', '/api/state')).data;
  assert.equal(st.firstDeleteSeen, true);
  assert.deepEqual(st.marks.keep, [idOf('A2.JPG')]);
});

test('delete: a photo gone from the library meanwhile is skipped and reported', async () => {
  await api('PUT', '/api/marks', { keep: [idOf('E1.JPG')], del: [], window: 60 });
  // E2 disappears (deleted on another device) before the delete
  fs.renameSync(path.join(lib, 'E2.JPG'), path.join(tmp, 'E2.JPG'));
  const r = (await api('POST', '/api/delete', { ids: [idOf('E2.JPG')], window: 60 })).data;
  assert.equal(r.deleted, 0);
  assert.equal(r.missing, 1);
});

test('access: not asked yet, then asked and allowed; or denied', async () => {
  const dir = path.join(tmp, 'ask');
  writeLibrary(dir, [{ name: 'X.JPG', t: T0 }], { auth: 'notDetermined' });
  const s = startServer(dir, { home: path.join(tmp, 'home-ask') });
  const b = await s.base;
  try {
    const call = (m, u) => fetch(b + u, { method: m, headers: { 'X-Uncapture': '1' } }).then((r) => r.json());
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
    const r = await fetch(b2 + '/api/authorize', { method: 'POST', headers: { 'X-Uncapture': '1' } }).then((x) => x.json());
    assert.equal(r.auth, 'denied');
  } finally {
    s2.proc.kill();
  }
});

test('the page is served; paths outside it are not', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<title>Uncapture<\/title>/);
  assert.equal((await fetch(base + '/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(base + '/nope.txt')).status, 404);
});
