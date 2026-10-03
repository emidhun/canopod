---
title: Commands and events
description: Every command the frontend can call and every event it can receive, for when you're reading or extending the code.
---

# Commands and events

The frontend talks to the Rust backend through Tauri's `invoke`, and receives pushed state through
events. This is the whole surface, which is useful when you're reading the code or extending it. The
typed wrappers live in `src/ipc.ts`, the handlers in `src-tauri/src/commands.rs`.

## What the UI receives

```text
RepoNode      { repoId, name, path, worktrees: WorktreeNode[] }
WorktreeNode  { wtKey, branch, path, isMain, git | null, dbName | null, services: ServiceNode[] }
ServiceNode   { svcKey, serviceId, name, kind, port | null, status }
GitMeta       { ahead, behind, dirty, lastCommitTs, lastCommitMsg }

wtKey  = the worktree's absolute path
svcKey = `${wtKey}::${serviceId}`
status ∈ stopped | starting | running | stopping | error
kind   ∈ web | server | worker
```

## Commands

### Tree and settings

| Command | Signature | Notes |
|---|---|---|
| `get_tree` | `() → RepoNode[]` | Full hydrate. |
| `refresh` | `(wtKey?) → void` | Rescan everything, or one worktree. |
| `get_settings` | `() → Settings` | |
| `save_settings` | `(newSettings) → void` | |
| `add_repo` | `(path) → RepoCfg` | Registers a repository. |
| `detect_repo` | `(path) → RepoDetection` | Name, branch, origin, stack, `package.json` scripts. |
| `remove_repo` | `(repoId) → void` | Stops tracking. Touches nothing on disk. |
| `get_repo_config` | `(repoId) → RepoConfigFile` | Reads `.worktreemanager.json`. |
| `save_repo_config` | `(repoId, provision, setup) → void` | Writes it. |
| `save_text_file` | `(path, contents) → void` | Used by config export. |

### Worktrees

| Command | Signature | Notes |
|---|---|---|
| `create_worktree` | `({repoId, branch, base?, createBranch}) → path` | add → submodules → provision → setup. |
| `run_worktree_setup` | `(wtKey) → void` | Re-provision and re-run setup. |
| `remove_worktree` | `(wtKey, deleteBranch, dropDb) → void` | |
| `remove_worktrees` | `(wtKeys[], deleteBranch, dropDb) → void` | The multi-select path. |
| `list_prunable_worktrees` | `() → PrunableWorktree[]` | Folders deleted on disk. |
| `prune_worktrees` | `(items[]) → void` | Per item: branch and database choices. |
| `switch_worktree_branch` | `(wtKey, branch, create, base?) → void` | In-place switch. |
| `worktree_dirty_report` | `(wtKey) → {dirty, details[], total}` | Up to ten paths, submodules included. |
| `worktree_status` | `(wtKey) → StatusEntry[]` | Resolved `git status --porcelain` rows. |
| `worktree_commit` | `(wtKey, message, addUntracked) → void` | |
| `worktree_stash` | `(wtKey, name?, includeUntracked) → summary` | |
| `worktree_discard` | `(wtKey, cleanUntracked) → void` | |

### Git and submodules

| Command | Signature | Notes |
|---|---|---|
| `git_pull` | `(wtKey) → summary` | `--ff-only`, then advances submodules. |
| `submodule_status` | `(wtKey) → SubmoduleStatus[]` | branch, sha, dirty, ahead-of-pin. |
| `pull_submodule` | `(wtKey, path) → summary` | |
| `switch_submodule_branch` | `(wtKey, path, branch) → void` | |
| `list_submodule_branches` | `(wtKey, path) → Branches` | |
| `fetch_submodules` | `(wtKey) → count` | |
| `sync_submodules` | `(wtKey) → summary` | Re-pin to the recorded commits. |
| `list_branches` | `(repoId) → Branches` | local, remote, tags. |
| `fetch_branches` | `(repoId) → Branches` | Fetch, then list. |

### Services

| Command | Signature |
|---|---|
| `service_start` / `service_stop` / `service_restart` | `(svcKey) → void` |
| `worktree_start_all` / `worktree_stop_all` | `(wtKey) → void` |
| `set_service_port` | `(svcKey, port) → void`, validated 1024–65535 |
| `get_logs` | `(svcKey) → LogLine[]`, the ring buffer snapshot |

### Databases

| Command | Signature |
|---|---|
| `list_databases` | `(wtKey) → string[]` |
| `current_database` | `(wtKey) → string \| null` |
| `switch_database` | `(wtKey, dbName) → void` |
| `snapshot_database` | `(wtKey, name) → void` |
| `export_database` | `(wtKey, filePath) → void` |
| `restore_database` | `(wtKey, filePath) → void` |
| `reset_db` | `(wtKey) → void` |
| `run_migration` | `(wtKey) → void` |

### Terminals and agents

| Command | Signature | Notes |
|---|---|---|
| `terminal_open` | `(id, cwd, cols, rows, command?) → void` | Idempotent per id. |
| `terminal_write` | `(id, data) → void` | |
| `terminal_resize` | `(id, cols, rows) → void` | |
| `terminal_get_buffer` | `(id) → {buffer, seq} \| null` | Race-free rehydrate. |
| `terminal_close` | `(id) → void` | |
| `write_worktree_context` | `(wtPath, contents) → void` | Writes `.canopod/context.md` and a self-ignoring `.gitignore`. |
| `resolve_agent_command` | `(wtKey) → string` | |

### Shell-outs and windows

| Command | Signature |
|---|---|
| `run_custom_command` | `(wtKey, command) → void` |
| `open_in_editor` | `(wtKey) → void` |
| `open_file_in_editor` | `(wtKey, path) → void` |
| `reveal_in_finder` | `(wtKey) → void` |
| `open_terminal` | `(wtKey) → void` |
| `open_port` | `(port) → void` |
| `show_main_window` | `() → void` |
| `quit_app` | `() → void` |

## Events

Pushed from Rust to whichever windows are listening. High-volume events are filtered to the windows
that consume them, and suppressed entirely while every window is hidden.

| Event | Payload | Meaning |
|---|---|---|
| `tree:changed` | `RepoNode[]` | A structural change: repo, worktree, service or settings. |
| `service:status` | `{svcKey, status, startedAt?, exitCode?}` | A service's lifecycle moved. |
| `service:log` | `{svcKey, lines[]}` | Batched log lines, every ~200 ms. |
| `service:stats` | `{entries: [{svcKey, cpu, memMb, uptimeSec}]}` | The 2-second stats poll. |
| `worktree:git` | `{wtKey, ahead, behind, dirty, lastCommitTs, lastCommitMsg}` | Git metadata refreshed. |
| `reset:status` | `{wtKey, state, message?}` | Database reset progress. |
| `worktree:op` | `{wtKey, op, state, detail}` | create / remove / setup / migrate / snapshot progress, carrying the `[k/n]:` step markers. |
| `terminal:data` | `{id, data (base64), seq}` | Raw PTY bytes. |
| `terminal:exit` | `{id}` | A session's process ended. |
| `tray:new-worktree` · `tray:overview` · `tray:settings` | — | Emitted by the popover for the main window to act on. |

## Errors

Every command rejects with a structured error:

```ts
{ code: "git" | "db" | "setup" | "process" | "terminal" | "config"
       | "not_found" | "invalid_input" | "conflict" | "internal",
  message: string }
```

The frontend reads it with `errText()` and `errCode()` instead of `String(e)`, so a plugin's
plain-string rejection and a backend error both come out useful.

## Detecting the backend

`hasBackend()` checks for `__TAURI_INTERNALS__` on `window`. It's false in a plain browser, which is
what enables [mock mode](dev-setup.html#mock-mode), and why features that need the
backend say so with a toast instead of failing silently.
