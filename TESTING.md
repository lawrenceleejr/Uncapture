# Testing on the Mac

Everything above PhotoKit is tested automatically on Linux against a folder
of JPEGs (see README). What follows needs a Mac with a real Photos library.
Use a **test album of throwaway photos** for anything that deletes.

The PhotoKit code is type-checked against the real macOS bindings and built
by CI on macOS, but it hasn't run against a library yet. Go through the
first section before relying on it.

## 1. First run (the plan's Milestone 0)

Build from source (`npm ci && npm run app`) or open the `.dmg` from CI.

- [ ] **The .dmg window** shows the three steps on its background, Uncapture
      and the Applications link side by side, and the "Open Privacy &
      Security" shortcut below, all labels readable and nothing cut off.
- [ ] **Blocked, then allowed.** After dragging to Applications, opening
      Uncapture is blocked. The shortcut opens System Settings at Privacy &
      Security, where "Open Anyway" is listed for Uncapture. If the shortcut
      opens the wrong page (or nothing), note the macOS version: ______

- [ ] **Permission prompt.** The first screen says Uncapture needs to see
      the library. `↵` shows macOS's prompt, with the text "Uncapture shows
      your photos in groups…". Allow: the start screen appears with the
      chart of photos per month.
- [ ] **Metadata fetch speed.** The terminal (`npm run app`) prints
      `read N photos and videos in M ms`; `/api/state` shows
      `library.fetchMs`. The plan's target is under 2 s for 100,000 on an
      M1. Write down N and M: ______
- [ ] **Newest photos.** In the viewer, `End` shows the newest cluster. Its
      times match Photos (Info, `⌘I`).
- [ ] **Thumbnails** show at once; sharper pictures follow. With "Optimize
      Mac Storage" on, nothing should download while flipping.
- [ ] **Large view and actual pixels.** `Space`, then `Z` on a photo that's
      only in iCloud: the hairline at the top and "Downloading the original
      from iCloud · N%" move, then the full picture shows.
- [ ] **Video.** A cluster with a video: `Space` plays it.
- [ ] **Delete three.** In the test album's dates, keep one photo of a
      cluster of four (`1`), `R`, `↵`. The first time, the short
      explanation shows; `↵` again. macOS asks to confirm deleting 3. Allow:
      "Deleted 3. They're in Recently Deleted…". The three are in Recently
      Deleted in Photos.
- [ ] **Cancel.** Do it again and choose Don't Allow in macOS's dialog:
      "Nothing was deleted: the confirmation was cancelled."
- [ ] **Library changes.** Delete a photo in Photos while Uncapture is open,
      come back to Uncapture: it's gone from the cluster (within ~10 s).
- [ ] **Burst.** A burst shows all its frames in one cluster, even at 5 s.
- [ ] **Favorites.** In a cluster with a ♥ photo, keep another: the favorite
      isn't dimmed. `X` on it marks it, with a warning.
- [ ] **Sharp copies for a day.** With "Optimize Mac Storage" on, open a
      day in daily cleanup (`T`, `↵`). The footer counts "sharper copies
      from iCloud: N of M"; photos that were blurry turn sharp as they
      arrive, without flicker. Reopening the day is sharp at once.
- [ ] **Locations.** `G` on a cluster taken somewhere known: the line under
      each photo names the place and its coordinates (the name can take a
      second to arrive); photos without a geotag have an empty line. In
      `npm start`/`--serve` mode only the coordinates show (Apple's geocoder
      answers on the app window's main thread).
- [ ] **Videos only.** `V` shows every video, singles too; `Space` plays one.
- [ ] **Hearts.** `S` on a photo: it's a favorite in Photos at once (♥ in
      Photos too). Note whether macOS asks to allow the change: ______
      `S` again takes it off.
- [ ] **Daily cleanup log.** With daily cleanup on (`T`), keep one photo of
      a cluster, Review, delete. Back on the start screen, today's day in the
      calendar is filled in and lists today's date with the count.
- [ ] **Sizes.** Review says "about N MB". If it's far from what Photos
      shows (Info), the undocumented `fileSize` key isn't there and it's
      estimating from pixels.

## 2. Denied, and updates

- [ ] In System Settings → Privacy & Security → Photos, turn Uncapture off.
      Uncapture's first screen says it isn't allowed, with "Open Privacy
      Settings" (`↵`), which opens that page. Turn it back on and return:
      the start screen comes back by itself.
- [ ] **Re-prompt after an update.** Install a newer build over the old
      one. Expected (ad-hoc signing): macOS asks for Photos access again.
      Record what actually happens: ______

## 3. Things to find out

- [ ] **iCloud Shared Library.** PhotoKit has no public flag for it, so
      Uncapture can't tell those photos apart yet (they're excluded only in
      the fake library). With a Shared Library, check whether its photos
      appear, and whether deleting one would remove it for everyone. Until
      then, don't use Uncapture on a library with a Shared Library.
- [ ] **Hidden photos** don't appear (they're never fetched).
- [ ] **Time zones.** PhotoKit doesn't say which zone a photo was taken in,
      so times show in the Mac's zone. Clustering uses absolute time, so a
      trip abroad clusters correctly; only the clock shown (and which day
      counts as "on this day") follows the Mac's zone.

## 4. The rest of the app

- [ ] The Mac menu bar has Flip and Keep, Look Closely, Clusters and
      Filters, Review and Delete; each item does what its key does.
- [ ] `F` and the green button both go full screen; the bar and footer
      appear when the mouse is near the top or bottom.
- [ ] Flipping feels instant on a 9-photo cluster, and with `→` held down.

## Type-checking the Mac code on Linux

`cargo check --no-default-features --target aarch64-apple-darwin` checks
the PhotoKit code (`rustup target add aarch64-apple-darwin`). For the full
app, Tauri's dependencies compile a small Objective-C file; `cargo check`
never links, so a stub compiler that writes an empty object file is enough:
point `CC_aarch64_apple_darwin` at a script that creates the file after `-o`
or `-Fo`, and set `AR_aarch64_apple_darwin=ar`.
