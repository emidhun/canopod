---
title: Install on macOS
description: Homebrew or the DMG, the one line that clears quarantine, and what you need installed first.
---

# Install on macOS

macOS on **Apple Silicon (arm64)** is Canopod's home platform. It's where the app is developed and
tested, and the only build anyone has run on a real desktop.

## Requirements

| Requirement | Why |
|---|---|
| macOS on Apple Silicon | The published build targets `aarch64-apple-darwin`. There is no Intel or universal build. |
| `git` | Every worktree operation shells out to git. |
| The runtimes and package managers used by your project | For Node projects, Canopod can read `.nvmrc`, `.node-version` and `.tool-versions` per worktree. Canopod itself does not require Node. |
| **Postgres** running locally | Only for the database features: snapshot, switch, export, restore, reset. |
| A `.worktreemanager.json` in the repo | Optional. Commit one when setup should travel with the branch. |

:::note
Your Postgres client binaries need to match the server's major version. Canopod asks the running server
which version it is, then prefers `Postgres.app/Versions/<major>/bin`, falling back to the newest
install and then to `$PATH`. A version mismatch is the most common reason a snapshot or export fails.
:::

## Option 1: Homebrew (recommended)

```sh
brew install --cask emidhun/canopod/canopod
```

Homebrew clears the quarantine attribute for you, so the app opens on first launch with no warning.

## Option 2: the DMG

Canopod is ad-hoc signed but not notarized, so macOS quarantines the download. Clearing that flag is
the step that matters:

```sh
hdiutil attach ~/Downloads/Canopod_0.5.0_aarch64.dmg
cp -R "/Volumes/Canopod/Canopod.app" /Applications/
hdiutil detach "/Volumes/Canopod"
xattr -dr com.apple.quarantine /Applications/Canopod.app     # clears quarantine
open /Applications/Canopod.app
```

Double-clicking the DMG and dragging Canopod to Applications works too. You still need the
`xattr -dr com.apple.quarantine` line. On macOS Sequoia you can instead go to
**System Settings → Privacy & Security → Open Anyway**.

:::warn If you skip the quarantine step
macOS will tell you the app is *damaged*, or from an *unidentified developer*, or that it *can't be
checked for malicious software*. The download is fine. The app just isn't notarized yet.
:::

## First launch

Canopod lives in the **menu bar**. Look for the fork mark up there. There's no Dock icon while the main
window is hidden.

Click the tray icon to toggle the popover. **Open Manager** in its footer brings up the main window.
Closing the main window hides it back to the tray rather than quitting, and **Quit** stops every
service Canopod started before it exits.

With no repositories registered yet, you land on the onboarding screen:

!shot onboarding-empty | First run with no repositories registered.

Carry on with [Adding a repository](onboarding.html).

## Where Canopod keeps its files

| What | Path |
|---|---|
| App settings | `~/Library/Application Support/com.midhunkumare.canopod/settings.json` |
| Runtime state (port indices, overrides, orphan bookkeeping) | `~/Library/Application Support/com.midhunkumare.canopod/state.json` |
| Log file (rolling, 2 MB, one rotation) | `~/Library/Logs/com.midhunkumare.canopod/canopod.log` |
| Theme, density, accent, text zoom | the webview's `localStorage`, key `canopod.appearance` |
| Per-worktree agent context | `localStorage`, key `canopod.ctx.<worktree path>` |

[Where settings live](settings-storage.html) has the full map.

## Updating

Use **Settings → General → Check now**, enable signed automatic installation, download the newer DMG,
or run `brew upgrade --cask canopod`. Your settings and runtime state sit outside the bundle, so they
survive. Tauri updater signatures verify in-app downloads independently of Apple notarization.

## Uninstalling

```sh
rm -rf /Applications/Canopod.app
rm -rf ~/Library/Application\ Support/com.midhunkumare.canopod
rm -rf ~/Library/Logs/com.midhunkumare.canopod
```

Your repositories, worktrees and databases are untouched. Canopod never owned them.
