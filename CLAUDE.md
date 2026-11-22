# Uncapture — notes for working on this repo

Uncapture cleans up the Apple Photos library on a Mac: photos taken close
together are shown as clusters; you keep the best and it deletes the rest
from Photos. A Rust server (`src-tauri/`) serves a plain HTML/CSS/JS UI
(`web/`, embedded into the binary) on 127.0.0.1, in a Tauri window. It
follows Brackit's design, keyboard model, speed rules and tests. See
README.md.

## Build and test

```bash
npm run test:rust      # Rust unit tests (clustering, filters, marks)
npm run build:cli      # terminal-only binary used by the tests
npm test               # server tests against FakeSource
npm run test:ui        # flip speed, WebKit, keys, review/delete (headless)
npm run demo           # a made-up library in build/demo, served in a browser
npm run app            # the Mac app (macOS only)
npm run dist           # the .app, then the .dmg via scripts/make-dmg.sh (macOS, needs create-dmg)
```

The .dmg's background (`src-tauri/dmg/background.svg`, rendered to
`background.png` and `@2x`) shows the first-run steps; icon positions in it
must match `scripts/make-dmg.sh`. Its "Privacy & Security" item is a symlink to
`/System/Library/PreferencePanes/Security.prefPane` (a `.webloc` with a
settings URL didn't open).

Re-clustering speed (100,000 assets under 100 ms) is asserted only in a
release build: `cargo test --release --no-default-features`.

## Where the photos come from: `PhotoSource`

- `src-tauri/src/source.rs`: the trait and `Asset`. Everything above it (the
  server, clustering, the page) is tested without a Photos library.
- `fake.rs`: `FakeSource`, a folder of JPEGs (`--fake FOLDER`). Times from
  EXIF; `fake.json` adds favorites, bursts, hidden, shared, auth state;
  deleting moves files to `.trash/`; a `.cancel-delete` file makes the
  "system confirmation" cancel. It resizes to the asked size, as PhotoKit
  does, so the flip test measures the real pipeline.
- `photokit.rs`: `PhotoKitSource`, macOS only, through `objc2-photos`. Image
  requests are synchronous on the request's own thread; authorization,
  delete and video export wait on a channel. **PhotoKit only**: never read
  or write `Photos Library.photoslibrary`.
- It can't be built on Linux, but it can be type-checked:
  `cargo check --target aarch64-apple-darwin` (for the full app, Tauri's
  Objective-C helper needs a stub compiler: see the end of TESTING.md). CI
  builds it on macOS.

## Flipping must stay instant: 50 ms budget

Same rule and same machinery as Brackit: a key press visibly changes the
screen within 50 ms, warm, cold and with the key held, in the grid (up to 12
photos) and in the large view.

- `test/ui/flip-speed.test.js` enforces it with the Event Timing API. Run
  `npm run test:ui` before pushing changes to rendering, image loading,
  layout, keys or viewer CSS. Fix the regression; don't raise the budget.
- How: renders coalesce to one per frame; the cluster on screen never waits
  for a download (thumbnails, fetched in batches and decoded ahead, a few
  clusters now and the rest in idle time); display-size copies are made in
  idle time; nothing heavy in the keydown path.
- **No CSS filters on pictures** (not even a 0.5 px blur on placeholders):
  in software rendering a filter on a big picture costs a flip its budget.
- **Pictures go on screen decoded**: anything put in a frame passes
  `onScreen()` (sync decoding in WebKit only). `test/ui/webkit.test.js`.

## Rules the code relies on

- **The API answers only its own page.** A key made at each launch
  (`App.key`) is in the window's URL (`?key=`, and in the link `--serve`
  prints); `/` sets it as an HttpOnly, SameSite=Strict cookie and the page
  strips it from the address. Every `/api` request needs that cookie (or
  `X-Uncapture-Key`, as the tests send) or gets 401; a cross-site
  `Sec-Fetch-Site`, a foreign `Origin` or `Host` is refused; every non-GET
  sends `X-Uncapture: 1` (the `api()` helper does). The page has a strict
  CSP (no inline scripts, nothing from elsewhere) and the window refuses to
  navigate off 127.0.0.1:port. `/api/window` takes only fullscreen/state.
  Keep all of it for any new endpoint. Tests: `pageUrl(base)` and
  `keyed(base)` in `test/ui/helpers.js`.
- **Nothing from Photos goes into a header or a path unchecked**: download
  names through `attachment()`, `header()` never panics (a panic aborts the
  app), export names lose `/ \ :`, control characters and leading dots.
- **Ids are stable**: `short_id` is a hash of the `localIdentifier`. Marks
  are saved by `localIdentifier` in
  `~/Library/Application Support/Uncapture/state.json`.
- **The keep/delete rule lives twice**, in `cluster::to_delete` (Rust,
  unit-tested, authoritative) and `delOf` in `web/app.js` (for instant UI).
  Change both together.
- **Deleting only from Review, in one batch.** The server re-derives what's
  marked and deletes only what is both requested and marked; PhotoKit
  re-fetches by `localIdentifier` first, so what's gone is skipped.
- **Undo of the last delete** (`B`, ⌘Z): PhotoKit can't recover from
  Recently Deleted, so `/api/delete` first has the source `keep_copy` each
  photo (every addable resource, written with `write_resource`; date,
  place, heart, hidden, regular albums) into `undo-new/<id>/`, up to
  `UNDO_BYTES`; once the delete happens that becomes `undo/` with
  `batch.json` (else it's dropped, and the old undo stays). `/api/undo`
  calls `restore` (PHAssetCreationRequest: all the resources if
  `supportsAssetResourceTypes` takes them, else the originals, else the
  rendered version as the original), marks what came back to keep, and
  takes it off `deletions` and `dailyLog`. Nothing unchecked goes to
  `addResourceWithType` or `addAssets`: an Objective-C exception aborts.
- `S` writes the favorite to Photos at once (`/api/favorite`); it isn't a
  mark. Daily cleanup's log (`dailyLog` in state.json, by "MM-DD") is
  written by `/api/delete` when the page sends the day it's cleaning up.
- Every delete is logged with its size (`deletions` in state.json, sizes
  measured before deleting: PhotoKit's file sizes where it gives them, else
  estimates), for the start screen's "Cleared so far".
- Display-size images are local first; when the Mac's rendition is much
  smaller than asked (Optimize Mac Storage), PhotoKitSource asks again with
  iCloud allowed, at that size. The grid shows the sharpest picture the
  page has for a photo (`sharpestLoaded`: its own, the large view's, the
  original), and closing the large view rebuilds the grid. Daily cleanup asks for sharp copies of the day (`/api/sharp`,
  up to 300): downloaded with `download()` in the background, kept in
  `Application Support/Uncapture/sharp-v2`, served by `/api/img` resized; the
  page swaps them in place (`sharpened`).
- Share (`E`) and drag out: `/api/share` and `/api/drag` write the photo's
  own file (`export_original`: the edited version, its original name) into
  `Application Support/Uncapture/share/<id>/`, then ask the window
  (`gui.rs`): NSSharingServicePicker, or a native drag via the `drag` crate,
  on the main thread. No window (a browser): Share downloads
  `/api/original/<id>`; drag says it's the Mac app's.
- The page always sends `videosOnly`/`screenshotsOnly` (and the other
  filters) explicitly: a left-out parameter falls back to the saved setting.
- Locations: `Asset.location` (PhotoKit's `location`, EXIF GPS in the fake
  library) goes to the page with the assets. Place names: `/api/place`,
  rounded to 2 decimals, kept in `places.json`; PhotoKitSource asks
  CLGeocoder (deprecated in the newest SDK, kept for macOS 11). Never in the
  key press: the page queues them. Always shown: in a cluster with a
  geotag, captions are two lines (`capOf` in app.js, `L.cap`) and the grid
  is laid out for that.
- **Which way up.** `jpeg_of` in photokit.rs makes every picture the shape
  Photos gives the asset (`pixelWidth`/`pixelHeight`): an NSImage's CGImage
  can be the sensor's pixels with the turn kept aside, so a sideways one is
  drawn by AppKit (when the NSImage's size is the upright one) or turned a
  quarter clockwise. The page trusts that: frames keep Photos' shape (no
  more guessing from the thumbnail), pictures are fitted whole
  (`object-fit: contain`), display copies keep the picture's shape
  (`fitIn`). Never crop.
- **Turns** (`[` `]`): `turns` in state.json by localIdentifier, `/api/turns`;
  `turnsOf(id)` in app.js. A turned box has the turned shape (`aspectOf`);
  the upright picture is rotated into it by a transform (`turnBox`, `.t1`–
  `.t3`; the large view and zoom set it inline). Display copies are made
  upright (`plan()`'s `cw`/`ch`). Photos isn't changed.
- **Loupe** (`` ` ``, Brackit's): `LP` and `drawLoupe` in app.js; reads the
  original (`fullUrl`, last two kept) and maps the mouse through the turn.
- Marks are saved debounced; anything that reads them from the server
  (Review, delete) calls `flushMarks()` first.

## Layout

- `src-tauri/src/`: `server.rs` (HTTP API), `cluster.rs` (clusters,
  filters, the rule), `source.rs`, `fake.rs`, `exif.rs`, `photokit.rs`,
  `gui.rs` (window + Mac menu bar), `main.rs`.
- `web/`: `app.js` (everything), `index.html`, `style.css`, `icon.svg`.
- `test/`: `server.test.js`, `fixture.js` (EXIF JPEGs), `ui/*.test.js`.

## Conventions

- The photos are the content: minimal chrome, one accent colour (amber =
  keep), Tufte-style data displays (labels on the data, hairlines, no chart
  junk). Brackit's CSS tokens.
- Every action has a key, an entry in the page's Menu (`MENU` in
  `web/app.js`) and in the Mac menu bar (`gui.rs`). `keys.test.js` checks
  the two menus match.
- Plain, non-marketing copy. README in the first person.
- Commit and push before testing.
