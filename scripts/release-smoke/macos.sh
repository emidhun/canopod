#!/usr/bin/env bash
set -euo pipefail

packages=${1:?package directory is required}
expected=${2:?expected version is required}
work=$(mktemp -d)
pid=
mcp_pid=

cleanup() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    osascript -e 'tell application id "com.midhunkumare.canopy" to quit' 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  if [[ -n "$mcp_pid" ]] && kill -0 "$mcp_pid" 2>/dev/null; then
    kill "$mcp_pid" 2>/dev/null || true
    wait "$mcp_pid" 2>/dev/null || true
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
backend="$app/Contents/MacOS/canopy-backend"
mkdir -p "$work/mcp-config" "$work/mcp-data" "$work/mcp-logs" "$work/mcp-fixture"
git -C "$work/mcp-fixture" init -b main
common=(--config-dir "$work/mcp-config" --data-dir "$work/mcp-data" --log-dir "$work/mcp-logs")
"$backend" serve --port 47991 "${common[@]}" >"$work/mcp-backend.log" 2>&1 &
mcp_pid=$!
for _ in {1..100}; do
  "$backend" status "${common[@]}" >/dev/null 2>&1 && break
  sleep .1
done
"$backend" status "${common[@]}" >/dev/null
"$backend" repo add "$work/mcp-fixture" "${common[@]}" >/dev/null
"$backend" mcp enable --repo mcp-fixture --read-only "${common[@]}" >/dev/null
"$backend" mcp smoke --repo mcp-fixture "${common[@]}" | tee "$work/mcp-smoke.json"
"$backend" stop "${common[@]}" >/dev/null
wait "$mcp_pid"
mcp_pid=
open -n -W "$app" >"$work/canopy.log" 2>&1 &
pid=$!
sleep 8
if ! kill -0 "$pid" 2>/dev/null; then
  wait "$pid" || status=$?
  cat "$work/canopy.log" >&2
  echo "Canopy exited during LaunchServices probe with ${status:-0}" >&2
  exit 1
fi
