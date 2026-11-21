# Uncapture

I made Uncapture for me. My Photos library is full of near-duplicates: five
tries at the same picture, a burst I never looked at, eight screenshots of
the same thing. They fill my iCloud storage, and Photos makes them slow to
clear out one by one.

Uncapture shows the photos I took close together side by side, one group at
a time. I keep the best one with a key press, and the rest of the group is
marked for deletion. When I'm done, I look over everything that will go, and
Uncapture deletes it from Photos in one batch.

It's a small Mac app. It runs only on my Mac and has no account. The only
thing that ever leaves the Mac is a geotagged photo's coordinates, rounded to
about a kilometre: Apple's geocoder turns them into a place name, as Photos
does.

## How it works

- **Clusters.** Photos taken within a minute of each other are one cluster.
  The window goes from 5 seconds to 30 minutes (`[` and `]`). A burst always
  stays in one cluster.
- **Clusters only** (on by default, `C`) hides photos that have no others
  near them, so I only see what needs a decision.
- **Daily cleanup** (`T`) shows only photos taken on one day of the year in
  earlier years: today, unless I pick another day in its calendar. It's a
  two-minute habit. The calendar shades each day by how recently I cleaned
  it up, and lists every time I deleted photos of that day. Photos from
  29 February show on 28 February in other years.
- **Screenshots only** (`P`) shows every screenshot the same way; they
  cluster well, and they're the easiest to let go.
- **Videos only** (`V`) shows every video, grouped the same way, alone or
  not.
- **Locations.** In a cluster with geotags, a second line under each photo
  gives the place and the coordinates.
- **Dates.** On the start screen I drag across the chart of photos per month
  to pick a range, or use `←` `→`.

In the viewer:

| Key | |
|---|---|
| `←` `→` `↑` `↓` | previous / next cluster (`⇧` jumps ten) |
| `j` `k` | next / previous photo, on into the next cluster |
| `1`–`9` | keep that photo |
| `Tab`, `↵` | move through the cluster, keep the focused photo |
| `A`, `0` | keep all, clear the cluster |
| `D` (or `X`) | mark the photo for deletion (also how to delete a favorite) |
| `S` | heart it in Photos (or take the heart off) |
| `E` | share it: the Mac's share sheet (Messages, Mail, AirDrop…) |

When I come across a memory worth sending, `E` shares it, or I drag the photo
out of the window into Messages or a folder. Either way it's the photo's own
file from Photos, with my edits.
| `Space` | the photo large; `Z` actual pixels |
| `R` | review everything marked |
| `M`, `?` | every action, every key |

The rule is the same as Brackit's picks. A cluster with no keeper is left
alone. Once a cluster has a keeper, its other photos are marked: dimmed and
struck through with one level line, photos and videos alike. Favorites (♥)
are never marked automatically. So I can also flip through with `j`, press
`D` on what should go and `S` on what I love.

## Deleting

Nothing is deleted from the viewer. Deleting happens only from Review (`R`),
in one batch, after macOS's own confirmation. macOS also decides what
happens next:

- macOS asks to confirm every delete. One batch is one question.
- Deleted photos go to **Recently Deleted** in Photos for 30 days. No app can
  empty it. The iCloud space comes back after 30 days, or straight away if I
  empty Recently Deleted in Photos.
- Deletions sync to every device on my iCloud account.
- Live Photos and RAW+JPEG pairs go as a whole, with their edits.

After each delete Uncapture says how much space it cleared, and the start
screen keeps the running total: how much in all, how many photos, since
when, with a small line of it growing.

Uncapture leaves out hidden photos. It's meant to leave out iCloud Shared
Library photos too, since deleting one removes it for everyone, but
PhotoKit has no public way to tell them apart. So for now I don't use it on
a library with a Shared Library (see TESTING.md). If a photo is already gone
by the time I delete, because I deleted it on my phone, it's skipped and
reported.

## Install

Download the `.dmg` for Apple Silicon or Intel from
[Releases](https://github.com/lawrenceleejr/uncapture/releases). Its window
shows the three steps:

1. Drag Uncapture to Applications.
2. Open it. The app isn't signed with an Apple Developer ID, so the first
   time macOS blocks it; click Done.
3. Open the **Privacy & Security** link in the same window (or System
   Settings → Privacy & Security), click **Open Anyway** next to Uncapture
   (near the bottom, under Security), and confirm. That's needed once per
   version.

Uncapture asks for access to Photos when I press the button on its first
screen. **macOS asks again after each update**: the permission belongs to the
app's signature, and each build has a new one.

## Build it

```bash
npm ci
npm run build:cli      # the terminal-only binary (any OS)
npm run app            # the Mac app, from source (macOS)
npm run dist           # the .app and .dmg (macOS)
```

To try it without touching Photos, on any computer:

```bash
npm run demo           # made-up photos in build/demo, opened in the browser
uncapture --serve --fake ~/some/folder/of/jpegs
```

With `--fake`, a folder of JPEGs stands in for the library: deleting moves
files to a `.trash` folder inside it.

## Tests

```bash
npm run test:rust      # clustering, filters, marks, re-clustering speed
npm run build:cli && npm test       # the server, against a fake library
npm run test:ui        # flip speed (50 ms), WebKit, every key, review and delete
```

What only a Mac with a Photos library can check is in [TESTING.md](TESTING.md).

## How it's built

It's built the way Brackit is: a small Rust server on 127.0.0.1 serves a
plain HTML/CSS/JS page, shown in a Tauri window. The Photos library is read
only through PhotoKit, never by opening the library files. Notes for working
on it are in [CLAUDE.md](CLAUDE.md).
