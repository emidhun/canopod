---
title: settings.json & state.json
description: What's in Canopod's two machine-local files, field by field, and which one you must never hand-edit.
---

# `settings.json` & `state.json`

Both live in the platform app-config directory under `com.midhunkumare.canopod`. See
[Where settings live](settings-storage.html) for the path on each platform.

## `settings.json`

Everything you configure in Settings, except the repository's provisioning file and appearance (which
lives in `localStorage`).

```jsonc
{
  "version": 1,
  "editor": { "command": "code" },        // "Open in editor"
  "terminal": "Terminal",                 // "Open in terminal"
  "showSwitchBranch": true,               // offer Switch branch… and ⌘\
  "repos": [
    {
      "id": "tooljet",                    // stable id; part of every service key
      "name": "ToolJet",
      "path": "/Users/me/code/ToolJet",   // the main checkout
      "worktreeDir": ".worktrees",        // absolute, or relative to the repo; "" = <repo>/.worktrees
      "resetDb": "npm run db:reset",      // the "Reset database" action
      "migrateDb": "npm run db:migrate",  // "Run migration"; "" falls back to .worktreemanager.json
      "services": [
        {
          "id": "frontend",
          "name": "Frontend",
          "kind": "web",                  // web | server | worker
          "command": "npm start -- --port $PORT",
          "cwd": "frontend",              // relative to the worktree root; "" = root
          "basePort": 8082,               // null for a service that does not listen
          "env": { "NODE_ENV": "development" }
        },
        {
          "id": "server",
          "name": "Server",
          "kind": "server",
          "command": "npm run start:dev",
          "cwd": "server",
          "basePort": 3000,
          "env": {}
        }
      ],
      "customCommands": [
        { "label": "Lint", "command": "npm run lint", "group": "Checks" },
        { "label": "Unit tests", "command": "npm test -- --run", "group": "Checks" }
      ],
      "agents": [
        { "id": "a1", "name": "Claude Code", "command": "claude", "promptOnLaunch": true },
        { "id": "a2", "name": "Codex", "command": "codex", "promptOnLaunch": true }
      ],
      "agentCommand": "claude"            // legacy single-agent field, kept in sync with agents[0]
    }
  ]
}
```

### Field notes

| Field | Notes |
|---|---|
| `version` | Schema version. Missing fields fall back to defaults on read, so an older file still loads. |
| `editor.command` | Defaults to `code`. |
| `terminal` | Empty means Canopod detects a sensible terminal for the platform. |
| `showSwitchBranch` | Defaults to `true`. `false` removes the action and the shortcut. |
| `repos[].id` | Used in service keys (`<worktree path>::<service id>`) and as the database-name prefix. Don't rename it casually; port indices are keyed by it. |
| `repos[].worktreeDir` | Relative paths resolve against the repo root. |
| `services[].basePort` | `null` is valid, for a worker with no port. It then exposes no port variable. |
| `customCommands[].group` | Optional. Empty means ungrouped, which is where every command starts. |
| `agents` | The first entry is the default launcher. |
| `agentCommand` | Kept for older files. Saving sets it to the first agent's command. |

Entries with an empty id or command (services), an empty label or command (custom commands), or a
missing id, name or command (agents) are dropped when Settings saves.

Edit it by hand while Canopod is closed. While it's running, the backend holds the authoritative copy in
memory and rewrites the file on save.

## `state.json`

Runtime bookkeeping. Not configuration, and not for hand-editing.

```jsonc
{
  "portIndices": {
    "tooljet": {
      "/Users/me/code/ToolJet": 0,                          // the main checkout is always 0
      "/Users/me/code/ToolJet/.worktrees/feat_x": 1,
      "/Users/me/code/ToolJet/.worktrees/fix_y": 2
    }
  },
  "portOverrides": {
    "/Users/me/code/ToolJet/.worktrees/feat_x::frontend": 8099
  },
  "orphans": [
    { "svcKey": "…::server", "pgid": 41233, "spawnTimeSecs": 1754899200 }
  ]
}
```

| Field | Purpose |
|---|---|
| `portIndices` | The stable per-worktree index behind `basePort + index × 10`. Index spaces are per repository, and a freed slot is reclaimed by the next worktree. |
| `portOverrides` | Explicit per-service overrides, keyed by service key, set from the service-detail dialog. |
| `orphans` | Process groups Canopod spawned, with their start time, so a crashed run's leftovers can be swept on the next launch without killing an unrelated process that reused the pid. |

There's also a terminal-orphan list on Unix for PTY sessions, maintained the same way.

:::danger Do not hand-edit `state.json`
Rewriting `portIndices` silently changes every derived port. If you have to reset it, quit Canopod,
delete the file, and expect new indices on the next launch, which means new ports and possibly new
database names.
:::

## Stored elsewhere

| Setting | Actually stored in |
|---|---|
| Theme, density, accent, text zoom | `localStorage` → `canopod.appearance` |
| Per-worktree agent context | `localStorage` → `canopod.ctx.<worktree path>` |
| Pinned worktrees, multi-selection | `localStorage` |
| Provisioned files, setup, migrate, teardown | `<repo>/.worktreemanager.json` |
| Which layout you last used, sidebar visibility | Not persisted; they reset with the window |
