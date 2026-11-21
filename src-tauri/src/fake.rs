//! `FakeSource`: a folder of JPEGs (and videos) standing in for the Photos
//! library, for tests, Linux CI and trying the app without touching Photos.
//!
//! - Capture time comes from EXIF DateTimeOriginal (+ OffsetTimeOriginal and
//!   sub-seconds), as in Brackit; without it, the file's modification time.
//! - An optional `fake.json` in the folder adds what EXIF can't say:
//!   `{ "auth": "notDetermined", "answer": "deny",
//!      "files": { "IMG_1.JPG": { "favorite": true, "burst": "B1",
//!        "screenshot": true, "shared": true, "hidden": true, "live": true,
//!        "time": 1717243200000, "tz": 540, "duration": 4.5,
//!        "width": 4032, "height": 3024 } } }`
//! - Deleting moves files to `.trash/` in the folder, so tests can check what
//!   went. If a file `.cancel-delete` exists, the "system confirmation" is
//!   cancelled and nothing moves.
//! - `UNCAPTURE_FAKE_DOWNLOAD_MS` makes full-size requests take that long,
//!   reporting progress, like an iCloud download.

use crate::exif;
use crate::source::*;
use chrono::TimeZone;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, UNIX_EPOCH};

struct Entry {
    file: PathBuf,
    thumb: Option<(u64, u64)>,
    video: bool,
    orientation: u16,
}

/// Resized copies, as PhotoKit's cache would hold them: (id, px) → JPEG
const RESIZED_MAX: usize = 400;

pub struct FakeSource {
    dir: PathBuf,
    auth: Mutex<Auth>,
    files: RwLock<HashMap<AssetId, Entry>>,
    listeners: Arc<Mutex<Vec<Box<dyn Fn() + Send + Sync>>>>,
    watching: Mutex<bool>,
    resized: Mutex<(HashMap<(AssetId, u32), Arc<Vec<u8>>>, std::collections::VecDeque<(AssetId, u32)>)>,
}

fn is_jpeg(n: &str) -> bool {
    let l = n.to_ascii_lowercase();
    l.ends_with(".jpg") || l.ends_with(".jpeg")
}
fn is_video(n: &str) -> bool {
    let l = n.to_ascii_lowercase();
    l.ends_with(".mov") || l.ends_with(".mp4") || l.ends_with(".m4v")
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // .trash, ._AppleDouble, .DS_Store
        }
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else if is_jpeg(&name) || is_video(&name) {
            out.push(p);
        }
    }
}

fn parse_auth(s: &str) -> Option<Auth> {
    serde_json::from_value(Value::String(s.to_string())).ok()
}

impl FakeSource {
    pub fn new(dir: PathBuf) -> FakeSource {
        let me = FakeSource {
            dir,
            auth: Mutex::new(Auth::Authorized),
            files: RwLock::new(HashMap::new()),
            listeners: Arc::new(Mutex::new(Vec::new())),
            watching: Mutex::new(false),
            resized: Mutex::new((HashMap::new(), Default::default())),
        };
        if let Some(a) = me.manifest().get("auth").and_then(|v| v.as_str()).and_then(parse_auth) {
            *me.auth.lock().unwrap() = a;
        }
        me
    }

    fn manifest(&self) -> Value {
        fs::read(self.dir.join("fake.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
    }

    fn rel(&self, p: &Path) -> String {
        p.strip_prefix(&self.dir).unwrap_or(p).to_string_lossy().replace('\\', "/")
    }

    fn notify(&self) {
        for f in self.listeners.lock().unwrap().iter() {
            f();
        }
    }

    /// what the folder looks like, cheaply: names, sizes and times
    fn signature(dir: &Path) -> u64 {
        let mut files = Vec::new();
        walk(dir, &mut files);
        let mut h: u64 = files.len() as u64;
        for f in files {
            let md = fs::metadata(&f).ok();
            let t = md.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            let s = short_id(&format!("{}:{}:{}", f.to_string_lossy(), md.map(|m| m.len()).unwrap_or(0), t));
            h = h.wrapping_mul(31).wrapping_add(u64::from_str_radix(&s, 16).unwrap_or(0));
        }
        h
    }
}

impl FakeSource {
    /// The photo at most `px` on its long side, upright, as JPEG (cached).
    /// A photo already that small is sent as it is.
    fn resized(&self, id: &AssetId, px: u32) -> Option<Arc<Vec<u8>>> {
        let key = (id.clone(), px);
        if let Some(b) = self.resized.lock().unwrap().0.get(&key) {
            return Some(b.clone());
        }
        let (file, orientation) = {
            let files = self.files.read().unwrap();
            let e = files.get(id).filter(|e| !e.video)?;
            (e.file.clone(), e.orientation)
        };
        let bytes = fs::read(&file).ok()?;
        let out = Arc::new(crate::resize::resize_jpeg(&bytes, px, orientation).unwrap_or(bytes));
        let mut cache = self.resized.lock().unwrap();
        cache.0.insert(key.clone(), out.clone());
        cache.1.push_back(key);
        while cache.1.len() > RESIZED_MAX {
            if let Some(old) = cache.1.pop_front() {
                cache.0.remove(&old);
            }
        }
        Some(out)
    }
}

fn wall_to_utc(date: &str) -> Option<chrono::NaiveDateTime> {
    chrono::NaiveDateTime::parse_from_str(date.get(..19)?, "%Y:%m:%d %H:%M:%S").ok()
}

impl PhotoSource for FakeSource {
    fn name(&self) -> &'static str {
        "fake"
    }

    fn authorization(&self) -> Auth {
        *self.auth.lock().unwrap()
    }

    fn request_authorization(&self) -> Auth {
        let mut a = self.auth.lock().unwrap();
        if *a == Auth::NotDetermined {
            let deny = self.manifest().get("answer").and_then(|v| v.as_str()) == Some("deny");
            *a = if deny { Auth::Denied } else { Auth::Authorized };
        }
        *a
    }

    fn assets(&self) -> Vec<Asset> {
        if !self.authorization().allowed() {
            return Vec::new();
        }
        let manifest = self.manifest();
        let extra = manifest.get("files").cloned().unwrap_or(Value::Null);
        let mut paths = Vec::new();
        walk(&self.dir, &mut paths);
        let mut out = Vec::new();
        let mut files = HashMap::new();
        for p in paths {
            let rel = self.rel(&p);
            let x = extra.get(&rel).cloned().unwrap_or(Value::Null);
            let video = is_video(&rel);
            let md = fs::metadata(&p).ok();
            let mtime = md.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
            let ex = if video { None } else { exif::read(&p) };
            let mut tz = x.get("tz").and_then(|v| v.as_i64()).map(|v| v as i32);
            let created = if let Some(t) = x.get("time").and_then(|v| v.as_i64()) {
                t
            } else if let Some(naive) = ex.as_ref().and_then(|e| e.date.as_deref()).and_then(wall_to_utc) {
                let e = ex.as_ref().unwrap();
                let ms = naive.and_utc().timestamp_millis() + e.subsec_ms as i64;
                match e.offset {
                    Some(off) => {
                        tz = tz.or(Some(off));
                        ms - off as i64 * 60_000
                    }
                    // no offset recorded: the wall clock was in the Mac's zone
                    None => chrono::Local.from_local_datetime(&naive).earliest().map(|d| d.timestamp_millis() + e.subsec_ms as i64).unwrap_or(ms),
                }
            } else {
                mtime
            };
            let (mut w, mut h) = ex.as_ref().map(|e| (e.width, e.height)).unwrap_or((0, 0));
            if ex.as_ref().map(|e| e.orientation >= 5 && e.orientation <= 8).unwrap_or(false) {
                std::mem::swap(&mut w, &mut h);
            }
            let flag = |k: &str| x.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
            let num = |k: &str| x.get(k).and_then(|v| v.as_u64()).map(|v| v as u32);
            let kind = if video {
                Kind::Video
            } else if flag("live") {
                Kind::Live
            } else {
                Kind::Photo
            };
            let id = short_id(&rel);
            out.push(Asset {
                id: id.clone(),
                local_id: rel.clone(),
                created,
                tz,
                kind,
                subtypes: if flag("screenshot") { SCREENSHOT } else { 0 },
                width: num("width").unwrap_or(if w > 0 { w } else if video { 1920 } else { 3 }),
                height: num("height").unwrap_or(if h > 0 { h } else if video { 1080 } else { 2 }),
                duration: x.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0),
                favorite: flag("favorite"),
                hidden: flag("hidden"),
                burst_id: x.get("burst").and_then(|v| v.as_str()).map(String::from),
                shared: flag("shared"),
                bytes: md.map(|m| m.len()),
                location: match (x.get("lat").and_then(|v| v.as_f64()), x.get("lon").and_then(|v| v.as_f64())) {
                    (Some(la), Some(lo)) => Some((la, lo)),
                    _ => ex.as_ref().and_then(|e| e.gps),
                },
            });
            let orientation = ex.as_ref().map(|e| e.orientation).unwrap_or(1);
            files.insert(id, Entry { file: p, thumb: ex.and_then(|e| e.thumb), video, orientation });
        }
        *self.files.write().unwrap() = files;
        out.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.local_id.cmp(&b.local_id)));
        out
    }

    fn thumbnail(&self, id: &AssetId, _px: u32) -> Option<Vec<u8>> {
        let files = self.files.read().unwrap();
        let e = files.get(id)?;
        if e.video {
            return None; // (PhotoKit gives a poster frame; a folder has none)
        }
        if let Some((off, len)) = e.thumb {
            let mut f = fs::File::open(&e.file).ok()?;
            f.seek(SeekFrom::Start(off)).ok()?;
            let mut buf = vec![0; len as usize];
            f.read_exact(&mut buf).ok()?;
            return Some(buf);
        }
        drop(files);
        self.resized(id, _px).map(|b| b.to_vec())
    }

    fn image(&self, id: &AssetId, px: Option<u32>, progress: Progress) -> Option<Vec<u8>> {
        let file = {
            let files = self.files.read().unwrap();
            let e = files.get(id).filter(|e| !e.video)?;
            e.file.clone()
        };
        match px {
            Some(px) => self.resized(id, px).map(|b| b.to_vec()),
            None => {
                simulate_download(&*progress);
                fs::read(file).ok()
            }
        }
    }

    fn video_file(&self, id: &AssetId, progress: Progress) -> Option<PathBuf> {
        let file = self.files.read().unwrap().get(id).filter(|e| e.video).map(|e| e.file.clone())?;
        simulate_download(&*progress);
        Some(file)
    }

    fn delete(&self, ids: &[AssetId]) -> DeleteOutcome {
        let mut out = DeleteOutcome::default();
        if self.dir.join(".cancel-delete").exists() {
            out.cancelled = true;
            return out;
        }
        let trash = self.dir.join(".trash");
        let _ = fs::create_dir_all(&trash);
        let found: Vec<(AssetId, Option<PathBuf>)> = {
            let files = self.files.read().unwrap();
            ids.iter().map(|id| (id.clone(), files.get(id).map(|e| e.file.clone()).filter(|f| f.exists()))).collect()
        };
        for (id, file) in found {
            match file {
                Some(f) => {
                    let name = self.rel(&f).replace('/', "__");
                    match fs::rename(&f, trash.join(name)) {
                        Ok(_) => out.deleted.push(id),
                        Err(e) => out.error = Some(e.to_string()),
                    }
                }
                None => out.missing.push(id),
            }
        }
        self.files.write().unwrap().retain(|id, _| !out.deleted.contains(id));
        self.notify();
        out
    }

    fn on_change(&self, f: Box<dyn Fn() + Send + Sync>) {
        self.listeners.lock().unwrap().push(f);
        let mut w = self.watching.lock().unwrap();
        if *w {
            return;
        }
        *w = true;
        // poll the folder: something added, removed or touched → changed
        let dir = self.dir.clone();
        let listeners = self.listeners.clone();
        std::thread::spawn(move || {
            let mut last = FakeSource::signature(&dir);
            loop {
                std::thread::sleep(Duration::from_millis(1000));
                let now = FakeSource::signature(&dir);
                if now != last {
                    last = now;
                    for f in listeners.lock().unwrap().iter() {
                        f();
                    }
                }
            }
        });
    }

    // the heart lives in fake.json, as Photos keeps it in its library
    fn set_favorite(&self, ids: &[AssetId], on: bool) -> Result<(), String> {
        let rels: Vec<String> = {
            let files = self.files.read().unwrap();
            ids.iter().filter_map(|id| files.get(id)).map(|e| self.rel(&e.file)).collect()
        };
        if rels.len() != ids.len() {
            return Err("not in the library".into());
        }
        let mut m = self.manifest();
        if !m.is_object() {
            m = serde_json::json!({});
        }
        let files = m.as_object_mut().unwrap().entry("files").or_insert_with(|| serde_json::json!({}));
        for r in rels {
            let e = files.as_object_mut().ok_or("bad fake.json")?.entry(r).or_insert_with(|| serde_json::json!({}));
            if let Some(o) = e.as_object_mut() {
                o.insert("favorite".into(), Value::Bool(on));
            } else {
                *e = serde_json::json!({ "favorite": on });
            }
        }
        fs::write(self.dir.join("fake.json"), serde_json::to_vec_pretty(&m).unwrap()).map_err(|e| e.to_string())
    }

    // place names from fake.json: "places": { "35.96,-83.92": "Knoxville, Tennessee" }
    fn place(&self, lat: f64, lon: f64) -> Option<String> {
        let key = format!("{:.2},{:.2}", lat, lon);
        self.manifest().get("places")?.get(&key)?.as_str().map(String::from)
    }

    // a sharp copy "from iCloud": the resized photo, after the simulated delay
    fn download(&self, id: &AssetId, px: u32) -> Option<Vec<u8>> {
        let ms: u64 = std::env::var("UNCAPTURE_FAKE_DOWNLOAD_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
        std::thread::sleep(Duration::from_millis(ms / 10));
        self.resized(id, px).map(|b| b.to_vec())
    }

    fn bytes(&self, ids: &[AssetId]) -> Vec<Option<u64>> {
        let files = self.files.read().unwrap();
        ids.iter().map(|id| files.get(id).and_then(|e| fs::metadata(&e.file).ok()).map(|m| m.len())).collect()
    }
}

fn simulate_download(progress: &dyn Fn(f64)) {
    let ms: u64 = std::env::var("UNCAPTURE_FAKE_DOWNLOAD_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    if ms == 0 {
        return;
    }
    for k in 1..=10 {
        std::thread::sleep(Duration::from_millis(ms / 10));
        progress(k as f64 / 10.0);
    }
}
