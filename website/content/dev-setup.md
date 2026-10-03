---
title: Building from source
description: Build and run Canopod from source, find your way around the code, and avoid the pitfalls already encountered.
---

# Building from source

Canopod is a Tauri 2 app: a Rust backend, a React and zustand frontend built by Vite, and three webview
entry points.

## Prerequisites

| Tool | Notes |
|---|---|
| **Rust** (rustup) | `source "$HOME/.cargo/env"` to put `cargo` on `PATH`. |
| **Node 22+** | The repo pins `nodejs v22.15.1` in `.tool-versions`. Vite 8 needs a modern Node. |
| **Xcode Command Line Tools** (macOS) | For `codesign`. |
| Linux system packages | `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`, plus `build-essential curl wget file libxdo-dev libssl-dev`. |
| Postgres and git | Only to exercise the features that need them. |

If your version manager's default Node is older than 22, put the pinned one first on `PATH` for build
commands:

```sh
export PATH="$HOME/.asdf/installs/nodejs/v22.15.1/bin:$PATH" && source "$HOME/.cargo/env"
```

## Commands

```sh
npm install            # once

npm run dev            # Vite only, on http://localhost:1420 (browser, mock data)
npm run tauri dev      # the full app: both windows + the tray, hot-reloading
npm run build          # tsc type-check + Vite build of the frontend
npm run tauri build    # release bundle (see Shipping a release)
npm run csp:check      # load the built pages under the shipped CSP in headless Chromium
```

From `src-tauri/`:

```sh
cargo check            # fast Rust check
cargo test --lib       # unit tests (includes the CSP regression guard)
cargo clippy --all-targets --features devtools -- -D warnings
```

CI treats warnings as errors, so run clippy before you push.

## Project layout

```text
index.html  popover.html  terminal.html      three webview entry points
src/
  main.tsx        app/App.tsx                the main window
  popover.tsx     popover/Popover.tsx        the menu-bar window
  terminal-window.tsx                        a detached terminal window
  onboarding/Onboarding.tsx                  first run + add repository
  app/canopod/*                               the redesigned shell: TopBar, SidebarNav,
                                             WorktreeView, ServiceRail, WorkSurface,
                                             LogsPane, StatusBar, Palette, modals
  app/nextAction.ts                          the workflow engine
  store.ts                                   zustand store + event subscriptions
  ipc.ts                                     typed IPC surface (invoke + events)
  types.ts  appearance.ts  mock.ts  icons.tsx
  styles/*.css                               tokens + shell + components + modals
src-tauri/src/
  lib.rs        app setup, plugins, window management
  commands.rs   every #[tauri::command]
  state.rs      the tree, port indices, worktree variables
  settings.rs   settings.json / state.json
  setup.rs      provisioning: config parsing, file templating, the setup runner
  services.rs   process table, spawn/stop, log ring buffers
  terminal.rs   PTY sessions for the agent lane
  git.rs        every git operation
  db.rs         Postgres helpers
  toolchain.rs  pinned-Node discovery
  tray.rs       tray icon + the macOS NSPanel popover
  stats.rs proc.rs error.rs csp.rs
```

## Mock mode

`hasBackend()` is false in a plain browser, so `npm run dev` at `http://localhost:1420` runs the whole
UI against `src/mock.ts`: three repositories, five worktrees, ticking stats, streaming logs, and
start/stop that behaves.

```sh
npm run dev
open http://localhost:1420/index.html      # the main window
open http://localhost:1420/popover.html    # the menu-bar window
```

Mock mode is good for layout, states, dialogs, keyboard behaviour, theming and screenshots. It can't
create or remove worktrees, run real setup, do database work, override ports, or open pop-out windows,
and it says so with a toast wherever that matters.

The screenshots in this documentation are captured this way. See
[Building a release](prod-setup.html#documentation-screenshots).

## Architecture

The Rust backend owns all state: registered repos, discovered worktrees, the process table, log ring
buffers, port indices and overrides. Both windows hydrate by calling `get_tree` (and `get_logs`), then
patch their local zustand store from backend events, and re-hydrate on window focus. That's implemented
once, in `store.ts`'s `initSync()`, and used by both windows; it *is* the sync mechanism. UI actions are
optimistic, and the authoritative event overwrites them. See
[Commands and events](reference-ipc.html).

## Conventions

**Comments explain why.** The codebase leans on short rationale comments above non-obvious decisions,
including the ones that record a trap somebody already fell into. Match that density.

**Backend honesty.** A control with no backend renders as coming soon and disabled, never as something
that looks functional. Wire one up and you delete its banner in the same change.

**One answer per question.** Anything offering "the next thing" routes through `nextAction()`, so the
four surfaces can't drift. Add a state there, not in a component.

**Fail closed on destructive paths.** A failed dirty-probe disables removal instead of assuming clean.

**Dialog keys**: `⏎` for a single-field prompt, `⌘⏎` when there's prose or several inputs.

## Debugging

| Want | Do |
|---|---|
| Backend logs | `RUST_LOG=debug npm run tauri dev`. The file is in the platform log dir. |
| Keep the popover open while inspecting it | `WTM_NO_BLUR_HIDE=1 npm run tauri dev`, since it otherwise hides on blur. |
| Frontend devtools | Right-click → Inspect in a dev build. |
| Check a release build actually paints | `npm run build && npm run csp:check`, which serves `dist/` under the shipped CSP and fails on any violation or blank page. |

## Known pitfalls

:::warn Read these before you start debugging
- **Node 18 vs 22.** With a default of 18, Vite fails and `engine-strict` installs fail with `notsup`.
  Canopod prepends a worktree's pinned Node for setup, services, reset, migrate, teardown and custom
  commands. Don't remove that (`toolchain.rs`).
- **`pg_dump` version.** It has to match the server's major version. `db.rs` queries
  `SHOW server_version_num` and prefers `Postgres.app/Versions/<major>/bin`. Neither the oldest on
  `PATH` nor the newest installed is right.
- **The DMG build hangs locally.** Tauri's `bundle_dmg.sh` drives Finder through AppleScript. Build
  app-only with `--bundles app` and make the DMG with `hdiutil`. CI bundles it fine.
- **Ad-hoc signing is required, not optional.** `bundle.macOS.signingIdentity: "-"` makes Tauri run a
  real `codesign` pass. Without it, the linker's per-binary signature seals resource metadata that
  doesn't survive copying the app off a DMG, and the app reports as "damaged".
- **BSD `sed`** doesn't support `0,/re/`. Use perl, python, or an editor for one-shot in-place edits.
- **Single instance.** The single-instance plugin has to stay first. A second instance's startup sweep
  would SIGTERM the first instance's services, and both would race on `settings.json`.
:::

## Tests

`cargo test --lib` runs the Rust unit tests, including port-index stability and reclamation, override
precedence, and the CSP regression guard that asserts the production policy still carries the
directives the app needs.

`npm run csp:check` runs Playwright and Chromium over all three entry points under the shipped CSP.

There's no frontend unit-test suite. The CSP check is what catches "the release build renders a blank
window".
