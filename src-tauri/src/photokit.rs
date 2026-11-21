//! `PhotoKitSource`: the real Photos library, through PhotoKit (macOS only).
//! Never touches `Photos Library.photoslibrary` directly.
//!
//! Threading: every HTTP request runs on its own thread, so image requests
//! are made *synchronous* there (PhotoKit allows that off the main thread);
//! the HTTP server never waits on one request for another. Calls that only
//! have an asynchronous form (authorization, deleting, writing a video) are
//! waited for over a channel. Progress handlers run on PhotoKit's queues and
//! report through a thread-safe callback.

use crate::source::*;
use block2::RcBlock;
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, sel, AllocAnyThread, DefinedClass};
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSImageCompressionFactor};
use objc2_core_foundation::CGSize;
use objc2_foundation::{NSArray, NSDictionary, NSError, NSNumber, NSObjectNSKeyValueCoding, NSString, NSURL};
// CLGeocoder is deprecated in the newest SDK (for MapKit) but is what works
// back to macOS 11, the app's minimum
#[allow(deprecated)]
use objc2_core_location::{CLGeocoder, CLLocation, CLPlacemark};
use objc2_photos::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::ptr::NonNull;
use std::rc::Rc;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// PHCachingImageManager is documented as safe to use from any thread.
struct Manager(Retained<PHCachingImageManager>);
unsafe impl Send for Manager {}
unsafe impl Sync for Manager {}

type Listener = Box<dyn Fn() + Send + Sync>;

pub struct PhotoKitSource {
    manager: Manager,
    /// short id → localIdentifier, from the last fetch
    local: Mutex<HashMap<AssetId, String>>,
    listeners: Arc<Mutex<Vec<Listener>>>,
    observing: Mutex<bool>,
}

impl PhotoKitSource {
    pub fn new() -> PhotoKitSource {
        PhotoKitSource {
            manager: Manager(unsafe { PHCachingImageManager::new() }),
            local: Mutex::new(HashMap::new()),
            listeners: Arc::new(Mutex::new(Vec::new())),
            observing: Mutex::new(false),
        }
    }

    /// The PHAssets for these ids, in order (None where gone from the library).
    fn fetch(&self, ids: &[AssetId]) -> Vec<(AssetId, Option<Retained<PHAsset>>)> {
        let map = self.local.lock().unwrap();
        let wanted: Vec<(AssetId, Option<String>)> = ids.iter().map(|id| (id.clone(), map.get(id).cloned())).collect();
        drop(map);
        let strings: Vec<Retained<NSString>> = wanted.iter().filter_map(|(_, l)| l.as_deref()).map(NSString::from_str).collect();
        let arr = NSArray::from_retained_slice(&strings);
        let opts = unsafe { PHFetchOptions::new() };
        unsafe {
            opts.setIncludeHiddenAssets(false);
            opts.setIncludeAllBurstAssets(true);
        }
        let result = unsafe { PHAsset::fetchAssetsWithLocalIdentifiers_options(&arr, Some(&opts)) };
        let mut found: HashMap<String, Retained<PHAsset>> = HashMap::new();
        for i in 0..unsafe { result.count() } {
            let a = unsafe { result.objectAtIndex(i) };
            found.insert(unsafe { a.localIdentifier() }.to_string(), a);
        }
        wanted.into_iter().map(|(id, l)| (id, l.and_then(|l| found.remove(&l)))).collect()
    }

    fn one(&self, id: &AssetId) -> Option<Retained<PHAsset>> {
        self.fetch(std::slice::from_ref(id)).pop().and_then(|(_, a)| a)
    }

    /// requestImage, synchronously, encoded as JPEG.
    fn request_image(&self, asset: &PHAsset, size: CGSize, delivery: PHImageRequestOptionsDeliveryMode, network: bool, progress: Option<Progress>, quality: f64) -> Option<Vec<u8>> {
        autoreleasepool(|_| {
            let opts = unsafe { PHImageRequestOptions::new() };
            unsafe {
                opts.setSynchronous(true);
                opts.setDeliveryMode(delivery);
                opts.setResizeMode(PHImageRequestOptionsResizeMode::Fast);
                opts.setNetworkAccessAllowed(network);
                opts.setVersion(PHImageRequestOptionsVersion::Current);
            }
            let handler_block = progress.map(|p| {
                RcBlock::new(move |v: f64, _e: *mut NSError, _stop: NonNull<Bool>, _info: *mut NSDictionary| p(v.clamp(0.0, 1.0)))
            });
            if let Some(b) = &handler_block {
                unsafe { opts.setProgressHandler(RcBlock::as_ptr(b)) };
            }
            let slot: Rc<RefCell<Option<Vec<u8>>>> = Rc::new(RefCell::new(None));
            let s2 = slot.clone();
            let done = RcBlock::new(move |img: *mut NSImage, _info: *mut NSDictionary| {
                if let Some(img) = unsafe { img.as_ref() } {
                    *s2.borrow_mut() = jpeg_of(img, quality);
                }
            });
            unsafe {
                self.manager.0.requestImageForAsset_targetSize_contentMode_options_resultHandler(asset, size, PHImageContentMode::AspectFit, Some(&opts), &done);
            }
            let out = slot.borrow_mut().take();
            out
        })
    }

    /// Register for library changes once access is granted (registering
    /// earlier would itself ask for access).
    fn observe(&self) {
        let mut on = self.observing.lock().unwrap();
        if *on {
            return;
        }
        *on = true;
        let listeners = self.listeners.clone();
        let obs = LibraryObserver::new(Box::new(move || {
            for f in listeners.lock().unwrap().iter() {
                f();
            }
        }));
        unsafe { PHPhotoLibrary::sharedPhotoLibrary().registerChangeObserver(ProtocolObject::from_ref(&*obs)) };
        // lives as long as the app
        let _ = Retained::into_raw(obs);
    }
}

/// NSImage → JPEG bytes (AppKit's encoder, via a CGImage: no TIFF detour).
fn jpeg_of(img: &NSImage, quality: f64) -> Option<Vec<u8>> {
    let cg = unsafe { img.CGImageForProposedRect_context_hints(std::ptr::null_mut(), None, None) }?;
    let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg);
    let q = NSNumber::new_f64(quality);
    let props: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_slices(&[unsafe { NSImageCompressionFactor }], &[&*q as &AnyObject]);
    let data = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &props) }?;
    Some(data.to_vec())
}

fn auth_of(s: PHAuthorizationStatus) -> Auth {
    match s {
        PHAuthorizationStatus::Authorized => Auth::Authorized,
        PHAuthorizationStatus::Limited => Auth::Limited,
        PHAuthorizationStatus::Denied => Auth::Denied,
        PHAuthorizationStatus::Restricted => Auth::Restricted,
        _ => Auth::NotDetermined,
    }
}

fn asset_of(a: &PHAsset) -> Option<Asset> {
    unsafe {
        let media = a.mediaType();
        if media != PHAssetMediaType::Image && media != PHAssetMediaType::Video {
            return None;
        }
        let sub = a.mediaSubtypes();
        let local_id = a.localIdentifier().to_string();
        let created = a.creationDate().unwrap_or_else(|| a.addedDate());
        let mut subtypes = 0;
        if sub.contains(PHAssetMediaSubtype::PhotoScreenshot) {
            subtypes |= SCREENSHOT;
        }
        if sub.contains(PHAssetMediaSubtype::PhotoHDR) {
            subtypes |= HDR;
        }
        if sub.contains(PHAssetMediaSubtype::PhotoPanorama) {
            subtypes |= PANORAMA;
        }
        if sub.contains(PHAssetMediaSubtype::PhotoDepthEffect) {
            subtypes |= PORTRAIT;
        }
        Some(Asset {
            id: short_id(&local_id),
            local_id,
            created: (created.timeIntervalSince1970() * 1000.0).round() as i64,
            // PhotoKit doesn't say which zone a photo was taken in: the Mac's is used
            tz: None,
            kind: if media == PHAssetMediaType::Video {
                Kind::Video
            } else if sub.contains(PHAssetMediaSubtype::PhotoLive) {
                Kind::Live
            } else {
                Kind::Photo
            },
            subtypes,
            width: a.pixelWidth() as u32,
            height: a.pixelHeight() as u32,
            duration: a.duration(),
            favorite: a.isFavorite(),
            hidden: a.isHidden(),
            burst_id: a.burstIdentifier().map(|b| b.to_string()),
            // PhotoKit has no public flag for the iCloud Shared Library (see TESTING.md)
            shared: false,
            bytes: None,
            location: a.location().map(|l| {
                let c = l.coordinate();
                (c.latitude, c.longitude)
            }),
        })
    }
}

/// Sum of a photo's files (original, edits, Live Photo video) from the
/// undocumented `fileSize` key; None if that key isn't there.
fn file_size(a: &PHAsset) -> Option<u64> {
    let resources = unsafe { PHAssetResource::assetResourcesForAsset(a) };
    let mut total = 0u64;
    for r in resources.iter() {
        // (asking KVC for a key that isn't there would raise: check first)
        if !r.respondsToSelector(sel!(fileSize)) {
            return None;
        }
        let v = r.valueForKey(&NSString::from_str("fileSize"))?;
        let n = v.downcast::<NSNumber>().ok()?;
        total += n.as_i64().max(0) as u64;
    }
    (total > 0).then_some(total)
}

impl PhotoSource for PhotoKitSource {
    fn name(&self) -> &'static str {
        "photos"
    }

    fn authorization(&self) -> Auth {
        auth_of(unsafe { PHPhotoLibrary::authorizationStatusForAccessLevel(PHAccessLevel::ReadWrite) })
    }

    fn request_authorization(&self) -> Auth {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(Some(tx));
        let handler = RcBlock::new(move |s: PHAuthorizationStatus| {
            if let Some(t) = tx.lock().unwrap().take() {
                let _ = t.send(s);
            }
        });
        unsafe { PHPhotoLibrary::requestAuthorizationForAccessLevel_handler(PHAccessLevel::ReadWrite, &handler) };
        rx.recv().map(auth_of).unwrap_or_else(|_| self.authorization())
    }

    fn assets(&self) -> Vec<Asset> {
        if !self.authorization().allowed() {
            return Vec::new();
        }
        self.observe();
        let mut out = Vec::new();
        autoreleasepool(|_| {
            let opts = unsafe { PHFetchOptions::new() };
            unsafe {
                opts.setIncludeHiddenAssets(false);
                opts.setIncludeAllBurstAssets(true);
                opts.setIncludeAssetSourceTypes(PHAssetSourceType::TypeUserLibrary);
            }
            let result = unsafe { PHAsset::fetchAssetsWithOptions(Some(&opts)) };
            let n = unsafe { result.count() };
            out.reserve(n);
            // in chunks, each in its own pool, so 100,000 assets stay small
            let mut i = 0;
            while i < n {
                let end = (i + 2000).min(n);
                autoreleasepool(|_| {
                    for k in i..end {
                        let a = unsafe { result.objectAtIndex(k) };
                        if let Some(x) = asset_of(&a) {
                            out.push(x);
                        }
                    }
                });
                i = end;
            }
        });
        out.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.local_id.cmp(&b.local_id)));
        *self.local.lock().unwrap() = out.iter().map(|a| (a.id.clone(), a.local_id.clone())).collect();
        out
    }

    fn thumbnail(&self, id: &AssetId, px: u32) -> Option<Vec<u8>> {
        let a = self.one(id)?;
        let size = CGSize { width: px as f64, height: px as f64 };
        // local only: Photos keeps small renditions even with Optimize Mac Storage
        self.request_image(&a, size, PHImageRequestOptionsDeliveryMode::HighQualityFormat, false, None, 0.8)
            .or_else(|| self.request_image(&a, size, PHImageRequestOptionsDeliveryMode::FastFormat, false, None, 0.8))
    }

    fn image(&self, id: &AssetId, px: Option<u32>, progress: Progress) -> Option<Vec<u8>> {
        let a = self.one(id)?;
        match px {
            Some(px) => {
                // a display-size copy: never downloads; the best local rendition
                let size = CGSize { width: px as f64, height: px as f64 };
                self.request_image(&a, size, PHImageRequestOptionsDeliveryMode::HighQualityFormat, false, None, 0.85)
                    .or_else(|| self.request_image(&a, size, PHImageRequestOptionsDeliveryMode::FastFormat, false, None, 0.85))
            }
            None => {
                // actual pixels: the full image, from iCloud if need be
                progress(0.0);
                let out = self.request_image(&a, unsafe { PHImageManagerMaximumSize }, PHImageRequestOptionsDeliveryMode::HighQualityFormat, true, Some(progress.clone()), 0.92);
                progress(1.0);
                out
            }
        }
    }

    fn download(&self, id: &AssetId, px: u32) -> Option<Vec<u8>> {
        let a = self.one(id)?;
        let size = CGSize { width: px as f64, height: px as f64 };
        // network allowed: Photos fetches what it needs from iCloud for this size
        self.request_image(&a, size, PHImageRequestOptionsDeliveryMode::HighQualityFormat, true, None, 0.85)
    }

    fn video_file(&self, id: &AssetId, progress: Progress) -> Option<PathBuf> {
        let a = self.one(id)?;
        let resources = unsafe { PHAssetResource::assetResourcesForAsset(&a) };
        let pick = |t: PHAssetResourceType| resources.iter().find(|r| unsafe { r.r#type() } == t);
        let res = pick(PHAssetResourceType::FullSizeVideo).or_else(|| pick(PHAssetResourceType::Video))?;
        let name = unsafe { res.originalFilename() }.to_string();
        let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_else(|| "mov".into());
        let dir = crate::server::data_dir().join("videos");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join(format!("{}.{}", id, ext));
        if file.exists() {
            return Some(file);
        }
        let tmp = dir.join(format!("{}.{}.partial.{}", id, std::process::id(), ext));
        let _ = std::fs::remove_file(&tmp);
        let opts = unsafe { PHAssetResourceRequestOptions::new() };
        let p = progress.clone();
        let prog = RcBlock::new(move |v: f64| p(v.clamp(0.0, 1.0)));
        unsafe {
            opts.setNetworkAccessAllowed(true);
            opts.setProgressHandler(RcBlock::as_ptr(&prog));
        }
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(Some(tx));
        let done = RcBlock::new(move |e: *mut NSError| {
            if let Some(t) = tx.lock().unwrap().take() {
                let _ = t.send(e.is_null());
            }
        });
        let url = NSURL::fileURLWithPath(&NSString::from_str(&tmp.to_string_lossy()));
        unsafe {
            PHAssetResourceManager::defaultManager().writeDataForAssetResource_toFile_options_completionHandler(&res, &url, Some(&opts), &done);
        }
        let ok = rx.recv_timeout(Duration::from_secs(30 * 60)).unwrap_or(false);
        if ok && std::fs::rename(&tmp, &file).is_ok() {
            progress(1.0);
            Some(file)
        } else {
            let _ = std::fs::remove_file(&tmp);
            None
        }
    }

    fn delete(&self, ids: &[AssetId]) -> DeleteOutcome {
        let mut out = DeleteOutcome::default();
        // re-fetch by localIdentifier: what has gone meanwhile is skipped, never re-deleted
        let fetched = self.fetch(ids);
        let mut present: Vec<Retained<PHAsset>> = Vec::new();
        let mut present_ids = Vec::new();
        for (id, a) in fetched {
            match a {
                Some(a) => {
                    present.push(a);
                    present_ids.push(id);
                }
                None => out.missing.push(id),
            }
        }
        if present.is_empty() {
            return out;
        }
        let arr = NSArray::from_retained_slice(&present);
        let change = RcBlock::new(move || unsafe {
            PHAssetChangeRequest::deleteAssets(ProtocolObject::from_ref(&*arr));
        });
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(Some(tx));
        let done = RcBlock::new(move |ok: Bool, e: *mut NSError| {
            let info = unsafe { e.as_ref() }.map(|e| (e.code(), e.localizedDescription().to_string()));
            if let Some(t) = tx.lock().unwrap().take() {
                let _ = t.send((ok.as_bool(), info));
            }
        });
        // macOS asks "Allow Uncapture to delete N photos?" here
        unsafe { PHPhotoLibrary::sharedPhotoLibrary().performChanges_completionHandler(RcBlock::as_ptr(&change), Some(&done)) };
        match rx.recv() {
            Ok((true, _)) => out.deleted = present_ids,
            Ok((false, Some((code, _)))) if code == PHPhotosError::UserCancelled.0 => out.cancelled = true,
            Ok((false, Some((_, msg)))) => out.error = Some(msg),
            Ok((false, None)) => out.cancelled = true,
            Err(_) => out.error = Some("Photos did not answer".into()),
        }
        out
    }

    fn set_favorite(&self, ids: &[AssetId], on: bool) -> Result<(), String> {
        let assets: Vec<Retained<PHAsset>> = self.fetch(ids).into_iter().filter_map(|(_, a)| a).collect();
        if assets.is_empty() {
            return Err("not in the library".into());
        }
        let change = RcBlock::new(move || unsafe {
            for a in &assets {
                PHAssetChangeRequest::changeRequestForAsset(a).setFavorite(on);
            }
        });
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(Some(tx));
        let done = RcBlock::new(move |ok: Bool, e: *mut NSError| {
            let msg = unsafe { e.as_ref() }.map(|e| e.localizedDescription().to_string());
            if let Some(t) = tx.lock().unwrap().take() {
                let _ = t.send((ok.as_bool(), msg));
            }
        });
        unsafe { PHPhotoLibrary::sharedPhotoLibrary().performChanges_completionHandler(RcBlock::as_ptr(&change), Some(&done)) };
        match rx.recv() {
            Ok((true, _)) => Ok(()),
            Ok((false, m)) => Err(m.unwrap_or_else(|| "Photos said no".into())),
            Err(_) => Err("Photos did not answer".into()),
        }
    }

    // Apple's reverse geocoder (what Photos uses): it answers on the main
    // queue, which the app window keeps running. One question at a time.
    #[allow(deprecated)]
    fn place(&self, lat: f64, lon: f64) -> Option<String> {
        static ONE: Mutex<()> = Mutex::new(());
        let _one = ONE.lock().unwrap();
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(Some(tx));
        let done = RcBlock::new(move |marks: *mut NSArray<CLPlacemark>, _e: *mut NSError| {
            let name = unsafe { marks.as_ref() }.and_then(|m| m.firstObject()).map(|p| unsafe {
                let parts: Vec<String> = [p.locality(), p.administrativeArea(), p.country()].into_iter().flatten().map(|s| s.to_string()).collect();
                // "Knoxville, Tennessee" (the country only when there's nothing nearer)
                parts.into_iter().take(2).collect::<Vec<_>>().join(", ")
            });
            if let Some(t) = tx.lock().unwrap().take() {
                let _ = t.send(name.filter(|n| !n.is_empty()));
            }
        });
        let loc = unsafe { CLLocation::initWithLatitude_longitude(CLLocation::alloc(), lat, lon) };
        let geo = unsafe { CLGeocoder::new() };
        unsafe { geo.reverseGeocodeLocation_completionHandler(&loc, RcBlock::as_ptr(&done)) };
        rx.recv_timeout(Duration::from_secs(10)).ok().flatten()
    }

    fn on_change(&self, f: Box<dyn Fn() + Send + Sync>) {
        self.listeners.lock().unwrap().push(f);
        if self.authorization().allowed() {
            self.observe();
        }
    }

    fn preheat(&self, ids: &[AssetId], px: u32) {
        let assets: Vec<Retained<PHAsset>> = self.fetch(ids).into_iter().filter_map(|(_, a)| a).collect();
        if assets.is_empty() {
            return;
        }
        let arr = NSArray::from_retained_slice(&assets);
        let opts = unsafe { PHImageRequestOptions::new() };
        unsafe {
            opts.setDeliveryMode(PHImageRequestOptionsDeliveryMode::HighQualityFormat);
            opts.setResizeMode(PHImageRequestOptionsResizeMode::Fast);
            opts.setNetworkAccessAllowed(false);
            let size = CGSize { width: px as f64, height: px as f64 };
            self.manager.0.startCachingImagesForAssets_targetSize_contentMode_options(&arr, size, PHImageContentMode::AspectFit, Some(&opts));
        }
    }

    fn bytes(&self, ids: &[AssetId]) -> Vec<Option<u64>> {
        self.fetch(ids).into_iter().map(|(_, a)| autoreleasepool(|_| a.as_deref().and_then(file_size))).collect()
    }
}

/* ------------------------------------------------------------ change observer */

struct ObserverIvars {
    f: Box<dyn Fn() + Send + Sync>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; no Drop impl.
    #[unsafe(super(NSObject))]
    #[name = "UncaptureLibraryObserver"]
    #[ivars = ObserverIvars]
    struct LibraryObserver;

    unsafe impl NSObjectProtocol for LibraryObserver {}

    unsafe impl PHPhotoLibraryChangeObserver for LibraryObserver {
        #[unsafe(method(photoLibraryDidChange:))]
        fn photo_library_did_change(&self, _change: &PHChange) {
            (self.ivars().f)();
        }
    }
);

impl LibraryObserver {
    fn new(f: Box<dyn Fn() + Send + Sync>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(ObserverIvars { f });
        unsafe { msg_send![super(this), init] }
    }
}
