//! Where the photos come from. `PhotoSource` keeps the UI, the clustering and
//! the API testable without a Photos library: `FakeSource` (a folder of JPEGs)
//! stands in for `PhotoKitSource` (the real library, macOS only) in tests and
//! on Linux CI.

use serde::{Deserialize, Serialize};

/// A short, stable id: a hash of the Photos `localIdentifier`. Never an index.
pub type AssetId = String;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Auth {
    NotDetermined,
    Denied,
    Restricted,
    Authorized,
    /// iOS-style limited access; treated as allowed (only the chosen photos show)
    Limited,
}

impl Auth {
    pub fn allowed(self) -> bool {
        matches!(self, Auth::Authorized | Auth::Limited)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Photo,
    Video,
    Live,
}

// subtypes, as bit flags (also sent to the page; HDR etc. are set on macOS only)
pub const SCREENSHOT: u32 = 1;
#[allow(dead_code)]
pub const HDR: u32 = 2;
#[allow(dead_code)]
pub const PANORAMA: u32 = 4;
#[allow(dead_code)]
pub const PORTRAIT: u32 = 8;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Asset {
    pub id: AssetId,
    pub local_id: String,
    /// capture time, ms since the epoch (UTC)
    pub created: i64,
    /// the photo's own time zone (minutes east of UTC), where known
    pub tz: Option<i32>,
    pub kind: Kind,
    pub subtypes: u32,
    pub width: u32,
    pub height: u32,
    /// seconds (videos)
    pub duration: f64,
    pub favorite: bool,
    pub hidden: bool,
    pub burst_id: Option<String>,
    /// in the iCloud Shared Library (deleting removes it for everyone)
    pub shared: bool,
    /// file size if known cheaply; see `PhotoSource::bytes`
    pub bytes: Option<u64>,
}

#[derive(Debug, Default, Serialize)]
pub struct DeleteOutcome {
    /// ids that are now in Recently Deleted
    pub deleted: Vec<AssetId>,
    /// ids that were already gone from the library (skipped)
    pub missing: Vec<AssetId>,
    /// the person said no in macOS's confirmation
    pub cancelled: bool,
    pub error: Option<String>,
}

/// Download progress, 0..1; may be called from any thread.
pub type Progress = std::sync::Arc<dyn Fn(f64) + Send + Sync>;

pub trait PhotoSource: Send + Sync {
    /// "photos" or "fake": shown in the UI and used by tests
    fn name(&self) -> &'static str;
    fn authorization(&self) -> Auth;
    /// shows the macOS prompt (blocks until it's answered)
    fn request_authorization(&self) -> Auth;
    /// metadata only, all of it, sorted by `created`
    fn assets(&self) -> Vec<Asset>;
    /// JPEG bytes, local only (never downloads)
    fn thumbnail(&self, id: &AssetId, px: u32) -> Option<Vec<u8>>;
    /// JPEG bytes at a size (local only), or with `px = None` the original at
    /// full resolution, which may download from iCloud: `progress` gets 0..1
    fn image(&self, id: &AssetId, px: Option<u32>, progress: Progress) -> Option<Vec<u8>>;
    /// a playable file for a video (may download from iCloud)
    fn video_file(&self, id: &AssetId, progress: Progress) -> Option<std::path::PathBuf>;
    /// moves the assets to Recently Deleted, after macOS's own confirmation
    fn delete(&self, ids: &[AssetId]) -> DeleteOutcome;
    /// called whenever the library changes (sync, edits, deletions elsewhere)
    fn on_change(&self, f: Box<dyn Fn() + Send + Sync>);
    /// sets or clears the heart in Photos (the same favorite Photos shows)
    fn set_favorite(&self, ids: &[AssetId], on: bool) -> Result<(), String>;
    /// warm the source's own cache for photos about to be shown
    fn preheat(&self, _ids: &[AssetId], _px: u32) {}
    /// file sizes in bytes; `None` where only an estimate is possible
    fn bytes(&self, ids: &[AssetId]) -> Vec<Option<u64>> {
        ids.iter().map(|_| None).collect()
    }
}

/// FNV-1a, 64 bit, as 16 hex digits: stable across runs and machines.
pub fn short_id(local_id: &str) -> AssetId {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in local_id.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", h)
}

/// A size estimate when the file size isn't available ("about").
pub fn estimate_bytes(a: &Asset) -> u64 {
    let px = a.width as f64 * a.height as f64;
    match a.kind {
        // ~ 0.3 bytes per pixel for HEIC/JPEG; a Live Photo adds a 3 s clip
        Kind::Photo => (px * 0.3) as u64,
        Kind::Live => (px * 0.3) as u64 + 3_000_000,
        // ~ 2 MB/s at 1080p, scaled by pixel count
        Kind::Video => (a.duration.max(1.0) * 2_000_000.0 * (px / (1920.0 * 1080.0)).max(0.25)) as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn short_ids_are_stable_and_distinct() {
        assert_eq!(short_id("ABC/L0/001"), short_id("ABC/L0/001"));
        assert_ne!(short_id("ABC/L0/001"), short_id("ABC/L0/002"));
        assert_eq!(short_id("x").len(), 16);
    }
}
