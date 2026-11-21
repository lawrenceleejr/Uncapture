# Uncapture

I made Uncapture for me. My Photos library is full of near-duplicates: five
tries at the same picture, a burst I never looked at, eight screenshots of
the same thing. They fill my iCloud storage, and Photos makes them slow to
clear out one by one.

Uncapture shows the photos I took close together side by side, one group at
a time. I keep the best one with a key press, and the rest of the group is
marked for deletion. When I'm done, I look over everything that will go, and
Uncapture deletes it from Photos in one batch.

It's a small Mac app. It runs only on my Mac, has no account and uploads
nothing.

## How it works

- **Clusters.** Photos taken within a minute of each other are one cluster.
  The window goes from 5 seconds to 30 minutes (`[` and `]`). A burst always
  stays in one cluster.
- **Clusters only** (on by default, `C`) hides photos that have no others
  near them, so I only see what needs a decision.
- **Daily cleanup** (`D`) shows only photos taken on today's date in earlier
  years. It's a two-minute habit. Photos from 29 February show on
  28 February in other years.
- **Dates.** On the start screen I drag across the chart of photos per month
  to pick a range, or use `←` `→`.

In the viewer:

| Key | |
|---|---|
| `←` `→` `↑` `↓` `j` `k` | previous / next cluster (`⇧` jumps ten) |
| `1`–`9` | keep that photo |
| `Tab`, `↵` | move through the cluster, keep the focused photo |
| `A`, `0` | keep all, clear the cluster |
| `X` | mark one photo for deletion (also how to delete a favorite) |
| `Space` | the photo large; `Z` actual pixels |
| `R` | review everything marked |
| `M`, `?` | every action, every key |

The rule is the same as Brackit's picks. A cluster with no keeper is left
alone. Once a cluster has a keeper, its other photos are marked: dimmed,
with a thin diagonal line. Favorites (♥) are never marked automatically.

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

Uncapture leaves out hidden photos. It's meant to leave out iCloud Shared
Library photos too, since deleting one removes it for everyone, but
PhotoKit has no public way to tell them apart. So for now I don't use it on
a library with a Shared Library (see TESTING.md). If a photo is already gone
by the time I delete, because I deleted it on my phone, it's skipped and
reported.

## Install

Download the `.dmg` for Apple Silicon or Intel from
[Releases](https://github.com/lawrenceleejr/uncapture/releases), and drag
Uncapture to Applications. The app isn't signed with an Apple Developer
ID, so the first time, right-click it and choose **Open**.

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
