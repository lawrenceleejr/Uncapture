//! Local HTTP server: serves the UI and a small JSON API on 127.0.0.1. Shared
//! by the app window (Tauri) and the terminal/browser mode (`--serve`).

use crate::cluster::{self, Filter, Ymd};
use crate::source::*;
use chrono::{Datelike, TimeZone};
use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use tiny_http::{Header, Method, Request, Response, StatusCode};

static WEB: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../web");

pub type WindowCtl = Box<dyn Fn(&str, &Value) -> Value + Send + Sync>;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub window: u32,
    pub clusters_only: bool,
    pub daily: bool,
    /// iCloud Shared Library photos (off: deleting one removes it for everyone)
    pub include_shared: bool,
    pub videos_only: bool,
    /// show where each photo was taken
    pub geo: bool,
    /// date range, "YYYY-MM-DD", inclusive
    pub from: Option<String>,
    pub to: Option<String>,
}
impl Default for Settings {
    fn default() -> Self {
        Settings { window: cluster::DEFAULT_WINDOW, clusters_only: true, daily: false, include_shared: false, videos_only: false, geo: false, from: None, to: None }
    }
}

/// Saved in `~/Library/Application Support/Uncapture/state.json`. Marks are
/// keyed by `localIdentifier`, so they survive any change of ids or order.
#[derive(Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct State {
    keep: Vec<String>,
    del: Vec<String>,
    settings: Settings,
    /// the last day daily cleanup was finished, "YYYY-MM-DD"
    daily_done: Option<String>,
    /// daily cleanup, by day of the year ("MM-DD"): each time photos of that
    /// day were deleted from daily cleanup, when and how many
    daily_log: std::collections::BTreeMap<String, Vec<DailyEntry>>,
    /// every delete: when, how many, about how many bytes (the space cleared)
    deletions: Vec<Deletion>,
    first_delete_seen: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct Deletion {
    /// "YYYY-MM-DD"
    date: String,
    photos: usize,
    bytes: u64,
}

#[derive(Serialize, Deserialize, Clone)]
struct DailyEntry {
    /// "YYYY-MM-DD", the day of the cleanup
    date: String,
    deleted: usize,
}

#[derive(Default)]
struct Lib {
    assets: Vec<Asset>,
    by_id: HashMap<String, usize>,
    version: u64,
    loading: bool,
    loaded: bool,
    /// how long the last full read of the library took (the plan's target:
    /// under 2 s for 100,000 assets on an M1)
    fetch_ms: u64,
}

/* Sharp copies for daily cleanup. Display-size images are local only, and
   with "Optimize Mac Storage" many photos only have small renditions on the
   Mac. Opening a day asks for a sharp copy of each of its photos (up to
   SHARP_MAX), downloaded in the background a few at a time and kept on disk;
   /api/img then serves those, resized to the size asked for. */
const SHARP_PX: u32 = 2048;
pub const SHARP_MAX: usize = 300;
const SHARP_WORKERS: usize = 3;
const SHARP_KEEP: usize = 1500;

#[derive(Default)]
struct Sharp {
    job: u64,
    queue: std::collections::VecDeque<String>,
    total: usize,
    done: usize,
    failed: usize,
    /// ids whose sharp copy is ready, in this job
    ready: Vec<String>,
    workers: usize,
}

fn sharp_dir() -> PathBuf {
    data_dir().join("sharp")
}
fn sharp_file(id: &str) -> PathBuf {
    sharp_dir().join(format!("{}.jpg", id))
}

pub struct App {
    src: Arc<dyn PhotoSource>,
    sharp: Mutex<Sharp>,
    /// sharp copies resized for the page: (id, px) → JPEG, a few hundred
    sharp_sized: Mutex<(HashMap<(String, u32), Arc<Vec<u8>>>, std::collections::VecDeque<(String, u32)>)>,
    lib: RwLock<Lib>,
    state: Mutex<State>,
    progress: Mutex<HashMap<String, f64>>,
    sizes: Mutex<HashMap<String, Option<u64>>>,
    refresh: Mutex<(bool, bool)>, // (running, again)
    pub shell: &'static str,
    pub window: std::sync::OnceLock<WindowCtl>,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}
pub fn data_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        home().join("Library").join("Application Support").join("Uncapture")
    } else {
        home().join(".uncapture")
    }
}
fn write_atomic(path: &Path, data: &[u8]) {
    let _ = fs::create_dir_all(path.parent().unwrap());
    let tmp = path.with_extension("tmp");
    if fs::write(&tmp, data).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

/// The Mac's UTC offset (minutes) at an instant: daylight saving included.
pub fn local_offset(ms: i64) -> i32 {
    chrono::Local.timestamp_millis_opt(ms).single().map(|d| d.offset().local_minus_utc() / 60).unwrap_or(0)
}

/// Today in local time (`UNCAPTURE_TODAY=YYYY-MM-DD` overrides, for tests).
pub fn today() -> Ymd {
    if let Some(d) = std::env::var("UNCAPTURE_TODAY").ok().and_then(|s| parse_day(&s)) {
        return d;
    }
    let d = chrono::Local::now().date_naive();
    (d.year(), d.month(), d.day())
}
fn parse_day(s: &str) -> Option<Ymd> {
    let d = chrono::NaiveDate::parse_from_str(s.get(..10)?, "%Y-%m-%d").ok()?;
    Some((d.year(), d.month(), d.day()))
}
fn fmt_day(d: Ymd) -> String {
    format!("{:04}-{:02}-{:02}", d.0, d.1, d.2)
}

impl App {
    pub fn new(src: Arc<dyn PhotoSource>, shell: &'static str) -> Arc<App> {
        let state: State = fs::read(data_dir().join("state.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let app = Arc::new(App {
            src,
            sharp: Mutex::new(Sharp::default()),
            sharp_sized: Mutex::new((HashMap::new(), Default::default())),
            lib: RwLock::new(Lib::default()),
            state: Mutex::new(state),
            progress: Mutex::new(HashMap::new()),
            sizes: Mutex::new(HashMap::new()),
            refresh: Mutex::new((false, false)),
            shell,
            window: std::sync::OnceLock::new(),
        });
        // the asset list cached on disk: the library shows at once, then refreshes
        if app.src.authorization().allowed() {
            if let Some(cached) = fs::read(app.cache_file()).ok().and_then(|b| serde_json::from_slice::<Vec<Asset>>(&b).ok()) {
                app.set_assets(cached, false);
            }
        }
        let weak = Arc::downgrade(&app);
        app.src.on_change(Box::new(move || {
            if let Some(a) = weak.upgrade() {
                a.refresh();
            }
        }));
        app.refresh();
        app
    }

    fn cache_file(&self) -> PathBuf {
        data_dir().join(format!("assets-{}.json", self.src.name()))
    }

    fn save_state(&self) {
        let s = self.state.lock().unwrap();
        write_atomic(&data_dir().join("state.json"), &serde_json::to_vec_pretty(&*s).unwrap_or_default());
    }

    fn set_assets(&self, all: Vec<Asset>, loaded: bool) {
        let shared = self.state.lock().unwrap().settings.include_shared;
        let assets: Vec<Asset> = all.into_iter().filter(|a| !a.hidden && (shared || !a.shared)).collect();
        let mut lib = self.lib.write().unwrap();
        lib.by_id = assets.iter().enumerate().map(|(i, a)| (a.id.clone(), i)).collect();
        lib.assets = assets;
        lib.version += 1;
        lib.loaded |= loaded;
    }

    /// Fetch the asset list again (in the background). Changes that arrive
    /// meanwhile cause one more fetch afterwards, not one each.
    pub fn refresh(self: &Arc<Self>) {
        {
            let mut r = self.refresh.lock().unwrap();
            if r.0 {
                r.1 = true;
                return;
            }
            *r = (true, false);
        }
        self.lib.write().unwrap().loading = true;
        let app = self.clone();
        std::thread::spawn(move || loop {
            if app.src.authorization().allowed() {
                let t0 = std::time::Instant::now();
                let all = app.src.assets();
                let ms = t0.elapsed().as_millis() as u64;
                println!("  read {} photos and videos in {} ms", all.len(), ms);
                app.lib.write().unwrap().fetch_ms = ms;
                write_atomic(&app.cache_file(), &serde_json::to_vec(&all).unwrap_or_default());
                app.set_assets(all, true);
            }
            let mut r = app.refresh.lock().unwrap();
            if r.1 {
                r.1 = false;
                continue;
            }
            r.0 = false;
            app.lib.write().unwrap().loading = false;
            return;
        });
    }

    /// A new list of photos to make sharp copies of (it replaces the last).
    fn start_sharp(self: &Arc<Self>, ids: Vec<String>) -> Value {
        let wanted: Vec<String> = {
            let lib = self.lib.read().unwrap();
            ids.into_iter().filter(|id| lib.by_id.get(id).map(|&i| lib.assets[i].kind != Kind::Video).unwrap_or(false)).take(SHARP_MAX).collect()
        };
        let mut s = self.sharp.lock().unwrap();
        s.job += 1;
        s.total = wanted.len();
        s.done = 0;
        s.failed = 0;
        s.ready.clear();
        s.queue.clear();
        for id in wanted {
            if sharp_file(&id).exists() {
                s.done += 1;
                s.ready.push(id);
            } else {
                s.queue.push_back(id);
            }
        }
        while s.workers < SHARP_WORKERS && s.workers < s.queue.len() {
            s.workers += 1;
            let app = self.clone();
            std::thread::spawn(move || app.sharp_worker());
        }
        json!({ "job": s.job, "total": s.total })
    }

    fn sharp_worker(&self) {
        let _ = fs::create_dir_all(sharp_dir());
        loop {
            let (job, id) = {
                let mut s = self.sharp.lock().unwrap();
                match s.queue.pop_front() {
                    Some(id) => (s.job, id),
                    None => {
                        s.workers -= 1;
                        let last = s.workers == 0;
                        drop(s);
                        if last {
                            prune_sharp();
                        }
                        return;
                    }
                }
            };
            let got = self.src.download(&id, SHARP_PX);
            if let Some(b) = &got {
                write_atomic(&sharp_file(&id), b);
            }
            let mut s = self.sharp.lock().unwrap();
            if s.job == job {
                if got.is_some() {
                    s.done += 1;
                    s.ready.push(id);
                } else {
                    s.failed += 1;
                }
            }
        }
    }

    /// The sharp copy of a photo at about `px`, if there is one.
    fn sharp_at(&self, id: &str, px: u32) -> Option<Arc<Vec<u8>>> {
        let key = (id.to_string(), px);
        if let Some(b) = self.sharp_sized.lock().unwrap().0.get(&key) {
            return Some(b.clone());
        }
        let bytes = fs::read(sharp_file(id)).ok()?;
        let out = Arc::new(if px < SHARP_PX * 4 / 5 { crate::resize::resize_jpeg(&bytes, px, 1).unwrap_or(bytes) } else { bytes });
        let mut c = self.sharp_sized.lock().unwrap();
        c.0.insert(key.clone(), out.clone());
        c.1.push_back(key);
        while c.1.len() > 300 {
            if let Some(old) = c.1.pop_front() {
                c.0.remove(&old);
            }
        }
        Some(out)
    }

    fn marks(&self) -> (HashSet<String>, HashSet<String>) {
        let s = self.state.lock().unwrap();
        (s.keep.iter().map(|l| short_id(l)).collect(), s.del.iter().map(|l| short_id(l)).collect())
    }

    /// Everything that would be deleted with this window, over the whole
    /// library (whatever the view's filters): clusters with their deletions.
    fn review(&self, window: u32) -> Vec<(Vec<usize>, Vec<usize>)> {
        let (keep, del) = self.marks();
        let lib = self.lib.read().unwrap();
        let f = Filter { window, ..Default::default() };
        cluster::build(&lib.assets, &f, &local_offset)
            .into_iter()
            .filter_map(|c| {
                let d = cluster::to_delete(&lib.assets, &c, &keep, &del);
                (!d.is_empty()).then_some((c, d))
            })
            .collect()
    }

    fn delete_count(&self, window: u32) -> usize {
        self.review(window).iter().map(|(_, d)| d.len()).sum()
    }

    /// File sizes for these assets: the source's where it knows, else an
    /// estimate from the pixel count (so every total reads "about").
    fn sizes_of(&self, idx: &[usize]) -> Vec<(String, u64)> {
        let (ids, est): (Vec<String>, Vec<u64>) = {
            let lib = self.lib.read().unwrap();
            idx.iter().map(|&i| (lib.assets[i].id.clone(), lib.assets[i].bytes.unwrap_or_else(|| estimate_bytes(&lib.assets[i])))).unzip()
        };
        let missing: Vec<String> = {
            let cache = self.sizes.lock().unwrap();
            ids.iter().filter(|id| !cache.contains_key(*id)).cloned().collect()
        };
        if !missing.is_empty() {
            let got = self.src.bytes(&missing);
            let mut cache = self.sizes.lock().unwrap();
            for (id, b) in missing.into_iter().zip(got) {
                cache.insert(id, b);
            }
        }
        let cache = self.sizes.lock().unwrap();
        ids.into_iter().zip(est).map(|(id, e)| {
            let b = cache.get(&id).copied().flatten().unwrap_or(e);
            (id, b)
        }).collect()
    }
}

/* ------------------------------------------------------------ http plumbing */

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

fn send_bytes(req: Request, code: u16, body: Vec<u8>, mime: &str) {
    let resp = Response::from_data(body).with_status_code(code).with_header(header("Content-Type", mime)).with_header(header("Cache-Control", "no-store"));
    let _ = req.respond(resp);
}

fn send_json(req: Request, code: u16, body: Value) {
    send_bytes(req, code, serde_json::to_vec(&body).unwrap_or_default(), "application/json");
}

fn err(req: Request, code: u16, msg: &str) {
    send_json(req, code, json!({ "error": msg }));
}

// keep the newest sharp copies only
fn prune_sharp() {
    let Ok(rd) = fs::read_dir(sharp_dir()) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = rd.flatten().filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path()))).collect();
    if files.len() <= SHARP_KEEP {
        return;
    }
    files.sort();
    for (_, f) in &files[..files.len() - SHARP_KEEP] {
        let _ = fs::remove_file(f);
    }
}

fn read_json(req: &mut Request) -> Value {
    let mut buf = Vec::new();
    let _ = req.as_reader().take(20_000_001).read_to_end(&mut buf);
    if buf.len() > 20_000_000 {
        return Value::Null;
    }
    serde_json::from_slice(&buf).unwrap_or(Value::Null)
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16) {
                Ok(v) => {
                    out.push(v);
                    i += 2;
                }
                Err(_) => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn split_url(url: &str) -> (String, HashMap<String, String>) {
    let (path, q) = url.split_once('?').unwrap_or((url, ""));
    let mut params = HashMap::new();
    for kv in q.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        params.insert(pct_decode(k), pct_decode(v));
    }
    (pct_decode(path), params)
}

fn get_header<'a>(req: &'a Request, name: &str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str())
}

fn flag(params: &HashMap<String, String>, k: &str) -> bool {
    params.get(k).map(|v| v == "1" || v == "true").unwrap_or(false)
}

fn ids_of(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

/* ------------------------------------------------------------ server */

pub fn start(app: Arc<App>, port: u16) -> io::Result<u16> {
    let server = tiny_http::Server::http(("127.0.0.1", port))
        .or_else(|_| tiny_http::Server::http(("127.0.0.1", 0)))
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(port);
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let app = app.clone();
            std::thread::spawn(move || handle(app, req));
        }
    });
    Ok(port)
}

fn handle(app: Arc<App>, req: Request) {
    // Only requests addressed to this machine (blocks DNS rebinding).
    let host = get_header(&req, "Host").unwrap_or("").split(':').next().unwrap_or("").to_string();
    if host != "127.0.0.1" && host != "localhost" {
        return err(req, 403, "forbidden host");
    }
    let (path, params) = split_url(req.url());
    if path.starts_with("/api/") {
        // Only Uncapture's own page may use the API: a page elsewhere can't
        // send this header without a CORS preflight, which is never granted,
        // and a foreign Origin is refused outright.
        let port = get_header(&req, "Host").and_then(|h| h.rsplit_once(':')).map(|(_, p)| p.to_string()).unwrap_or_default();
        if let Some(origin) = get_header(&req, "Origin") {
            let own = [format!("http://127.0.0.1:{}", port), format!("http://localhost:{}", port)];
            if !own.iter().any(|o| o == origin) {
                return err(req, 403, "forbidden origin");
            }
        }
        if *req.method() != Method::Get && get_header(&req, "X-Uncapture") != Some("1") {
            return err(req, 403, "missing X-Uncapture header");
        }
        api(&app, req, &path, &params);
    } else {
        serve_static(req, &path);
    }
}

fn serve_static(req: Request, path: &str) {
    let rel = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
    if rel.contains("..") {
        return err(req, 403, "forbidden");
    }
    match WEB.get_file(rel) {
        Some(f) => {
            let mime = match Path::new(rel).extension().and_then(|e| e.to_str()).unwrap_or("") {
                "html" => "text/html; charset=utf-8",
                "js" => "text/javascript; charset=utf-8",
                "css" => "text/css; charset=utf-8",
                "svg" => "image/svg+xml",
                "png" => "image/png",
                _ => "application/octet-stream",
            };
            let resp = Response::from_data(f.contents().to_vec()).with_header(header("Content-Type", mime)).with_header(header("Cache-Control", "no-cache"));
            let _ = req.respond(resp);
        }
        None => err(req, 404, "not found"),
    }
}

fn state_json(app: &App) -> Value {
    let s = app.state.lock().unwrap();
    let lib = app.lib.read().unwrap();
    json!({
        "source": app.src.name(),
        "auth": app.src.authorization(),
        "shell": app.shell,
        "platform": std::env::consts::OS.replace("macos", "darwin"),
        "settings": s.settings,
        "dailyDone": s.daily_done,
        "dailyLog": s.daily_log,
        "deletions": s.deletions,
        "today": fmt_day(today()),
        "firstDeleteSeen": s.first_delete_seen,
        "windows": cluster::WINDOWS,
        "library": { "version": lib.version, "count": lib.assets.len(), "loading": lib.loading, "loaded": lib.loaded, "fetchMs": lib.fetch_ms },
        "marks": {
            "keep": s.keep.iter().map(|l| short_id(l)).collect::<Vec<_>>(),
            "del": s.del.iter().map(|l| short_id(l)).collect::<Vec<_>>(),
        },
    })
}

/// Every asset, compact: [id, time, tz, kind, width, height, duration, flags
/// (, latitude, longitude)].
/// Indices into this list (same `version`) are what /api/library returns.
fn assets_json(lib: &Lib) -> Vec<u8> {
    let mut s = String::with_capacity(lib.assets.len() * 64 + 64);
    let _ = write!(s, "{{\"version\":{},\"assets\":[", lib.version);
    for (i, a) in lib.assets.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        let kind = match a.kind {
            Kind::Photo => 0,
            Kind::Video => 1,
            Kind::Live => 2,
        };
        let mut flags = 0u32;
        if a.favorite {
            flags |= 1;
        }
        if a.subtypes & SCREENSHOT != 0 {
            flags |= 2;
        }
        if a.burst_id.is_some() {
            flags |= 4;
        }
        if a.shared {
            flags |= 8;
        }
        let tz = a.tz.map(|t| t.to_string()).unwrap_or_else(|| "null".into());
        let _ = write!(s, "[\"{}\",{},{},{},{},{},{},{}", a.id, a.created, tz, kind, a.width, a.height, (a.duration * 10.0).round() / 10.0, flags);
        match a.location {
            Some((la, lo)) => {
                let _ = write!(s, ",{:.5},{:.5}]", la, lo);
            }
            None => s.push(']'),
        }
    }
    s.push_str("]}");
    s.into_bytes()
}

fn filter_from(params: &HashMap<String, String>, st: &Settings) -> Filter {
    let window = params.get("window").and_then(|w| w.parse().ok()).map(cluster::snap_window).unwrap_or(st.window);
    let daily = params.get("onThisDay").map(|v| v == "1").unwrap_or(st.daily);
    // the day of the year to clean up ("MM-DD"): today unless one is chosen
    let t = today();
    let day = params.get("day").and_then(|d| cluster::parse_md(d)).map(|(m, d)| (t.0, m, d)).unwrap_or(t);
    Filter {
        window,
        clusters_only: params.get("clustersOnly").map(|v| v == "1").unwrap_or(st.clusters_only),
        videos_only: params.get("videosOnly").map(|v| v == "1").unwrap_or(st.videos_only),
        on_this_day: daily.then_some(day),
        from: params.get("from").and_then(|s| parse_day(s)),
        to: params.get("to").and_then(|s| parse_day(s)),
    }
}

fn api(app: &Arc<App>, mut req: Request, path: &str, params: &HashMap<String, String>) {
    let method = req.method().clone();
    let get = method == Method::Get;
    let post = method == Method::Post;
    let put = method == Method::Put;

    if get {
        if path == "/api/thumbs" {
            let px = params.get("px").and_then(|v| v.parse().ok()).unwrap_or(320u32).clamp(64, 1024);
            let ids: Vec<String> = params.get("ids").map(|s| s.split(',').take(200).map(String::from).collect()).unwrap_or_default();
            return serve_thumbs(app, req, &ids, px);
        }
        if let Some(id) = path.strip_prefix("/api/img/") {
            let id = id.to_string();
            if !app.lib.read().unwrap().by_id.contains_key(&id) {
                return err(req, 404, "not found");
            }
            let full = flag(params, "full");
            let px = params.get("px").and_then(|v| v.parse().ok()).map(|p: u32| p.clamp(64, 8192));
            let bytes = if full {
                app.progress.lock().unwrap().insert(id.clone(), 0.0);
                let a = app.clone();
                let pid = id.clone();
                let out = app.src.image(&id, None, Arc::new(move |p| {
                    a.progress.lock().unwrap().insert(pid.clone(), p);
                }));
                app.progress.lock().unwrap().remove(&id);
                out
            } else {
                let px = px.unwrap_or(1600);
                // a sharp copy downloaded for daily cleanup, else what's on the Mac
                app.sharp_at(&id, px).map(|b| b.to_vec()).or_else(|| app.src.image(&id, Some(px), Arc::new(|_| {})))
            };
            return match bytes {
                Some(b) => {
                    let resp = Response::from_data(b).with_header(header("Content-Type", "image/jpeg")).with_header(header("Cache-Control", "private, max-age=3600"));
                    let _ = req.respond(resp);
                }
                None => err(req, 404, "not available"),
            };
        }
        if let Some(id) = path.strip_prefix("/api/video/") {
            let id = id.to_string();
            if !app.lib.read().unwrap().by_id.contains_key(&id) {
                return err(req, 404, "not found");
            }
            app.progress.lock().unwrap().insert(id.clone(), 0.0);
            let a = app.clone();
            let pid = id.clone();
            let file = app.src.video_file(&id, Arc::new(move |p| {
                a.progress.lock().unwrap().insert(pid.clone(), p);
            }));
            app.progress.lock().unwrap().remove(&id);
            return match file {
                Some(f) => serve_video(req, &f),
                None => err(req, 404, "not available"),
            };
        }
        if let Some(id) = path.strip_prefix("/api/progress/") {
            let p = app.progress.lock().unwrap().get(id).copied();
            return send_json(req, 200, json!({ "downloading": p.is_some(), "progress": p.unwrap_or(1.0) }));
        }
    }

    match (path, get, post, put) {
        ("/api/state", true, _, _) => send_json(req, 200, state_json(app)),
        ("/api/authorize", _, true, _) => {
            let before = app.src.authorization();
            let auth = app.src.request_authorization();
            if auth.allowed() && !before.allowed() {
                app.refresh();
            }
            send_json(req, 200, json!({ "auth": auth }))
        }
        ("/api/assets", true, _, _) => {
            let body = assets_json(&app.lib.read().unwrap());
            send_bytes(req, 200, body, "application/json")
        }
        ("/api/library", true, _, _) => {
            let f = filter_from(params, &app.state.lock().unwrap().settings);
            let lib = app.lib.read().unwrap();
            let t0 = std::time::Instant::now();
            let cs = cluster::build(&lib.assets, &f, &local_offset);
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            let photos: usize = cs.iter().map(|c| c.len()).sum();
            // daily cleanup: clusters per year, for the header
            let mut years: Vec<(i32, usize)> = Vec::new();
            if f.on_this_day.is_some() {
                for c in &cs {
                    let y = cluster::local_day(&lib.assets[c[0]], &local_offset).0;
                    match years.last_mut() {
                        Some(last) if last.0 == y => last.1 += 1,
                        _ => years.push((y, 1)),
                    }
                }
            }
            let version = lib.version;
            drop(lib);
            let to_delete = app.delete_count(f.window);
            send_json(
                req,
                200,
                json!({
                    "version": version, "window": f.window, "clusters": cs, "photos": photos,
                    "years": years, "today": fmt_day(today()), "ms": (ms * 10.0).round() / 10.0,
                    "toDelete": to_delete,
                }),
            )
        }
        ("/api/review", true, _, _) => {
            let window = params.get("window").and_then(|w| w.parse().ok()).map(cluster::snap_window).unwrap_or(app.state.lock().unwrap().settings.window);
            let groups = app.review(window);
            let all: Vec<usize> = groups.iter().flat_map(|(_, d)| d.iter().copied()).collect();
            let sizes = app.sizes_of(&all);
            let bytes: u64 = sizes.iter().map(|(_, b)| b).sum();
            let sizes: serde_json::Map<String, Value> = sizes.into_iter().map(|(id, b)| (id, json!(b))).collect();
            let lib = app.lib.read().unwrap();
            let id = |i: &usize| lib.assets[*i].id.clone();
            let favorites = all.iter().filter(|&&i| lib.assets[i].favorite).count();
            let clusters: Vec<Value> = groups.iter().map(|(c, d)| json!({ "ids": c.iter().map(id).collect::<Vec<_>>(), "del": d.iter().map(id).collect::<Vec<_>>() })).collect();
            send_json(req, 200, json!({ "window": window, "version": lib.version, "clusters": clusters, "count": all.len(), "bytes": bytes, "sizes": sizes, "favorites": favorites }))
        }
        ("/api/marks", _, _, true) => {
            let body = read_json(&mut req);
            {
                let lib = app.lib.read().unwrap();
                let to_local = |ids: Vec<String>| -> Vec<String> { ids.iter().filter_map(|id| lib.by_id.get(id)).map(|&i| lib.assets[i].local_id.clone()).collect() };
                let keep = to_local(ids_of(&body["keep"]));
                let del = to_local(ids_of(&body["del"]));
                let mut s = app.state.lock().unwrap();
                // marks on photos not in the library right now stay as they were
                let known = |l: &String| lib.by_id.contains_key(&short_id(l));
                let mut nk: Vec<String> = s.keep.iter().filter(|l| !known(l)).cloned().collect();
                let mut nd: Vec<String> = s.del.iter().filter(|l| !known(l)).cloned().collect();
                nk.extend(keep);
                nd.extend(del);
                s.keep = nk;
                s.del = nd;
            }
            app.save_state();
            let window = body["window"].as_u64().map(|w| cluster::snap_window(w as u32)).unwrap_or(app.state.lock().unwrap().settings.window);
            send_json(req, 200, json!({ "toDelete": app.delete_count(window) }))
        }
        ("/api/settings", _, _, true) => {
            let body = read_json(&mut req);
            let shared_changed;
            {
                let mut s = app.state.lock().unwrap();
                let before = s.settings.include_shared;
                let mut cur = serde_json::to_value(&s.settings).unwrap_or(Value::Null);
                if let (Some(c), Some(b)) = (cur.as_object_mut(), body.as_object()) {
                    for (k, v) in b {
                        c.insert(k.clone(), v.clone());
                    }
                }
                if let Ok(mut st) = serde_json::from_value::<Settings>(cur) {
                    st.window = cluster::snap_window(st.window);
                    s.settings = st;
                }
                shared_changed = before != s.settings.include_shared;
            }
            app.save_state();
            if shared_changed {
                app.refresh();
            }
            let st = app.state.lock().unwrap().settings.clone();
            send_json(req, 200, json!({ "settings": st }))
        }
        ("/api/daily-done", _, true, _) => {
            let d = fmt_day(today());
            app.state.lock().unwrap().daily_done = Some(d.clone());
            app.save_state();
            send_json(req, 200, json!({ "dailyDone": d }))
        }
        ("/api/delete", _, true, _) => {
            let body = read_json(&mut req);
            let window = body["window"].as_u64().map(|w| cluster::snap_window(w as u32)).unwrap_or(app.state.lock().unwrap().settings.window);
            let wanted: HashSet<String> = ids_of(&body["ids"]).into_iter().collect();
            // only what is both shown in Review and still marked: the server
            // re-derives the deletions rather than trusting the page
            let marked: HashSet<String> = {
                let groups = app.review(window);
                let lib = app.lib.read().unwrap();
                groups.iter().flat_map(|(_, d)| d.iter().map(|&i| lib.assets[i].id.clone())).collect()
            };
            let targets: Vec<String> = wanted.iter().filter(|id| marked.contains(*id)).cloned().collect();
            let skipped = wanted.len() - targets.len();
            if targets.is_empty() {
                return send_json(req, 200, json!({ "deleted": 0, "missing": 0, "skipped": skipped, "cancelled": false, "error": null }));
            }
            let local: HashMap<String, String> = {
                let lib = app.lib.read().unwrap();
                targets.iter().filter_map(|id| lib.by_id.get(id).map(|&i| (id.clone(), lib.assets[i].local_id.clone()))).collect()
            };
            // deleting from daily cleanup: which of these were taken on that day of the year
            let daily_day = body["day"].as_str().and_then(cluster::parse_md);
            let of_day: HashSet<String> = match daily_day {
                Some(md) => {
                    let lib = app.lib.read().unwrap();
                    let year = today().0;
                    targets
                        .iter()
                        .filter(|id| lib.by_id.get(*id).map(|&i| cluster::same_day_of_year(cluster::local_day(&lib.assets[i], &local_offset), md, year)).unwrap_or(false))
                        .cloned()
                        .collect()
                }
                None => HashSet::new(),
            };
            // the space they take, measured before they go
            let sizes: HashMap<String, u64> = {
                let idx: Vec<usize> = {
                    let lib = app.lib.read().unwrap();
                    targets.iter().filter_map(|id| lib.by_id.get(id).copied()).collect()
                };
                app.sizes_of(&idx).into_iter().collect()
            };
            // macOS shows its own confirmation here; this waits for the answer
            let out = app.src.delete(&targets);
            let bytes: u64 = out.deleted.iter().filter_map(|id| sizes.get(id)).sum();
            if !out.deleted.is_empty() || !out.missing.is_empty() {
                let gone: HashSet<&String> = out.deleted.iter().chain(out.missing.iter()).filter_map(|id| local.get(id)).collect();
                let mut s = app.state.lock().unwrap();
                s.keep.retain(|l| !gone.contains(l));
                s.del.retain(|l| !gone.contains(l));
                s.first_delete_seen = true;
                let n = out.deleted.iter().filter(|id| of_day.contains(*id)).count();
                if let (Some((m, d)), true) = (daily_day, n > 0) {
                    s.daily_log.entry(format!("{:02}-{:02}", m, d)).or_default().push(DailyEntry { date: fmt_day(today()), deleted: n });
                }
                if !out.deleted.is_empty() {
                    s.deletions.push(Deletion { date: fmt_day(today()), photos: out.deleted.len(), bytes });
                }
            }
            let (all_photos, all_bytes) = {
                let s = app.state.lock().unwrap();
                (s.deletions.iter().map(|d| d.photos).sum::<usize>(), s.deletions.iter().map(|d| d.bytes).sum::<u64>())
            };
            app.save_state();
            app.refresh();
            send_json(
                req,
                200,
                json!({
                    "deleted": out.deleted.len(), "missing": out.missing.len(), "skipped": skipped, "cancelled": out.cancelled, "error": out.error,
                    "bytes": bytes, "allPhotos": all_photos, "allBytes": all_bytes,
                }),
            )
        }
        ("/api/favorite", _, true, _) => {
            // the heart in Photos: written to the library straight away
            let body = read_json(&mut req);
            let ids: Vec<String> = ids_of(&body["ids"]).into_iter().filter(|id| app.lib.read().unwrap().by_id.contains_key(id)).collect();
            let on = body["on"].as_bool().unwrap_or(true);
            if ids.is_empty() {
                return err(req, 404, "not found");
            }
            match app.src.set_favorite(&ids, on) {
                Ok(()) => {
                    let mut lib = app.lib.write().unwrap();
                    for id in &ids {
                        if let Some(&i) = lib.by_id.get(id) {
                            lib.assets[i].favorite = on;
                        }
                    }
                    drop(lib);
                    let window = app.state.lock().unwrap().settings.window;
                    send_json(req, 200, json!({ "favorite": on, "toDelete": app.delete_count(window) }))
                }
                Err(e) => err(req, 500, &e),
            }
        }
        ("/api/place", true, _, _) => {
            // a place name for a geotag, rounded to ~1 km and kept on disk, so
            // each spot is asked about once
            let (Some(lat), Some(lon)) = (params.get("lat").and_then(|v| v.parse::<f64>().ok()), params.get("lon").and_then(|v| v.parse::<f64>().ok())) else {
                return err(req, 400, "lat and lon");
            };
            let key = format!("{:.2},{:.2}", lat, lon);
            let file = data_dir().join("places.json");
            let mut cache: serde_json::Map<String, Value> = fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            if let Some(v) = cache.get(&key) {
                return send_json(req, 200, json!({ "place": v }));
            }
            let (rl, ro): (f64, f64) = (key.split(',').next().unwrap().parse().unwrap_or(lat), key.split(',').nth(1).unwrap().parse().unwrap_or(lon));
            let place = app.src.place(rl, ro);
            if let Some(p) = &place {
                cache.insert(key, json!(p));
                write_atomic(&file, &serde_json::to_vec(&cache).unwrap_or_default());
            }
            send_json(req, 200, json!({ "place": place }))
        }
        ("/api/sharp", _, true, _) => {
            let body = read_json(&mut req);
            send_json(req, 200, app.start_sharp(ids_of(&body["ids"])))
        }
        ("/api/sharp", true, _, _) => {
            let s = app.sharp.lock().unwrap();
            send_json(req, 200, json!({ "job": s.job, "total": s.total, "done": s.done, "failed": s.failed, "ready": s.ready, "running": !s.queue.is_empty() || s.workers > 0 }))
        }
        ("/api/first-delete-seen", _, true, _) => {
            app.state.lock().unwrap().first_delete_seen = true;
            app.save_state();
            send_json(req, 200, json!({}))
        }
        ("/api/preheat", _, true, _) => {
            let px = params.get("px").and_then(|v| v.parse().ok()).unwrap_or(1600u32).clamp(64, 4096);
            let ids: Vec<String> = params.get("ids").map(|s| s.split(',').take(100).map(String::from).collect()).unwrap_or_default();
            let a = app.clone();
            std::thread::spawn(move || a.src.preheat(&ids, px));
            send_json(req, 200, json!({}))
        }
        ("/api/open", _, true, _) => {
            let body = read_json(&mut req);
            match body["what"].as_str() {
                Some("privacy") => open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_Photos"),
                Some("photos") => open_app("Photos"),
                _ => return err(req, 400, "unknown"),
            }
            send_json(req, 200, json!({}))
        }
        ("/api/window", _, true, _) => {
            let body = read_json(&mut req);
            let out = match app.window.get() {
                Some(w) => w(body["cmd"].as_str().unwrap_or(""), &body),
                None => json!({}),
            };
            send_json(req, 200, out)
        }
        _ => err(req, 404, "not found"),
    }
}

/// Thumbnails in one response, as Brackit's /api/thumbs: a JSON index line
/// `[[id, length], …]`, a newline, then the JPEGs back to back.
fn serve_thumbs(app: &Arc<App>, req: Request, ids: &[String], px: u32) {
    let known: Vec<String> = {
        let lib = app.lib.read().unwrap();
        ids.iter().filter(|id| lib.by_id.contains_key(*id)).cloned().collect()
    };
    let mut index = Vec::with_capacity(known.len());
    let mut body = Vec::new();
    for id in &known {
        if let Some(jpg) = app.src.thumbnail(id, px) {
            index.push(json!([id, jpg.len()]));
            body.extend_from_slice(&jpg);
        }
    }
    let mut out = serde_json::to_vec(&index).unwrap_or_default();
    out.push(b'\n');
    out.extend_from_slice(&body);
    send_bytes(req, 200, out, "application/octet-stream");
}

// Byte ranges, so <video> can seek (WebKit requires it).
fn serve_video(req: Request, file: &Path) {
    let Ok(mut f) = File::open(file) else { return err(req, 404, "not found") };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let lower = file.to_string_lossy().to_ascii_lowercase();
    let mime = if lower.ends_with(".mov") && cfg!(target_os = "macos") { "video/quicktime" } else { "video/mp4" };
    let range = get_header(&req, "Range").and_then(|r| r.strip_prefix("bytes=")).map(String::from);
    let mut headers = vec![header("Content-Type", mime), header("Accept-Ranges", "bytes")];
    let Some(r) = range else {
        let _ = req.respond(Response::new(StatusCode(200), headers, f, Some(size as usize), None));
        return;
    };
    let (a, b) = r.split_once('-').unwrap_or((&r, ""));
    let start: u64 = a.parse().unwrap_or(0);
    let end: u64 = b.parse().unwrap_or(size.saturating_sub(1)).min(size.saturating_sub(1));
    if start > end || start >= size {
        return err(req, 416, "bad range");
    }
    let _ = f.seek(SeekFrom::Start(start));
    headers.push(header("Content-Range", &format!("bytes {}-{}/{}", start, end, size)));
    let len = end - start + 1;
    let _ = req.respond(Response::new(StatusCode(206), headers, f.take(len), Some(len as usize), None));
}

pub fn open_url(u: &str) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(u).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(u).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd").args(["/C", "start", "", u]).spawn();
}

fn open_app(_name: &str) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").args(["-a", _name]).spawn();
}
