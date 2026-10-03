<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brandmark-dark.svg" />
    <img src="assets/brandmark-light.svg" width="84" alt="Canopod brandmark" />
  </picture>
</p>

# Canopod — Documentation

> **These pages predate the redesign.** They describe the older UI — service cards, a log tab per
> service, the five-step add-repository wizard — none of which the current build has. The maintained
> documentation is the site in [`../website/`](../website/); build it with
> `node website/scripts/build.mjs` and open `website/site/index.html`.

Canopod is a lightweight **menu-bar git-worktree + dev-service manager**. It discovers
every worktree of your registered repos, provisions each one (deps, isolated database, ports),
and lets you start/stop services, watch logs, manage databases, and change ports — from a tray
popover and a main window. Built for fast multi-repo / submodule workflows like ToolJet.
There's a 12-second demo in the [main README](../README.md).

- **Repo:** `github.com/emidhun/canopod`
- **Stack:** Tauri 2 (Rust backend) + React 19 + zustand
- **Platform:** macOS **arm64** (Linux port in progress — compiles in CI, not yet validated)
- **Bundle id:** `com.midhunkumare.canopod` · **settings:** `~/Library/Application Support/com.midhunkumare.canopod/`

## For users
- [user-guide.md](user-guide.md) — task-oriented walkthrough: install → add repo → provision → run →
  databases → pull → remove, with a troubleshooting table.
- [features.md](features.md) — reference for what every button/menu does.

## For developers (read in this order)
1. [architecture.md](architecture.md) — how the pieces fit (backend = source of truth, two windows, events)
2. [configuration.md](configuration.md) — `.worktreemanager.json`, app Settings, `state.json`, the variables
3. [features.md](features.md) — what every button/menu does
4. [backend.md](backend.md) — Rust module map, IPC commands, events
5. [development.md](development.md) — run/build/sign/DMG, the **must-know environment gotchas**
6. [distribution.md](distribution.md) — installing the DMG, signing/notarization, why no App Store
7. [roadmap.md](roadmap.md) — what's done, optional follow-ups, v2 ideas

## 60-second mental model
- The **Rust backend is the single source of truth.** The tray popover and the main window are
  dumb React renderers that hydrate via `get_tree` and stay in sync through Tauri **events**.
- A worktree's services (frontend/server/worker) are defined per-repo in app **Settings**.
- How a worktree is *provisioned* (env vars, install/build/migrate, teardown) is declared **in the
  repo** via `.worktreemanager.json` — so it travels with the branch and is zero-bash for the user.
- Each worktree gets an **isolated database** and **deterministic ports** (`basePort + index*10`,
  overridable per service).

## Conventions
- Commits to this repo **omit** the `Co-Authored-By` trailer (user preference).
- The original Claude Design handoff lives under `design/`; the brandmark bundle under `design/brand/`.
