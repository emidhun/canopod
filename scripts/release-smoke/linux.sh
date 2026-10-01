#!/usr/bin/env bash
set -euo pipefail

kind=${1:?package kind is required}
packages=${2:?package directory is required}
expected=${3:?expected version is required}
work=$(mktemp -d)
pid=
display_pid=

cleanup() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  if [[ -n "$display_pid" ]] && kill -0 "$display_pid" 2>/dev/null; then
    kill "$display_pid" 2>/dev/null || true
    wait "$display_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

case "$kind" in
  deb)
    package=$(find "$packages" -maxdepth 1 -type f -name '*.deb' -print -quit)
    sudo apt-get update
    sudo apt-get install -y "$package" xvfb
    app=$(command -v canopy)
    backend=$(command -v canopy-backend)
    ;;
  rpm)
    package=$(find "$packages" -maxdepth 1 -type f -name '*.rpm' -print -quit)
    dnf install -y "$package" xorg-x11-server-Xvfb
    app=$(command -v canopy)
    backend=$(command -v canopy-backend)
    ;;
  appimage)
    package=$(find "$packages" -maxdepth 1 -type f -name '*.AppImage' -print -quit)
    sudo apt-get update
    sudo apt-get install -y xvfb libwebkit2gtk-4.1-0
    chmod +x "$package"
    (cd "$work" && "$package" --appimage-extract >/dev/null)
    app=$(find "$work/squashfs-root" -type f -path '*/bin/canopy' -print -quit)
    backend=$(find "$work/squashfs-root" -type f -name 'canopy-backend' -print -quit)
    test -n "$app" && test -n "$backend"
    ;;
  *)
    echo "unsupported package kind: $kind" >&2
    exit 2
    ;;
esac

test -n "$app" && test -n "$backend"
"$backend" --version | grep -F "canopy-backend $expected"
Xvfb :99 -screen 0 1280x800x24 >"$work/xvfb.log" 2>&1 &
display_pid=$!
sleep 2
DISPLAY=:99 "$app" >"$work/canopy.log" 2>&1 &
pid=$!
sleep 8
if ! kill -0 "$pid" 2>/dev/null; then
  wait "$pid" || status=$?
  cat "$work/canopy.log" >&2
  echo "Canopy exited during launch probe with ${status:-0}" >&2
  exit 1
fi
