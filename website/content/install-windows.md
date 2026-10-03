---
title: Install on Windows
description: The Windows build, what's ported, and what nobody has tested yet.
---

# Install on Windows

The Windows build compiles and ships, but it has not been run on a Windows desktop. Every release
builds an NSIS installer on a `windows-latest` runner, and CI compiles and tests the `cfg(windows)`
code paths on each push. Treat it as an early-adopter build.

:::warn What "untested port" means here
The Windows-specific code exists and compiles: Job Object process control, Git Bash as the command
shell, Windows Node and Postgres path discovery, and a tray menu in place of the macOS panel. What has not been
verified is the application's behaviour as a whole: window chrome, where the popover lands, PTY
behaviour, and the dialogs. If something is broken, an issue with the log file attached is the most
useful thing you can send.
:::

## Requirements

| Requirement | Notes |
|---|---|
| Windows 10/11 x64 | The release job builds the default `x86_64-pc-windows-msvc` target. |
| WebView2 runtime | Ships with current Windows; the installer pulls it in if it's missing. |
| `git` on `PATH` | Every worktree operation shells out to git. |
| **Git Bash** (or another POSIX shell) | Canopy writes POSIX command lines. On Windows it looks for Git Bash to run them. |
| Node via nvm-windows or fnm | Pinned-version discovery checks `%APPDATA%\nvm\v<version>` and fnm's data dir. |
| **Postgres** (optional) | Only for the database features. |

## Install

1. Download `Canopy_0.5.0_x64-setup.exe` from the
   [releases page](https://github.com/emidhun/canopy/releases).
2. Run it. SmartScreen will warn you about an unsigned installer, because the build isn't
   code-signed. If you're happy with that, choose **More info → Run anyway**.
3. Launch Canopy. It puts an icon in the notification area.

## The tray on Windows

macOS gets a non-activating `NSPanel` hanging under the menu bar. Windows and Linux get a regular
borderless always-on-top window, plus a small menu on the tray icon:

- **Open Canopy** shows the main window.
- **Quit Canopy** stops every service and exits.

Left-clicking the icon toggles the popover, positioned under the icon.

## Differences from macOS

| Area | On Windows |
|---|---|
| Commands | Run through Git Bash instead of your login shell. `PATH` comes from the process environment. |
| Process control | Services go into a **Job Object**, so stopping one takes the whole tree down (what `killpg` does on Unix). |
| Terminal sessions | Real PTYs through `portable_pty` (ConPTY). Idle shell sessions are swept after an hour; agent sessions aren't. |
| "Reveal in Finder" | Opens Explorer at the worktree path. |
| Settings path | `%APPDATA%\com.midhunkumare.canopy\settings.json`. |
| Log file | The platform log dir, `canopy.log`, same rolling 2 MB policy. |

## Database prerequisites

Snapshot, export, restore and switch call `psql`, `pg_dump`, `pg_restore` and `createdb`. On Windows
those need to be on `PATH` (the EDB installer's `bin` directory), and their major version has to match
the server you're connecting to.

## If the app does not start

1. Read the log file in the platform log dir (`canopy.log`). The backend logs at INFO; `RUST_LOG=debug`
   raises it.
2. Check that WebView2 is installed.
3. Check that `git --version` works from a normal command prompt.
4. File an issue with the log attached. The Windows paths that need real-world validation are the ones
   a first failure will point straight at.
