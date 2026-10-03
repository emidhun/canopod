---
title: Where settings live
description: Every file and storage key Canopod writes, where it lives on each platform, and which ones you can safely edit.
---

# Where settings live

Canopod's configuration is split by what it belongs to: your machine, the repository, or the running
state.

| Layer | Lives in | Travels with the repo? | Hand-editable? |
|---|---|---|---|
| App settings | `settings.json` | No | Yes, when the app is closed |
| Repo provisioning | `<repo>/.worktreemanager.json` | Yes, commit it | Yes |
| Runtime state | `state.json` | No | **No** |
| Appearance | `localStorage` | No | Via the UI |
| Worktree context | `localStorage` | No | Via the context editor |
| Pins, multi-selection | `localStorage` | No | Via the UI |

## Paths by platform

Canopod uses the platform's app-config directory under the bundle identifier
`com.midhunkumare.canopod`.

| Platform | Settings and state | Log file |
|---|---|---|
| macOS | `~/Library/Application Support/com.midhunkumare.canopod/` | `~/Library/Logs/com.midhunkumare.canopod/canopod.log` |
| Linux | `~/.config/com.midhunkumare.canopod/` | `~/.local/share/com.midhunkumare.canopod/logs/canopod.log` |
| Windows | `%APPDATA%\com.midhunkumare.canopod\` | the platform log dir, `canopod.log` |

Both `settings.json` and `state.json` sit in that directory. Settings → Advanced shows the path with a
copy button.

:::note
The path shown in Settings → Advanced reads `~/Library/Application Support/Canopod/settings.json`. The
directory the backend actually uses is the bundle identifier, `com.midhunkumare.canopod`. Go by the
identifier when you're looking for the file.
:::

## `settings.json`

Everything you configure in the platform pages and in the four repository pages that aren't the config
file. [settings.json & state.json](config-state.html) has the shape and every field.

You can edit it by hand while Canopod is closed. While it's open, the backend holds the authoritative
copy in memory and rewrites the file on save, so your edit would be overwritten.

## `state.json`

Runtime bookkeeping, not user configuration:

- `portIndices`, each worktree's stable index per repository. This is what keeps ports from shuffling.
- `portOverrides`, explicit per-service port overrides.
- `orphans`, process-group ids and start times, so a crashed Canopod's leftover services can be swept on
  the next launch.

Don't hand-edit it. Deleting it is recoverable but disruptive: indices get reassigned, so derived ports
change, and any override is lost.

## `.worktreemanager.json`

In the repository root, and `wtm.json` is accepted too. Canopod looks in the worktree first, then the
main checkout. A committed copy travels per branch, while an uncommitted copy in the main checkout
works as a fallback while you're still iterating on it.

Full schema: [.worktreemanager.json](config-worktreemanager.html).

## `localStorage`

The webview's storage, shared by every Canopod window since they're all the same origin.

| Key | Contents |
|---|---|
| `canopod.appearance` | `{ theme, density, accent, fontScale }` |
| `canopod.ctx.<worktree path>` | That worktree's agent context: title, body, links, files, PR and issue fields |
| pins / selection keys | Which worktrees are pinned, and the current multi-selection |

Appearance changes broadcast to the other windows through a `storage` event, so a theme switch applies
everywhere at once. Clearing site data for the app resets appearance and loses saved contexts, though
`.canopod/context.md` files already written into worktrees aren't affected.

## `.canopod/` inside a worktree

Launch an agent and Canopod writes `<worktree>/.canopod/context.md`. If the directory is new it also
writes a `.gitignore` beside it that ignores the directory itself. An existing `.gitignore` is never
overwritten.

## In-repo worktree roots

If your worktree root sits inside the repository, which is what the default `.worktrees` does, Canopod
self-ignores it so the worktrees don't turn up as untracked files in the parent checkout.

## Backup and migration

Copy `settings.json` to bring your repositories, services, agents and commands with you. Leave
`state.json` behind and let the new machine assign its own indices. `.worktreemanager.json` comes with
the repository, which is the whole point of it.
