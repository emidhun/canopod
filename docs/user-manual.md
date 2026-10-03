# Canopod — Complete User Manual

Canopod is a macOS **menu-bar app** for managing multiple **git worktrees** of your repositories,
each running its own dev services in an isolated environment. It gives every branch its own database,
its own ports, and its own set of running services — so you can work on many branches at once without
them colliding, and switch between them instantly instead of stashing and restarting.

This manual documents **everything a user needs**: every screen and control, how ports and database
names are generated, how custom command buttons work, the configuration files, and the full list of
variables you can reference.

---

## Table of contents
1. [Core concepts](#1-core-concepts)
2. [Installing & launching](#2-installing--launching)
3. [The menu-bar popover](#3-the-menu-bar-popover)
4. [The main window](#4-the-main-window)
5. [Adding a repository (onboarding)](#5-adding-a-repository-onboarding)
6. [Services](#6-services)
7. [Ports — how they're assigned & named](#7-ports--how-theyre-assigned--named)
8. [Databases — how names are generated & isolated](#8-databases--how-names-are-generated--isolated)
9. [Custom command buttons](#9-custom-command-buttons)
10. [Worktree lifecycle: create, setup, pull, remove](#10-worktree-lifecycle)
11. [Configuration — the three layers](#11-configuration--the-three-layers)
12. [Variables reference](#12-variables-reference)
13. [Shell & toolchain (Node version)](#13-shell--toolchain)
14. [Logs](#14-logs)
15. [Settings reference](#15-settings-reference)
16. [Troubleshooting](#16-troubleshooting)
17. [Limitations](#17-limitations)
18. [Glossary](#18-glossary)

---

## 1. Core concepts

| Concept | What it means in Canopod |
|---|---|
| **Repository** | A git repo you register with Canopod (its main checkout on disk). |
| **Worktree** | A `git worktree` of that repo — a branch checked out into its own folder. Each is managed independently. |
| **Service** | A long-running process for a worktree (e.g. a frontend dev server, an API server, a background worker). You define the command; Canopod starts/stops/monitors it. |
| **Isolation** | Every worktree gets its **own database** and its **own set of ports**, so multiple branches run side-by-side without conflict. |
| **Provisioning** | The steps that prepare a worktree after it's created (install deps, create DB, set env). Declared in the repo so they travel with the branch. |

**The mental model:** Canopod is the *source of truth* for what's running. You register repos and define
their services once; then for each branch you create a worktree, and Canopod provisions it, assigns its
ports and database, and lets you start everything with one click.

---

## 2. Installing & launching

Canopod is a **macOS (Apple Silicon)** app distributed as a `.dmg`.

1. Open the DMG and drag **Canopod** to Applications.
2. Because the current build isn't notarized, clear the quarantine flag once (in Terminal):
   ```sh
   xattr -dr com.apple.quarantine /Applications/Canopod.app
   ```
   (Or: System Settings → Privacy & Security → **Open Anyway**.)
3. Launch Canopod. It runs in the **menu bar** — there is no Dock icon. Look for the Canopod mark (a small
   fork/branch glyph) in the menu bar.

Click the menu-bar icon to open the **popover**; from there, **Open Manager** opens the main window.

---

## 3. The menu-bar popover

Click the menu-bar icon to open a compact popover — the fastest way to start/stop worktrees without
opening the full window.

**Top actions**
- **Open Manager** — opens the main window.
- **Quit** — stops every service Canopod started and exits the app.

**Per repository → per worktree**
Repos are grouped; under each, one row per worktree showing:
- The **branch name**.
- **Service status dots** — green = running, amber (pulsing) = starting/stopping, faint = stopped.
- Row actions:
  - 🌐 **Globe** — open the web service in your browser (`localhost:<frontend port>`); enabled when running.
  - ↗ **Open worktree** — open the worktree in your editor.
  - 🗄 **Reset database** — runs the repo's reset command for that worktree.
  - **Start / Stop** — toggles all of that worktree's services.

The popover **height fits its content** and scrolls internally (no visible scrollbar) if you have more
worktrees than fit on screen. It closes automatically when it loses focus.

---

## 4. The main window

A slim **title bar** at top (with the Canopod mark, a **＋ Add repository** button, a **Rescan** button,
and **Settings**), then two panes: a **sidebar** on the left and the **worktree view** on the right.

### 4.1 Sidebar
- Header: **Worktrees** with a total count, and a **filter** box (type to filter by repo or branch name).
- Repos are grouped; under each, one row per worktree with:
  - a **status dot** (green = all services running, amber = some running, faint = idle),
  - the **branch** name (monospace),
  - a subtitle: `N running` or `idle`.
- The **active** worktree is highlighted with a teal rail.
- Bottom: **New worktree** button.

### 4.2 Worktree header (right pane, top)
- **Branch name** with a fork glyph.
- **Icon cluster**: open in **editor**, reveal in **Finder**, open **terminal** (all at the worktree path).
- **Setup** — runs the repo's provisioning `setup` commands for this worktree.
- **Start all / Stop all** — the primary button; boots or stops every service.
- **⋯ overflow menu**:
  - **Copy worktree path**
  - Your repo's **custom command buttons** (see §9)
  - **Add command…** (opens Settings)
  - **Remove worktree** (in red; disabled for the main checkout)
- **Status line** below: `<repo> · in sync with origin | ↑ahead ↓behind · clean | uncommitted changes · <last commit>`, with a **Pull** button on the right.

While setup/a command is running, a live progress strip appears under the header.

### 4.3 Services section
One card per service — see §6.

### 4.4 Database section
A card for the worktree's database — see §8.

### 4.5 Logs panel
Fills the remaining height — see §14.

---

## 5. Adding a repository (onboarding)

The first time you launch Canopod (no repos yet), or whenever you click **＋ Add repository**, a 5-step
wizard opens:

1. **Repository** — choose the repo folder (Browse or type a path). Canopod verifies it's a git repo and
   reads its branch and origin.
2. **Stack** — Canopod guesses the framework (Node, Next.js, NestJS, Rails, Django, Go, Rust…). Confirm or
   change it.
3. **Services** — Canopod reads the repo's `package.json` scripts and suggests services (e.g. `start`,
   `start:dev`). Toggle which ones Canopod should run per worktree.
4. **Commands** — pre-filled database commands (reset / migrate), per-worktree env overrides, and setup
   steps. Edit or toggle any of them.
5. **Review** — a summary of everything Canopod will save. Confirm to add the repo.

On finish, Canopod saves your service/command configuration and writes the repo's provisioning file
(`.worktreemanager.json`). You can change anything later in **Settings**.

> **Note:** auto-detection reads `package.json`. For non-Node stacks it detects the stack but you
> configure the services/commands yourself.

---

## 6. Services

A **service** is a long-running process for a worktree. Each service has:

| Field | Meaning |
|---|---|
| **id** | Stable identifier (e.g. `frontend`, `server`). Used to build the port variable name (see §7). |
| **name** | Display name (e.g. "Frontend"). |
| **kind** | `web` · `server` · `worker` — affects the icon and which service is treated as the browser-openable "client". |
| **command** | The shell command that starts it (e.g. `npm start -- --port $PORT`). |
| **cwd** | Working directory, relative to the worktree root (e.g. `frontend`). Blank = worktree root. |
| **basePort** | The base port for this service (see §7). |
| **env** | Extra environment variables for this service. |

### Service card (main window)
Each service shows:
- a **status dot** (green running / amber busy / faint stopped),
- the **name**,
- the **port chip** `:3000` — click to open `localhost:3000` (when running); hover the **✎** to edit the port,
- a live **CPU sparkline**,
- **CPU · MEM · Uptime** stats,
- **Restart** and **Start/Stop** controls (appear on hover / when stopped).

### Editing a port
Hover the port chip and click **✎**, type a new port, press Enter. Canopod validates it, re-derives any
dependent env keys, and auto-restarts the service if it was running. The override persists.

---

## 7. Ports — how they're assigned & named

Canopod assigns **deterministic, non-colliding ports** to each worktree so multiple branches can run at
once.

### The formula
```
effective port = explicit override (if set)
                 else basePort + (worktree index × 10)
```
- Each worktree has a **stable index**. The **main checkout is index 0** (so it keeps the base ports).
  Each new worktree gets the lowest free index (1, 2, 3…), persisted so ports never shuffle.
- **Example** — a service with `basePort: 3000`:
  - main checkout (index 0) → **3000**
  - 2nd worktree (index 1) → **3010**
  - 3rd worktree (index 2) → **3020**
- An explicit **per-service override** (set via the port ✎ editor) takes precedence over the formula.

### Port variables (what to use in commands / .env)
For a service with **id** `frontend`, Canopod exposes its effective port under these names:

| Variable | Where it works | Notes |
|---|---|---|
| `$PORT` | service's own start command | Set to *this* service's own port. Simplest for a service starting itself. |
| `$WT_FRONTEND_PORT` | setup, custom commands, **and** running services | Documented form. `WT_<ID>_PORT` where `<ID>` is the service id, uppercased. |
| `$WM_PORT_FRONTEND` | setup, custom commands, **and** running services | Back-compat alias, same value. |

- Use **`$PORT`** in a service's own command: `npm start -- --port $PORT`.
- Use **`$WT_<OTHER>_PORT`** (or `$WM_PORT_<OTHER>`) to point one service at another. Example — a frontend
  that needs the server's URL: `--api http://localhost:$WT_SERVER_PORT`.

### Where ports live
Overrides and each worktree's index are stored in Canopod's runtime state (not hand-edited).

---

## 8. Databases — how names are generated & isolated

Each worktree gets its **own database**, so branches don't share data or migrations.

### The database name
```
WT_DB_NAME = <repo>_<slug>
```
- `<slug>` is derived from the **worktree folder name**: lowercased, with every non-alphanumeric
  character replaced by `_`.
- **Example** — repo `tooljet`, worktree folder `feature/my-branch` → slug `feature_my_branch` →
  database `tooljet_feature_my_branch`. (A worktree folder named `feature_x` → `tooljet_feature_x`.)

### How isolation works
All worktrees share the **same Postgres server** (same host/port/user/password, copied from the main
checkout's `.env`); they differ only by **database name**. The name is set in the worktree's `.env` via
`PG_DB` (typically `PG_DB=${WT_DB_NAME}` in your provisioning config).

Connection settings are read from the worktree's `.env` using standard keys:

| .env key | Default if unset |
|---|---|
| `PG_DB` | *(required for DB features)* |
| `PG_HOST` | `localhost` |
| `PG_PORT` | `5432` |
| `PG_USER` | `postgres` |
| `PG_PASS` | *(none)* |

### Database card actions (main window)
- **`db_name ▾` picker** — searchable list of all databases on the server; pick one to **switch** (rewrites
  `PG_DB` and restarts the server for that worktree).
- **⋯ actions menu**:
  - **Run migration** — runs the repo's migrate command.
  - **Save snapshot…** — clones the current DB to a named copy (default `<db>_snap_<timestamp>`).
  - **Export to file…** — `pg_dump` to a `.dump` file you choose.
  - **Restore from file…** — restore a `.dump`/`.backup` (via `pg_restore --clean`) or a `.sql` (via `psql`)
    into the current database.
  - **Reset database** — destructive; runs the repo's reset command.

> **Requirement:** the DB features use Postgres client binaries **matching your server's major version**
> (Canopod picks a matching `pg_dump`/`pg_restore` from Postgres.app or Homebrew, falling back to `$PATH`).
> These features assume **Postgres**.

---

## 9. Custom command buttons

Custom commands are your own one-off scripts, surfaced as buttons in the worktree header — for things
like linting, seeding data, generating code, running a specific test suite, etc.

### Defining them
In **Settings**, per repository, add **Custom commands** as `{ label, command }` pairs:
- **label** — the text shown in the menu (e.g. "Lint", "Seed demo data").
- **command** — the shell command to run.

### How they behave
- They appear in the worktree header's **⋯ menu** under **Custom commands**.
- Clicking one runs the command **in that worktree's root**, on the worktree's pinned Node, through your
  login shell — the same execution model as Setup/migrate.
- Progress is shown as toasts; the command's output also streams to the logs.
- **All provisioning variables are available** (see §12): `$WT_PATH`, `$WTM_REPO`, `$WT_<SERVICE>_PORT`,
  `$WT_DB_NAME`, `$WT_SLUG`, etc.

**Example custom commands**
| Label | Command |
|---|---|
| Lint | `npm run lint` |
| Seed | `npm run db:seed` |
| Open DB | `psql $WT_DB_NAME` |
| Typecheck | `npm run typecheck` |

---

## 10. Worktree lifecycle

### Create (New worktree)
1. Pick the **repository**.
2. Choose **New branch** (name + a base branch/tag to fork from) or **Existing branch / tag** (searchable
   picker of local branches, remote branches, and tags).
3. **Fetch all** refreshes remote branches/tags first if needed.
4. On create, Canopod: runs `git worktree add` → initializes submodules → applies your `env` overrides →
   runs the `setup` commands. Progress streams live.

### Setup
The **Setup** button re-runs the repo's `setup` commands for a worktree (e.g. after changing deps).

### Pull (submodule-aware)
The **Pull** button runs `git pull --ff-only` and then **advances submodules**: each submodule is pulled
if it's on a branch, updated to its pinned branch tip if `.gitmodules` tracks one, or synced to the
recorded commit otherwise. A summary toast reports what happened.

### Remove
The ⋯ menu → **Remove worktree** opens a confirm dialog:
- a **dirty precheck** warns about uncommitted changes (including in submodules),
- **Also delete branch** (off by default),
- **Drop database** (on by default) — runs the repo's `teardown` before deletion.

Canopod stops services → runs teardown → removes the worktree → optionally deletes the branch → prunes.

---

## 11. Configuration — the three layers

Config lives in **three** places. Know which is which.

### 11.1 App Settings (per machine)
Edited in-app via the **Settings** gear. Holds: your editor & terminal apps, and per repo: name,
worktree directory, reset-DB command, migrate command, the **services** table, and **custom commands**.

### 11.2 Repo provisioning — `.worktreemanager.json` (in the repo, travels with the branch)
Lives at the repo root (or `wtm.json`). Looked up in the **worktree first**, then the **main checkout**
(so an uncommitted copy in main works as a fallback; commit it to travel per-branch).

```jsonc
{
  "env": {                                   // add-or-replace keys in the worktree's .env
    "PG_DB": "${WT_DB_NAME}",                 // isolated database name
    "PORT": "${WT_SERVER_PORT}",              // service port
    "TOOLJET_HOST": "http://localhost:${WT_FRONTEND_PORT}"
  },
  "setup":   [ "npm install", "npm run db:create && npm run db:migrate" ], // run on worktree create / Setup
  "migrate": [ "npm run db:migrate" ],       // run by "Run migration"
  "teardown":[ "npm run db:drop" ]           // run on remove when "Drop database" is checked
}
```
- `env` values are templates: `${VAR}` tokens are interpolated with the worktree's variables (§12) and
  written into the worktree's `.env` (add-or-replace, preserving other lines).
- `setup` / `migrate` / `teardown` commands run in the worktree root, on the pinned Node, with all
  variables exposed as `$VAR`.

### 11.3 Runtime state (per machine — don't hand-edit)
Canopod stores each worktree's stable **port index**, any **port overrides**, and process bookkeeping in
its state file. This is what keeps ports stable across restarts.

---

## 12. Variables reference

Available to `env` values (as `${VAR}`) and to setup/migrate/teardown/custom commands (as `$VAR`):

| Variable | Value |
|---|---|
| `${WT_SLUG}` | DB-safe worktree id — the worktree folder name, lowercased, non-alphanumeric → `_`. |
| `${WT_DB_NAME}` | `<repo>_<slug>` — the worktree's isolated database name (e.g. `tooljet_feature_x`). |
| `${WT_INDEX}` | The worktree's stable port index (main checkout = 0). |
| `${WT_<SERVICE>_PORT}` | A service's effective port, by service id uppercased — e.g. `${WT_SERVER_PORT}`, `${WT_FRONTEND_PORT}`. |
| `$WT_PATH` / `$WTM_WORKTREE` | Absolute path to the worktree. |
| `$REPO_PATH` / `$WTM_REPO` | Absolute path to the repo's main checkout. |
| `$PORT` | (Service commands only) the service's own effective port. |
| `$WM_PORT_<SERVICE>` | Back-compat alias of `$WT_<SERVICE>_PORT`. |
| `$WM_WT_SLUG` | Back-compat alias of `$WT_SLUG`. |

---

## 13. Shell & toolchain

- **Shell:** Canopod runs every command through your shell (from `$SHELL`, e.g. zsh/bash/fish), as a
  **login shell**, so your PATH and version managers (nvm/asdf/volta/rbenv/pyenv…) initialize exactly as
  in your terminal.
- **Node version:** if a worktree pins a Node version (`.nvmrc`, `.node-version`, or `.tool-versions`),
  Canopod locates that version (asdf/nvm/fnm installs) and puts it first on PATH for that worktree's
  commands — so engine-strict installs use the right Node. If it can't find the pinned version, it falls
  back to whatever Node your login shell resolves.
- **Other languages** (Ruby/Python/Go…) resolve automatically through the login shell + your shim manager
  (rbenv/pyenv/asdf) reading the directory's version file.

---

## 14. Logs

The **Logs** panel (bottom of the worktree view) has:
- A tab per service, plus an **All** tab (merged, time-ordered, each line tagged with its `[service]`).
- A live status dot per tab.
- **Auto-scroll** that pauses when you scroll up.
- **Clear** to empty the active tab.
- A bounded ring buffer (recent lines).

Setup / custom-command / migration output also streams here as it runs.

---

## 15. Settings reference

Open with the **Settings** gear. Contains:
- **Editor** — the command used for "Open in editor" (e.g. `code`).
- **Terminal** — the app used for "Open terminal".
- **Repositories** (add via folder picker), each with:
  - **Name**, **Worktree directory** (where new worktrees are created),
  - **Reset-DB command**, **Migrate command**,
  - **Services** table — id / name / kind / command / cwd / basePort / env,
  - **Custom commands** — label + command pairs (§9),
  - **Env overrides** and **Setup commands** — written to the repo's `.worktreemanager.json`.

---

## 16. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| App won't open ("damaged" / "unverified") | Quarantine — run `xattr -dr com.apple.quarantine /Applications/Canopod.app`. |
| Setup fails with wrong Node / `notsup` | The repo needs a Node version that isn't installed, or your manager isn't found. Install the pinned version. |
| Frontend hits the wrong API port | Set the server URL from a port variable (`http://localhost:${WT_SERVER_PORT}`) in your `env`, and start the frontend with `--port $PORT`. |
| DB action fails on version | Install the Postgres version matching your server's major version. |
| A service shows stopped but its port is busy | Another worktree or a stale process holds the port. Stop the other worktree, or change this service's port. |
| A command can't find my tools | Canopod uses `$SHELL` as a login shell — make sure your PATH/manager setup is in that shell's profile. |

---

## 17. Limitations

- **macOS (Apple Silicon) only.**
- **Database tooling assumes Postgres** — snapshot / switch / export / restore / reset are Postgres-only.
  Other databases still work as services, but those DB actions won't.
- **Auto-detection is Node-centric** — non-Node stacks are detected but services are configured manually.
- Distributed builds are currently **ad-hoc signed, not notarized** (one-time `xattr -dr com.apple.quarantine` on install).

---

## 18. Glossary

| Term | Meaning |
|---|---|
| **Worktree** | A branch checked out into its own folder via `git worktree`. |
| **Service** | A long-running process (web/server/worker) started by a command. |
| **basePort** | A service's starting port; the effective port = `basePort + index×10` (or an override). |
| **Index** | A worktree's stable slot number (main = 0) used to space its ports apart. |
| **Slug** | DB-safe form of the worktree folder name (lowercased, non-alphanumeric → `_`). |
| **Provisioning** | The `env` + `setup` steps that prepare a worktree (from `.worktreemanager.json`). |
| **Custom command** | A user-defined `{label, command}` button that runs in the worktree root. |
