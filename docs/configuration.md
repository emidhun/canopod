# Configuration

There are **three** places config lives. Know which is which.

## 1. App Settings — `settings.json` (per machine)
Path: `~/Library/Application Support/com.midhunkumare.canopod/settings.json`.

Editable in-app via the titlebar gear (SettingsView). Shape:
```jsonc
{
  "version": 1,
  "editor": { "command": "code" },     // open-in-editor command
  "terminal": "Terminal",              // app for "Open Terminal"
  "repos": [{
    "id": "tooljet",
    "name": "ToolJet",
    "path": "/Users/.../CE/ToolJet",          // main checkout
    "worktreeDir": "/Users/.../CE/ToolJet/.worktrees",  // where new worktrees go
    "resetDb": "npm run db:reset",            // command run by "Reset DB"
    "services": [
      { "id": "frontend", "name": "Frontend", "kind": "web",
        "command": "npm start -- --port $PORT", "cwd": "frontend", "basePort": 8082, "env": {} },
      { "id": "server", "name": "Server", "kind": "server",
        "command": "npm run start:dev", "cwd": "server", "basePort": 3000, "env": {} }
    ],
    "customCommands": [                        // buttons in the worktree header
      { "label": "Lint", "command": "npm run lint" }
    ]
  }]
}
```
- `command` should reference `$PORT` if you want the service's own listen port to be per-worktree
  (e.g. webpack's `--port`). The backend reads `process.env.PORT` automatically for servers that honor it.
- The Settings editor also edits the repo's **`env` overrides** and **`setup` commands** (below) and
  writes them to `.worktreemanager.json`. (Editing `migrate`/`teardown` in the UI is not wired yet.)
- **`customCommands`** are per-repo `{label, command}` pairs (app settings, not `.worktreemanager.json`).
  Each renders as a button in the worktree header; clicking runs the command in the worktree root on the
  pinned Node (same execution model as Setup/migrate), streaming progress as toasts. The provisioning
  variables (`$WT_PATH`, `$WTM_REPO`, `$WT_<SERVICE>_PORT`, etc.) are exposed.

## 2. Repo provisioning — `.worktreemanager.json` (in the repo, travels with branch)
Lives at the repo root (or `wtm.json`). Looked up in the **worktree** first, then the **main checkout**
(so an uncommitted copy in main works as a fallback; commit it to travel per-branch). Schema:
```jsonc
{
  "env": {                         // add-or-replace keys in the worktree's .env (seeded from main)
    "PG_DB": "${WT_DB_NAME}",
    "PORT": "${WT_SERVER_PORT}",
    "TOOLJET_SERVER_PORT": "${WT_SERVER_PORT}"
  },
  "setup":    [ "npm --prefix frontend install", "...", "npm run db:create && npm run db:migrate" ],
  "migrate":  [ "npm run db:migrate" ],   // run by the "Run migration" button
  "teardown": [ "npm run db:drop" ]       // run before delete when "Drop database" is checked
}
```
- `env` runs first on create (and via "Setup"); `setup` commands run next; all on the pinned Node, in
  the worktree, with the variables below exposed as both `${VAR}` (in `env` values) and `$VAR` (in
  commands). `teardown` runs on remove; `migrate` on demand.

### Variables available to provisioning
| Variable | Value |
|---|---|
| `${WT_SLUG}` | db-safe worktree id (folder name, lowercased, non-alnum→`_`) |
| `${WT_DB_NAME}` | `<repo>_<slug>` (e.g. `tooljet_feature_x`) |
| `${WT_INDEX}` | the worktree's stable port index |
| `${WT_<SERVICE>_PORT}` | a service's effective port, e.g. `${WT_SERVER_PORT}`, `${WT_FRONTEND_PORT}` |
| `$WTM_REPO` / `$REPO_PATH` | main checkout path |
| `$WTM_WORKTREE` / `$WT_PATH` | the worktree path |
| `$WM_PORT_<SERVICE>` / `$WM_WT_SLUG` | back-compat aliases of the above |

The current ToolJet config is reproduced in [tooljet-config.md](tooljet-config.md).

## 3. Runtime state — `state.json` (per machine, don't hand-edit)
`~/Library/Application Support/com.midhunkumare.canopod/state.json`:
```jsonc
{
  "portIndices": { "<repoId>": { "<wtKey>": <index> } },  // stable per-worktree index
  "portOverrides": { "<svcKey>": <port> },                // explicit per-service port overrides
  "orphans": [ { "svcKey", "pgid", "spawnTimeSecs" } ]     // for crash cleanup
}
```

## Ports
Effective port = **override if set, else `basePort + index*10`**. The main checkout is index 0
(so it keeps the base ports); each new worktree gets the lowest free index. Overrides come from the
service-card port editor and persist here.

## Databases
Per-worktree isolation is achieved purely through the `.env`: `PG_DB` is set to `tooljet_<slug>`.
All worktrees share the same Postgres **server** (same `PG_HOST/PG_PORT/PG_USER/PG_PASS` copied from
main's `.env`), differing only in database **name**. Switching DB just rewrites `PG_DB` and restarts
the server.
