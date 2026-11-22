//! The app window: the system WebView (WKWebView on macOS) pointed at the
//! embedded local server, plus the Mac menu bar and window control.

use crate::server;
use crate::source::PhotoSource;
use serde_json::json;
use std::sync::Arc;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub fn run(src: Arc<dyn PhotoSource>) {
    let srv = server::App::new(src, "tauri");

    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(build_menu).on_menu_event(|app, event| {
        // Uncapture's own items run the same command the keyboard runs
        let id = event.id().as_ref().to_string();
        if let Some(cmd) = id.strip_prefix("cmd:") {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval(&format!("window.uncaptureCommand && window.uncaptureCommand({:?})", cmd));
            }
        }
    });

    builder
        .setup(move |app| {
            let h = app.handle().clone();
            let _ = srv.window.set(Box::new(move |cmd, body| {
                let Some(w) = h.get_webview_window("main") else { return json!({}) };
                match cmd {
                    "fullscreen" => {
                        let on = body.get("on").and_then(|v| v.as_bool()).unwrap_or(false);
                        let _ = w.set_fullscreen(on);
                        json!({ "fullscreen": on })
                    }
                    // the system share sheet beside the photo (page coordinates)
                    #[cfg(target_os = "macos")]
                    "share" => {
                        let path = std::path::PathBuf::from(body["path"].as_str().unwrap_or(""));
                        let (x, y) = (body["x"].as_f64().unwrap_or(0.0), body["y"].as_f64().unwrap_or(0.0));
                        let w2 = w.clone();
                        let _ = w.run_on_main_thread(move || {
                            if let Ok(view) = w2.ns_view() {
                                macos::share(view, &path, x, y);
                            }
                        });
                        json!({ "shared": true })
                    }
                    // the photo's file dragged out of the window, as the mouse moves
                    #[cfg(target_os = "macos")]
                    "drag" => {
                        let path = std::path::PathBuf::from(body["path"].as_str().unwrap_or(""));
                        let icon = std::path::PathBuf::from(body["icon"].as_str().unwrap_or(""));
                        let w2 = w.clone();
                        let _ = w.run_on_main_thread(move || {
                            let image = if icon.exists() { drag::Image::File(icon) } else { drag::Image::Raw(Vec::new()) };
                            let _ = drag::start_drag(&w2, drag::DragItem::Files(vec![path]), image, |_, _| {}, drag::Options::default());
                        });
                        json!({ "dragging": true })
                    }
                    _ => json!({ "fullscreen": w.is_fullscreen().unwrap_or(false) }),
                }
            }));
            let port = server::start(srv.clone(), 0)?;
            let url = format!("http://127.0.0.1:{}/?shell=tauri&key={}", port, srv.key);
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                // the window only ever shows Uncapture's own page
                .on_navigation(move |u| u.host_str() == Some("127.0.0.1") && u.port() == Some(port))
                .title("Uncapture")
                .inner_size(1440.0, 920.0)
                .min_inner_size(900.0, 600.0)
                .background_color(tauri::window::Color(13, 13, 12, 255));
            #[cfg(target_os = "macos")]
            let builder = builder.title_bar_style(tauri::TitleBarStyle::Transparent).hidden_title(true);
            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while starting Uncapture");
}

// The menu bar mirrors the in-page Menu (MENU in web/app.js): every action,
// grouped the same way. Items carry no key equivalents, so keys still reach
// the page, where the same shortcuts are handled.
#[cfg(target_os = "macos")]
fn build_menu<R: tauri::Runtime>(h: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as P, Submenu};
    let item = |id: &str, label: &str| MenuItem::with_id(h, format!("cmd:{}", id), label, true, None::<&str>);
    Menu::with_items(
        h,
        &[
            &Submenu::with_items(
                h,
                "Uncapture",
                true,
                &[&P::about(h, None, None)?, &P::separator(h)?, &P::hide(h, None)?, &P::hide_others(h, None)?, &P::separator(h)?, &P::quit(h, None)?],
            )?,
            &Submenu::with_items(h, "Edit", true, &[&P::cut(h, None)?, &P::copy(h, None)?, &P::paste(h, None)?, &P::select_all(h, None)?])?,
            &Submenu::with_items(
                h,
                "Flip and Keep",
                true,
                &[
                    &item("next", "Next Cluster   →")?,
                    &item("prev", "Previous Cluster   ←")?,
                    &item("next10", "Forward Ten   ⇧→")?,
                    &item("prev10", "Back Ten   ⇧←")?,
                    &item("first", "First Cluster   Home")?,
                    &item("last", "Last Cluster   End")?,
                    &item("nextopen", "Next Cluster Without a Keeper   U")?,
                    &P::separator(h)?,
                    &item("nextphoto", "Next Photo   J")?,
                    &item("prevphoto", "Previous Photo   K")?,
                    &item("focus", "Next Photo in Cluster   Tab")?,
                    &P::separator(h)?,
                    &item("keep", "Keep Photo   ↵")?,
                    &item("keepall", "Keep All in Cluster   A")?,
                    &item("clear", "Clear Cluster's Marks   0")?,
                    &item("mark", "Mark Photo for Deletion   D")?,
                    &item("favorite", "Favorite in Photos   S")?,
                    &item("hide", "Hide in Photos   H")?,
                ],
            )?,
            &Submenu::with_items(
                h,
                "Look Closely",
                true,
                &[
                    &item("large", "Large View   Space")?,
                    &item("share", "Share Photo…   E")?,
                    &item("zoom", "Actual Pixels   Z")?,
                    &item("loupe", "Loupe   `")?,
                    &P::separator(h)?,
                    &item("fullscreen", "Full Screen   F")?,
                ],
            )?,
            &Submenu::with_items(
                h,
                "Clusters and Filters",
                true,
                &[
                    &item("longer", "Longer Window   ]")?,
                    &item("shorter", "Shorter Window   [")?,
                    &P::separator(h)?,
                    &item("clustersonly", "Clusters Only   C")?,
                    &item("videosonly", "Videos Only   V")?,
                    &item("screenshotsonly", "Screenshots Only   P")?,
                    &item("daily", "Daily Cleanup (On This Day)   T")?,
                    &P::separator(h)?,
                    &item("start", "Dates and Filters…   O")?,
                ],
            )?,
            &Submenu::with_items(
                h,
                "Review and Delete",
                true,
                &[&item("review", "Review Deletions   R")?, &item("delete", "Delete from Photos…   ↵ in Review")?, &item("undo", "Undo   B")?, &P::separator(h)?, &item("openphotos", "Open Photos")?],
            )?,
            &Submenu::with_items(h, "Window", true, &[&P::minimize(h, None)?, &P::close_window(h, None)?])?,
            &Submenu::with_items(h, "Help", true, &[&item("menu", "Menu   M")?, &item("keys", "Keyboard Shortcuts   ?")?])?,
        ],
    )
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::rc::Retained;
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSSharingServicePicker, NSView};
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL};

    /// NSSharingServicePicker for one file, shown at (x, y) in the page.
    pub fn share(view: *mut std::ffi::c_void, path: &std::path::Path, x: f64, y: f64) {
        // AppKit: on the main thread only
        if MainThreadMarker::new().is_none() {
            return;
        }
        if view.is_null() {
            return;
        }
        let view: &NSView = unsafe { &*(view as *const NSView) };
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let items: Retained<NSArray<NSURL>> = NSArray::from_retained_slice(&[url]);
        let items: &NSArray = unsafe { &*(Retained::as_ptr(&items) as *const NSArray) };
        let picker = unsafe { NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), items) };
        // the page's y runs down; the window's content view's runs up
        let h = view.bounds().size.height;
        let vy = if view.isFlipped() { y } else { h - y };
        let rect = NSRect::new(NSPoint::new(x - 1.0, vy - 1.0), NSSize::new(2.0, 2.0));
        picker.showRelativeToRect_ofView_preferredEdge(rect, view, NSRectEdge::MinY);
        // AppKit shows it from here on; keep it alive until it's dismissed
        std::mem::forget(picker);
    }
}
