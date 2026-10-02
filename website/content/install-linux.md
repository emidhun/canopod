---
title: Install on Linux
description: The .deb, .rpm and AppImage, the system packages they need, and why the tray behaves differently here.
---

# Install on Linux

As with the Windows build, the Linux packages compile and ship but have not been validated on a
desktop.
Every release builds `.deb`, `.rpm` and `.AppImage` on an `ubuntu-latest` runner, and there's a CI job
whose whole purpose is compiling the `cfg(not(macos))` paths: the tray fallback, `xdg-open`, terminal
detection.

## System dependencies

Tauri 2 apps need WebKitGTK and a tray backend. On Debian and Ubuntu these are the packages the
release workflow installs for itself:

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

On Fedora the equivalents are `webkit2gtk4.1`, `gtk3`, `libappindicator-gtk3` and `librsvg2`.

## Install

All three packages are on the [releases page](https://github.com/emidhun/canopy/releases).

```sh
# Debian / Ubuntu
sudo dpkg -i Canopy_0.4.7_amd64.deb || sudo apt-get -f install

# Fedora / RHEL
sudo rpm -i Canopy-0.4.7-1.x86_64.rpm

# Anywhere, no install, no root
chmod +x Canopy_0.4.7_amd64.AppImage
./Canopy_0.4.7_amd64.AppImage
```

## The tray on Linux

This is the difference worth knowing about. Linux tray implementations (AppIndicator and
StatusNotifier) don't deliver click events at all, so the click-toggles-popover behaviour Canopy uses
on macOS isn't available. The icon carries a menu instead:

- **Open Canopy** shows the main window.
- **Quit Canopy** stops every service and exits.

The popover window still exists here (a regular borderless always-on-top window, not an `NSPanel`),
and the main window is the primary surface.

:::note Your desktop environment matters
On GNOME you may need an AppIndicator extension before the tray icon shows up at all. If there's no
icon, the app is still running: the main window appears at launch and normal window management works.
:::

## Requirements for everything else

| Requirement | Notes |
|---|---|
| `git` | Every worktree operation shells out to git. |
| Your login shell | Commands run as a login shell, so version managers initialise the way they do in a terminal. |
| A Node version manager | Pinned versions are found in `~/.asdf/installs/nodejs/…`, `~/.nvm/versions/node/…` and fnm's data dir. |
| `xdg-open` | Opens a service's port in the browser and reveals a folder in the file manager. |
| A terminal emulator | "Open terminal" detects a common one; the Terminal settings page lets you name the program. |
| **Postgres** (optional) | Only for the database features, and the client binaries have to match the server's major version. |

## Where Canopy keeps its files

| What | Path |
|---|---|
| Settings and runtime state | `~/.config/com.midhunkumare.canopy/` (`settings.json`, `state.json`) |
| Log file | `~/.local/share/com.midhunkumare.canopy/logs/canopy.log` |
| Appearance and per-worktree context | the webview's `localStorage` |

## Known issues

- Window decorations and popover placement are unverified on tiling window managers.
- The AppImage brings its own WebKitGTK expectations. If it won't start, try the `.deb` or `.rpm`.
- In-app updater artifacts are signed. Package-manager installs may still need a fresh `.deb` or
  `.rpm`; the AppImage is the supported self-replacing Linux bundle.
