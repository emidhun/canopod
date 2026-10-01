# Distribution

## Current state
The latest published release is **v0.4.7** (2026-08-13). It includes an Apple Silicon DMG/app archive,
Linux deb/rpm/AppImage packages and Windows NSIS/MSI installers. Artifact presence proves packaging,
not successful installation or desktop behavior.

macOS builds are **ad-hoc signed, not notarized**, and **arm64-only** (Apple Silicon). The release
workflow has no Developer ID or notarization step, and `tauri.conf.json` uses signing identity `-`.
Linux and Windows packages are experimental because no real-desktop acceptance record exists.

## Installing from the DMG (what to tell recipients)
```sh
hdiutil attach ~/Downloads/Canopy_0.4.7_aarch64.dmg
cp -R "/Volumes/Canopy/Canopy.app" /Applications/
hdiutil detach "/Volumes/Canopy"
xattr -dr com.apple.quarantine /Applications/Canopy.app      # clears quarantine — the step that matters
open /Applications/Canopy.app
```
Or: double-click the DMG, drag Canopy to Applications, then run only the `xattr -dr com.apple.quarantine` line.
On macOS Sequoia, the GUI alternative is System Settings → Privacy & Security → **Open Anyway**.

Recipient prerequisites: git, plus only the runtimes, package managers and databases required by the
repository's configured commands. `.worktreemanager.json` is optional initially; commit one when the
setup should travel with each branch.

## Removing the warning permanently: Developer ID + notarization
Requires an **Apple Developer Program** membership ($99/yr — a cost, not income; doesn't enable App
Store for this app). With it:
1. Create a **Developer ID Application** certificate.
2. Configure signing + notarization in `tauri.conf.json` / build env (identity, Apple ID or API key,
   team id). `tauri build` signs and submits to the notary service; staple the ticket.
3. Result: the DMG opens with a double-click anywhere — no Terminal, no warnings.
Best done under an **org account** (e.g. ToolJet's) you're a member of, rather than borrowing personal
credentials (against Apple's terms; ships under their identity).

## Why not the Mac App Store
Canopy can't be sandboxed: it spawns arbitrary shell/process trees (`npm`, `git`, `webpack`, `killpg`),
touches arbitrary filesystem paths (worktrees anywhere), and uses private window APIs (`NSPanel`,
`macOSPrivateApi`). All are disallowed/crippled by the App Store sandbox. Dev tools (VS Code, GitButler,
TablePlus, etc.) all distribute outside the App Store for the same reasons — Developer ID + notarization
is the right path.

## Universal (Intel + Apple Silicon)
Not built — current builds are arm64-only. A universal build needs the `x86_64-apple-darwin` target and
`tauri build --target universal-apple-darwin`.
