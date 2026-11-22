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
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSGraphicsContext, NSImage, NSImageCompressionFactor};
use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGColorSpace, CGContext, CGImage, CGImageAlphaInfo};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use objc2_foundation::{NSArray, NSDate, NSDictionary, NSError, NSNumber, NSObjectNSKeyValueCoding, NSString, NSURL};
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

    /// One new item in the library from kept files, with the photo's date,
    /// place, heart and albums.
    fn create(&self, dir: &std::path::Path, kept: &Kept, files: &[(isize, &KeptFile)]) -> Result<String, String> {
        let files: Vec<(PHAssetResourceType, Retained<NSURL>, Retained<NSString>)> = files
            .iter()
            .map(|(k, f)| (PHAssetResourceType(*k), NSURL::fileURLWithPath(&NSString::from_str(&dir.join(&f.file).to_string_lossy())), NSString::from_str(&f.name)))
            .collect();
        let date = (kept.created > 0).then(|| NSDate::dateWithTimeIntervalSince1970(kept.created as f64 / 1000.0));
        let location = kept.location.map(|(lat, lon)| unsafe { CLLocation::initWithLatitude_longitude(CLLocation::alloc(), lat, lon) });
        let (favorite, hidden) = (kept.favorite, kept.hidden);
        // the user's own albums it was in, where adding is allowed
        let albums: Vec<Retained<PHAssetCollection>> = if kept.albums.is_empty() {
            Vec::new()
        } else {
            let ids: Vec<Retained<NSString>> = kept.albums.iter().map(|s| NSString::from_str(s)).collect();
            let r = unsafe { PHAssetCollection::fetchAssetCollectionsWithLocalIdentifiers_options(&NSArray::from_retained_slice(&ids), None) };
            (0..unsafe { r.count() }).map(|i| unsafe { r.objectAtIndex(i) }).filter(|c| unsafe { c.canPerformEditOperation(PHCollectionEditOperation::AddContent) }).collect()
        };
        // the new item's localIdentifier, from its placeholder
        let made: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let made2 = made.clone();
        let change = RcBlock::new(move || unsafe {
            let req = PHAssetCreationRequest::creationRequestForAsset();
            for (kind, url, name) in &files {
                let o = PHAssetResourceCreationOptions::new();
                o.setOriginalFilename(Some(name));
                o.setShouldMoveFile(false);
                req.addResourceWithType_fileURL_options(*kind, url, Some(&o));
            }
            if let Some(d) = &date {
                req.setCreationDate(Some(d));
            }
            if let Some(l) = &location {
                req.setLocation(Some(l));
            }
            req.setFavorite(favorite);
            req.setHidden(hidden);
            if let Some(ph) = req.placeholderForCreatedAsset() {
                *made2.lock().unwrap() = ph.localIdentifier().to_string();
                let one = NSArray::from_retained_slice(&[ph]);
                for c in &albums {
                    if let Some(cr) = PHAssetCollectionChangeRequest::changeRequestForAssetCollection(c) {
                        cr.addAssets(ProtocolObject::from_ref(&*one));
                    }
                }
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
        match rx.recv_timeout(Duration::from_secs(10 * 60)) {
            Ok((true, _)) => Ok(made.lock().unwrap().clone()),
            Ok((false, m)) => Err(m.unwrap_or_else(|| "Photos said no".into())),
            Err(_) => Err("Photos did not answer".into()),
        }
    }

    fn one(&self, id: &AssetId) -> Option<Retained<PHAsset>> {
        self.fetch(std::slice::from_ref(id)).pop().and_then(|(_, a)| a)
    }

    /// requestImage, synchronously, encoded as JPEG.
    fn request_image(&self, asset: &PHAsset, size: CGSize, delivery: PHImageRequestOptionsDeliveryMode, network: bool, progress: Option<Progress>, quality: f64) -> Option<Vec<u8>> {
        self.request_sized(asset, size, delivery, network, progress, quality).map(|(b, _)| b)
    }

    /// requestImage, synchronously, encoded as JPEG, with its long side in pixels.
    fn request_sized(&self, asset: &PHAsset, size: CGSize, delivery: PHImageRequestOptionsDeliveryMode, network: bool, progress: Option<Progress>, quality: f64) -> Option<(Vec<u8>, u32)> {
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
            let slot: Rc<RefCell<Option<(Vec<u8>, u32)>>> = Rc::new(RefCell::new(None));
            let s2 = slot.clone();
            // the shape Photos says the asset has: every picture is made to match
            let want = unsafe { (asset.pixelWidth(), asset.pixelHeight()) };
            let done = RcBlock::new(move |img: *mut NSImage, _info: *mut NSDictionary| {
                if let Some(img) = unsafe { img.as_ref() } {
                    *s2.borrow_mut() = jpeg_of(img, quality, want);
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

/* Pictures upright. Photos' own width and height (`want`) are the shape the
   photo is shown in; the NSImage's CGImage can come out sideways (the
   sensor's pixels, the turn kept aside as an orientation), as iPhone portrait
   photos and videos are stored. Then it's turned: by AppKit when the NSImage
   itself knows the turn (its size is the upright one), else a quarter turn
   clockwise, the way an iPhone held upright stores them. */
const fn landscape(w: f64, h: f64) -> bool {
    w > h * 1.05
}
const fn portrait(w: f64, h: f64) -> bool {
    h > w * 1.05
}
fn sideways(w: f64, h: f64, want: (f64, f64)) -> bool {
    (landscape(w, h) && portrait(want.0, want.1)) || (portrait(w, h) && landscape(want.0, want.1))
}

/// A bitmap context `w`×`h` in the picture's own colours (sRGB if that can't be).
fn bitmap(cg: &CGImage, w: usize, h: usize) -> Option<CFRetained<CGContext>> {
    let space = CGImage::color_space(Some(cg));
    // 8 bits per channel, RGB, no alpha (kCGImageAlphaNoneSkipLast)
    let make = |s: Option<&CGColorSpace>| unsafe { objc2_core_graphics::CGBitmapContextCreate(std::ptr::null_mut(), w, h, 8, 0, s, CGImageAlphaInfo::NoneSkipLast.0) };
    space.as_deref().and_then(|s| make(Some(s))).or_else(|| make(CGColorSpace::new_device_rgb().as_deref()))
}

/// The picture turned a quarter clockwise.
fn turned(cg: &CGImage) -> Option<CFRetained<CGImage>> {
    let (w, h) = (CGImage::width(Some(cg)), CGImage::height(Some(cg)));
    let ctx = bitmap(cg, h, w)?;
    // (y up) a point (x, y) goes to (y, w − x)
    CGContext::translate_ctm(Some(&ctx), 0.0, w as f64);
    CGContext::rotate_ctm(Some(&ctx), -std::f64::consts::FRAC_PI_2);
    CGContext::draw_image(Some(&ctx), CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w as f64, h as f64)), Some(cg));
    objc2_core_graphics::CGBitmapContextCreateImage(Some(&ctx))
}

/// The NSImage drawn by AppKit at `w`×`h` pixels, which applies any turn it carries.
fn drawn(img: &NSImage, cg: &CGImage, w: usize, h: usize) -> Option<CFRetained<CGImage>> {
    let ctx = bitmap(cg, w, h)?;
    let ns = NSGraphicsContext::graphicsContextWithCGContext_flipped(&ctx, false);
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&ns));
    img.drawInRect(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(w as f64, h as f64)));
    NSGraphicsContext::restoreGraphicsState_class();
    objc2_core_graphics::CGBitmapContextCreateImage(Some(&ctx))
}

/// NSImage → upright JPEG bytes (AppKit's encoder, via a CGImage: no TIFF detour).
fn jpeg_of(img: &NSImage, quality: f64, want: (usize, usize)) -> Option<(Vec<u8>, u32)> {
    let raw = unsafe { img.CGImageForProposedRect_context_hints(std::ptr::null_mut(), None, None) }?;
    let (w, h) = (CGImage::width(Some(&raw)), CGImage::height(Some(&raw)));
    let size = img.size();
    let want = if want.0 > 0 && want.1 > 0 { (want.0 as f64, want.1 as f64) } else { (size.width, size.height) };
    let upright = if !sideways(w as f64, h as f64, want) {
        None
    } else if !sideways(size.width, size.height, want) {
        drawn(img, &raw, h, w)
    } else {
        turned(&raw)
    };
    let cg: &CGImage = upright.as_deref().unwrap_or(&raw);
    let long = CGImage::width(Some(cg)).max(CGImage::height(Some(cg))) as u32;
    let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), cg);
    let q = NSNumber::new_f64(quality);
    let props: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_slices(&[unsafe { NSImageCompressionFactor }], &[&*q as &AnyObject]);
    let data = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &props) }?;
    Some((data.to_vec(), long))
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

/// The first of these kinds of file the asset has.
fn resource_of(a: &PHAsset, kinds: &[PHAssetResourceType]) -> Option<Retained<PHAssetResource>> {
    let resources = unsafe { PHAssetResource::assetResourcesForAsset(a) };
    kinds.iter().find_map(|&t| resources.iter().find(|r| unsafe { r.r#type() } == t))
}

/// One of an asset's files, written to `dest` (from iCloud if need be).
fn write_resource(res: &PHAssetResource, dest: &std::path::Path, progress: Progress) -> bool {
    let tmp = dest.with_extension(format!("partial.{}", std::process::id()));
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
        PHAssetResourceManager::defaultManager().writeDataForAssetResource_toFile_options_completionHandler(res, &url, Some(&opts), &done);
    }
    let ok = rx.recv_timeout(Duration::from_secs(30 * 60)).unwrap_or(false);
    if ok && std::fs::rename(&tmp, dest).is_ok() {
        progress(1.0);
        true
    } else {
        let _ = std::fs::remove_file(&tmp);
        false
    }
}

/// A plain file name, whatever Photos says (no folders, no "..", no dot-files).
fn clean_name(name: &str) -> String {
    let n: String = name.chars().filter(|c| !c.is_control() && !"/\\:".contains(*c)).collect();
    n.trim_start_matches('.').to_string()
}

// The resource types an app can give Photos to make an item (all of them but
// the proxies): an original, its edits and their base, a Live Photo's video.
const ADDABLE: [isize; 12] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
// what makes an item on its own: Photo, Video, Audio, and a Live Photo's video
const ORIGINALS: [isize; 4] = [1, 2, 3, 9];

/// The kinds Photos would accept together as one new item.
fn supported(kinds: &[isize]) -> bool {
    let nums: Vec<Retained<NSNumber>> = kinds.iter().map(|&k| NSNumber::new_isize(k)).collect();
    !kinds.is_empty() && unsafe { PHAssetCreationRequest::supportsAssetResourceTypes(&NSArray::from_retained_slice(&nums)) }
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
                // a display-size copy: the best local rendition. If the Mac has
                // only a small one (Optimize Mac Storage), it would show blurry:
                // then ask again with iCloud allowed, for this size only.
                let size = CGSize { width: px as f64, height: px as f64 };
                let local = self
                    .request_sized(&a, size, PHImageRequestOptionsDeliveryMode::HighQualityFormat, false, None, 0.85)
                    .or_else(|| self.request_sized(&a, size, PHImageRequestOptionsDeliveryMode::FastFormat, false, None, 0.85));
                let full = unsafe { a.pixelWidth().max(a.pixelHeight()) } as u32;
                let enough = (px.min(full.max(1)) as f64 * 0.6) as u32;
                match local {
                    Some((b, long)) if long >= enough => Some(b),
                    small => self
                        .request_sized(&a, size, PHImageRequestOptionsDeliveryMode::HighQualityFormat, true, None, 0.85)
                        .map(|(b, _)| b)
                        .or(small.map(|(b, _)| b)),
                }
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
        let res = resource_of(&a, &[PHAssetResourceType::FullSizeVideo, PHAssetResourceType::Video])?;
        let name = unsafe { res.originalFilename() }.to_string();
        let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_else(|| "mov".into());
        let dir = crate::server::data_dir().join("videos");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join(format!("{}.{}", id, ext));
        if file.exists() {
            return Some(file);
        }
        write_resource(&res, &file, progress).then_some(file)
    }

    fn export_original(&self, id: &AssetId, dir: &std::path::Path, progress: Progress) -> Option<PathBuf> {
        let a = self.one(id)?;
        // the edited version where there is one, as Photos would share it
        let kinds: &[PHAssetResourceType] = if unsafe { a.mediaType() } == PHAssetMediaType::Video {
            &[PHAssetResourceType::FullSizeVideo, PHAssetResourceType::Video]
        } else {
            &[PHAssetResourceType::FullSizePhoto, PHAssetResourceType::Photo]
        };
        let res = resource_of(&a, kinds)?;
        let name = clean_name(&unsafe { res.originalFilename() }.to_string());
        let file = dir.join(if name.is_empty() { format!("{}.jpg", id) } else { name });
        write_resource(&res, &file, progress).then_some(file)
    }

    // every file Photos would need to make the item again, and its details
    fn keep_copy(&self, id: &AssetId, dir: &std::path::Path) -> Option<Kept> {
        let a = self.one(id)?;
        std::fs::create_dir_all(dir).ok()?;
        let mut files = Vec::new();
        for (k, r) in unsafe { PHAssetResource::assetResourcesForAsset(&a) }.iter().enumerate() {
            let kind = unsafe { r.r#type() }.0;
            if !ADDABLE.contains(&kind) || files.iter().any(|f: &KeptFile| f.kind == kind as i64) {
                continue;
            }
            let file = k.to_string();
            // all of it or no copy: half an item couldn't be put back as it was
            if !write_resource(&r, &dir.join(&file), Arc::new(|_| {})) {
                return None;
            }
            files.push(KeptFile { kind: kind as i64, file, name: clean_name(&unsafe { r.originalFilename() }.to_string()) });
        }
        if !files.iter().any(|f| ORIGINALS.contains(&(f.kind as isize)) || f.kind == 5 || f.kind == 6) {
            return None;
        }
        let albums = unsafe { PHAssetCollection::fetchAssetCollectionsContainingAsset_withType_options(&a, PHAssetCollectionType::Album, None) };
        let albums = (0..unsafe { albums.count() })
            .map(|i| unsafe { albums.objectAtIndex(i) })
            .filter(|c| unsafe { c.assetCollectionSubtype() } == PHAssetCollectionSubtype::AlbumRegular)
            .map(|c| unsafe { c.localIdentifier() }.to_string())
            .collect();
        Some(Kept {
            files,
            created: unsafe { a.creationDate() }.map(|d| (d.timeIntervalSince1970() * 1000.0) as i64).unwrap_or(0),
            location: unsafe { a.location() }.map(|l| {
                let c = unsafe { l.coordinate() };
                (c.latitude, c.longitude)
            }),
            favorite: unsafe { a.isFavorite() },
            hidden: unsafe { a.isHidden() },
            albums,
            extra: serde_json::Value::Null,
        })
    }

    // A new item from the kept files: with its edits if Photos takes them that
    // way, else the original alone, else the edited version as the original.
    fn restore(&self, dir: &std::path::Path, kept: &Kept) -> Result<String, String> {
        let all: Vec<(isize, &KeptFile)> = kept.files.iter().map(|f| (f.kind as isize, f)).collect();
        let originals: Vec<(isize, &KeptFile)> = all.iter().filter(|(k, _)| ORIGINALS.contains(k)).cloned().collect();
        let rendered: Vec<(isize, &KeptFile)> = all
            .iter()
            .filter_map(|&(k, f)| match k {
                5 => Some((1, f)),
                6 => Some((2, f)),
                10 => Some((9, f)),
                _ => None,
            })
            .collect();
        let mut last = "Photos can't make an item from these files".to_string();
        for files in [all, originals, rendered] {
            let kinds: Vec<isize> = files.iter().map(|(k, _)| *k).collect();
            if !supported(&kinds) {
                continue;
            }
            match self.create(dir, kept, &files) {
                Ok(local) => return Ok(local),
                Err(e) => last = e,
            }
        }
        Err(last)
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

    // Hidden in Photos (its Hidden album). By localIdentifier, hidden ones
    // included: putting one back means finding it among the hidden.
    fn set_hidden(&self, local_ids: &[String], on: bool) -> Result<(), String> {
        let strings: Vec<Retained<NSString>> = local_ids.iter().map(|s| NSString::from_str(s)).collect();
        let opts = unsafe { PHFetchOptions::new() };
        unsafe { opts.setIncludeHiddenAssets(true) };
        let result = unsafe { PHAsset::fetchAssetsWithLocalIdentifiers_options(&NSArray::from_retained_slice(&strings), Some(&opts)) };
        let assets: Vec<Retained<PHAsset>> = (0..unsafe { result.count() }).map(|i| unsafe { result.objectAtIndex(i) }).collect();
        if assets.is_empty() {
            return Err("not in the library".into());
        }
        let change = RcBlock::new(move || unsafe {
            for a in &assets {
                PHAssetChangeRequest::changeRequestForAsset(a).setHidden(on);
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
        match rx.recv_timeout(Duration::from_secs(60)) {
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
