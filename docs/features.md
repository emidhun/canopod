# Features

## Menu-bar popover
- Per-repo group → per-worktree rows. Each row: branch name, service status chips (green=running,
  amber pulse=transitioning, faint=stopped), and actions:
  - **Globe** — open the web service in the browser (`localhost:<frontend port>`), enabled when running.
  - **Open worktree** (external-link) — open in the configured editor.
  - **Reset DB**, **Start/Stop** (whole worktree).
- Top: **Open Manager** (shows main window) and **Quit** (kills all processes).
- Anchors below the menu bar with a native gap; hides on blur.

## Main window
The window has a slim **top drag-bar** (clears the macOS traffic lights; drag to move the window) with the
Canopod mark on the left and **Sync external worktrees** + **Settings** icons on the right, then a
sidebar + main pane. Sync discovers worktrees registered by Git outside Canopod and offers to reconcile
registrations whose directories were deleted.

**Sidebar** — a flat list of every worktree (`Worktrees · N`), each row showing the branch (mono) and
`<repo> · <N running | idle>` with a status dot (green=all running, amber=partial, faint=idle). The active
worktree gets a teal rail. A filter at top, **New worktree** at the bottom.

**Worktree header**
- Branch name (mono) with a fork glyph, then the toolbar: a grouped **icon cluster** (open in editor /
  Finder / terminal) · **Setup** (run `.worktreemanager.json` setup) · **Start all / Stop all** (the only
  filled/primary control) · **⋯** overflow menu. The ⋯ menu holds **Copy worktree path**, the repo's
  **custom commands** (each runs in the worktree root on the pinned Node, progress as toasts), **Add
  command…** (opens Settings), and — set apart in red — **Remove worktree**.
- **Status line** below: `<repo> · in sync with origin | ↑a ↓b · clean | uncommitted changes · <last commit>`
  with a **Pull** button on the right.

**Services** — section `Services · N running`, one compact row per service: status dot, name, **port**
(`:3000`, opens localhost; hover **✎** edits it → validates, re-derives dependent env, auto-restarts), a live
**CPU sparkline**, CPU / MEM / uptime, and a hover **power** button to start/stop.

**Database** — section with a **`db_name ▾` picker** (searchable switch-database dropdown) on the left and a
**`⋯` actions menu** on the right: **Run migration** (repo's `migrateDb` Settings command, else
`.worktreemanager.json` `migrate`) · **Save snapshot…** (prompts for a name, default `<db>_snap_<timestamp>`;
clones the DB) · **Export to file…** (`pg_dump` to a chosen `.dump`) · **Restore from file…** (`pg_restore
--clean` a `.dump`/`.backup`, or `psql` a `.sql`, into the current DB) · and, set apart as destructive,
**Reset database** (repo's `resetDb` command).

**Logs panel** (fills the remaining height) — filter tabs **All** + one per service (with a live dot); in
**All** mode lines from every service are merged, time-ordered, and `[service]`-tagged. Auto-scroll pauses
when you scroll up; **Clear** empties the active filter. 160-line ring buffer per service.

## Worktree lifecycle
- **Create** (New worktree modal): pick repo, New branch (name + base) or Existing branch (searchable
  picker), **Fetch all** (`git fetch --all --prune --recurse-submodules`). On create: `git worktree
  add` → submodule init/update with `--reference` object-sharing → apply `env` → run `setup`. Streams
  progress.
- **Sync external worktrees** (top bar or command palette): refresh every configured repository from
  `git worktree list`, add worktrees created by another agent or terminal, and open the prune flow for
  stale registrations. Arbitrary copied directories are not imported.
- **Remove** (confirm modal): dirty precheck (incl. submodules), **Also delete branch** (off),
  **Drop database** (on). Stops services → runs `teardown` (drop DB) → `git worktree remove --force`
  → optional branch delete → prune.

## Settings
Add/remove repos (folder picker), per repo: name, worktree dir, reset-DB command, migrate command, services table
(id/name/kind/command/cwd/basePort/env), **Custom commands** rows (label + command → header buttons),
**Env overrides** rows, and **Setup commands** rows. Saving writes app settings (incl. `customCommands`)
+ the repo's `.worktreemanager.json` (env + setup).

## Pull (submodule-aware)
`git pull --ff-only`, then each submodule is **advanced** (not just pinned to the superproject
commit): pulled if it's checked out on a branch, updated to its pinned branch tip if `.gitmodules`
tracks one (e.g. ToolJet's `branch = lts-3.16`), or synced to the recorded commit otherwise. Returns
a summary surfaced in the toast (e.g. `pulled, 2 submodule(s) pulled`).

## 0.5.0 workspace refinements

Shell and agent sessions share Terminal and one add menu, with optional logs alongside. Layout shortcuts are ⌘1 Logs, ⌘2 Terminal, ⌘3 Terminal + logs. Settings uses a focused file editor, wider JSON preview, consistent controls and guarded saving. Database restore validates destinations and makes replacement explicit; reset can run in the background. Needs you supports dismissal of saved notifications and setup reminders, including Clear notifications. Reminder dismissal is session-only and never changes provisioning state.
