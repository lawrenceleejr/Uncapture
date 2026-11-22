# Changes

## 0.1.0 (not released yet)

The first version, not yet tried against a real Photos library: see
TESTING.md.

- Clusters of photos taken close together, with a window from 5 s to 30 min
  (`[` `]`); a burst always stays in one cluster.
- Photos and videos stored sideways (iPhone portrait shots) show upright;
  coming back from the large view no longer leaves cropped photos.
- The loupe from Brackit (`` ` ``) magnifies the original under the mouse.
- Clusters only (`C`), daily cleanup on this day in earlier years (`T`), and
  a date range dragged on the chart of photos per month.
- Daily cleanup's calendar: any day of the year, shaded by how recently it
  was cleaned up, with every past cleanup of the chosen day and how many
  photos went.
- The space cleared: large after each delete, and in all on the start screen
  (with a sparkline of it growing).
- After a delete you're back exactly where you were, for the next batch. The
  timeline swells under the mouse, as in Brackit. Marked photos and videos
  are dimmed and struck through with one level line.
- Screenshots only (`P`). Share a photo (`E`, the system share sheet) or drag
  it out of the window as a file.
- Videos only (`V`); where each photo was taken, under it, whenever it has a
  geotag, with place names from Apple's geocoder; the date and time in every
  caption.
- Daily cleanup fetches sharp copies of the day's photos from iCloud (up to
  300), so they aren't blurry with Optimize Mac Storage.
- `j` / `k` step through photos one at a time, across clusters; `D` marks
  one for deletion; `S` hearts it in Photos.
- Keep with `1`–`9` (or `Tab` and `↵`); the rest of a cluster with a keeper
  is marked for deletion. Favorites are protected unless marked with `D`.
- The large view (`Space`), with actual pixels (`Z`) downloaded from iCloud
  if needed.
- Review (`R`) and delete from Photos in one batch, after macOS's
  confirmation.
- Every action has a key, an entry in the Menu (`M`) and in the Mac menu
  bar; `?` lists them all.
- Undo the last delete (`B` or ⌘Z): Uncapture keeps a copy of each photo
  before deleting it (files, edits, Live Photo video, date, place, heart,
  albums) and adds them back to Photos, marked to keep. Until the next
  delete or for a week, up to 4 GB.
- Security: the server answers only the app's own window, with a key made at
  each launch (other programs on the Mac and web pages get nothing, not even
  reads); requests from other sites are refused; the page runs only its own
  scripts (a Content Security Policy) and the window can't be navigated away.
  A photo whose original name isn't plain ASCII no longer crashes Share or
  drag, and names from Photos can't point outside the share folder. Shared
  files are cleared at each launch; sharp copies are capped at 1 GB.
