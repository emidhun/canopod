# Architecture

## Shape
Two webview windows over one Rust backend:

- **`main`** window (`index.html` → `src/main.tsx` → `src/app/App.tsx`) — the workbench: a slim top
  drag-bar (Rescan + Settings), a flat worktree sidebar, the worktree header (branch + toolbar + status
  line), compact service rows (with CPU sparkline), the database row (name picker + actions menu), a
  height-filling logs panel (filter tabs, merged "All" view), settings, and new/remove-worktree modals.
- **`popover`** window (`popover.html` → `src/popover.tsx` → `src/popover/Popover.tsx`) — a frameless
  **NSPanel** anchored under the tray icon: per-worktree rows with status chips + quick actions.

Both are built from one Vite app (multi-entry: `vite.config.ts` `rollupOptions.input`).

## Single source of truth
The **Rust backend owns all state**: registered repos, discovered worktrees, service process table,
logs, port indices/overrides. Both windows:
1. Hydrate by calling `get_tree` (and `get_logs`) on mount.
2. Subscribe to backend **events** and patch their local zustand store.
3. Re-hydrate on window focus.

This is implemented once in `src/store.ts` (`initSync()`), used by **both** windows — that *is* the
sync mechanism. UI actions are optimistic; the authoritative event overwrites.

### Events (backend → both windows)
| Event | Payload | Meaning |
|---|---|---|
| `tree:changed` | full `RepoNode[]` | structural change (repo/worktree/service/settings) |
| `service:status` | `{svcKey, status, startedAt?, exitCode?}` | a service's lifecycle changed |
| `service:log` | `{svcKey, lines[]}` | batched log lines (≤80ms) |
| `service:stats` | `{entries:[{svcKey, cpu, memMb, uptimeSec}]}` | 2s stats poll |
| `worktree:git` | `{wtKey, ahead, behind, dirty, lastCommitTs, lastCommitMsg}` | git meta refresh |
| `reset:status` | `{wtKey, state, message?}` | Reset DB progress |
| `worktree:op` | `{wtKey, op, state, detail}` | create/remove/snapshot/migrate progress |

## Data model (sent to the UI)
```
RepoNode   { repoId, name, path, worktrees: WorktreeNode[] }
WorktreeNode { wtKey(=abs path), branch, path, isMain, git|null, dbName|null, services: ServiceNode[] }
ServiceNode  { svcKey(=`{wtKey}::{serviceId}`), serviceId, name, kind(web|server|worker), port|null, status }
status ∈ stopped | starting | running | stopping | error
```

## Process model
- Services spawn via `/bin/zsh -lc "<command>"` in their own **process group** (`process_group(0)`),
  on the worktree's **pinned Node** (see gotchas), with `$PORT` + `$WM_PORT_<svc>` / `$WT_<svc>_PORT`
  + `$WM_WT_SLUG`/`$WT_SLUG` injected.
- Stop = `killpg(SIGTERM)` → 3s grace → `killpg(SIGKILL)`, taking down the whole child tree.
- Logs: stdout/stderr line readers → 160-line ring buffer per service, flushed to the UI every ~80ms.
- Crash safety: spawned pgids persisted to `state.json`; swept on next launch (with start-time check).
  Cmd-Q / Quit kills every group before exit.

## Tray + popover mechanics (`src-tauri/src/tray.rs`)
- Tray icon is a runtime-drawn template image (the Canopod fork mark, solid nodes).
- On left-click: position the popover **manually** from the tray icon's rect — centered under it,
  hanging below the menu bar with a small gap (the positioner's `TrayCenter` pinned tall popovers to
  the top, so we compute the position ourselves), then `panel.show_and_make_key()`.
- The popover is a non-activating `NSPanel` (`tauri-nspanel`) so it doesn't steal focus and works over
  fullscreen apps; hides on resign-key (disabled under `WTM_NO_BLUR_HIDE` / debug).
- Main-window close = hide-to-tray (Accessory activation policy); "Open Manager" restores it (Regular).
