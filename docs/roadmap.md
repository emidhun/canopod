# Status & roadmap

Today's execution order, effort budgets and completion checklist are in
[the adoption plan](adoption-plan.md#today-october-1) (2026-10-01): release/docs
audit → onboarding fixes → first-workspace validation → agent connection checks
→ recipe/user-session materials → final validation. The bounded checklist is complete;
broader adoption and MCP requirements remain tracked separately. The inventory
below is historical and requires reconciliation with current code and releases.

## Delivered
- v1 core: popover + main window, worktree discovery/create/delete with submodule object-sharing,
  per-service start/stop/restart, live logs, CPU/MEM/uptime, settings, Reset DB, Pull (submodule-aware).
- Provisioning: `.worktreemanager.json` — generalized **`provision`** array (seed + key-upsert for
  dotenv/json/yaml, copy + interpolate for text, at any subpath; legacy `env` auto-migrates), plus
  `setup`/`migrate`/`teardown`; per-worktree isolated DB + deterministic ports, pinned-Node handling.
- Settings: repo-nav + tabbed detail layout (General / Services / Commands / Files / Setup) with a
  live config preview and import/export.
- In-place branch switch (submodule-aware) and per-submodule pull/branch-switch from the header.
- Branding: Canopod brandmark (app icon, tray, in-app mark).
- DB tools: switch database, save snapshot, export to file, run migration, drop-on-delete — in an
  inline database bar in the worktree header.
- Per-service port override (editable port chip; validates, re-derives env, auto-restarts).
- Commands run through the user's own shell (`$SHELL`), not a hardcoded zsh.
- CI: ubuntu + macos jobs (`cargo check`/`cargo test` + frontend build) so the Linux code paths
  compile on every push.

## Follow-ups (offered, not requested — none block anything)
1. **Notarization** — removes the install warning. (See distribution.md.)
2. **Port-index reclamation on delete** — removed worktrees still hold their `portIndices` slot, so
   indices climb over time. Free it in `remove_worktree` (clear from `RuntimeState.port_indices`).
3. **Global "Stop all worktrees"** — today Stop-all is per-worktree; only Quit stops everything.
4. **"Reset to default" for a port override** — clear the `portOverrides` entry from the UI (currently
   revert by typing the derived `basePort + index*10`).
5. **Edit `migrate`/`teardown` in Settings UI** — shown read-only in the Files preview today.
6. **"Use shared backend" toggle**, **two-tone in-app mark**, **dropdown flip-up near screen bottom**,
   **universal (Intel) build**, **split SettingsView into per-tab modules**.

## Cross-platform (Linux / Windows) support
Released builds are macOS **arm64**. The Linux **and Windows** ports are code-complete and compile in
CI (dedicated `linux` + `windows` jobs, plus NSIS/deb/AppImage/rpm in the release matrix), with the
macOS-only pieces cfg-gated — but neither has been validated on a real desktop yet.

| Area | Status |
|---|---|
| Tray popover | ✅ cfg-gated: NSPanel on macOS, plain window + tray **menu** fallback elsewhere (appindicator delivers no click events) |
| Shell | ✅ user's `$SHELL` everywhere (zsh/bash/fish; `sh` fallback); Windows runs commands through **Git Bash** (`bash -lc`), keeping the POSIX model (`&&`, pipes, `export`) intact |
| Open editor / file manager / terminal | ✅ per-platform (`open` / `xdg-open` + terminal-emulator detection / `explorer` / `cmd start`) |
| Process control | ✅ POSIX process groups on macOS/Linux (`killpg`); ✅ Windows **Job Objects** (`KILL_ON_JOB_CLOSE` → OS reaps the tree on crash, so no orphan sweep needed) — see `src-tauri/src/proc.rs` |
| Postgres binaries | ✅ Windows `C:\Program Files\PostgreSQL\<maj>\bin` probed (Git-Bash PATH form); ❌ Linux distro paths (`/usr/lib/postgresql/<maj>/bin` etc.) still not probed — only Postgres.app + PATH |
| Pinned Node | ✅ nvm-windows / fnm / Volta layouts probed alongside asdf/nvm/fnm |
| Window chrome | ⚠️ `titleBarStyle: Overlay` is macOS-only (traffic-light inset now gated to the `mac` class); Linux/Windows get stock decorations — needs a look |
| Packaging | ⚠️ bundle targets include deb/AppImage/rpm/NSIS but artifacts are unbuilt/untested; signing story per-OS |
| Real-desktop validation | ❌ tray, popover positioning, DPI, transparency on Windows and under GNOME/KDE compositors |

**Effort:** Linux is *moderate* (pg-path detection + validation pass). Windows is now *code-complete*
(Job Objects replace the POSIX process-group/signal model), pending real-desktop validation.

**Known Windows limitations (follow-ups):** service stop is a hard `TerminateJobObject` (no graceful
CTRL_BREAK — a GUI app has no console); a PTY shell's background grandchildren may linger (portable-pty
doesn't expose the child HANDLE to job-wrap); the hidden main window stays in the taskbar (no
Accessory-mode equivalent); native (not custom) titlebar; no code-signing.

## v2+ (out of v1 scope)
- AI-agent workflows: run multiple coding agents in parallel, each in its own isolated, running
  worktree environment — the per-worktree DB/port isolation is the foundation.
