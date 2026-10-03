# Canopod documentation — plan

Source of truth for this repo: the Canopod app at `~/learnSpace/worktreemanager`, branch
`ux-font-zoom-and-fixes` (version **0.4.7**). Everything documented here was read out of that
tree — frontend (`src/`), backend (`src-tauri/src/`), config (`src-tauri/tauri.conf.json`),
CI/release workflows, and the existing `docs/*.md`. Where the app says a feature is
"coming soon" / not wired, the docs say so too. **No invented behaviour.**

---

## 1. Goals

1. A complete, organised **documentation website** for Canopod — every feature, every screen,
   every setting, every variable, every keyboard shortcut.
2. Install instructions for **macOS, Windows and Linux**, honest about what is supported.
3. A **step-by-step onboarding** path: install → add repository → first worktree → run services.
4. Settings split into **platform level** (Canopod itself) and **worktree/repository level**.
5. **Guides** (task-oriented), **examples** (real configs), **dev setup** and **prod setup**.
6. **Screenshots on every page**, in **both light and dark mode**, theme-aware in the browser.

## 2. Non-goals

- Not a marketing site. No pricing, no testimonials.
- No feature that does not exist in 0.4.7. "Coming soon" surfaces are documented as such.
- No external runtime dependencies in the published site (no CDN, no analytics).

---

## 3. Feature inventory (what must be covered)

Confirmed by reading the source. Each bullet maps to at least one documentation section.

### 3.1 Windows and surfaces
- **Main window** (`index.html` → `src/app/App.tsx`): top bar, sidebar, worktree bar,
  service rail, work surface (Logs / Terminal / Agent panes), status bar.
- **Menu-bar popover** (`popover.html` → `src/popover/Popover.tsx`): repo picker, search,
  status groups (Running / Starting / Idle), per-row actions, footer (New worktree,
  Open Manager, Quit), health line with version.
- **Detached terminal window** (`terminal.html`): a popped-out agent/shell session.
- **Onboarding** (`src/onboarding/Onboarding.tsx`): empty state → add screen → provisioning →
  ready.
- **Settings** (`src/app/SettingsView.tsx`): 5 platform pages + 7 repository pages.
- **Tray icon**: click toggles popover (macOS NSPanel); Linux/Windows get a menu
  (Open Canopod / Quit Canopod).

### 3.2 Top bar
Brand, repo → branch breadcrumb, ⌘K search button, `N running` chip, agents chip,
"Needs you" / "All clear" attention chip, **Sync** (rescan + reconcile deleted worktrees),
**Settings**.

### 3.3 Sidebar
Filter field, repository filter (only with 2+ repos, ends in "Add repository… ⇧⌘N"),
"All worktrees" row, in-progress creation rows with live step text, groups
**Needs you / Pinned / Running / Idle**, per-row: status dot, branch, dirty pip, agent pip,
pin pip, quick actions (start/stop, terminal, editor, pin), multi-select (⌘-click, ⇧-click)
with a footer "Delete N" bar, **New worktree** button.

### 3.4 Worktree bar + next action
Branch, git chips (↑ahead ↓behind ● dirty), open-in-editor, ⋯ menu (Switch branch ⌘\,
Pull, Sync submodules ⇧⌘S, Run setup…, Database…, Context…, Reveal in Finder, Copy path,
Remove worktree…), and the **next action** button with its reason.

The next-action engine (`src/app/nextAction.ts`) priority order — document verbatim:
crash → agent waiting → setup never run → starting (busy) → behind origin → services stopped →
agent working (busy) → ahead + uncommitted → open :port → start agent.
Note the two documented gaps: `agentState` never returns `waiting` (TODO #54) and
`neverSetUp` always returns false (TODO #53).

### 3.5 Service rail
Per-service chip: status dot, name, port (click opens `localhost:<port>`), live CPU/MEM,
hover start/stop/restart; database chip; custom-command buttons (first is its own button,
the rest collapse into a grouped **Commands** popover).

### 3.6 Work surface
Panes: **Logs**, **Terminal**, **Agent**. Layout presets ⌘1–⌘5
(Runtime / Split / Agent / Shell / Terminal), a draggable split, "Custom" when hand-made.
Session tabs per pane with new/close/restart, **pop out** to a separate window and
**bring back**, an "ended" bar with Restart/Close, and the Agent pane's context bar.

### 3.7 Logs
One merged, time-ordered stream for the whole worktree; service filter chips; level filter
(Errors / Warnings / Info, with `ok` folded into Info); text search; Follow toggle;
Clear; crash fix-bar with "Jump to error" + "Restart"; 160-line ring buffer per service.

### 3.8 Status bar
Branch (opens Switch branch when enabled), ↑↓ counts, "uncommitted" chip → the
Uncommitted-changes modal, last-commit line, welded **Pull** split button with the
per-submodule popover (Pull everything ⌘⏎, Sync submodules ⇧⌘S, per-submodule pull and
branch switch), agent chip, layout cycle, "Needs you" bell.

### 3.9 Overview (⌘O)
Sections Needs you / Running / Idle; columns Worktree, Repo, Services, Agent, CPU, Memory,
Size (not measured yet — TODO #55), Git, actions; header Start all / Stop all.

### 3.10 Command palette (⌘K)
Suggested (the next action + up to 3 attention rows), Worktrees, Actions
(start/stop all, new worktree, add repository, pull all, start agent, open terminal,
5 layout presets, all worktrees, settings). Keyboard: ↑↓, ⏎, esc.

### 3.11 Attention queue ("Needs you")
Ranked: backgrounded-op failures + service crashes (sev 0) → agent waiting (1) →
setup never run (2) → completions (9). Dismiss, or open the notice detail modal.

### 3.12 Worktree lifecycle
- **Create** (New worktree modal): repo select, New branch (name + base) / Existing
  (branches, remotes, tags; in-use rows disabled), Fetch all, "You'll get" destination panel,
  optional **Agent handoff** (PR/issue + descriptions), live progress, **Run in background**.
  Backend: `git worktree add` → submodules → provision files → setup.
- **Setup** (Setup runner modal): step list parsed from `[k/n]:` markers, attaches to a run
  already in flight, Run in background, "Start services" on completion.
- **Switch branch** (⌘\): reuses dependencies (~0s), can create a branch, blocks branches
  checked out elsewhere, warns that uncommitted changes carry over.
- **Uncommitted changes**: Commit / Stash / Discard modes, per-mode file annotations,
  untracked handling, `discard` type-to-confirm for `git clean -fd`, the exact git command
  shown, submodule-only and conflict guards.
- **Remove**: dirty precheck (fails closed), Drop database (on), Also delete branch (off),
  background-able; multi-delete variant.
- **Sync-prune**: reconcile worktrees whose folders vanished, per-item branch/db choices.
- **Pull**: `git pull --ff-only` + submodules advanced; **Sync submodules** re-pins them.

### 3.13 Ports and databases
`effective port = override ?? basePort + index × 10`; main checkout is index 0; indices are
stable and reclaimed; per-service overrides via the Service detail modal (1024–65535,
clash detection against every other worktree).
Database name `<repoSlug>_<wtSlug>`; one Postgres server, isolated by database name via
`PG_DB` in the worktree's `.env`; `PG_HOST/PG_PORT/PG_USER/PG_PASS` defaults.
Database modal: switch (searchable), Save snapshot…, Export to file…, Restore from file…,
Reset database, Run migration. `pg_dump`/`pg_restore` are chosen to match the live server's
major version; 15-minute per-invocation cap.

### 3.14 Agents
Per-repo agent profiles (id, name, command, promptOnLaunch); first is default; picker when
more than one. Launch writes `.canopod/context.md` (with a self-ignoring `.gitignore`), then
runs the CLI as its own PTY with the composed prompt as the first argument.
Context editor: task title + markdown body (Write/Preview), PR/issue + descriptions, links,
"Runtime the agent inherits" (branch, ports, database), Copy as PR body, Start agent ⌘⏎.
Context is stored per worktree in `localStorage` (`canopod.ctx.<wtKey>`).

### 3.15 Provisioning (`.worktreemanager.json`)
`provision[]` (path, format `dotenv|json|yaml|text`, from, interpolate, keys) + `setup[]` +
`teardown[]` + `migrate[]`. Lookup order: the worktree's copy, then the main checkout;
`wtm.json` also accepted; legacy top-level `env` is folded into a leading `.env` entry.
Variables: `WT_SLUG`, `WT_INDEX`, `WT_DB_NAME`, `WT_<SERVICE-ID>_PORT`,
`WT_<SERVICE-NAME>_PORT`, `WT_PATH`, `REPO_PATH`, `$PORT` (a service's own port), plus the
`WM_*` back-compat aliases.

### 3.16 Shell and toolchain
Every command runs through the user's login shell; a worktree's pinned Node
(`.nvmrc` / `.node-version` / `.tool-versions`) is located in asdf/nvm/fnm installs and
prepended to PATH; other language managers resolve through the login shell.

### 3.17 Appearance
Theme (dark / light / match system), density (comfortable / compact), accent
(teal / green / amber / violet), **text zoom ⌘+ / ⌘- / ⌘0** (0.8–1.6, 10% steps).
Stored in `localStorage` under `canopod.appearance`, applied live to every window.

### 3.18 Settings pages
- Platform: **General** (editor command, Show switch-branch action, Appearance),
  **Terminal** (terminal app; embedded shell = coming soon), **Notifications** (coming soon),
  **Shortcuts** (full reference table), **Advanced** (version, config path, experiments,
  reset — mostly coming soon).
- Repository: **General** (name, path, worktree root, export/import config, danger zone),
  **Services**, **Agents**, **Commands** (reset/migrate + custom commands with groups and
  "Test in current worktree"), **Files** (provisioned files, 4-step editor, Insert variable),
  **Setup** (ordered tasks, dry run = coming soon), **Security** (coming soon).
- Shell: ⌘F search-all-settings overlay, ⌘P JSON preview, ⌘S save, per-section dirty markers,
  the repository picker as the scope divider.

### 3.19 Storage locations
`settings.json` and `state.json` in the platform app-config dir
(macOS `~/Library/Application Support/com.midhunkumare.canopod/`), logs in the platform log
dir (`~/Library/Logs/…/canopod.log`), appearance + per-worktree context in `localStorage`,
pins/multiselect in `localStorage`.

### 3.20 Architecture facts worth documenting
Rust owns all state; both windows hydrate via `get_tree` and patch from events
(`tree:changed`, `service:status`, `service:log`, `service:stats`, `worktree:git`,
`reset:status`, `worktree:op`, `terminal:data`, `terminal:exit`); single-instance plugin;
process groups + SIGTERM→SIGKILL; orphan sweep on launch; strict CSP with a CI regression
guard; 62 IPC commands.

---

## 4. Information architecture

```
Home  (what Canopod is, the 60-second model, screenshot)
│
├── Getting started
│   ├── Install — macOS            (Homebrew, DMG, quarantine, Apple Silicon)
│   ├── Install — Windows          (NSIS .exe, untested-port caveats, prerequisites)
│   ├── Install — Linux            (.deb / .rpm / .AppImage, tray caveats, deps)
│   ├── Onboarding, step by step   (empty state → add repo → provisioning → ready)
│   └── Your first worktree        (create → setup → start → open → clean up)
│
├── Using Canopod
│   ├── The main window            (top bar, sidebar, worktree bar, rail, status bar)
│   ├── The next action            (the engine, all ten states, the four surfaces)
│   ├── Worktrees                  (create, switch branch, pull, sync, remove, prune)
│   ├── Services and ports         (rail, service detail, the port formula, overrides)
│   ├── Databases                  (naming, isolation, switch/snapshot/export/restore/reset)
│   ├── Logs                       (merge, filters, search, follow, crash recovery)
│   ├── Terminals and agents       (sessions, layouts, pop-out, context handoff)
│   ├── The menu-bar popover       (rows, groups, actions, footer, health)
│   ├── Command palette + overview (⌘K, ⌘O)
│   └── Keyboard shortcuts         (the full table, by scope)
│
├── Settings
│   ├── Platform settings          (General, Terminal, Notifications, Shortcuts, Advanced)
│   ├── Repository settings        (General, Services, Agents, Commands, Files, Setup, Security)
│   └── Where settings live        (files, localStorage, logs, per-platform paths)
│
├── Configuration reference
│   ├── .worktreemanager.json      (full schema, every field, lookup order)
│   ├── Variables                  (every variable, where it works, worked examples)
│   └── settings.json / state.json (shapes, do-not-edit notes)
│
├── Examples
│   ├── Node + Postgres app        (end-to-end, from scratch)
│   ├── ToolJet (monorepo + submodules)
│   └── Non-Node stacks            (Rails / Django / Go / Rust patterns and limits)
│
├── Development
│   ├── Dev setup                  (prereqs, run, build, test, project layout, mock mode)
│   └── Production / release       (CI matrix, tagging, DMG steps, signing, notarization)
│
└── Reference
    ├── IPC + events               (every command and event)
    ├── Troubleshooting            (symptom → cause → fix)
    └── Limitations and roadmap    (what is not wired yet, with issue numbers)
```

Total: **30 pages** (the tree above expanded to 30 once "Using Canopod" was split the way the app's
surfaces actually divide).

---

## 5. Site implementation

- **Zero runtime dependencies.** Content is Markdown in `content/`; `scripts/build.mjs`
  renders it to static HTML in `site/` with a shared layout. No npm install needed to build.
- **Renderer**: a small purpose-built Markdown subset (headings with anchors, paragraphs,
  lists, tables, fenced code with language labels, inline code, bold/italic, links, images,
  blockquotes, `:::note/tip/warn/danger` callouts, `{{screenshot}}` shortcode).
- **Layout**: fixed header (brand, search, theme toggle), left nav grouped exactly as the IA
  above, right-hand "On this page" table of contents, prev/next footer.
- **Design**: light-first palette matching Canopod's own tokens (teal accent `#0f9aa2` in
  light, `#5cc7cd` in dark), Inter-ish system sans + system mono, 1120px content column.
- **Dark mode**: CSS custom properties on `:root`, `@media (prefers-color-scheme: dark)`
  guarded with `:root:not([data-theme="light"])`, plus `:root[data-theme="dark"]` so the
  toggle wins both ways. Choice persisted in `localStorage`.
- **Screenshots**: every `{{screenshot}}` emits a `<figure>` with `<picture>` containing the
  dark source under `prefers-color-scheme: dark` **and** a `data-theme`-driven swap in the
  toggle's inline script, so images follow the page theme.
- **Search**: a build-time JSON index of every heading; client-side filter in the header.
- **Dev server**: `node scripts/serve.mjs` — rebuild-on-request static server, no deps.
- **Prod**: `node scripts/build.mjs` → `site/`, deployable to GitHub Pages
  (`.github/workflows/pages.yml`, no Jekyll).

## 6. Screenshot plan

Driven by `scripts/screenshots.mjs` (Playwright, resolved from the Canopod repo's
`node_modules`) against `npm run dev` in the Canopod repo (Vite, port 1420). In a plain
browser `hasBackend()` is false, so the app runs on `src/mock.ts` — three repos, five
worktrees, live-ticking stats and logs. Theme, density, accent and text zoom are seeded
into `localStorage` before load, so light and dark runs are pixel-identical apart from
the palette.

Order of work — **light first, completely, then dark** (so the two sets can never be
confused mid-flight):

1. Build the whole site with light-mode screenshots in `assets/screens/light/`.
2. Re-run the same script with `THEME=dark` into `assets/screens/dark/`.
3. Both sets share filenames; the layout swaps them by theme.

Shot list (each captured in both themes):

| # | File | Surface |
|---|------|---------|
| 1 | `main-worktree` | worktree view, Runtime layout |
| 2 | `main-topbar` | top bar, cropped |
| 3 | `main-sidebar` | sidebar, cropped |
| 4 | `main-rail` | service rail + commands, cropped |
| 5 | `main-statusbar` | status bar, cropped |
| 6 | `layout-split` | ⌘2 split logs + agent |
| 7 | `layout-agent` | ⌘3 agent pane empty state |
| 8 | `layout-terminal` | ⌘5 terminal pane empty state |
| 9 | `logs-filters` | level filter popover open |
| 10 | `palette` | ⌘K |
| 11 | `attention` | "Needs you" popover |
| 12 | `overview` | ⌘O |
| 13 | `modal-service` | service detail |
| 14 | `modal-database` | database tools |
| 15 | `modal-context` | context editor |
| 16 | `modal-new-worktree` | new worktree |
| 17 | `modal-new-worktree-handoff` | agent handoff expanded |
| 18 | `modal-switch-branch` | switch branch |
| 19 | `modal-remove-worktree` | remove worktree |
| 20 | `modal-uncommitted` | uncommitted changes |
| 21 | `worktree-menu` | ⋯ overflow menu |
| 22 | `pull-menu` | status-bar pull popover |
| 23 | `settings-general` | Settings → General |
| 24 | `settings-shortcuts` | Settings → Shortcuts |
| 25 | `settings-advanced` | Settings → Advanced |
| 26 | `settings-terminal` | Settings → Terminal |
| 27 | `settings-notifications` | Settings → Notifications |
| 28 | `settings-repo` | Settings → Repository |
| 29 | `settings-services` | Settings → Services (expanded) |
| 30 | `settings-agents` | Settings → Agents |
| 31 | `settings-commands` | Settings → Commands |
| 32 | `settings-files` | Settings → Files |
| 33 | `settings-setup` | Settings → Setup |
| 34 | `settings-security` | Settings → Security |
| 35 | `settings-json` | ⌘P JSON preview |
| 36 | `settings-search` | ⌘F search overlay |
| 37 | `onboarding-empty` | first-run hero |
| 38 | `onboarding-add` | add-repository screen |
| 39 | `popover` | menu-bar popover |
| 40 | `zoom` | text zoom at 130% |

## 7. Execution order

1. `git init`, `plan.md` (this file). ✅
2. Build system: `scripts/build.mjs`, `scripts/serve.mjs`, layout, CSS. ✅
3. Write all content pages (light-mode site). ✅ — 30 pages
4. Capture the 40 light screenshots; wire them into pages; build; verify. ✅
5. Capture the 40 dark screenshots; verify the theme swap. ✅
6. `README.md`, `.gitignore`, Pages workflow; final build; commit. ✅

## 8. Verification checklist

- [x] `node scripts/build.mjs` completes with no missing-content or missing-screenshot warnings, and
      writes 30 pages.
- [x] Every page has a title, a nav entry, a TOC and prev/next links.
- [x] Every `!shot` resolves to a file that exists in **both** light and dark sets — the build prints
      "Every screenshot resolves in both themes."
- [x] No external asset references: zero `src="http…"`, zero remote stylesheets. The only absolute
      URLs are 14 prose links to github.com.
- [x] The toggle switches theme in both directions, from either OS preference, and survives a reload
      (verified by script: OS-dark → toggle → light → reload → still light, and the mirror case).
- [x] Screenshots swap with the theme, verified by computed style rather than by eye.
- [x] Search returns hits (12 pages for "port"), and there are no console errors or failed requests
      on any checked page.
- [x] Five documented facts re-checked against the source before committing: the port formula and
      index reclamation (`state.rs`), the database-name construction (`state.rs`), the config lookup
      order and legacy-`env` migration (`setup.rs`), the next-action priority order and its two
      unreachable states (`nextAction.ts`), and the shortcut table (`SettingsView.tsx` + `App.tsx`).
