#!/usr/bin/env bash
set -euo pipefail

kind=${1:?package kind is required}
packages=${2:?package directory is required}
packages=$(cd "$packages" && pwd)
expected=${3:?expected version is required}
work=$(mktemp -d)
pid=
display_pid=
mcp_pid=

cleanup() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  if [[ -n "$display_pid" ]] && kill -0 "$display_pid" 2>/dev/null; then
    kill "$display_pid" 2>/dev/null || true
    wait "$display_pid" 2>/dev/null || true
  fi
  if [[ -n "$mcp_pid" ]] && kill -0 "$mcp_pid" 2>/dev/null; then
    kill "$mcp_pid" 2>/dev/null || true
    wait "$mcp_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

case "$kind" in
  deb)
    package=$(find "$packages" -maxdepth 1 -type f -name '*.deb' -print -quit)
    sudo apt-get update
    sudo apt-get install -y "$package" xvfb git
    app=$(command -v canopod)
    backend=$(command -v canopod-backend)
    ;;
  rpm)
    package=$(find "$packages" -maxdepth 1 -type f -name '*.rpm' -print -quit)
    dnf install -y "$package" xorg-x11-server-Xvfb git
    app=$(command -v canopod)
    backend=$(command -v canopod-backend)
    ;;
  appimage)
    package=$(find "$packages" -maxdepth 1 -type f -name '*.AppImage' -print -quit)
    sudo apt-get update
    sudo apt-get install -y xvfb libwebkit2gtk-4.1-0 git
    chmod +x "$package"
    (cd "$work" && "$package" --appimage-extract >/dev/null)
    app=$(find "$work/squashfs-root" -type f -path '*/bin/canopod' -print -quit)
    backend=$(find "$work/squashfs-root" -type f -name 'canopod-backend' -print -quit)
    test -n "$app" && test -n "$backend"
    ;;
  *)
    echo "unsupported package kind: $kind" >&2
    exit 2
    ;;
esac

test -n "$app" && test -n "$backend"
"$backend" --version | grep -F "canopod-backend $expected"
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
Xvfb :99 -screen 0 1280x800x24 >"$work/xvfb.log" 2>&1 &
display_pid=$!
sleep 2
if [[ $EUID -eq 0 ]]; then
  # Fedora package smoke runs in a root-owned container; launch WebKit as an
  # unprivileged user rather than disabling its sandbox.
  mkdir -p "$work/gui-home"
  chmod 755 "$work"
  chmod 777 "$work/gui-home"
  runuser -u nobody -- env HOME="$work/gui-home" DISPLAY=:99 "$app" >"$work/canopod.log" 2>&1 &
else
  DISPLAY=:99 "$app" >"$work/canopod.log" 2>&1 &
fi
pid=$!
sleep 8
if ! kill -0 "$pid" 2>/dev/null; then
  wait "$pid" || status=$?
  cat "$work/canopod.log" >&2
  echo "Canopod exited during launch probe with ${status:-0}" >&2
  exit 1
fi
