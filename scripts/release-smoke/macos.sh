#!/usr/bin/env bash
set -euo pipefail

packages=${1:?package directory is required}
expected=${2:?expected version is required}
work=$(mktemp -d)
pid=

cleanup() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    osascript -e 'tell application id "com.midhunkumare.canopy" to quit' 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

dmg=$(find "$packages" -maxdepth 1 -type f -name '*.dmg' -print -quit)
archive=$(find "$packages" -maxdepth 1 -type f -name '*.app.tar.gz' -print -quit)
test -n "$dmg" && test -n "$archive"
hdiutil verify "$dmg"
tar -xzf "$archive" -C "$work"
app=$(find "$work" -maxdepth 1 -type d -name '*.app' -print -quit)
test -n "$app"
codesign --verify --deep --strict --verbose=2 "$app"
version=$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")
test "$version" = "$expected"
"$app/Contents/MacOS/canopy-backend" --version | grep -F "canopy-backend $expected"
open -n -W "$app" >"$work/canopy.log" 2>&1 &
pid=$!
sleep 8
if ! kill -0 "$pid" 2>/dev/null; then
  wait "$pid" || status=$?
  cat "$work/canopy.log" >&2
  echo "Canopy exited during LaunchServices probe with ${status:-0}" >&2
  exit 1
fi
