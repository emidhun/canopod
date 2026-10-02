# User Guide

A task-oriented walkthrough of using Canopy day to day. For a reference of every control, see
[features.md](features.md); for the config file formats, see [configuration.md](configuration.md).

---

## 1. Install and launch

**Quickest:** `brew install --cask emidhun/canopy/canopy` — or grab the
[macOS DMG](https://github.com/emidhun/canopy/releases/download/v0.4.7/Canopy_0.4.7_aarch64.dmg)
/ [Linux packages](https://github.com/emidhun/canopy/releases) directly.
Full steps in the [README](../README.md#install) (or
[distribution.md](distribution.md) for the details). Once installed, launch **Canopy** — it runs as a
**menu-bar app**, so it has no dock icon; look for its mark in the macOS menu bar.

Click the menu-bar icon to open the **popover**. From there:

- **Open Manager** — opens the main window (where you do most things).
- **Quit** — stops all services Canopy started and exits.

---

## 2. Add a repo

1. Open the main window → **Settings** (gear, top-right).
2. **Add repo** → pick the folder of your repo's **main checkout** (the normal clone, not a worktree).
3. Set:
   - **Name** — display name.
   - **Worktree directory** — where new worktrees are created (e.g. `<repo>/.worktrees`).
   - **Reset-DB command** and **Migrate command** (optional) — used by the database menu.
4. Define **services** — one row each. For example, a web frontend and an API server:

   | id | name | kind | command | cwd | basePort |
   |----|------|------|---------|-----|----------|
   | `frontend` | Frontend | web | `npm start -- --port $PORT` | `frontend` | 8082 |
   | `server` | Server | server | `npm run start:dev` | `server` | 3000 |

   - Reference **`$PORT`** in a service's command to bind it to the per-worktree port Canopy assigns.
   - To point one service at another (e.g. frontend → server), use **`$WM_PORT_<SERVICE>`** or
     **`$WT_<SERVICE>_PORT`** (e.g. `$WT_SERVER_PORT`). Both work in service commands.

5. (Optional) Add **Custom commands** (`{label, command}`) — they appear as buttons/menu items in the
   worktree header and run in the worktree root.

Saving writes your app settings **and** the repo's `.worktreemanager.json` (env overrides + setup
commands — see next step).

---

## 3. Tell Canopy how to provision a worktree

Provisioning (what runs when a worktree is created) is declared **in the repo** so it travels with the
branch. Commit a `.worktreemanager.json` at the repo root:

```jsonc
{
  "env": {                                    // add-or-replace keys in the worktree's .env
    "PG_DB": "${WT_DB_NAME}",                 // isolated database name
    "PORT": "${WT_SERVER_PORT}",
    "TOOLJET_SERVER_PORT": "${WT_SERVER_PORT}"
  },
  "setup":    [ "npm --prefix server install", "npm run db:create && npm run db:migrate" ],
  "migrate":  [ "npm run db:migrate" ],        // run by "Run migration"
  "teardown": [ "npm run db:drop" ]            // run on remove when "Drop database" is checked
}
```

`${VAR}` tokens in `env` values and `$VAR` in commands are interpolated with the worktree's variables
(`${WT_DB_NAME}`, `${WT_SERVER_PORT}`, `$WT_PATH`, …). The full list is in
[configuration.md](configuration.md#variables-available-to-provisioning). A complete ToolJet example
is in [tooljet-config.md](tooljet-config.md).

> Canopy looks for the config in the **worktree first**, then the **main checkout** — so an
> uncommitted copy in main works as a fallback while you iterate, and committing it makes it travel
> per branch.

---

## 4. Create a worktree

1. Main window → **New worktree**.
2. Pick the **repository**.
3. Choose one:
   - **New branch** — enter a branch name, then pick a **base** (branch or tag) to fork from.
   - **Existing branch / tag** — search and pick a local branch, a remote branch (a local tracking
     branch is created), or a **tag** (a local branch is created from it).
   - **Fetch all** refreshes remote branches and tags first (`git fetch --all --prune`).
4. **Create worktree**. Canopy runs `git worktree add`, initializes submodules, applies your `env`
   overrides, and runs the `setup` commands — streaming progress live.

The new worktree appears in the sidebar and becomes active.

---

## 4.1 Sync worktrees created by another agent

If another agent or terminal runs `git worktree add` for a repository already registered in Canopy,
click **Sync external worktrees** in the top bar or run it from the `⌘K` command palette. Canopy asks
Git for the repository's registered worktrees, refreshes the sidebar, and reports what it added.

Sync imports only entries returned by `git worktree list`; it does not scan arbitrary copied folders
or add unrelated repositories. It also detects worktree registrations whose directories were deleted
outside Canopy and offers to prune the stale Git entries, with optional branch and database cleanup.

### Updates and project reminders

Under **Settings → General**, Canopy checks GitHub at most once per day and sends a native notification
only when a newer release exists. **Install updates automatically** is opt-in: downloaded bundles are
verified with Canopy's updater signing key before installation and the app restarts cleanly. Use
**Check now** for the same flow on demand.

The separate **Daily GitHub star reminder** sends at most one notification per 24 hours and can be
disabled at any time. It does not contact GitHub; only opening the project page does.

---

## 5. Run services

- **Start all / Stop all** — the primary button in the worktree header boots or stops every service.
- **Per service** (in the Services section) — hover a row for a **power** button to start/stop just
  that one.
- **Open in browser** — click a service's **port** (`:3000`) to open `localhost:<port>`. In the
  popover, the **globe** icon does the same for the web service.
- **Logs** — the panel at the bottom has a tab per service plus **All** (merged, time-ordered,
  `[service]`-tagged). Auto-scroll pauses when you scroll up; **Clear** empties the active tab.

### Changing a port

In a service row, hover the port and click **✎**. Enter a new port — Canopy validates it, re-derives
any dependent env keys, and auto-restarts the service. Overrides persist per service.

---

## 6. Manage databases

Each worktree has its own database. In the **Database** section:

- **`db_name ▾` picker** — searchable list of all databases on the server; pick one to **switch**
  (rewrites `PG_DB` and restarts the server).
- **`⋯` actions menu**:
  - **Run migration** — runs the repo's migrate command.
  - **Save snapshot…** — clones the current DB to a named copy (default `<db>_snap_<timestamp>`).
  - **Export to file…** — `pg_dump` to a `.dump` you choose.
  - **Restore from file…** — restore a `.dump`/`.backup` (via `pg_restore --clean`) or a `.sql`
    (via `psql`) **into the current database**.
  - **Reset database** — destructive; runs the repo's reset command.

> Snapshots/exports/restores use Postgres binaries matching your **server's major version**; make sure
> the matching Postgres version is installed (see the `pg_dump` note in
> [development.md](development.md#gotchas-that-have-bitten-us-read-before-debugging)).

---

## 7. Keep a worktree up to date

Use **Pull** (in the worktree header status line) to `git pull --ff-only` and **advance submodules**:
each submodule is pulled if it's on a branch, updated to its pinned branch tip if `.gitmodules` tracks
one, or synced to the recorded commit otherwise. The toast reports a summary (e.g.
`✓ pulled, 2 submodule(s) pulled`).

---

## 8. Remove a worktree

Worktree header **⋯** → **Remove worktree**. In the confirm dialog:

- A **dirty precheck** warns if the worktree (or a submodule) has uncommitted changes.
- **Also delete branch** (off by default).
- **Drop database** (on by default) — runs your `teardown` before deletion.

Canopy stops the services, runs teardown, removes the worktree, optionally deletes the branch, and
prunes.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| App won't open ("damaged" / "unverified") | Quarantine — run `xattr -dr com.apple.quarantine /Applications/Canopy.app` (see [Install](../README.md#install)). |
| `setup` fails with `notsup` / wrong Node | The project needs a newer Node than your default. Canopy uses the worktree's pinned Node (`.tool-versions`/`.nvmrc`); make sure that version is installed. |
| Server can't find `@tooljet/plugins/dist/server` | Plugins must be built per worktree — add `npm --prefix plugins install && npm --prefix plugins run build` to `setup`. |
| Frontend hits the wrong API port | The frontend bakes the server URL from `TOOLJET_SERVER_PORT` at launch — set it in `env` to `${WT_SERVER_PORT}`, and give the frontend `--port $PORT`. |
| Snapshot/export/restore fails on version | Install the Postgres version matching your server's major version. |
| A service shows as stopped but a port is in use | Another worktree (or a stale process) holds the port. Stop the other worktree, or edit this service's port. |

For anything deeper, see [features.md](features.md) (what each control does) and
[configuration.md](configuration.md) (where each setting lives).
