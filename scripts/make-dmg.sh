#!/bin/bash
# The .dmg, with a background that walks through the first run (drag to
# Applications, open, then Open Anyway in Privacy & Security) and a shortcut
# to that settings page. Tauri's own .dmg can't hold the extra shortcut, so
# this uses create-dmg (brew install create-dmg) on the .app Tauri built.
#
#   scripts/make-dmg.sh [target] [out.dmg]     (macOS only)
#   e.g. scripts/make-dmg.sh aarch64-apple-darwin dist/Uncapture.dmg
set -euo pipefail
cd "$(dirname "$0")/.."
target="${1:-}"
out="${2:-dist/Uncapture.dmg}"
bundle="src-tauri/target/${target:+$target/}release/bundle"
app="$bundle/macos/Uncapture.app"
[ -d "$app" ] || { echo "no $app: run 'npx tauri build --bundles app${target:+ --target $target}' first" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/src"
cp -R "$app" "$work/src/"
# one background for normal and Retina screens
tiffutil -cathidpicheck src-tauri/dmg/background.png src-tauri/dmg/background@2x.png -out "$work/background.tiff"

mkdir -p "$(dirname "$out")"
rm -f "$out"
create-dmg \
  --volname "Uncapture" \
  --volicon src-tauri/icons/icon.icns \
  --background "$work/background.tiff" \
  --window-pos 200 120 \
  --window-size 660 540 \
  --icon-size 96 \
  --text-size 12 \
  --icon "Uncapture.app" 180 170 \
  --hide-extension "Uncapture.app" \
  --app-drop-link 480 170 \
  --add-file "Open Privacy & Security.webloc" src-tauri/dmg/settings.webloc 330 430 \
  --hide-extension "Open Privacy & Security.webloc" \
  "$out" "$work/src"
echo "  $out"
