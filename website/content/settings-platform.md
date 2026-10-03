---
title: Application settings
description: The five settings pages that belong to Canopy itself, and how to get around the Settings window.
---

# Application settings

Settings has one navigation list: the platform pages, then the repository picker acting as a divider,
then that repository's pages. Nothing appears twice.

!shot settings-general | Settings → General: editor command, behaviour, and the live Appearance controls.

## The Settings window

| Element | Behaviour |
|---|---|
| **Filter pages…** | Narrows the navigation list itself. |
| **Search** (`⌘F`) | Searches every setting, not just page names, and jumps to it, flashing the section it landed on. |
| Repository picker | Switches which repository the repo pages below are editing, and shows each repo's worktree count. |
| Per-page dot | A section with unsaved changes is marked in the nav and named in the save bar. |
| **Preview JSON** (`⌘P`) | Opens the repo's `.worktreemanager.json` as a panel beside the editor. Repository pages only. |
| ⋯ menu | Copy JSON, Export config…, Load from repo file, Import from file… Repository pages only. |
| Save bar | `Unsaved changes in <sections>`, with **Discard** and **Save changes** (`⌘S`). |
| Status line | When everything's saved: which file is in scope, and a count of worktrees, provisioned files and services. |

!shot settings-search | ⌘F searches every setting and tells you which page it lives on.

Two behaviours to know about. **Appearance isn't part of the save step**: theme, density and accent
apply live and go straight to `localStorage`, in every Canopy window. And **Sync re-reads config from
disk**: if a repo's `.worktreemanager.json` changed outside the app, pressing Sync updates the Files,
Setup and Migrate pages, except for a repository you're mid-edit on, which is never clobbered.

## General

| Setting | What it does |
|---|---|
| **Editor → Command** | The command behind "Open in editor": `code`, `cursor`, `subl`, `idea`, anything on your `PATH`. Also used to open a single file from the uncommitted-changes dialog. |
| **Show the Switch-branch action** | Offers *Switch branch…* in the worktree menu, the status-bar branch, and `⌘\`. Off hides all three. |
| **Appearance → Theme** | `Dark`, `Light`, or `Match system`. |
| **Appearance → Density** | `Comfortable` or `Compact`, which tightens the spacing ramp. |
| **Appearance → Accent** | Teal, Green, Amber or Violet. |
| **Check for updates automatically** | Checks GitHub at most once per day and sends a native notification when a newer published release exists. |
| **Install updates automatically** | Opt-in. Downloads a Tauri-signed update, verifies it, installs it and restarts Canopy. Managed services are stopped during the restart. |
| **Daily GitHub star reminder** | Sends at most one native reminder per day. Disable it after starring Canopy or whenever you prefer. |
| **Check now** | Runs the release check immediately. An available update can be installed and restarted in-app or opened on GitHub for its release notes. |
| **Record crash reports** | Writes a local stack trace to Canopy's crash-report directory after a panic. Nothing is uploaded. |

Text zoom (`⌘+`, `⌘-`, `⌘0`) belongs to appearance too, but it lives on the keyboard rather than on
this page: 80% to 160% in 10% steps, applied to the whole type ramp.

:::note Updates are signed separately from macOS notarization
The updater verifies every downloaded bundle with Canopy's Tauri updater key. That integrity check
works even while the macOS app remains ad-hoc signed and not notarized. Manual downloads remain the
fallback for package formats the running platform cannot replace in place.
:::

## Terminal

Configure the external terminal and embedded shell appearance, font size and scrollback. Shell and agent sessions share the Terminal workspace.

## Notifications

Preferences control native alerts for service crashes, waiting agents and setup outcomes. The in-app Needs you queue also shows saved job notices and setup reminders. Clear notifications or dismiss a row to hide notices and reminders; active crashes and waiting agents remain actionable.

## Shortcuts

A filterable reference of every binding that has a listener behind it, grouped by scope. It's
reproduced in full on the [Keyboard shortcuts](shortcuts.html) page. Not remappable yet.

## Advanced

!shot settings-advanced | Settings → Advanced: version and config path are live; experiments and reset are not implemented yet.

| Setting | Status |
|---|---|
| **Version** | Real, the running app version. |
| **Config path** | Real, with a copy button. |
| **Copy diagnostics** | Coming soon. |
| **Open logs** | Coming soon, so open the log directory yourself for now. |
| **Experiments** (parallel setup tasks, predictive worktree warmup) | Coming soon, nothing wired. |
| **Clear caches**, **Reset all settings** | Coming soon. |

## Why unwired controls are shown

A page with no backend renders a banner and disabled controls instead of working-looking ones. A switch
that flips and changes nothing is worse than a visible gap, and keeping the layout means the wiring is
purely additive when the backend arrives. [Limitations](limitations.html) has the full list.
