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
```

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

- **The API only takes changes from its own page.** Every non-GET request
  sends `X-Uncapture: 1` (the `api()` helper does); a foreign `Origin` or
  `Host` is refused. Keep it that way for any new endpoint.
- **Ids are stable**: `short_id` is a hash of the `localIdentifier`. Marks
  are saved by `localIdentifier` in
  `~/Library/Application Support/Uncapture/state.json`.
- **The keep/delete rule lives twice**, in `cluster::to_delete` (Rust,
  unit-tested, authoritative) and `delOf` in `web/app.js` (for instant UI).
  Change both together.
- **Deleting only from Review, in one batch.** The server re-derives what's
  marked and deletes only what is both requested and marked; PhotoKit
  re-fetches by `localIdentifier` first, so what's gone is skipped.
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
