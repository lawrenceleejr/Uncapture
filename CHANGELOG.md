# Changes

## 0.1.0 (not released yet)

The first version, not yet tried against a real Photos library: see
TESTING.md.

- Clusters of photos taken close together, with a window from 5 s to 30 min
  (`[` `]`); a burst always stays in one cluster.
- Clusters only (`C`), daily cleanup on this day in earlier years (`T`), and
  a date range dragged on the chart of photos per month.
- Daily cleanup's calendar: any day of the year, shaded by how recently it
  was cleaned up, with every past cleanup of the chosen day and how many
  photos went.
- The space cleared: large after each delete, and in all on the start screen
  (with a sparkline of it growing).
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
