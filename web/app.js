'use strict';
/* Uncapture UI. No framework: a few views toggled by `hidden`, one keyboard
   map, and Brackit's machinery for instant flipping (a prioritised load queue,
   a batched thumbnail store, display-size copies made in idle time). */

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const api = async (method, url, body) => {
  const r = await fetch(url, {
    method,
    // the server only accepts changes from its own page (see server.rs handle)
    headers: { 'X-Uncapture': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
};
const dpr = () => window.devicePixelRatio || 1;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmtN = (n) => n.toLocaleString('en-US');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const S = {
  server: null,
  assets: [], // [{id, t, tz, kind, w, h, dur, fav, shot, burst, shared}]
  byId: new Map(),
  version: 0,
  clusters: [], // arrays of asset ids, in time order
  years: [],
  idx: 0,
  focus: 0, // position of the focused photo in the cluster
  keep: new Set(),
  del: new Set(),
  settings: { window: 60, clustersOnly: true, daily: false, videosOnly: false, from: null, to: null },
  toDelete: 0,
  solo: null, // {zoom}
  dailyDay: null, // the day of the year for daily cleanup, "MM-DD" (today by default)
  flipping: false,
  lastKeyAt: 0,
};

/* ------------------------------------------------------------ time */

// The wall-clock time a photo was taken: its own time zone where known,
// otherwise this Mac's (PhotoKit doesn't record the zone).
function wall(a) {
  if (a.tz == null) {
    const d = new Date(a.t);
    return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), wd: d.getDay(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
  }
  const d = new Date(a.t + a.tz * 60000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}
const z2 = (v) => String(v).padStart(2, '0');
const dayKey = (w) => `${w.y}-${z2(w.mo + 1)}-${z2(w.d)}`;
const fmtTime = (a) => {
  const w = wall(a);
  return `${z2(w.h)}:${z2(w.mi)}:${z2(w.s)}`;
};
const fmtDay = (a, withWeekday = true) => {
  const w = wall(a);
  return `${withWeekday ? DAYS[w.wd] + ' ' : ''}${w.d} ${MONTHS[w.mo]} ${w.y}`;
};
function niceDay(d, withYear = true) {
  const [y, m, dd] = d.split('-');
  return `${+dd} ${MONTHS[+m - 1]}${withYear ? ' ' + y : ''}`;
}
const fmtBytes = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
const fmtDur = (s) => (s > 0 ? `${Math.floor(s / 60)}:${z2(Math.floor(s % 60))}` : '');
const fmtWindow = (s) => (s < 60 ? `${s} s` : `${s / 60} min`);

/* ------------------------------------------------------------ boot */

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('shell') === 'tauri') document.body.classList.add('app');
  S.server = await api('GET', '/api/state');
  document.body.classList.add(S.server.platform);
  Object.assign(S.settings, S.server.settings);
  S.keep = new Set(S.server.marks.keep);
  S.del = new Set(S.server.marks.del);
  bindUi();
  buildHelp();
  if (!authorized()) return showAuth();
  await loadLibrary();
  showStart();
}

const authorized = () => S.server && (S.server.auth === 'authorized' || S.server.auth === 'limited');

// The asset list, once per library version. Clusters index into it.
async function loadAssets() {
  const r = await fetch('/api/assets');
  const data = await r.json();
  S.version = data.version;
  S.assets = data.assets.map(([id, t, tz, kind, w, h, dur, flags, lat, lon]) => ({
    id, t, tz, w, h, dur, lat, lon,
    kind: kind === 1 ? 'video' : kind === 2 ? 'live' : 'photo',
    fav: !!(flags & 1), shot: !!(flags & 2), burst: !!(flags & 4), shared: !!(flags & 8),
  }));
  S.byId = new Map(S.assets.map((a) => [a.id, a]));
  for (const a of S.assets) a.day = dayKey(wall(a));
}

// Wait until the server has read the library (the first time can take a
// moment for a big one), then load it.
async function loadLibrary() {
  for (let i = 0; ; i++) {
    S.server = await api('GET', '/api/state');
    const lib = S.server.library;
    if (lib.loaded || (!lib.loading && i > 0) || (lib.count > 0 && i === 0)) break;
    $('#start-status').textContent = 'Reading your Photos library…';
    await new Promise((r) => setTimeout(r, 400));
  }
  $('#start-status').textContent = '';
  await loadAssets();
}

/* ------------------------------------------------------------ access */

function showAuth() {
  for (const v of ['#start', '#viewer', '#review']) $(v).hidden = true;
  $('#auth').hidden = false;
  setChrome('auth');
  const a = S.server.auth;
  $('#auth-ask').hidden = a !== 'notDetermined';
  $('#auth-denied').hidden = a === 'notDetermined';
  $('#auth-denied-text').textContent =
    a === 'restricted'
      ? "Access to Photos is restricted on this Mac (by Screen Time or a management profile), so Uncapture can't see your photos."
      : "Uncapture isn't allowed to see your photos. Turn it on in System Settings → Privacy & Security → Photos, then come back here.";
  $('#auth-open').hidden = a === 'restricted';
}

async function allowAccess() {
  $('#auth-status').textContent = 'Waiting for your answer…';
  const r = await api('POST', '/api/authorize').catch((e) => ({ error: e.message }));
  $('#auth-status').textContent = r.error || '';
  S.server.auth = r.auth || S.server.auth;
  if (authorized()) {
    await loadLibrary();
    showStart();
  } else showAuth();
}

// After opening System Settings, notice when access is turned on.
async function recheckAuth() {
  if ($('#auth').hidden) return;
  const st = await api('GET', '/api/state').catch(() => null);
  if (!st) return;
  S.server = st;
  if (authorized()) {
    await loadLibrary();
    showStart();
  } else showAuth();
}

/* ------------------------------------------------------------ chrome */

function setChrome(view) {
  const viewer = view === 'viewer';
  $('#bar .center').hidden = !viewer;
  $('#filters-btn').hidden = !viewer;
  $('#review-btn').hidden = view === 'auth';
  $('#fs-btn').hidden = view === 'auth';
  updateWhere();
}

function updateWhere() {
  const w = $('#where');
  if ($('#viewer').hidden) return (w.textContent = '');
  if (S.settings.daily) {
    // "On this day: 2019 · 2021 · 2023 (14 clusters) · last cleaned up 12 Nov 2026"
    const ys = S.years.map(([y]) => y).join(' · ');
    w.innerHTML = '';
    w.append(`${dayName(dailyDay())}: `, el('b', '', ys || 'nothing'), ` (${fmtN(S.clusters.length)} cluster${S.clusters.length === 1 ? '' : 's'})`);
    const last = (S.server.dailyLog[dailyDay()] || []).at(-1);
    if (last) w.append(` · last cleaned up ${niceDay(last.date)}`);
  } else w.textContent = rangeLabel();
  if (S.settings.videosOnly) w.append(' · videos only');
}

function updateDeleteCount() {
  const n = S.toDelete;
  $('#review-count').textContent = fmtN(n);
  $('#start-review-n').textContent = fmtN(n);
  $('#review-btn').classList.toggle('has', n > 0);
  $('#start-review').classList.toggle('has', n > 0);
  const c = $('#c-del');
  c.innerHTML = '';
  c.append(el('b', '', fmtN(n)), ' to delete so far');
}

let toastTimer = null;
function toast(msg, opts = {}) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), opts.ms || 1800);
}

/* ------------------------------------------------------------ start screen */

const ST = { bins: [], geom: null, drag: null, monthly: true, lib: null, token: 0 };

function showStart() {
  for (const v of ['#auth', '#viewer', '#review']) $(v).hidden = true;
  closeSolo();
  $('#start').hidden = false;
  $('#start-return').hidden = !S.clusters.length || !S.opened;
  setChrome('start');
  renderWindows();
  $('#opt-clusters').checked = S.settings.clustersOnly;
  $('#opt-daily').checked = S.settings.daily;
  $('#opt-videos').checked = S.settings.videosOnly;
  renderDaily();
  renderSaved();
  ST.bins = chartBins();
  drawChart();
  showDailyRows();
  refreshStart();
}

// Daily cleanup shows the calendar of days in place of the chart of dates.
function showDailyRows() {
  $('#chart-row').hidden = S.settings.daily;
  $('#cal-row').hidden = !S.settings.daily;
  if (S.settings.daily) drawCalendar();
}

/* Cleared so far: the total, a sparkline of it growing from the first delete
   to today (a step at each delete, the last value marked), and the facts. */
function renderSaved() {
  const log = S.server.deletions || [];
  $('#saved-row').hidden = !log.length;
  if (!log.length) return;
  const bytes = log.reduce((t, d) => t + d.bytes, 0);
  const photos = log.reduce((t, d) => t + d.photos, 0);
  $('#saved-n').textContent = fmtBytes(bytes);
  const first = log[0].date;
  $('#saved-sub').textContent = `${fmtN(photos)} photo${photos === 1 ? '' : 's'} since ${niceDay(first)} · the last ${fmtBytes(log.at(-1).bytes)} on ${niceDay(log.at(-1).date)}`;
  const svg = $('#saved-spark');
  const W = 180;
  const H = 28;
  const t0 = Date.parse(first);
  const t1 = Math.max(Date.parse(S.server.today), Date.parse(log.at(-1).date)) + 864e5;
  const x = (t) => ((t - t0) / (t1 - t0)) * W;
  const y = (b) => H - 2 - (b / bytes) * (H - 4);
  let total = 0;
  let d = `M0 ${y(0)}`;
  for (const e of log) {
    const xe = x(Date.parse(e.date)).toFixed(1);
    d += ` H${xe}`;
    total += e.bytes;
    d += ` V${y(total).toFixed(1)}`;
  }
  d += ` H${W}`;
  svg.innerHTML = `<line class="base" x1="0" x2="${W}" y1="${H - 1.5}" y2="${H - 1.5}"/><path d="${d}"/><circle cx="${W}" cy="${y(total)}" r="2"/>`;
  svg.setAttribute('aria-label', `${fmtBytes(bytes)} cleared since ${niceDay(first)}`);
}

function renderDaily() {
  const done = S.server.dailyDone && S.server.dailyDone === S.server.today;
  const s = $('#daily-status');
  s.textContent = done ? 'done today' : 'not done today';
  s.classList.toggle('done', !!done);
}

function renderWindows() {
  const box = $('#windows');
  box.replaceChildren();
  for (const w of S.server.windows) {
    const b = el('button', w === S.settings.window ? 'on' : '', fmtWindow(w));
    b.onclick = () => setWindow(w);
    box.append(b);
  }
}

// What the current filters give, from the server (clustering is the server's).
function libraryUrl() {
  const s = S.settings;
  const q = new URLSearchParams({ window: s.window, clustersOnly: s.clustersOnly ? 1 : 0, onThisDay: s.daily ? 1 : 0 });
  if (s.daily) q.set('day', dailyDay());
  if (s.videosOnly) q.set('videosOnly', 1);
  if (!s.daily && s.from) q.set('from', s.from);
  if (!s.daily && s.to) q.set('to', s.to);
  return '/api/library?' + q;
}

let startTimer = 0;
function refreshStart() {
  clearTimeout(startTimer);
  startTimer = setTimeout(async () => {
    const token = ++ST.token;
    const lib = await api('GET', libraryUrl()).catch(() => null);
    if (!lib || token !== ST.token) return;
    ST.lib = lib;
    S.toDelete = lib.toDelete;
    updateDeleteCount();
    const n = lib.clusters.length;
    $('#big-n').textContent = S.settings.videosOnly
      ? `${fmtN(lib.photos)} video${lib.photos === 1 ? '' : 's'} · ${fmtN(n)} cluster${n === 1 ? '' : 's'}`
      : `${fmtN(n)} cluster${n === 1 ? '' : 's'} · ${fmtN(lib.photos)} photo${lib.photos === 1 ? '' : 's'}`;
    const where = S.settings.daily
      ? lib.years.length
        ? `${dayName(dailyDay())}: ${lib.years.map(([y]) => y).join(' · ')}`
        : `Nothing from ${dailyDay() === todayMD() ? 'this day' : dayName(dailyDay())} in earlier years`
      : rangeLabel();
    $('#big-sub').textContent = `${where} · of ${fmtN(S.assets.length)} in the library`;
    $('#start-open').disabled = n === 0;
  }, 60);
}

function rangeLabel() {
  const { from, to } = S.settings;
  if (!from && !to) return 'All dates';
  const a = from || ST.firstDay;
  const b = to || ST.lastDay;
  if (!a || !b) return 'All dates';
  if (a === b) return niceDay(a);
  // whole months read as months
  const first = a.endsWith('-01');
  const last = b === lastOfMonth(b);
  if (first && last) {
    const ma = `${MONTHS[+a.slice(5, 7) - 1]} ${a.slice(0, 4)}`;
    const mb = `${MONTHS[+b.slice(5, 7) - 1]} ${b.slice(0, 4)}`;
    return ma === mb ? ma : `${ma} – ${mb}`;
  }
  return `${niceDay(a, a.slice(0, 4) !== b.slice(0, 4))} – ${niceDay(b)}`;
}
const lastOfMonth = (d) => {
  const y = +d.slice(0, 4);
  const m = +d.slice(5, 7);
  return `${y}-${z2(m)}-${z2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
};

/* Photos per month (per day for a short library) on a true time axis: empty
   months are gaps. Selected bins in ink, the rest recede; the peak labelled. */
function chartBins() {
  const days = new Map();
  for (const a of S.assets) days.set(a.day, (days.get(a.day) || 0) + 1);
  const keys = [...days.keys()].sort();
  if (!keys.length) return [];
  ST.firstDay = keys[0];
  ST.lastDay = keys.at(-1);
  const span = (Date.parse(keys.at(-1)) - Date.parse(keys[0])) / 864e5;
  ST.monthly = span > 120;
  $('#chart-title').textContent = ST.monthly ? 'Photos per month' : 'Photos per day';
  const bins = new Map();
  for (const [d, n] of days) {
    const k = ST.monthly ? d.slice(0, 7) : d;
    bins.set(k, (bins.get(k) || 0) + n);
  }
  // a continuous axis
  const out = [];
  if (ST.monthly) {
    let y = +keys[0].slice(0, 4);
    let m = +keys[0].slice(5, 7);
    const end = keys.at(-1).slice(0, 7);
    for (;;) {
      const k = `${y}-${z2(m)}`;
      out.push({ key: k, n: bins.get(k) || 0, from: `${k}-01`, to: lastOfMonth(`${k}-01`) });
      if (k === end) break;
      if (++m > 12) (m = 1), y++;
    }
  } else {
    for (let t = Date.parse(keys[0]); t <= Date.parse(keys.at(-1)); t += 864e5) {
      const k = new Date(t).toISOString().slice(0, 10);
      out.push({ key: k, n: bins.get(k) || 0, from: k, to: k });
    }
  }
  return out;
}

function drawChart() {
  const svg = $('#chart');
  const W = svg.clientWidth || 800;
  const H = 72;
  svg.setAttribute('viewBox', `0 0 ${W} ${H + 22}`);
  svg.innerHTML = '';
  svg.classList.toggle('off', S.settings.daily);
  const bins = ST.bins;
  if (!bins.length) return;
  const n = bins.length;
  const step = W / n;
  const bw = Math.max(1, Math.min(14, step * 0.72));
  const max = Math.max(1, ...bins.map((b) => b.n));
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  ST.geom = { n, step, W };
  const { from, to } = S.settings;
  const inSel = (b) => (!from || b.to >= from) && (!to || b.from <= to);
  if (from || to) {
    const i0 = from ? Math.max(0, bins.findIndex((b) => b.to >= from)) : 0;
    let i1 = to ? bins.findIndex((b) => b.from > to) - 1 : n - 1;
    if (i1 < 0) i1 = n - 1;
    mk('rect', { x: (i0 * step).toFixed(2), y: 0, width: ((i1 - i0 + 1) * step).toFixed(2), height: H, class: 'band' });
  }
  const top = H - 13; // headroom for the peak's label
  bins.forEach((b, i) => {
    if (!b.n) return;
    const h = Math.max(1.5, (b.n / max) * top);
    const r = mk('rect', { x: (i * step + (step - bw) / 2).toFixed(2), y: (H - h).toFixed(2), width: bw.toFixed(2), height: h.toFixed(2), class: inSel(b) ? 'bar on' : 'bar' });
    const label = ST.monthly ? `${MONTHS[+b.key.slice(5, 7) - 1]} ${b.key.slice(0, 4)}` : niceDay(b.key);
    r.append(Object.assign(document.createElementNS(NS, 'title'), { textContent: `${label}: ${fmtN(b.n)}` }));
  });
  mk('line', { x1: 0, x2: W, y1: H + 0.5, y2: H + 0.5, class: 'base' });
  // the tallest bin labelled directly
  let peak = 0;
  bins.forEach((b, i) => b.n > bins[peak].n && (peak = i));
  mk('text', { x: clamp(peak * step + step / 2, 14, W - 14), y: H - (bins[peak].n / max) * top - 4, class: 'peak', 'text-anchor': 'middle' }, fmtN(bins[peak].n));
  // sparse labels: years (monthly) or the ends and month starts (daily)
  const labels = [];
  if (ST.monthly) {
    bins.forEach((b, i) => b.key.endsWith('-01') && labels.push({ i, text: b.key.slice(0, 4), tick: true }));
    if (!bins[0].key.endsWith('-01')) labels.unshift({ i: 0, text: bins[0].key.slice(0, 4), tick: false });
  } else {
    labels.push({ i: 0, text: niceDay(bins[0].key), anchor: 'start' });
    if (n > 1) labels.push({ i: n - 1, text: niceDay(bins.at(-1).key), anchor: 'end' });
  }
  let lastRight = -Infinity;
  for (const l of labels) {
    const anchor = l.anchor || 'start';
    const x = anchor === 'end' ? W : l.i * step;
    const est = l.text.length * 6.2;
    const left = anchor === 'end' ? x - est : x;
    if (left < lastRight + 10 && anchor !== 'end') continue;
    if (l.tick) mk('line', { x1: x, x2: x, y1: H + 1, y2: H + 5, class: 'tick' });
    mk('text', { x: anchor === 'start' && l.tick ? x + 2 : x, y: H + 17, 'text-anchor': anchor, class: 'axis' }, l.text);
    lastRight = left + est;
  }
}

function chartBinAt(clientX) {
  const g = ST.geom;
  if (!g) return null;
  const r = $('#chart').getBoundingClientRect();
  return ST.bins[clamp(Math.floor((((clientX - r.left) / r.width) * g.W) / g.step), 0, g.n - 1)];
}

function setRange(a, b) {
  if (a && b && a.from > b.from) [a, b] = [b, a];
  const whole = !a || !b || (a === ST.bins[0] && b === ST.bins.at(-1));
  S.settings.from = whole ? null : a.from;
  S.settings.to = whole ? null : b.to;
  if (S.settings.daily) S.settings.daily = false;
  $('#opt-daily').checked = false;
  saveSettings();
  drawChart();
  refreshStart();
}

// All, or the last 12 months / 30 days up to the newest photo
function quickRange(q) {
  if (!ST.bins.length) return;
  if (q === 'all') return setRange(null, null);
  const from = new Date(Date.parse(ST.lastDay) - (q === 'year' ? 364 : 29) * 864e5).toISOString().slice(0, 10);
  S.settings.from = from <= ST.firstDay ? null : from;
  S.settings.to = null;
  S.settings.daily = false;
  $('#opt-daily').checked = false;
  saveSettings();
  drawChart();
  refreshStart();
}

// ← → one bin at a time (bins with photos); ⇧ grows or shrinks the end
function stepBin(d, widen) {
  const bins = ST.bins.filter((b) => b.n);
  if (!bins.length) return;
  const { from, to } = S.settings;
  const whole = !from && !to;
  if (!widen) {
    let i = whole ? (d > 0 ? -1 : bins.length) : bins.findIndex((b) => b.to >= (to || from));
    if (i === -1 && !whole) i = bins.length - 1;
    const b = bins[clamp(i + d, 0, bins.length - 1)];
    return setRange(b, b);
  }
  const a = bins.find((b) => b.to >= (from || bins[0].from)) || bins[0];
  let i = to ? bins.findIndex((b) => b.to >= to) : bins.length - 1;
  if (i === -1) i = bins.length - 1;
  i = clamp(i + d, bins.indexOf(a), bins.length - 1);
  setRange(a, bins[i]);
}

let settingsTimer = 0;
function saveSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(flushSettings, 250);
}
function flushSettings() {
  clearTimeout(settingsTimer);
  api('PUT', '/api/settings', { ...S.settings }).catch(() => {});
}

function bindStart() {
  const svg = $('#chart');
  svg.addEventListener('pointerdown', (e) => {
    const b = chartBinAt(e.clientX);
    if (!b) return;
    svg.setPointerCapture(e.pointerId);
    ST.drag = b;
    setRange(b, b);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!ST.drag) return;
    const b = chartBinAt(e.clientX);
    if (b) setRange(ST.drag, b);
  });
  const end = () => (ST.drag = null);
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('dblclick', () => setRange(null, null));
  $('#quick').onclick = (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.q) quickRange(b.dataset.q);
  };
  $('#cal').addEventListener('click', (e) => setDailyDay(calDayAt(e)));
  $('#cal').addEventListener('dblclick', (e) => {
    setDailyDay(calDayAt(e));
    openViewer();
  });
  $('#opt-clusters').onchange = (e) => setClustersOnly(e.target.checked);
  $('#opt-daily').onchange = (e) => setDaily(e.target.checked);
  $('#opt-videos').onchange = (e) => setVideosOnly(e.target.checked);
  $('#start-open').onclick = () => openViewer();
  $('#start-review').onclick = () => openReview();
  $('#start-return').onclick = () => backToViewer();
}

/* ------------------------------------------------------------ filters (start and viewer) */

function setWindow(w) {
  if (w === S.settings.window) return;
  S.settings.window = w;
  saveSettings();
  if (!$('#start').hidden) {
    renderWindows();
    refreshStart();
  } else recluster(`Window ${fmtWindow(w)}`);
}
function stepWindow(d) {
  const ws = S.server.windows;
  const i = clamp(ws.indexOf(S.settings.window) + d, 0, ws.length - 1);
  if (ws[i] === S.settings.window) return toast(d > 0 ? 'Longest window: 30 min' : 'Shortest window: 5 s');
  setWindow(ws[i]);
}
function setClustersOnly(on) {
  S.settings.clustersOnly = on;
  $('#opt-clusters').checked = on;
  saveSettings();
  if (!$('#start').hidden) refreshStart();
  else recluster(on ? 'Clusters only' : 'Single photos too');
}
function setVideosOnly(on) {
  S.settings.videosOnly = on;
  $('#opt-videos').checked = on;
  saveSettings();
  if (!$('#start').hidden) refreshStart();
  else recluster(on ? 'Videos only' : 'Photos and videos');
}
/* ------------------------------------------------------------ locations */

// "35.96° N  83.92° W", and the place name once known: Apple's reverse
// geocoder, asked by the server (rounded to ~1 km, kept on disk), one at a
// time, never in the key press.
const PLACES = new Map(); // "lat,lon" (2 decimals) -> name | null
const placeQueue = [];
let placeBusy = false;
const geoKey = (a) => `${a.lat.toFixed(2)},${a.lon.toFixed(2)}`;
const fmtCoord = (a) => `${Math.abs(a.lat).toFixed(2)}° ${a.lat < 0 ? 'S' : 'N'}  ${Math.abs(a.lon).toFixed(2)}° ${a.lon < 0 ? 'W' : 'E'}`;
function geoText(a) {
  const name = PLACES.get(geoKey(a));
  return name ? `${name} · ${fmtCoord(a)}` : fmtCoord(a);
}
function geoLine(a, cls) {
  const g = el(cls === 'place' ? 'span' : 'div', cls);
  if (a.lat == null) return g; // no geotag: the line stays empty
  g.dataset.geo = geoKey(a);
  g.textContent = geoText(a);
  g.title = `${a.lat.toFixed(5)}, ${a.lon.toFixed(5)}`;
  if (!PLACES.has(geoKey(a))) askPlace(a);
  return g;
}
function askPlace(a) {
  const k = geoKey(a);
  if (placeQueue.some((x) => x.k === k)) return;
  placeQueue.unshift({ k, lat: a.lat, lon: a.lon }); // what's on screen now first
  placeQueue.length = Math.min(placeQueue.length, 40);
  setTimeout(pumpPlaces, 0);
}
async function pumpPlaces() {
  if (placeBusy || !placeQueue.length) return;
  placeBusy = true;
  const { k, lat, lon } = placeQueue.shift();
  if (!PLACES.has(k)) {
    const r = await api('GET', `/api/place?lat=${lat}&lon=${lon}`).catch(() => null);
    PLACES.set(k, (r && r.place) || null);
    if (r && r.place) {
      // the coordinates stay after the name
      document.querySelectorAll(`[data-geo="${k}"]`).forEach((g) => (g.textContent = `${r.place} · ${g.textContent.split(' · ').pop()}`));
    }
  }
  placeBusy = false;
  pumpPlaces();
}

function setDaily(on) {
  S.settings.daily = on;
  if (on) S.dailyDay = todayMD(); // a new daily cleanup starts on today
  $('#opt-daily').checked = on;
  saveSettings();
  if (!$('#start').hidden) {
    drawChart();
    showDailyRows();
    refreshStart();
  } else recluster(on ? 'Daily cleanup: on this day' : 'All dates');
}

/* ------------------------------------------------------------ daily cleanup: the calendar */

const todayMD = () => S.server.today.slice(5);
const dailyDay = () => S.dailyDay || todayMD();
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayName = (md) => (md === todayMD() ? 'On this day' : `${+md.slice(3)} ${FULL_MONTHS[+md.slice(0, 2) - 1]}`);
// every day of the year, 29 February included
const DOY = (() => {
  const out = [];
  for (let t = Date.UTC(2024, 0, 1); t < Date.UTC(2025, 0, 1); t += 864e5) out.push(new Date(t).toISOString().slice(5, 10));
  return out;
})();
const monthLen = (m) => DOY.filter((d) => +d.slice(0, 2) === m).length;

// photos per day of the year, from earlier years
function doyCounts() {
  const year = +S.server.today.slice(0, 4);
  if (ST.doy && ST.doyVersion === S.version && ST.doyYear === year) return ST.doy;
  const m = new Map();
  for (const a of S.assets) {
    if (+a.day.slice(0, 4) >= year) continue;
    const md = a.day.slice(5);
    const e = m.get(md) || { n: 0, years: new Set() };
    e.n++;
    e.years.add(+a.day.slice(0, 4));
    m.set(md, e);
  }
  ST.doy = m;
  ST.doyVersion = S.version;
  ST.doyYear = year;
  return m;
}

// how recently a day was cleaned up, as an ink level (null: never)
function recency(md) {
  const last = (S.server.dailyLog[md] || []).at(-1);
  if (!last) return null;
  const age = (Date.parse(S.server.today) - Date.parse(last.date)) / 864e5;
  return age <= 31 ? 1 : age <= 365 ? 0.55 : 0.25;
}

/* Twelve rows of months, 31 columns of days: a small multiple of the year.
   Ink shows how recently each day was cleaned up; a hairline square, a day
   with photos not cleaned up yet; a dot, a day without photos. */
function drawCalendar() {
  const svg = $('#cal');
  const W = svg.clientWidth || 880;
  const left = 30;
  const top = 14;
  const cw = (W - left) / 31;
  const rh = 17;
  const H = top + 12 * rh;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.height = `${H}px`;
  svg.innerHTML = '';
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  ST.cal = { left, top, cw, rh };
  for (const d of [1, 10, 20, 31]) mk('text', { x: left + (d - 0.5) * cw, y: 9, 'text-anchor': 'middle' }, d);
  const counts = doyCounts();
  const sel = dailyDay();
  const today = todayMD();
  for (let m = 1; m <= 12; m++) {
    const y = top + (m - 1) * rh;
    mk('text', { x: 0, y: y + 10.5 }, MONTHS[m - 1]);
    for (let d = 1; d <= monthLen(m); d++) {
      const md = `${z2(m)}-${z2(d)}`;
      const x = left + (d - 1) * cw;
      const w = Math.max(3, cw - 3);
      const c = counts.get(md);
      const r = recency(md);
      let cell;
      if (r != null) cell = mk('rect', { x: x + 1, y: y + 1, width: w, height: rh - 5, class: 'c', opacity: r });
      else if (c) cell = mk('rect', { x: x + 1.5, y: y + 1.5, width: w - 1, height: rh - 6, class: 'todo' });
      else cell = mk('rect', { x: x + 1 + w / 2 - 1, y: y + (rh - 4) / 2 - 1, width: 2, height: 2, class: 'none' });
      const log = S.server.dailyLog[md] || [];
      const tip = [`${+d} ${MONTHS[m - 1]}`, c ? `${fmtN(c.n)} photo${c.n === 1 ? '' : 's'} from ${[...c.years].sort().join(' · ')}` : 'no photos from earlier years'];
      if (log.length) tip.push(`cleaned up ${niceDay(log.at(-1).date)} (${log.at(-1).deleted} deleted)`);
      cell.append(Object.assign(document.createElementNS(NS, 'title'), { textContent: tip.join(' · ') }));
      if (md === today) mk('rect', { x: x + 1, y: y + rh - 3, width: w, height: 1.5, class: 'today' });
      if (md === sel) mk('rect', { x: x - 0.5, y: y - 0.5, width: w + 3, height: rh - 2, class: 'sel' });
    }
  }
  renderCalDay();
}

// the chosen day: its photos and every time it was cleaned up, newest first
function renderCalDay() {
  const md = dailyDay();
  const c = doyCounts().get(md);
  const log = (S.server.dailyLog[md] || []).slice().reverse();
  const box = $('#cal-day');
  box.replaceChildren();
  const head = el('div');
  head.append(el('b', '', `${+md.slice(3)} ${FULL_MONTHS[+md.slice(0, 2) - 1]}${md === todayMD() ? ' (today)' : ''}`), c ? ` · ${fmtN(c.n)} photo${c.n === 1 ? '' : 's'} from ${[...c.years].sort().join(' · ')}` : ' · no photos from earlier years');
  const hist = el('div', 'muted');
  if (log.length) {
    hist.append('Cleaned up ');
    log.forEach((e, i) => {
      if (i) hist.append(' · ');
      hist.append(el('b', '', niceDay(e.date)), ` (${fmtN(e.deleted)} deleted)`);
    });
  } else hist.textContent = 'Not cleaned up yet.';
  box.append(head, hist);
}

function setDailyDay(md) {
  if (!md || md === S.dailyDay) return;
  S.dailyDay = md;
  drawCalendar();
  refreshStart();
}
function stepDailyDay(days) {
  const i = DOY.indexOf(dailyDay());
  setDailyDay(DOY[(i + days + DOY.length) % DOY.length]);
}
function stepDailyMonth(dm) {
  const md = dailyDay();
  const m = ((+md.slice(0, 2) - 1 + dm + 12) % 12) + 1;
  setDailyDay(`${z2(m)}-${z2(Math.min(+md.slice(3), monthLen(m)))}`);
}
function calDayAt(e) {
  const g = ST.cal;
  if (!g) return null;
  const r = $('#cal').getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * ($('#cal').viewBox.baseVal.width || r.width);
  const m = Math.floor((e.clientY - r.top - g.top) / g.rh) + 1;
  const d = Math.floor((x - g.left) / g.cw) + 1;
  if (m < 1 || m > 12 || d < 1 || d > monthLen(m)) return null;
  return `${z2(m)}-${z2(d)}`;
}

/* ------------------------------------------------------------ viewer: clusters */

async function openViewer() {
  flushSettings();
  const lib = ST.lib && ST.lib.version === S.version ? ST.lib : await api('GET', libraryUrl());
  applyLibrary(lib, null);
  S.opened = true;
  showViewer();
}

function backToViewer() {
  if (!S.opened) return;
  recluster(null);
  showViewer();
}

function showViewer() {
  for (const v of ['#auth', '#start', '#review']) $(v).hidden = true;
  $('#viewer').hidden = false;
  setChrome('viewer');
  layoutCache = null;
  render();
}

function applyLibrary(lib, keepId) {
  S.clusters = lib.clusters.map((c) => c.map((i) => S.assets[i].id));
  S.years = lib.years || [];
  S.toDelete = lib.toDelete;
  updateDeleteCount();
  TL.version = (TL.version || 0) + 1;
  // stay on the cluster holding the photo you were on (or the nearest in time)
  let idx = 0;
  if (keepId) {
    idx = S.clusters.findIndex((c) => c.includes(keepId));
    if (idx === -1) {
      const t = S.byId.get(keepId)?.t ?? 0;
      idx = S.clusters.findIndex((c) => S.byId.get(c[0]).t >= t);
      if (idx === -1) idx = S.clusters.length - 1;
    }
  }
  S.idx = clamp(idx, 0, Math.max(0, S.clusters.length - 1));
  const c = S.clusters[S.idx];
  S.focus = c && keepId ? Math.max(0, c.indexOf(keepId)) : 0;
  S.dailyMarked = false;
  updateWhere();
  startSharp();
}

// The window or a filter changed: cluster again, staying where you were.
let reclusterToken = 0;
async function recluster(msg) {
  const c = S.clusters[S.idx];
  const at = c ? c[Math.min(S.focus, c.length - 1)] : null;
  const token = ++reclusterToken;
  if (S.version !== S.server.library.version) await loadAssets();
  const lib = await api('GET', libraryUrl()).catch(() => null);
  if (!lib || token !== reclusterToken) return;
  if (lib.version !== S.version) {
    await loadAssets();
    return recluster(msg);
  }
  applyLibrary(lib, at);
  if (msg) toast(`${msg} · ${fmtN(S.clusters.length)} cluster${S.clusters.length === 1 ? '' : 's'}`);
  if (!$('#viewer').hidden) render();
}

const cur = () => S.clusters[S.idx];
const focusedId = () => {
  const c = cur();
  return c ? c[clamp(S.focus, 0, c.length - 1)] : null;
};

/* ------------------------------------------------------------ marks */

// The rule (the same as the server's, cluster::to_delete): a cluster with no
// keeper is untouched; once it has one, its other photos go, except
// favorites, which go only when marked with X. A photo marked with X goes.
function delOf(c) {
  const hasKeeper = c.some((id) => S.keep.has(id));
  const out = new Set();
  for (const id of c) {
    if (S.keep.has(id)) continue;
    if (S.del.has(id) || (hasKeeper && !S.byId.get(id)?.fav)) out.add(id);
  }
  return out;
}

function changeMarks(c, fn) {
  const before = delOf(c).size;
  fn();
  S.toDelete += delOf(c).size - before;
  updateDeleteCount();
  TL.version++;
  updateMarksUi();
  saveMarks();
}

function toggleKeep(id) {
  const c = cur();
  changeMarks(c, () => {
    if (S.keep.has(id)) S.keep.delete(id);
    else {
      S.keep.add(id);
      S.del.delete(id);
    }
  });
}
function keepAll() {
  const c = cur();
  if (c) changeMarks(c, () => c.forEach((id) => (S.keep.add(id), S.del.delete(id))));
}
function clearCluster() {
  const c = cur();
  if (c) changeMarks(c, () => c.forEach((id) => (S.keep.delete(id), S.del.delete(id))));
}
function toggleDel(id) {
  const a = S.byId.get(id);
  const c = cur();
  changeMarks(c, () => {
    if (S.del.has(id)) S.del.delete(id);
    else {
      S.del.add(id);
      S.keep.delete(id);
    }
  });
  if (a && a.fav && S.del.has(id)) toast('♥ A favorite, marked for deletion. X again keeps it.', { ms: 3200 });
}

// S: the heart in Photos, written to the library at once. A favorite is
// never marked for deletion by a keeper, so this also takes it off the list.
async function toggleFavorite() {
  const id = focusedId();
  const a = S.byId.get(id);
  const c = cur();
  if (!a || !c) return;
  const on = !a.fav;
  const before = delOf(c).size;
  a.fav = on;
  S.toDelete += delOf(c).size - before;
  refreshCaptions();
  const r = await api('POST', '/api/favorite', { ids: [id], on }).catch((e) => ({ error: e.message }));
  if (r.error) {
    a.fav = !on;
    S.toDelete -= delOf(c).size - before;
    refreshCaptions();
    return toast(`Photos didn't change the favorite: ${r.error}`, { ms: 3500 });
  }
  S.toDelete = r.toDelete;
  updateDeleteCount();
  toast(on ? '♥ Favorite, in Photos too' : 'No longer a favorite');
}
function refreshCaptions() {
  updateDeleteCount();
  TL.version++;
  if (S.solo) renderSoloCaption();
  const c = cur();
  if (!c) return;
  document.querySelectorAll('#stage .look').forEach((look, pos) => {
    const cap = look.querySelector('.caption');
    if (cap) cap.replaceWith(caption(S.byId.get(look.dataset.id), pos));
  });
  updateMarksUi();
}

// j / k: photo by photo, on into the next (or previous) cluster at the ends
function stepPhoto(d) {
  const c = cur();
  if (!c) return;
  const f = S.focus + d;
  S.lastKeyAt = performance.now();
  if (f >= 0 && f < c.length) {
    S.focus = f;
    return updateFocusUi();
  }
  const next = S.idx + d;
  if (next < 0 || next >= S.clusters.length) return;
  S.idx = next;
  S.focus = d > 0 ? 0 : S.clusters[next].length - 1;
  if (S.solo) S.solo.zoom = false;
  if (!S.flipping && !renderPending) render();
  else scheduleRender();
}

let marksTimer = 0;
let marksSeq = 0;
let marksPending = false;
function saveMarks() {
  clearTimeout(marksTimer);
  marksPending = true;
  marksTimer = setTimeout(flushMarks, 300);
}
// Send the marks now (Review and delete read them from the server).
async function flushMarks() {
  clearTimeout(marksTimer);
  if (!marksPending) return;
  marksPending = false;
  const seq = ++marksSeq;
  const r = await api('PUT', '/api/marks', { keep: [...S.keep], del: [...S.del], window: S.settings.window }).catch(() => null);
  // the server's count covers marks in other views too
  if (r && seq === marksSeq && !marksPending) {
    S.toDelete = r.toDelete;
    updateDeleteCount();
  }
}

function updateMarksUi() {
  const c = cur();
  if (!c) return;
  const d = delOf(c);
  document.querySelectorAll('#stage .look').forEach((look) => {
    const id = look.dataset.id;
    look.classList.toggle('keep', S.keep.has(id));
    look.classList.toggle('del', d.has(id));
  });
  if (S.solo) renderSoloCaption();
  drawTicks();
}

/* ------------------------------------------------------------ image loading */

/* Every display image goes through one prioritised queue: the cluster on
   screen first, then the clusters ahead, then one behind. Moving on re-ranks
   the queue and cancels downloads no longer wanted. Decoded images are kept
   in a small LRU cache. (Brackit's load queue.) */
const MAX_INFLIGHT = 6;
const AHEAD = 6; // clusters to prefetch forward (display size, decoded)
const CACHE_MAX = 90;
const LANE = { preview: 3 };
const kindOf = (url) => (url.includes('full=1') ? 'full' : 'preview');
const imageCache = new Map();
const queue = [];
let inflight = 0;
const lanes = { preview: 0 };

function getImage(url, priority = 0) {
  let e = imageCache.get(url);
  if (e) {
    imageCache.delete(url);
    imageCache.set(url, e);
    if (!e.started && priority < e.priority) e.priority = priority;
  } else {
    e = { url, kind: kindOf(url), priority, img: new Image(), done: false, started: false, ctrl: null, objectUrl: null };
    e.img.decoding = 'async';
    e.img.draggable = false;
    e.promise = new Promise((resolve) => (e.resolve = resolve));
    imageCache.set(url, e);
    queue.push(e);
    evict();
  }
  pump();
  return e;
}

function evict() {
  const fulls = [...imageCache.keys()].filter((u) => u.includes('full=1'));
  for (const u of fulls.slice(0, Math.max(0, fulls.length - 2))) {
    drop(imageCache.get(u));
    imageCache.delete(u);
  }
  let n = imageCache.size;
  for (const [url, e] of imageCache) {
    if (n <= CACHE_MAX) break;
    if (e.priority < 1 && !e.done) continue; // never drop what's on screen
    drop(e);
    imageCache.delete(url);
    n--;
  }
}

function drop(e) {
  if (!e) return;
  if (e.ctrl && !e.done) e.ctrl.abort();
  const qi = queue.indexOf(e);
  if (qi >= 0) queue.splice(qi, 1);
  if (e.objectUrl) setTimeout(() => URL.revokeObjectURL(e.objectUrl), 1000);
}

function startable(e) {
  if (inflight >= MAX_INFLIGHT) return false;
  if (e.priority < 1 || e.kind === 'full') return true;
  return lanes.preview < LANE.preview;
}

function pump() {
  queue.sort((a, b) => a.priority - b.priority);
  for (let i = 0; i < queue.length && inflight < MAX_INFLIGHT; ) {
    const e = queue[i];
    if (!startable(e)) {
      i++;
      continue;
    }
    queue.splice(i, 1);
    const lane = e.priority >= 1 && e.kind !== 'full';
    if (lane) lanes.preview++;
    e.started = true;
    e.ctrl = new AbortController();
    inflight++;
    fetch(e.url, { signal: e.ctrl.signal })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
      .then((blob) => {
        e.objectUrl = URL.createObjectURL(blob);
        e.img.src = e.objectUrl;
        return e.img.decode().catch(() => {});
      })
      .then(
        () => {
          e.done = true;
          e.resolve(e.img);
          if (dispQueue.length) scheduleDisplayCopy();
        },
        (err) => {
          if (err && err.name === 'AbortError') return;
          e.done = true;
          e.resolve(e.img);
        }
      )
      .finally(() => {
        inflight--;
        if (lane) lanes.preview--;
        pump();
      });
  }
}

const PX = [320, 640, 1024, 1600, 2400, 3200];
const bucket = (px) => PX.find((p) => p >= px) || PX.at(-1);
const imgUrl = (id, px) => `/api/img/${id}?px=${px}`;
const fullUrl = (id) => `/api/img/${id}?full=1`;

/* Thumbnail store (Brackit's): every photo's small thumbnail, fetched in
   batches of 60 per request, two at a time, for a wide window around you,
   mostly ahead. Kept compressed; only the nearby ones are decoded, so a
   placeholder is ready the instant you flip. Ids are stable, so nothing is
   thrown away when the window or a filter changes. */
const TH_PX = 360;
const TH = { url: new Map(), img: new Map(), none: new Set(), loading: new Set(), q: [], inflight: 0, waiters: new Map() };
const TH_BATCH = 60;
const TH_INFLIGHT = 2;
const TH_AHEAD = 300;
const TH_BEHIND = 60;
const TH_DECODE_AHEAD = 20;
const TH_URL_MAX = 6000;
const TH_IMG_MAX = 400;

function thumbIdsAround() {
  const ids = [];
  const add = (c) => c && ids.push(...c.slice(0, 40));
  add(S.clusters[S.idx]);
  for (let d = 1; d <= 30; d++) add(S.clusters[S.idx + d]);
  for (let d = 1; d <= 8; d++) add(S.clusters[S.idx - d]);
  for (let d = 31; d <= TH_AHEAD; d++) add(S.clusters[S.idx + d]);
  for (let d = 9; d <= TH_BEHIND; d++) add(S.clusters[S.idx - d]);
  return ids;
}

function scheduleThumbs() {
  const urgent = TH.q.filter((id) => TH.waiters.has(id));
  const want = (id) => !TH.url.has(id) && !TH.none.has(id) && !TH.loading.has(id);
  TH.q = [...urgent, ...thumbIdsAround().filter(want)];
  pumpThumbs();
  decodeThumbWindow();
}

// Keep the clusters just ahead decoded so placeholders appear at once; the
// next few now, those further on in idle time (a batch of thumbnails can
// arrive between a key and its paint: decoding hundreds then would show).
let decodeIdle = 0;
function decodeCluster(i) {
  const c = S.clusters[i];
  if (c) for (const id of c.slice(0, 12)) if (TH.url.has(id) && !TH.img.has(id)) thumbImage(id);
}
function decodeThumbWindow() {
  for (let d = -1; d <= 3; d++) decodeCluster(S.idx + d);
  if (!decodeIdle) decodeIdle = (window.requestIdleCallback || ((f) => setTimeout(f, 50)))(decodeRest);
}
function decodeRest(deadline) {
  decodeIdle = 0;
  for (let d = -2; d <= TH_DECODE_AHEAD; d++) {
    decodeCluster(S.idx + d);
    if (deadline && deadline.timeRemaining && deadline.timeRemaining() < 3) {
      decodeIdle = (window.requestIdleCallback || ((f) => setTimeout(f, 50)))(decodeRest);
      return;
    }
  }
}

function pumpThumbs() {
  while (TH.inflight < TH_INFLIGHT && TH.q.length) {
    const batch = [];
    while (batch.length < TH_BATCH && TH.q.length) {
      const id = TH.q.shift();
      if (!TH.url.has(id) && !TH.none.has(id) && !TH.loading.has(id)) batch.push(id);
    }
    if (!batch.length) break;
    batch.forEach((id) => TH.loading.add(id));
    TH.inflight++;
    fetch(`/api/thumbs?px=${TH_PX}&ids=${batch.join(',')}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
      .then((ab) => {
        const bytes = new Uint8Array(ab);
        const nl = bytes.indexOf(10);
        const index = JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl)));
        let off = nl + 1;
        for (const [id, len] of index) {
          TH.url.set(String(id), URL.createObjectURL(new Blob([bytes.subarray(off, off + len)], { type: 'image/jpeg' })));
          off += len;
        }
        while (TH.url.size > TH_URL_MAX) {
          const [old, u] = TH.url.entries().next().value;
          TH.url.delete(old);
          TH.img.delete(old);
          URL.revokeObjectURL(u);
        }
      })
      .catch(() => {})
      .finally(() => {
        TH.inflight--;
        decodeThumbWindow();
        for (const id of batch) {
          TH.loading.delete(id);
          if (!TH.url.has(id)) TH.none.add(id); // no thumbnail (a video from a folder)
          const ws = TH.waiters.get(id);
          if (ws) {
            TH.waiters.delete(id);
            ws.forEach((fn) => fn());
          }
        }
        pumpThumbs();
      });
  }
}

function thumbImage(id) {
  const have = TH.img.get(id);
  if (have) return have.promise;
  if (TH.none.has(id)) return Promise.resolve(null);
  if (!TH.url.has(id)) {
    return new Promise((resolve) => {
      const ws = TH.waiters.get(id) || [];
      ws.push(resolve);
      TH.waiters.set(id, ws);
      TH.q = TH.q.filter((x) => x !== id);
      TH.q.unshift(id);
      pumpThumbs();
    }).then(() => thumbImage(id));
  }
  const img = new Image();
  img.decoding = 'async';
  img.src = TH.url.get(id);
  const entry = { img, done: false };
  entry.promise = img.decode().then(
    () => ((entry.done = true), fixAspect(id, img), img),
    () => null
  );
  TH.img.set(id, entry);
  while (TH.img.size > TH_IMG_MAX) TH.img.delete(TH.img.keys().next().value);
  return entry.promise;
}
const thumbReady = (id) => {
  const e = TH.img.get(id);
  return e && e.done ? e.img : null;
};

// If the library's width/height disagree with the picture (portrait vs
// landscape), believe the picture.
function fixAspect(id, img) {
  const a = S.byId.get(id);
  if (!a || !img.naturalWidth) return;
  const ra = a.w / a.h;
  const ri = img.naturalWidth / img.naturalHeight;
  if ((ra > 1.05 && ri < 0.95) || (ra < 0.95 && ri > 1.05)) [a.w, a.h] = [a.h, a.w];
}

/* Pictures go on screen decoded and drawn at once. Images load with
   decoding="async"; in WebKit (Safari, the Mac app) an element marked so is
   painted later, blank or half-done, and copies inherit the setting. So
   anything put in a frame passes onScreen(), which switches it to "sync" in
   WebKit only (in Chromium "sync" makes the paint wait instead).
   test/ui/webkit.test.js checks. */
const SYNC_DECODE = /Apple/.test(navigator.vendor || '');
function onScreen(node) {
  if (!node || !SYNC_DECODE) return node;
  if (node.tagName === 'IMG') node.decoding = 'sync';
  else if (node.querySelectorAll) for (const im of node.querySelectorAll('img')) im.decoding = 'sync';
  return node;
}

/* Display-sized copies (Brackit's): in idle moments each prefetched picture
   is drawn once at exactly the size it will be shown (× pixel ratio). A flip
   then only swaps in small, ready pictures. */
const DISP = new Map(); // url -> { canvas, key }
const DISP_MAX = 80;
let dispQueue = [];
let dispScheduled = false;

let layoutCache = null;
// a caption line under each photo; a second one, with where it was taken,
// in clusters that have a geotag
const hasGeo = (c) => c.some((id) => S.byId.get(id)?.lat != null);
const capOf = (c) => (hasGeo(c) ? 44 : 26);
function stageSize() {
  if (!layoutCache) {
    const st = $('#stage');
    layoutCache = { W: st.clientWidth || window.innerWidth - 32, H: st.clientHeight || window.innerHeight - 100 };
  }
  return layoutCache;
}
const aspectOf = (a) => (a && a.w && a.h ? a.w / a.h : 1.5);

/* The grid for a cluster: 1–9 photos fill the window (the column count that
   shows them biggest: a row, 2 + 1, a near-square grid); more than 9 scroll
   in rows of fixed tiles with the focused photo kept in view. */
function layoutFor(c) {
  const CAP = capOf(c);
  const { W, H } = stageSize();
  const gap = 10;
  const n = c.length;
  const as = c.map((id) => aspectOf(S.byId.get(id))).sort((x, y) => x - y);
  const a = as[Math.floor(as.length / 2)]; // the typical shape
  const tall = as[0]; // the tallest photo
  if (n <= 9) {
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const cellW = (W - (cols - 1) * gap) / cols;
      const cellH = (H - (rows - 1) * gap) / rows - CAP;
      const w = Math.min(cellW, cellH * a);
      if (!best || w > best.w * 1.02) best = { cols, w, cellW, cellH };
    }
    const tileW = Math.floor(best.w);
    return { cols: best.cols, tileW, boxH: Math.floor(Math.min(best.cellH, tileW / tall)), scroll: false, cap: CAP };
  }
  const cols = clamp(Math.floor((W + gap) / (230 + gap)), 4, 8);
  const tileW = Math.floor((W - (cols - 1) * gap) / cols);
  return { cols, tileW, boxH: Math.floor(Math.min(tileW / tall, H * 0.6)), scroll: true, cap: CAP };
}

function frameSize(a, L) {
  const r = aspectOf(a);
  const w = Math.max(1, Math.floor(Math.min(L.tileW, L.boxH * r)));
  return { w, h: Math.max(1, Math.floor(w / r)) };
}

const dispKey = (w, h) => `${Math.round(w * dpr())}x${Math.round(h * dpr())}`;
function displayCopy(url, w, h) {
  const d = DISP.get(url);
  return d && d.key === dispKey(w, h) ? d.canvas : null;
}

// The sharpest decoded picture of a photo the page has: the grid's own, the
// large view's, or the original fetched for actual pixels. Coming back from
// the large view, the grid shows what you just saw sharp there.
function sharpestLoaded(id, url) {
  let best = null;
  for (const u of [url, soloUrl(id), fullUrl(id)]) {
    const e = imageCache.get(u);
    if (e && e.done && e.img.naturalWidth && (!best || e.img.naturalWidth > best.naturalWidth)) best = e.img;
  }
  return best;
}
// a display copy, unless a sharper picture has arrived since it was made
function freshCopy(id, url, w, h) {
  const c = displayCopy(url, w, h);
  if (!c) return null;
  const best = sharpestLoaded(id, url);
  return best && best.naturalWidth > (+c.dataset.srcw || 0) * 1.2 ? null : c;
}

// What each photo in a cluster needs: its box and the URL at that size.
function plan(c) {
  const L = layoutFor(c);
  return c.map((id) => {
    const a = S.byId.get(id);
    const { w, h } = frameSize(a, L);
    return { id, a, w, h, url: imgUrl(id, bucket(Math.max(w, h) * dpr())) };
  });
}

function queueDisplayCopies() {
  dispQueue = [];
  for (let d = 0; d <= AHEAD; d++) {
    const c = S.clusters[S.idx + d];
    if (c && c.length <= 12) for (const p of plan(c)) if (p.a.kind !== 'video') dispQueue.push(p);
  }
  scheduleDisplayCopy();
}

function scheduleDisplayCopy(delay = 0) {
  if (dispScheduled) return;
  dispScheduled = true;
  const go = () => (window.requestIdleCallback || ((f) => setTimeout(f, 16)))(makeDisplayCopy);
  delay ? setTimeout(go, delay) : go();
}

function makeDisplayCopy() {
  dispScheduled = false;
  // never compete with flipping: wait for a quiet moment after the last key
  if (S.flipping || performance.now() - S.lastKeyAt < 300) return scheduleDisplayCopy(300);
  while (dispQueue.length) {
    const { id, url, w, h } = dispQueue.shift();
    const src = sharpestLoaded(id, url);
    if (!src || freshCopy(id, url, w, h)) continue;
    const e = { img: src };
    const cw = Math.max(1, Math.round(w * dpr()));
    const ch = Math.max(1, Math.round(h * dpr()));
    const key = dispKey(w, h);
    const store = (c) => {
      c.dataset.srcw = src.naturalWidth;
      DISP.set(url, { canvas: c, key });
      while (DISP.size > DISP_MAX) DISP.delete(DISP.keys().next().value);
      if (dispQueue.length) scheduleDisplayCopy();
    };
    if (window.createImageBitmap) {
      createImageBitmap(e.img, { resizeWidth: cw, resizeHeight: ch, resizeQuality: 'high' })
        .then((bmp) => {
          const c = document.createElement('canvas');
          c.width = cw;
          c.height = ch;
          c.getContext('2d').drawImage(bmp, 0, 0, cw, ch);
          bmp.close && bmp.close();
          store(c);
        })
        .catch(() => store(drawCopy(e.img, cw, ch)));
    } else store(drawCopy(e.img, cw, ch));
    return; // one at a time, so a keypress never waits behind this
  }
}

function drawCopy(img, cw, ch) {
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, cw, ch);
  return c;
}

// Re-rank the queue around the current cluster; cancel what's not wanted.
function preloadAround() {
  const want = new Map();
  const add = (c, pr) => {
    if (!c || c.length > 12) return; // big bursts load as they scroll into view
    plan(c).forEach((p, i) => p.a.kind !== 'video' && want.set(p.url, pr + i * 0.01));
  };
  add(cur(), 0.1);
  const ahead = S.flipping ? 0 : AHEAD;
  for (let d = 1; d <= ahead; d++) add(S.clusters[S.idx + d], d);
  if (!S.flipping) add(S.clusters[S.idx - 1], 1.5);
  if (S.solo) {
    // the large view: the focused photo here and in the next clusters
    for (let d = 0; d <= (S.flipping ? 0 : 3); d++) {
      const c = S.clusters[S.idx + d];
      if (!c) continue;
      const id = d === 0 ? focusedId() : c[keeperPos(c) ?? 0];
      if (S.byId.get(id)?.kind !== 'video') want.set(soloUrl(id), d === 0 ? 0 : d + 0.5);
    }
  }
  for (const [url, e] of [...imageCache]) {
    if (e.done) continue;
    if (want.has(url)) e.priority = want.get(url);
    else if (e.kind !== 'full' || e.priority >= 0) {
      drop(e);
      imageCache.delete(url);
    }
  }
  for (const [url, pr] of want) getImage(url, pr);
  scheduleThumbs();
  queueDisplayCopies();
  schedulePreheat();
}

// PhotoKit: warm its cache for the clusters ahead (idle time only).
let preheatTimer = 0;
function schedulePreheat() {
  if (!S.server || S.server.source !== 'photos') return;
  clearTimeout(preheatTimer);
  preheatTimer = setTimeout(() => {
    const ids = [];
    for (let d = AHEAD + 1; d <= AHEAD + 6; d++) {
      const c = S.clusters[S.idx + d];
      if (c) ids.push(...c.slice(0, 9));
    }
    if (ids.length) api('POST', `/api/preheat?px=1024&ids=${ids.join(',')}`).catch(() => {});
  }, 600);
}

/* ------------------------------------------------------------ sharp copies (daily cleanup) */

/* Display-size pictures are local only, and with "Optimize Mac Storage"
   many photos have only small renditions on the Mac. Opening a day asks the
   server for a sharp copy of each of its photos (up to SHARP_MAX, from where
   you are on), downloaded from iCloud in the background. Each one on screen
   is swapped for its sharp copy as it arrives, in place. */
const SHARP_MAX = 300;
const SH = { job: 0, key: '', timer: 0, seen: new Set(), hideTimer: 0 };

function startSharp() {
  const ids = [];
  if (S.settings.daily) {
    for (let d = 0; d < S.clusters.length && ids.length < SHARP_MAX; d++) {
      for (const id of S.clusters[(S.idx + d) % S.clusters.length]) {
        if (ids.length < SHARP_MAX && S.byId.get(id)?.kind !== 'video') ids.push(id);
      }
    }
  }
  const key = [...ids].sort().join(',');
  if (key === SH.key) return;
  SH.key = key;
  SH.seen = new Set();
  clearTimeout(SH.timer);
  $('#c-sharp').hidden = true;
  // (an empty list stops the last one: not in daily cleanup any more)
  api('POST', '/api/sharp', { ids })
    .then((r) => {
      SH.job = r.job;
      if (r.total) pollSharp();
    })
    .catch(() => {});
}

async function pollSharp() {
  clearTimeout(SH.timer);
  const r = await api('GET', '/api/sharp').catch(() => null);
  if (!r || r.job !== SH.job) return;
  const fresh = r.ready.filter((id) => !SH.seen.has(id));
  fresh.forEach((id) => SH.seen.add(id));
  if (fresh.length) sharpened(new Set(fresh));
  const box = $('#c-sharp');
  clearTimeout(SH.hideTimer);
  box.hidden = false;
  if (r.running) {
    box.textContent = `sharper copies from iCloud: ${fmtN(r.done)} of ${fmtN(r.total)}`;
    SH.timer = setTimeout(pollSharp, 700);
  } else {
    box.textContent = `${fmtN(r.done)} sharp ${r.done === 1 ? 'copy' : 'copies'}${r.failed ? ` · ${fmtN(r.failed)} unavailable` : ''}`;
    SH.hideTimer = setTimeout(() => (box.hidden = true), 4000);
  }
}

const idOfUrl = (url) => (url.match(/^\/api\/img\/([0-9a-f]+)\?px=/) || [])[1];

// Forget the low-resolution copies of these photos; swap the ones on screen.
function sharpened(ids) {
  for (const [url, e] of [...imageCache]) {
    if (ids.has(idOfUrl(url))) {
      drop(e);
      imageCache.delete(url);
    }
  }
  for (const url of [...DISP.keys()]) if (ids.has(idOfUrl(url))) DISP.delete(url);
  const c = cur();
  if (!c || $('#viewer').hidden) return;
  if (S.solo) {
    const id = focusedId();
    const frame = $('#solo-frame');
    if (!ids.has(id) || frame.dataset.level === 'full' || frame.dataset.level === 'video') return;
    if (ids.has(id) && frame.dataset.level !== 'full' && frame.dataset.level !== 'video') {
      getImage(soloUrl(id), 0.05).promise.then((img) => {
        if (!S.solo || focusedId() !== id || frame.dataset.id !== id || frame.dataset.level === 'full' || !img.naturalWidth) return;
        const old = frame.firstElementChild;
        img.style.width = old ? old.style.width : '';
        img.style.height = old ? old.style.height : '';
        img.style.objectFit = 'cover';
        img.classList.remove('lowres');
        frame.dataset.level = 'preview';
        frame.replaceChildren(onScreen(img));
      });
    }
    // (and the grid under it: closing the large view shows it as it is)
  }
  const token = renderToken;
  for (const p of plan(c)) {
    if (!ids.has(p.id)) continue;
    getImage(p.url, 0.05).promise.then((img) => {
      const frame = document.querySelector(`#stage .frame[data-id="${p.id}"]`);
      if (token !== renderToken || !frame || !img.naturalWidth) return;
      const old = frame.querySelector('img, canvas');
      if (old) old.replaceWith(onScreen(img));
      else frame.prepend(onScreen(img));
    });
  }
}

/* ------------------------------------------------------------ viewer: render */

function caption(a, pos) {
  const c = el('div', 'caption');
  const key = el('span', 'key', pos < 9 ? String(pos + 1) : '·');
  key.title = pos < 9 ? `Keep this photo (${pos + 1})` : 'Keep this photo';
  key.onclick = (e) => {
    e.stopPropagation();
    S.focus = pos;
    toggleKeep(a.id);
    updateFocusUi();
  };
  c.append(key, el('span', 'time', `${fmtDay(a, false)}  ${fmtTime(a)}`));
  if (a.fav) c.append(el('span', 'fav', '♥'));
  if (a.kind === 'video') c.append(el('span', 'kind', `▶ ${fmtDur(a.dur)}`));
  else if (a.kind === 'live') c.append(el('span', 'kind', 'Live'));
  if (a.shot) c.append(el('span', 'kind', 'Screenshot'));
  return c;
}

function crossSvg() {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('class', 'cross');
  s.setAttribute('viewBox', '0 0 100 100');
  s.setAttribute('preserveAspectRatio', 'none');
  const l = document.createElementNS(NS, 'line');
  for (const [k, v] of Object.entries({ x1: 0, y1: 100, x2: 100, y2: 0 })) l.setAttribute(k, v);
  s.append(l);
  return s;
}

let renderToken = 0;
let lazyIO = null;
function render() {
  const token = ++renderToken;
  const stage = $('#stage');
  const c = cur();
  stage.replaceChildren();
  stage.classList.remove('scroll');
  if (lazyIO) lazyIO.disconnect();
  $('#counter').innerHTML = c ? `<b>${fmtN(S.idx + 1)}</b> / ${fmtN(S.clusters.length)}` : '';
  $('#c-window').textContent = `window ${fmtWindow(S.settings.window)}`;
  if (!c) {
    stage.append(
      el(
        'div',
        'empty',
        S.settings.videosOnly
          ? 'No videos here.\nPress V for photos too, or O for dates and filters.'
          : S.settings.daily
          ? 'Nothing from this day in earlier years.\nPress T for all dates, or O for dates and filters.'
          : 'No clusters here.\nPress C to show single photos too, ] for a longer window, or O for dates and filters.'
      )
    );
    stage.firstChild.style.whiteSpace = 'pre-line';
    $('#c-date').textContent = $('#c-n').textContent = '';
    drawTicks();
    return;
  }
  if (S.solo) {
    // the large view covers the grid: build it when the view closes
    S.stageStale = true;
    preloadAround();
    metaLine(c);
    drawTicks();
    renderSolo();
    return;
  }
  S.stageStale = false;
  S.focus = clamp(S.focus, 0, c.length - 1);
  preloadAround();
  metaLine(c);
  const L = layoutFor(c);
  stage.classList.toggle('scroll', L.scroll);
  const d = delOf(c);
  const plans = plan(c);
  if (L.scroll) {
    lazyIO = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && e.target._load && (e.target._load(), (e.target._load = null))),
      { root: stage, rootMargin: '200px' }
    );
  }
  plans.forEach((p, pos) => {
    const { id, a, w, h, url } = p;
    const look = el('div', 'look');
    look.dataset.id = id;
    look.style.width = `${L.tileW}px`;
    if (S.keep.has(id)) look.classList.add('keep');
    if (d.has(id)) look.classList.add('del');
    if (pos === S.focus) look.classList.add('focus');
    const box = el('div', 'box');
    box.style.height = `${L.boxH + L.cap}px`;
    const frame = el('div', 'frame');
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
    frame.dataset.id = id;
    frame.onclick = () => {
      S.focus = pos;
      updateFocusUi();
      openSolo();
    };
    // the caption sits right under its photo, whatever the photo's shape
    box.append(frame, caption(a, pos));
    if (L.cap > 26) box.append(geoLine(a, 'geo'));
    look.append(box);
    stage.append(look);
    let shownW = 0; // the width of the source on screen (0: a thumbnail or nothing)
    const put = (node, low) => {
      if (token !== renderToken || !node) return;
      node.classList.toggle('lowres', !!low);
      const old = frame.querySelector('img, canvas');
      if (old) old.replaceWith(onScreen(node));
      else frame.prepend(onScreen(node));
    };
    frame.append(crossSvg());
    if (a.kind === 'video') frame.append(el('span', 'badge', '▶'));
    // a picture, if it's sharper than what's there (others' elements are copied:
    // one element can't be in two places)
    const showSharp = (img) => {
      if (token !== renderToken || !img || !img.naturalWidth || img.naturalWidth <= shownW) return;
      shownW = img.naturalWidth;
      const own = imageCache.get(url);
      put(own && own.img === img ? img : img.cloneNode());
    };
    const showThumb = (timg) => {
      if (token !== renderToken || shownW || !timg || !timg.naturalWidth) return;
      put(timg.cloneNode(), true);
    };
    const copy = a.kind !== 'video' && freshCopy(id, url, w, h);
    if (copy) return put(copy);
    const best = a.kind !== 'video' && sharpestLoaded(id, url);
    if (best) showSharp(best);
    else {
      const ready = thumbReady(id);
      if (ready) showThumb(ready);
      else thumbImage(id).then(showThumb);
    }
    if (a.kind === 'video') return;
    const load = () => {
      const e = getImage(url, L.scroll ? 0.5 + pos * 0.01 : 0.1 + pos * 0.01);
      if (e.done) showSharp(e.img);
      else e.promise.then(showSharp);
    };
    if (L.scroll && pos > 11) {
      look._load = load;
      lazyIO.observe(look);
    } else load();
  });
  if (L.scroll) scrollFocusIntoView();
  drawTicks();
  if (S.settings.daily && dailyDay() === todayMD() && S.idx === S.clusters.length - 1) dailyDone();
}

function metaLine(c) {
  const a = S.byId.get(c[0]);
  const b = S.byId.get(c.at(-1));
  const span = Math.round((b.t - a.t) / 1000);
  const dur = span < 1 ? '' : span < 120 ? ` · over ${span} s` : ` · over ${Math.round(span / 60)} min`;
  $('#c-date').textContent = `${fmtDay(a)}  ${fmtTime(a)}`;
  $('#c-n').textContent = `${c.length} photo${c.length === 1 ? '' : 's'}${dur}`;
}

function updateFocusUi() {
  const c = cur();
  if (!c) return;
  S.focus = clamp(S.focus, 0, c.length - 1);
  document.querySelectorAll('#stage .look').forEach((l, i) => l.classList.toggle('focus', i === S.focus));
  if ($('#stage').classList.contains('scroll')) scrollFocusIntoView();
  if (S.solo) renderSolo();
}
function scrollFocusIntoView() {
  const l = document.querySelectorAll('#stage .look')[S.focus];
  if (l) l.scrollIntoView({ block: 'nearest' });
}

const keeperPos = (c) => {
  const i = c.findIndex((id) => S.keep.has(id));
  return i === -1 ? null : i;
};

function go(delta) {
  if (!S.clusters.length) return;
  const next = clamp(S.idx + delta, 0, S.clusters.length - 1);
  if (next === S.idx) return;
  S.idx = next;
  const c = cur();
  S.focus = keeperPos(c) ?? 0;
  if (S.solo) S.solo.zoom = false;
  S.lastKeyAt = performance.now();
  // one press renders now; held-key repeats are coalesced to one per frame
  if (!S.flipping && !renderPending) render();
  else scheduleRender();
}
function jump(i) {
  S.idx = clamp(i, 0, S.clusters.length - 1);
  S.focus = keeperPos(cur() || []) ?? 0;
  render();
}

let renderPending = false;
function scheduleRender() {
  $('#counter').innerHTML = `<b>${fmtN(S.idx + 1)}</b> / ${fmtN(S.clusters.length)}`;
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    render();
  });
}

function nextOpen() {
  for (let i = S.idx + 1; i < S.clusters.length; i++) {
    if (keeperPos(S.clusters[i]) == null) return jump(i);
  }
  toast('Every later cluster has a keeper');
}

function dailyDone() {
  if (S.dailyMarked) return;
  S.dailyMarked = true;
  api('POST', '/api/daily-done')
    .then((r) => {
      if (S.server.dailyDone !== r.dailyDone) toast('Daily cleanup: done for today');
      S.server.dailyDone = r.dailyDone;
    })
    .catch(() => {});
}

/* ------------------------------------------------------------ timeline */

// One hairline tick per cluster, its height growing with the cluster's size;
// clusters with a keeper stand taller, in amber; the current one in ink.
const TICK_H = 22;
const BULGE = 26;
const TL = { version: 0, base: null, baseKey: '' };

function drawTicks() {
  const cv = $('#ticks');
  const w = cv.clientWidth;
  const H = TICK_H + BULGE;
  if (!w) return;
  if (cv.width !== Math.round(w * dpr()) || cv.height !== Math.round(H * dpr())) {
    cv.width = Math.round(w * dpr());
    cv.height = Math.round(H * dpr());
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const n = S.clusters.length;
  if (!n) return;
  // the strip changes only with marks, filters or size: drawn once off-screen
  const key = `${w}|${n}|${dpr()}|${TL.version}`;
  if (!TL.base || TL.baseKey !== key) {
    TL.base = document.createElement('canvas');
    TL.base.width = cv.width;
    TL.base.height = cv.height;
    const b = TL.base.getContext('2d');
    b.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    const css = getComputedStyle(document.documentElement);
    const faint = css.getPropertyValue('--tick').trim();
    const accent = css.getPropertyValue('--accent').trim();
    const step = w / n;
    const tw = Math.max(1, Math.min(2, step - 1));
    for (let i = 0; i < n; i++) {
      const c = S.clusters[i];
      const kept = keeperPos(c) != null;
      const th = kept ? 14 : Math.min(11, 3 + 2 * Math.log2(c.length));
      b.fillStyle = kept ? accent : faint;
      b.globalAlpha = kept ? 1 : 0.85;
      b.fillRect(i * step + step / 2 - tw / 2, H - th, tw, th);
    }
    TL.baseKey = key;
  }
  ctx.drawImage(TL.base, 0, 0);
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  const step = w / n;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
  ctx.fillRect(S.idx * step + step / 2 - 0.75, H - TICK_H, 1.5, TICK_H);
}

let peekIdx = -1;
function peekAt(e) {
  const r = $('#ticks').getBoundingClientRect();
  const n = S.clusters.length;
  if (!n) return;
  const i = clamp(Math.floor(((e.clientX - r.left) / r.width) * n), 0, n - 1);
  const peek = $('#peek');
  const host = $('#index').getBoundingClientRect();
  peek.style.left = `${clamp(e.clientX - host.left - 84, 0, host.width - 168)}px`;
  peek.hidden = false;
  if (i === peekIdx) return;
  peekIdx = i;
  const c = S.clusters[i];
  const shown = c[keeperPos(c) ?? 0];
  const a = S.byId.get(c[0]);
  peek.querySelector('.peek-cap').textContent = `${fmtN(i + 1)} · ${a.day ? niceDay(a.day) : ''} ${fmtTime(a).slice(0, 5)} · ${c.length}`;
  peek.classList.toggle('kept', keeperPos(c) != null);
  const box = peek.querySelector('.peek-img');
  box.replaceChildren();
  const put = (img) => peekIdx === i && img && img.naturalWidth && box.replaceChildren(onScreen(img.cloneNode()));
  const ready = thumbReady(shown);
  if (ready) put(ready);
  else thumbImage(shown).then(put);
}

/* ------------------------------------------------------------ large view */

let soloToken = 0;
const soloUrl = (id) => imgUrl(id, bucket(Math.max(window.innerWidth, window.innerHeight) * dpr()));

function openSolo() {
  const c = cur();
  if (!c) return;
  S.solo = { zoom: false };
  $('#solo').hidden = false;
  renderSolo();
  preloadAround();
}

function closeSolo() {
  if (!S.solo) return;
  soloToken++;
  stopProgress();
  S.solo = null;
  $('#solo').hidden = true;
  $('#solo').classList.remove('zoom');
  $('#solo-frame').replaceChildren();
  $('#solo-note').hidden = true;
  // the grid again, with whatever sharper pictures the large view brought
  requestAnimationFrame(() => !S.solo && !$('#viewer').hidden && render());
}

function renderSoloCaption() {
  const c = cur();
  if (!c) return;
  const id = focusedId();
  const a = S.byId.get(id);
  const d = delOf(c);
  const cap = $('#solo-caption');
  cap.replaceChildren();
  cap.classList.toggle('keep', S.keep.has(id));
  $('#solo').classList.toggle('keep', S.keep.has(id));
  $('#solo').classList.toggle('del', d.has(id));
  if (c.length > 1) {
    const keys = el('span', 'keys');
    c.slice(0, 9).forEach((x, i) => {
      const k = el('span', 'key', String(i + 1));
      if (i === S.focus) k.classList.add('here');
      if (S.keep.has(x)) k.classList.add('on');
      if (d.has(x)) k.classList.add('gone');
      k.onclick = () => {
        S.focus = i;
        renderSolo();
      };
      keys.append(k);
    });
    cap.append(keys);
  }
  cap.append(el('span', 'time', `${fmtDay(a)}  ${fmtTime(a)}`));
  if (a.lat != null) cap.append(geoLine(a, 'place'));
  if (a.fav) cap.append(el('span', 'fav', '♥'));
  if (a.kind === 'video') cap.append(el('span', 'kind', `▶ ${fmtDur(a.dur)}`));
  const hint = el('span', 'hint');
  hint.innerHTML = `${S.keep.has(id) ? 'kept' : d.has(id) ? 'to delete' : ''} &nbsp;<kbd>j</kbd><kbd>k</kbd> photos <kbd>↵</kbd> keep <kbd>D</kbd> delete <kbd>S</kbd> ♥ <kbd>Z</kbd> actual pixels <kbd>Space</kbd> back`;
  cap.append(hint);
}

function renderSolo() {
  const token = ++soloToken;
  const c = cur();
  if (!c) return closeSolo();
  const id = focusedId();
  const a = S.byId.get(id);
  const frame = $('#solo-frame');
  $('#solo').classList.toggle('zoom', !!S.solo.zoom);
  renderSoloCaption();
  stopProgress();
  $('#solo-note').hidden = true;
  // a full-size download for another photo is no longer wanted
  for (const [url, e] of [...imageCache]) {
    if (e.kind === 'full' && !e.done && url !== fullUrl(id)) {
      drop(e);
      imageCache.delete(url);
    }
  }
  const fit = () => {
    const r = aspectOf(a);
    const w = Math.min(frame.clientWidth || window.innerWidth - 24, (frame.clientHeight || window.innerHeight - 64) * r);
    return { w: Math.round(w), h: Math.round(w / r) };
  };
  const show = (node, level) => {
    if (token !== soloToken || !node) return;
    frame.dataset.id = id;
    frame.dataset.level = level;
    node.classList.toggle('lowres', level === 'thumb');
    if (level === 'thumb' || level === 'preview') {
      const { w, h } = fit();
      node.style.width = `${w}px`;
      node.style.height = `${h}px`;
      node.style.objectFit = 'cover';
    } else {
      node.style.width = node.style.height = node.style.objectFit = '';
    }
    node.style.transform = '';
    frame.replaceChildren(onScreen(node));
    if (S.solo && S.solo.zoom && level === 'full') zoomTo(S.solo.zx ?? 0.5, S.solo.zy ?? 0.5);
  };
  if (a.kind === 'video') return showVideo(id, token);
  const sharper = (level) => frame.dataset.id === id && (frame.dataset.level === 'full' || (level === 'thumb' && frame.dataset.level === 'preview'));
  const pre = getImage(soloUrl(id), 0);
  const showPreview = (img) => {
    if (token !== soloToken || !img || !img.naturalWidth || sharper('preview')) return;
    show(img, 'preview');
  };
  if (pre.done) showPreview(pre.img);
  else {
    // the grid's display copy or the thumbnail, scaled up, until it's here
    const copy = plan(c).find((p) => p.id === id);
    const e = copy && imageCache.get(copy.url);
    const showThumb = (timg) => {
      if (token !== soloToken || !timg || !timg.naturalWidth || sharper('thumb')) return;
      show(timg.cloneNode(), 'thumb');
    };
    if (e && e.done) showThumb(e.img);
    else {
      const ready = thumbReady(id);
      if (ready) showThumb(ready);
      else thumbImage(id).then(showThumb);
    }
    pre.promise.then(showPreview);
  }
  if (S.solo.zoom) loadFull(id, token, show);
}

// Actual pixels: the original, downloaded from iCloud if need be.
function loadFull(id, token, show) {
  const e = getImage(fullUrl(id), -1);
  if (e.done) return show(e.img, 'full');
  watchProgress(id, token);
  e.promise.then((img) => {
    stopProgress();
    if (token !== soloToken) return;
    if (!img.naturalWidth) {
      $('#solo-note').textContent = "The original isn't available (offline?).";
      $('#solo-note').hidden = false;
      return;
    }
    show(img, 'full');
  });
}

let progressTimer = 0;
function watchProgress(id, token) {
  stopProgress();
  const note = $('#solo-note');
  const bar = $('#dl div');
  const tick = async () => {
    const p = await api('GET', `/api/progress/${id}`).catch(() => null);
    if (token !== soloToken) return;
    if (p && p.downloading) {
      bar.style.width = `${Math.round(p.progress * 100)}%`;
      if (p.progress > 0) {
        note.textContent = `Downloading the original from iCloud · ${Math.round(p.progress * 100)}%`;
        note.hidden = false;
      }
    }
    progressTimer = setTimeout(tick, 250);
  };
  progressTimer = setTimeout(tick, 150);
}
function stopProgress() {
  clearTimeout(progressTimer);
  $('#dl div').style.width = '0';
  $('#solo-note').hidden = true;
}

function showVideo(id, token) {
  const frame = $('#solo-frame');
  const v = document.createElement('video');
  v.controls = true;
  v.autoplay = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = `/api/video/${id}`;
  v.onerror = () => {
    if (token !== soloToken) return;
    $('#solo-note').textContent = "This video can't be played here.";
    $('#solo-note').hidden = false;
  };
  v.onloadeddata = () => stopProgress();
  frame.dataset.id = id;
  frame.dataset.level = 'video';
  frame.replaceChildren(v);
  watchProgress(id, token);
}

function zoomTo(fx, fy) {
  const node = $('#solo-frame').firstChild;
  if (!node || node.tagName === 'VIDEO') return;
  const frame = $('#solo-frame');
  const w = (node.naturalWidth || node.width) / dpr();
  const h = (node.naturalHeight || node.height) / dpr();
  node.style.width = w + 'px';
  node.style.height = h + 'px';
  const fw = frame.clientWidth;
  const fh = frame.clientHeight;
  const tx = w > fw ? -(w - fw) * fx : (fw - w) / 2;
  const ty = h > fh ? -(h - fh) * fy : (fh - h) / 2;
  node.style.transform = `translate(${tx}px, ${ty}px)`;
  S.solo.zx = fx;
  S.solo.zy = fy;
}

function toggleZoom(e) {
  if (!S.solo) return;
  if (S.byId.get(focusedId())?.kind === 'video') return;
  const r = $('#solo-frame').getBoundingClientRect();
  S.solo.zx = e ? clamp((e.clientX - r.left) / r.width, 0, 1) : 0.5;
  S.solo.zy = e ? clamp((e.clientY - r.top) / r.height, 0, 1) : 0.5;
  S.solo.zoom = !S.solo.zoom;
  renderSolo();
}

/* ------------------------------------------------------------ review and delete */

const RV = { data: null, cursor: 0, busy: false, bytes: {} };

async function openReview() {
  closeSolo();
  closeMenu();
  $('#review').hidden = false;
  $('#review-result').textContent = '';
  $('#review-result').classList.remove('done');
  $('#review-title').textContent = 'Review';
  $('#review-sub').textContent = 'Working out what goes…';
  $('#review-grid').replaceChildren();
  await loadReview();
}

function closeReview() {
  $('#review').hidden = true;
  $('#first').hidden = true;
  if (!$('#viewer').hidden) {
    TL.version++;
    render();
  } else if (!$('#start').hidden) refreshStart();
}

async function loadReview() {
  await flushMarks();
  if (S.version !== S.server.library.version) await loadAssets();
  const r = await api('GET', `/api/review?window=${S.settings.window}`).catch((e) => ({ error: e.message }));
  if (r.error) {
    $('#review-sub').textContent = r.error;
    return;
  }
  RV.data = r;
  RV.bytes = r.sizes || {};
  RV.cursor = 0;
  renderReview();
}

// What's marked now (the page's own rule, so toggling here shows at once).
function reviewIds() {
  const out = [];
  for (const g of RV.data.clusters) for (const id of g.ids) if (delOf(g.ids).has(id)) out.push(id);
  return out;
}

function renderReview() {
  const ids = reviewIds();
  const bytes = ids.reduce((s, id) => s + (RV.bytes[id] || 0), 0);
  const n = ids.length;
  $('#review-title').textContent = n ? `Delete ${fmtN(n)} photo${n === 1 ? '' : 's'} · frees about ${fmtBytes(bytes)}` : 'Nothing to delete';
  const favs = ids.filter((id) => S.byId.get(id)?.fav).length;
  const groups = RV.data.clusters.filter((g) => delOf(g.ids).size).length;
  $('#review-sub').textContent = n
    ? `from ${fmtN(groups)} cluster${groups === 1 ? '' : 's'} at a ${fmtWindow(RV.data.window)} window${favs ? ` · ${favs} favorite${favs === 1 ? '' : 's'} marked with X` : ''} · click or X to keep one`
    : 'Keep at least one photo in a cluster (1–9) and the rest of it will show here.';
  $('#delete-btn').disabled = !n || RV.busy;
  const grid = $('#review-grid');
  grid.replaceChildren();
  if (!RV.data.clusters.length) {
    grid.append(el('div', 'review-empty', 'Nothing is marked.'));
    return;
  }
  let k = 0;
  for (const g of RV.data.clusters) {
    const d = delOf(g.ids);
    const box = el('div', 'rgroup');
    const a = S.byId.get(g.ids[0]);
    const head = el('div', 'rgroup-head');
    head.append(el('span', '', a ? `${fmtDay(a)}  ${fmtTime(a).slice(0, 5)}` : ''), el('span', 'muted', `${d.size} of ${g.ids.length} go`));
    box.append(head);
    const row = el('div', 'rrow');
    for (const id of g.ids) {
      const x = S.byId.get(id);
      if (!x) continue;
      const t = el('div', 'rtile');
      t.dataset.id = id;
      t.dataset.k = d.has(id) ? String(k++) : '';
      t.classList.toggle('keep', S.keep.has(id));
      t.classList.toggle('del', d.has(id));
      const r = aspectOf(x);
      const w = Math.min(150, 112 * r);
      const pic = el('div', 'pic');
      pic.style.width = `${Math.round(w)}px`;
      pic.style.height = `${Math.round(w / r)}px`;
      pic.append(crossSvg());
      if (d.has(id)) pic.classList.add('del');
      if (x.fav) pic.append(el('span', 'badge', '♥'));
      t.append(pic);
      t.onclick = () => reviewToggle(id);
      t.title = d.has(id) ? 'Will be deleted. Click (or X) to keep it.' : S.keep.has(id) ? 'Kept' : 'Stays';
      const ready = thumbReady(id);
      const put = (img) => img && img.naturalWidth && pic.prepend(onScreen(img.cloneNode()));
      if (ready) put(ready);
      else thumbImage(id).then(put);
      row.append(t);
    }
    box.append(row);
    grid.append(box);
  }
  // the hairline on what goes, as in the viewer
  grid.querySelectorAll('.rtile.del .cross').forEach((s) => (s.style.display = 'block'));
  RV.cursor = clamp(RV.cursor, 0, Math.max(0, k - 1));
  moveReviewCursor(RV.cursor);
}

function moveReviewCursor(i) {
  const tiles = [...document.querySelectorAll('#review-grid .rtile.del')];
  document.querySelectorAll('#review-grid .rtile.cursor').forEach((t) => t.classList.remove('cursor'));
  if (!tiles.length) return;
  RV.cursor = clamp(i, 0, tiles.length - 1);
  tiles[RV.cursor].classList.add('cursor');
  tiles[RV.cursor].scrollIntoView({ block: 'nearest' });
}

// In Review: a photo that goes is kept instead (it becomes a keeper); a
// photo kept here goes again.
function reviewToggle(id) {
  const g = RV.data.clusters.find((x) => x.ids.includes(id));
  if (!g) return;
  const before = delOf(g.ids).size;
  if (S.keep.has(id)) S.keep.delete(id);
  else {
    S.keep.add(id);
    S.del.delete(id);
  }
  S.toDelete += delOf(g.ids).size - before;
  updateDeleteCount();
  saveMarks();
  renderReview();
}

function reviewCursorToggle() {
  const t = document.querySelectorAll('#review-grid .rtile.del')[RV.cursor];
  if (t) reviewToggle(t.dataset.id);
}

function askDelete() {
  if (RV.busy || !RV.data || !reviewIds().length) return;
  if (!S.server.firstDeleteSeen) {
    $('#first').hidden = false;
    return;
  }
  doDelete();
}

async function doDelete() {
  $('#first').hidden = true;
  if (!S.server.firstDeleteSeen) {
    S.server.firstDeleteSeen = true;
    api('POST', '/api/first-delete-seen').catch(() => {});
  }
  const ids = reviewIds();
  if (!ids.length || RV.busy) return;
  RV.busy = true;
  await flushMarks();
  const btn = $('#delete-btn');
  btn.disabled = true;
  const res = $('#review-result');
  res.classList.remove('done');
  res.textContent = `Waiting for macOS to confirm deleting ${fmtN(ids.length)}…`;
  const r = await api('POST', '/api/delete', { ids, window: S.settings.window, day: S.settings.daily ? dailyDay() : undefined }).catch((e) => ({ error: e.message, deleted: 0 }));
  RV.busy = false;
  res.replaceChildren();
  if (r.cancelled) res.textContent = 'Nothing was deleted: the confirmation was cancelled.';
  else if (r.error && !r.deleted) res.textContent = `Nothing was deleted. Photos said: ${r.error}`;
  else {
    // the space first, large; then what happens to it
    if (r.deleted) {
      const head = el('div', 'cleared');
      head.append(el('span', 'amount num', fmtBytes(r.bytes || 0)), ' cleared');
      res.append(head);
    }
    let msg = `Deleted ${fmtN(r.deleted)} photo${r.deleted === 1 ? '' : 's'}. They're in Recently Deleted in Photos for 30 days: iCloud gets the space back then, or as soon as you empty it there.`;
    if (r.missing) msg += ` ${fmtN(r.missing)} were already gone from Photos and were skipped.`;
    if (r.skipped) msg += ` ${fmtN(r.skipped)} were no longer marked and stayed.`;
    res.append(el('div', 'what', msg));
    if (r.deleted && r.allBytes > r.bytes) res.append(el('div', 'total', `In all, Uncapture has cleared ${fmtBytes(r.allBytes)}: ${fmtN(r.allPhotos)} photos.`));
  }
  res.classList.toggle('done', !!r.deleted);
  if (r.deleted || r.missing) {
    // the marks of what went are cleared (the server did the same)
    const st = await api('GET', '/api/state');
    S.server = st;
    S.keep = new Set(st.marks.keep);
    S.del = new Set(st.marks.del);
    await waitForLibrary();
    await loadAssets();
    await loadReview();
    if (S.opened) await recluster(null);
  } else renderReview();
}

// After a delete, the server reads the library again: wait for that.
async function waitForLibrary() {
  for (let i = 0; i < 50; i++) {
    const st = await api('GET', '/api/state').catch(() => null);
    if (st) S.server = st;
    if (st && !st.library.loading && st.library.version !== S.version) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/* ------------------------------------------------------------ full screen */

const inApp = () => S.server && S.server.shell === 'tauri';
let appFs = false;
const isFullscreen = () => (inApp() ? appFs : !!document.fullscreenElement);
function onFullscreenChange(on) {
  document.body.classList.toggle('fs', on);
  layoutCache = null;
  setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
}
async function setFullscreen(on) {
  if (on === isFullscreen()) return;
  if (inApp()) {
    await api('POST', '/api/window', { cmd: 'fullscreen', on }).catch(() => null);
    appFs = on;
    return onFullscreenChange(on);
  }
  try {
    if (on) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  } catch {
    if (on) toast('Full screen unavailable');
  }
}
const toggleFullscreen = () => setFullscreen(!isFullscreen());

/* ------------------------------------------------------------ menu */

/* Every action, in one list. A menu item replays its key through the same
   handler, so the Menu, the Mac menu bar and the keyboard never disagree.
   `when` says when an item applies; `on` marks toggles. */
const inViewer = () => !$('#viewer').hidden && $('#review').hidden && !!cur();
const inViewerAny = () => !$('#viewer').hidden && $('#review').hidden;
const MENU = [
  ['Flip and keep', [
    { id: 'next', label: 'Next cluster', key: '→', press: { key: 'ArrowRight' }, when: inViewer },
    { id: 'prev', label: 'Previous cluster', key: '←', press: { key: 'ArrowLeft' }, when: inViewer },
    { id: 'next10', label: 'Forward ten', key: '⇧→', press: { key: 'ArrowRight', shiftKey: true }, when: inViewer },
    { id: 'prev10', label: 'Back ten', key: '⇧←', press: { key: 'ArrowLeft', shiftKey: true }, when: inViewer },
    { id: 'first', label: 'First cluster', key: 'Home', press: { key: 'Home' }, when: inViewer },
    { id: 'last', label: 'Last cluster', key: 'End', press: { key: 'End' }, when: inViewer },
    { id: 'nextopen', label: 'Next cluster without a keeper', key: 'U', press: { key: 'u' }, when: inViewer },
    { id: 'nextphoto', label: 'Next photo', key: 'J', press: { key: 'j' }, when: inViewer },
    { id: 'prevphoto', label: 'Previous photo', key: 'K', press: { key: 'k' }, when: inViewer },
    { id: 'focus', label: 'Next photo in the cluster', key: 'Tab', press: { key: 'Tab' }, when: inViewer },
    { id: 'keep', label: 'Keep photo', key: '↵  or 1–9', press: { key: 'Enter' }, when: inViewer, on: () => S.keep.has(focusedId()) },
    { id: 'keepall', label: 'Keep all in the cluster', key: 'A', press: { key: 'a' }, when: inViewer },
    { id: 'clear', label: "Clear the cluster's marks", key: '0', press: { key: '0', code: 'Digit0' }, when: inViewer },
    { id: 'mark', label: 'Mark photo for deletion', key: 'D  or X', press: { key: 'd' }, when: inViewer, on: () => S.del.has(focusedId()) },
    { id: 'favorite', label: 'Favorite in Photos (♥)', key: 'S', press: { key: 's' }, when: inViewer, on: () => !!S.byId.get(focusedId())?.fav },
  ]],
  ['Look closely', [
    { id: 'large', label: 'Large view', key: 'Space', press: { key: ' ' }, when: inViewer, on: () => !!S.solo },
    { id: 'zoom', label: 'Actual pixels', key: 'Z', press: { key: 'z' }, when: () => !!S.solo, on: () => !!(S.solo && S.solo.zoom) },
    { id: 'fullscreen', label: 'Full screen', key: 'F', press: { key: 'f' }, on: () => isFullscreen() },
  ]],
  ['Clusters and filters', [
    { id: 'longer', label: 'Longer window', key: ']', press: { key: ']' }, when: () => authorized() && $('#review').hidden },
    { id: 'shorter', label: 'Shorter window', key: '[', press: { key: '[' }, when: () => authorized() && $('#review').hidden },
    { id: 'clustersonly', label: 'Clusters only', key: 'C', press: { key: 'c' }, when: () => authorized() && $('#review').hidden, on: () => S.settings.clustersOnly },
    { id: 'videosonly', label: 'Videos only', key: 'V', press: { key: 'v' }, when: () => authorized() && $('#review').hidden, on: () => S.settings.videosOnly },
    { id: 'daily', label: 'Daily cleanup (on this day)', key: 'T', press: { key: 't' }, when: () => authorized() && $('#review').hidden, on: () => S.settings.daily },
    { id: 'start', label: 'Dates and filters…', key: 'O', press: { key: 'o' }, when: inViewerAny },
  ]],
  ['Review and delete', [
    { id: 'review', label: 'Review deletions', key: 'R', press: { key: 'r' }, when: () => authorized(), on: () => !$('#review').hidden },
    { id: 'delete', label: 'Delete from Photos…', key: '↵ in Review', press: { key: 'Enter' }, when: () => !$('#review').hidden && !!RV.data && reviewIds().length > 0 },
    { id: 'openphotos', label: 'Open Photos', key: '', press: { key: 'OpenPhotos' } },
  ]],
  ['Help', [
    { id: 'menu', label: 'Menu', key: 'M', press: { key: 'm' } },
    { id: 'keys', label: 'Keyboard shortcuts', key: '?', press: { key: '?' } },
  ]],
];

function runCommand(id) {
  const item = MENU.flatMap(([, items]) => items).find((i) => i.id === id);
  if (!item || (item.when && !item.when())) return;
  closeMenu();
  const pr = item.press;
  onKey({ key: pr.key, code: pr.code || '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: !!pr.shiftKey, repeat: false, target: document.body, preventDefault() {} });
}
window.uncaptureCommand = runCommand; // the Mac menu bar calls this

function openMenu(fromKey) {
  const box = $('#menu');
  box.replaceChildren();
  for (const [title, items] of MENU) {
    const sec = el('div', 'menu-sec');
    sec.append(el('div', 'menu-title', title));
    for (const it of items) {
      const b = el('button', 'menu-item');
      b.disabled = !!(it.when && !it.when());
      if (it.on && it.on()) b.classList.add('on');
      b.dataset.cmd = it.id;
      b.append(el('span', 'menu-label', it.label), el('span', 'menu-key', it.key));
      b.onclick = () => runCommand(it.id);
      sec.append(b);
    }
    box.append(sec);
  }
  box.hidden = false;
  if (fromKey) menuStep(1);
}
function menuStep(d) {
  const items = [...document.querySelectorAll('#menu .menu-item:not(:disabled)')];
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  items[i === -1 ? (d > 0 ? 0 : items.length - 1) : (i + d + items.length) % items.length].focus();
}
function closeMenu() {
  $('#menu').hidden = true;
}

// The ? sheet: built from MENU, plus the keys that aren't menu items.
function buildHelp() {
  const extra = {
    'Flip and keep': [['← →  ↑ ↓', 'previous / next cluster'], ['k j', 'previous / next photo, across clusters'], ['1 – 9', 'keep that photo (again: undo)'], ['⇧ Tab', 'previous photo in the cluster']],
    'Clusters and filters': [['on the start screen', ''], ['← →  ⇧', 'a month (or day) / widen'], ['A  Y  L', 'all · last 12 months · last 30 days'], ['in daily cleanup', ''], ['← →  ↑ ↓', 'a day / a month'], ['Home', 'today'], ['↵', 'open the clusters']],
    'Review and delete': [['← →  ↑ ↓', 'move between photos that go'], ['X  click', 'keep it instead'], ['Esc  R', 'close']],
    'Look closely': [['1 – 9  Tab', 'switch photo in the large view'], ['j k', 'photo by photo, across clusters'], ['Esc  Space', 'back from the large view'], ['click · double-click', 'back · actual pixels']],
  };
  const skip = new Set(['next', 'prev', 'next10', 'prev10', 'nextphoto', 'prevphoto', 'menu', 'keys', 'openphotos']);
  const cols = [el('dl'), el('dl')];
  MENU.forEach(([title, items], gi) => {
    const dl = cols[gi < 2 ? 0 : 1];
    dl.append(el('dt', 'group', title), el('dd'));
    if (title === 'Flip and keep') dl.append(el('dt', '', '⇧ + arrows'), el('dd', '', 'jump ten clusters'));
    for (const it of items) if (!skip.has(it.id) && it.key) dl.append(el('dt', '', it.key), el('dd', '', it.label.toLowerCase()));
    for (const [k, v] of extra[title] || []) dl.append(el('dt', '', k), el('dd', '', v));
  });
  cols[1].append(el('dt', 'group', 'Anywhere'), el('dd'), el('dt', '', 'M'), el('dd', '', 'menu of every action'), el('dt', '', '?'), el('dd', '', 'this sheet'));
  $('#help-cols').replaceChildren(...cols);
}

/* ------------------------------------------------------------ keys */

// Forward and back through the clusters: → ↓ and ← ↑. (j and k step through
// the photos, one at a time, across clusters.)
const FLIP_KEYS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
const PHOTO_KEYS = { j: 1, J: 1, k: -1, K: -1 };

function onKey(e) {
  if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'text') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return; // the system's
  const k = /^Digit([0-9])$/.test(e.code || '') ? e.code.slice(5) : e.key;
  const lower = k.length === 1 ? k.toLowerCase() : k;

  if (k === 'OpenPhotos') return api('POST', '/api/open', { what: 'photos' }).catch(() => {});

  if (!$('#menu').hidden) {
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      menuStep(k === 'ArrowDown' ? 1 : -1);
      return e.preventDefault();
    }
    if (k === 'Enter' && document.activeElement && document.activeElement.classList.contains('menu-item')) {
      document.activeElement.click();
      return e.preventDefault();
    }
    closeMenu();
    if (k === 'Escape' || lower === 'm') return e.preventDefault();
  } else if (lower === 'm') {
    openMenu(true);
    return e.preventDefault();
  }

  if (!$('#help').hidden) {
    $('#help').hidden = true;
    return e.preventDefault();
  }
  if (k === '?') {
    $('#help').hidden = false;
    return e.preventDefault();
  }
  if (lower === 'f') {
    toggleFullscreen();
    return e.preventDefault();
  }

  if (!$('#first').hidden) {
    if (k === 'Enter') doDelete();
    else if (k === 'Escape') $('#first').hidden = true;
    return e.preventDefault();
  }

  if (!$('#auth').hidden) {
    if (k === 'Enter') (S.server.auth === 'notDetermined' ? $('#auth-allow') : $('#auth-open')).click();
    return e.preventDefault();
  }

  if (!$('#review').hidden) {
    if (k === 'Escape' || lower === 'r') closeReview();
    else if (k === 'Enter') askDelete();
    else if (lower === 'x') reviewCursorToggle();
    else if (k === 'ArrowRight' || k === 'ArrowDown' || lower === 'j') moveReviewCursor(RV.cursor + 1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || lower === 'k') moveReviewCursor(RV.cursor - 1);
    else if (k === 'Home') moveReviewCursor(0);
    else if (k === 'End') moveReviewCursor(1e9);
    else return;
    return e.preventDefault();
  }

  // the window and the filters work on the start screen and in the viewer
  if (authorized()) {
    if (k === '[' || k === ']') {
      stepWindow(k === ']' ? 1 : -1);
      return e.preventDefault();
    }
    if (lower === 'c') {
      setClustersOnly(!S.settings.clustersOnly);
      return e.preventDefault();
    }
    if (lower === 'v') {
      setVideosOnly(!S.settings.videosOnly);
      return e.preventDefault();
    }
    if (lower === 't') {
      setDaily(!S.settings.daily);
      return e.preventDefault();
    }
    if (lower === 'r') {
      openReview();
      return e.preventDefault();
    }
  }

  if (!$('#start').hidden && S.settings.daily) {
    // the calendar of days
    if (k === 'ArrowLeft' || k === 'ArrowRight') stepDailyDay(k === 'ArrowRight' ? 1 : -1);
    else if (k === 'ArrowUp' || k === 'ArrowDown') stepDailyMonth(k === 'ArrowDown' ? 1 : -1);
    else if (k === 'Home') setDailyDay(todayMD());
    else if (k === 'Enter') !$('#start-open').disabled && openViewer();
    else if (k === 'Escape') backToViewer();
    else if (lower === 'a') quickRange('all');
    else return;
    return e.preventDefault();
  }

  if (!$('#start').hidden) {
    if (k === 'Enter') !$('#start-open').disabled && openViewer();
    else if (k === 'Escape') backToViewer();
    else if (lower === 'a') quickRange('all');
    else if (lower === 'y') quickRange('year');
    else if (lower === 'l') quickRange('month');
    else if (k === 'ArrowLeft' || k === 'ArrowRight') stepBin(k === 'ArrowRight' ? 1 : -1, e.shiftKey);
    else return;
    return e.preventDefault();
  }

  if ($('#viewer').hidden) return;
  const c = cur();

  if (FLIP_KEYS[k]) {
    go(FLIP_KEYS[k] * (e.shiftKey ? 10 : 1));
    return e.preventDefault();
  }
  if (PHOTO_KEYS[k]) {
    stepPhoto(PHOTO_KEYS[k]);
    return e.preventDefault();
  }
  if (/^[1-9]$/.test(k)) {
    if (!c) return;
    const pos = Number(k) - 1;
    if (pos >= c.length) return e.preventDefault();
    S.focus = pos;
    if (S.solo) renderSolo(); // switch photo
    else {
      toggleKeep(c[pos]);
      updateFocusUi();
    }
    return e.preventDefault();
  }
  switch (k === 'Tab' ? 'Tab' : lower) {
    case 'Tab':
      if (!c) break;
      S.focus = (S.focus + (e.shiftKey ? -1 : 1) + c.length) % c.length;
      updateFocusUi();
      break;
    case 'Enter':
      if (c) toggleKeep(focusedId());
      break;
    case 'a':
      keepAll();
      break;
    case '0':
      clearCluster();
      break;
    case 'd':
    case 'x':
      if (c) toggleDel(focusedId());
      break;
    case 's':
      toggleFavorite();
      break;
    case ' ': {
      const v = $('#solo-frame video');
      if (v && S.solo && document.activeElement === v) break;
      if (S.solo) closeSolo();
      else openSolo();
      break;
    }
    case 'z':
      if (S.solo) toggleZoom();
      break;
    case 'Home':
      jump(0);
      break;
    case 'End':
      jump(S.clusters.length - 1);
      break;
    case 'u':
      nextOpen();
      break;
    case 'o':
      showStart();
      break;
    case 'Escape':
      if (S.solo) closeSolo();
      else if (isFullscreen()) setFullscreen(false);
      else showStart();
      break;
    default:
      return;
  }
  e.preventDefault();
}

/* ------------------------------------------------------------ wiring */

function bindUi() {
  bindStart();
  $('#auth-allow').onclick = () => allowAccess();
  $('#auth-open').onclick = () => api('POST', '/api/open', { what: 'privacy' }).catch(() => {});
  $('#filters-btn').onclick = () => showStart();
  $('#review-btn').onclick = () => ($('#review').hidden ? openReview() : closeReview());
  $('#review-close').onclick = () => closeReview();
  $('#delete-btn').onclick = () => askDelete();
  $('#first-go').onclick = () => doDelete();
  $('#first-cancel').onclick = () => ($('#first').hidden = true);
  $('#open-photos').onclick = () => api('POST', '/api/open', { what: 'photos' }).catch(() => {});
  $('#fs-btn').onclick = () => toggleFullscreen();
  $('#help-btn').onclick = () => ($('#help').hidden = !$('#help').hidden);
  $('#help').onclick = () => ($('#help').hidden = true);
  $('#menu-btn').onclick = (e) => {
    e.stopPropagation();
    $('#menu').hidden ? openMenu(false) : closeMenu();
  };
  document.addEventListener('click', (e) => {
    if (!$('#menu').hidden && !e.target.closest('#menu')) closeMenu();
  });

  // the timeline: click to jump, hover to peek
  const ticks = $('#ticks');
  ticks.addEventListener('mousemove', peekAt);
  ticks.addEventListener('mouseleave', () => {
    $('#peek').hidden = true;
    peekIdx = -1;
  });
  ticks.addEventListener('click', (e) => {
    const r = ticks.getBoundingClientRect();
    jump(Math.floor(((e.clientX - r.left) / r.width) * S.clusters.length));
  });

  // the large view: a click (or tap) goes back, a double-click zooms
  let tapTimer = 0;
  $('#solo-frame').addEventListener('click', (e) => {
    if (e.target.tagName === 'VIDEO') return;
    if (S.solo && S.solo.zoom) return toggleZoom(e);
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => S.solo && !S.solo.zoom && closeSolo(), 260);
  });
  $('#solo-frame').addEventListener('dblclick', (e) => {
    if (e.target.tagName === 'VIDEO') return;
    clearTimeout(tapTimer);
    if (S.solo && !S.solo.zoom) toggleZoom(e);
  });
  $('#solo-frame').addEventListener('mousemove', (e) => {
    if (!S.solo || !S.solo.zoom || $('#solo-frame').dataset.level !== 'full') return;
    const r = $('#solo-frame').getBoundingClientRect();
    zoomTo(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
  });

  document.addEventListener('fullscreenchange', () => onFullscreenChange(!!document.fullscreenElement));
  let chromeTimer = 0;
  document.addEventListener('mousemove', (e) => {
    if (!document.body.classList.contains('fs')) return;
    const near = e.clientY < 70 || e.clientY > window.innerHeight - 80;
    document.body.classList.toggle('chrome', near);
    clearTimeout(chromeTimer);
    if (near) chromeTimer = setTimeout(() => document.body.classList.remove('chrome'), 2500);
  });

  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(async () => {
      layoutCache = null;
      if (inApp()) {
        const w = await api('POST', '/api/window', { cmd: 'state' }).catch(() => null);
        if (w && typeof w.fullscreen === 'boolean' && w.fullscreen !== appFs) {
          appFs = w.fullscreen;
          document.body.classList.toggle('fs', appFs);
        }
      }
      if (!$('#start').hidden) (S.settings.daily ? drawCalendar() : drawChart());
      if (!$('#viewer').hidden) render();
    }, 80);
  });

  document.addEventListener('keydown', (e) => {
    // keys belong to Uncapture, not to a button the mouse left focused
    const t = e.target;
    if (t && t.dataset && t.dataset.mouse && (t.tagName === 'BUTTON' || (t.tagName === 'INPUT' && t.type === 'checkbox'))) {
      t.blur();
      if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
    }
    if (t && t.tagName === 'BUTTON' && !t.dataset.mouse && (e.key === ' ' || e.key === 'Enter') && $('#menu').hidden) return;
    if (e.key === 'Tab' && !$('#viewer').hidden && $('#review').hidden && $('#menu').hidden) e.preventDefault();
    if (e.repeat && (FLIP_KEYS[e.key] || PHOTO_KEYS[e.key])) S.flipping = true;
    onKey(e);
  });
  document.addEventListener('mousedown', (e) => {
    const b = e.target.closest && e.target.closest('button, input[type=checkbox]');
    if (b) b.dataset.mouse = '1';
  });
  document.addEventListener('mouseup', (e) => {
    const b = e.target.closest && e.target.closest('button, input[type=checkbox]');
    if (b) setTimeout(() => b.blur(), 0);
  });
  document.addEventListener('keyup', (e) => {
    if (S.flipping && (FLIP_KEYS[e.key] || PHOTO_KEYS[e.key])) {
      S.flipping = false;
      if (!$('#viewer').hidden) preloadAround(); // resume the full prefetch
    }
  });

  // the library changes underneath (iCloud sync, edits on another device):
  // pick it up when the window comes back, staying where you were
  const check = async () => {
    if (!$('#auth').hidden) return recheckAuth();
    const st = await api('GET', '/api/state').catch(() => null);
    if (!st) return;
    const changed = st.library.version !== S.version && !st.library.loading;
    S.server = { ...st, firstDeleteSeen: S.server.firstDeleteSeen || st.firstDeleteSeen };
    if (!changed || RV.busy) return;
    await loadAssets();
    if (!$('#viewer').hidden && $('#review').hidden) recluster(null);
    else if (!$('#start').hidden) {
      ST.bins = chartBins();
      drawChart();
      refreshStart();
    }
  };
  window.addEventListener('focus', check);
  // closing the window with marks not yet sent: send them on the way out
  window.addEventListener('pagehide', () => {
    if (!marksPending) return;
    fetch('/api/marks', { method: 'PUT', keepalive: true, headers: { 'X-Uncapture': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ keep: [...S.keep], del: [...S.del], window: S.settings.window }) });
  });
  document.addEventListener('visibilitychange', () => !document.hidden && check());
  setInterval(() => !document.hidden && check(), 10000);
}

function start() {
  boot().catch((e) => {
    document.body.textContent = 'Uncapture could not start: ' + e.message;
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
