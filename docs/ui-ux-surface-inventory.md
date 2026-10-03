# Canopod UI/UX surface and content inventory

Audit date: 2026-10-02. Companion to [the findings and revamp plan](ui-ux-audit.md).

This inventory reconciles the three UI entry points (`main.tsx`, `popover.tsx`, `terminal-window.tsx`), Settings catalog and Modal consumers. It covers active source surfaces, including content hidden behind disclosures and menus. **Source coverage is not exhaustive runtime verification.** Live means the installed macOS 0.5.0 surface was inspected; packaged content differs from current source. No permission changes, token rotation, reset, deletion, restore or configuration saves were performed.

## All 13 Settings pages

Every page below was opened in the installed app. Expanded editor content and available advanced sections were inspected. Dynamic object lists were sampled by object type; every possible user-created object was not executed. Source-only additions are distinguished below.

| Page | Content included in review | Nested content / states |
|---|---|---|
| App General | Editor command; switch-branch visibility; theme, density, accent, text zoom; automatic update checks; version/check/install feedback | Current source additionally includes automatic installation, GitHub star reminder and crash-report controls. Appearance applies immediately; other fields use Save. Update available/checking/installing/error states require fixture execution. |
| MCP | Enabled/status/error; repository access; capability permissions; Apply; agent client selection and custom config path; connection action/result; suggested first task | Manual transport/endpoint/header/token/config details; config disclosure; copy actions; Enable/Disable/Refresh; Rotate token inline confirmation opened and canceled. Permission application and connection lifecycle pending. |
| Terminal | External terminal application; shell program and arguments; font family/size; scrollback; cursor shape/blink; bell; worktree directory; inherited environment | Arguments disabled for auto-selected shell; settings apply to newly opened sessions; actual session effects pending. |
| Notifications | Service crash, agent decision, setup result, origin movement; sound; badge | Background-only explanation, switches, badge choice. Native notification delivery pending. |
| Shortcuts | Complete registry-driven command table; bindings; overrides; capture state; conflicts; individual reset; restore defaults | Fixed dismiss bindings, platform notation, blank/remapped bindings. Capture/remap not applied. |
| Advanced | Version/config path; Copy path/diagnostics; Open logs; experiment flags | Reset disclosure; clear caches/logs action; reset all inline confirmation opened and canceled. Loading/errors and reset execution pending. |
| Repository General | Name/path; reveal path; worktree root; default base branch; automatic setup; start after setup; isolated database | Config import/export; Danger disclosure; Remove repository modal opened and canceled. Filesystem pickers and actual removal pending. |
| Services | Every row's name/kind/command/base-port summary; name, command, directory, base port, derived-port example, kind | Extra environment and health-check advanced fields; add/duplicate/remove; empty and incomplete rows. Expanded installed service editors inspected; no commands run. |
| Agents | Name/command; default order; waiting phrases; prompt on launch | Make default/remove/add; worktree context, runtime facts, failing logs; max parallel and idle timeout; empty/incomplete profiles. |
| Commands | Reset database and migration command definitions; custom command list/order | Expanded label/command/group; run test and result; duplicate/move/remove/add; empty/incomplete command. Test target implementation reviewed without execution. |
| Files | File list, path/format/key count; selected file path and browse; source template and browse; interpolation; keyed values or text strategy | Variable picker; add/remove key; duplicate/remove/add file; disabled conflict/apply/file-mode advanced placeholders; migrate/teardown lifecycle commands. Current source lifecycle content reviewed; no file writes. |
| Setup | Ordered command tasks; enabled state; add/remove/move; working directory | Dry run; advanced stop/continue-on-failure and timeout. Policy inspected live; command execution and runner handoff reviewed in source. |
| Security | Mask preview secrets; omit export secrets; SSH key and credential-helper fields | Located under Repository but edits global `settings.security`; masking/template explanations; no credentials edited/exported. |

Settings shell content: App/Repository groups, selected repository and worktree count, repository picker/Add repository, page filter, cross-setting search, result/no-result state, page highlight, close, dirty footer/Save/Discard, incomplete-row validation, config-loading message, JSON preview with masking, More menu (Copy JSON, Export, Load repo file, Import) and hidden import file input. Preview and More opened live. Search for **update** returned no matches despite update controls being present.

## Every shared-Modal consumer

All 13 consumer components were included in source review. Database has an additional snapshot variant; Uncommitted changes has multiple workflow/error/loading variants. These are tracked separately rather than counted as new pages.

| Component / surface | Reviewed contents | Runtime evidence |
|---|---|---|
| `NewWorktreeModal` | Repository; branch/base/existing branch and ref picker; branch availability; handoff title/description; computed path/ports/database; setup/start choices; create/background/error | Opened live; actual create pending. |
| `RemoveWorktreeModal` | Exact worktree; dirty checks; local branch/database choices; warnings; cancel/remove/busy/background | Source; execution pending in disposable fixtures. |
| `RemoveWorktreesModal` | Selected list; per-item checks/options; clean/dirty summary; remove progress/partial outcome | Source; pending/error safety issue recorded UX-01. |
| `PruneWorktreesModal` | Missing-worktree candidates; selection; branch/database cleanup options; consequences; results | Source; fixture pending. |
| `SwitchBranchModal` | Current branch; existing/new branch choice; local refs; validation; apply/busy/error | Source; switching pending. |
| `UncommittedChangesModal` | File statuses/loading/failure; pull/switch/removal modes; commit message; stash/commit/discard; submodule constraints; typed destructive acknowledgment | Source; dirty fixtures and hung read pending. |
| `ContextModal` | Task title/description; links add/remove/open; context/handoff explanation; start agent; context persistence | Source; live editable content and autosave recovery pending. |
| `DatabaseModal` | Current database; snapshot/database list; activate; snapshot; migrate; export; restore; reset; job state/background | Opened live; list populated after initial empty presentation. Long database identifiers crowd/wrap action labels. |
| `DatabaseModal` snapshot variant | Snapshot name; target summary; create/Enter/cancel; busy/background/error | Opened and canceled live. |
| `RestoreDatabaseModal` | Dump picker/types; new/existing destination; name; activate after restore; replacement acknowledgment; restore progress/error | Opened and canceled live; no file selected or restore run. |
| `ServiceDetailModal` | Name/state/port; environment; port override; start/stop/restart/open; logs and busy/error | Source; action lifecycle pending. |
| `SetupRunnerModal` | Provisioning/task timeline; current/failed/completed steps; output tail; rerun/background/close | Source; opening can start setup, so real execution deferred. |
| `NoticeModal` | Notice target/status/detail/output; available retry/open/dismiss actions | Source; representative attention contents inspected live. |
| `RepoGeneralPage` removal confirmation | Repository name/path and stop-tracking consequences; cancel/remove | Opened and canceled live. |

Shared modal behavior also reviewed: title/subtitle/icon, initial focus, focus trap/return, Escape/backdrop, busy dismissal restrictions, footer actions and scrollable content.

## Remaining pages, panels and menus

| Surface | Content reviewed | Evidence / remaining work |
|---|---|---|
| Empty app / onboarding | No repositories; Add repository; stack choices; folder/path detection/loading/error; detected service summaries/editors, commands/cwd/ports/kind; provenance; advanced env rows/setup steps/database commands; existing config handling; provisioning steps/cancel/error; Ready actions; Connect to agent handoff | Source; fresh repository and each detection failure need live fixtures. |
| Workspace shell | Topbar repo/branch/search; running and attention counters; Sync; Settings; sidebar repo filter/add, worktree filter/groups/collapse/pinning/selection/multi-select/New | Live populated workspace; empty/no-match/large lists source. |
| Overview | Repository/branch, status, service/Git metrics, CPU/memory/disk, row next actions/overflow, bulk Start/Stop | Live screenshot and source; min window, filter and full keyboard tests pending. |
| Worktree page | Branch/repository/handoff identity; editor; More menu; setup alert/actions; service rail and database; custom commands and overflow; working panes | Live and source; services starting/crash/stopping and long-list fixture pending. |
| Logs | Service tabs; search; level filter menu; line counts; timestamps/level/message; copy/clear/follow; empty/no matches | Source and workspace inspection; high-volume/midnight fixtures pending. |
| WorkSurface | Logs/Agent/Terminal layouts; separator; session tabs; shell/agent launch; picker; terminal ended/restart/close; detach; missing/empty session states | Ended terminal observed live; launch/detach/lifecycle not executed. |
| Status bar | Branch/switch; Git summary; Pull; pull options; submodule branch picker/details/actions; layout cycle; attention | Source + live workspace; dirty/submodule results pending. |
| Command palette | Search/results/categories/active choice/empty; navigation and action target; shortcuts | Source; assistive technology and complete execution matrix pending. |
| Attention/activity | Grouped notices, decisions/errors/information; count; open/dismiss/details/retry | Live and source; retained background-job matrix pending. |
| Small menus/popovers | RefPick; AnchoredMenu; Worktree More; service/command overflow; agent/session choice; log level; InsertVar; Settings repo/More/search; pull/submodule menus | Source; some opened live. Arrow/focus/viewport containment needs runtime coverage. |
| Tray popover | Repository picker; attention/running/idle worktrees; row actions; service counts; next action; keyboard selection; manager/settings/add/new/quit entry actions | Source entry point reviewed; native tray interaction pending. |
| Detached terminal | Session identity/status; terminal; ended/restart; reattach/close/window lifecycle | Source entry point reviewed; native lifecycle pending. |
| Native surfaces | Startup failure dialog; Open Canopod/Quit tray menu; folder chooser; provision/source picker; config export save dialog/import file input; database export save/restore file chooser; OS notifications; window close/hide/quit; updater prompts | Source/API call review; OS-specific paths pending. |
| Transient/global feedback | Toasts; persistent job notices; busy spinners; version mismatch/update feedback; loading/empty/error and retry paths | Source and sampled live; full failure/timing matrix pending. |

## Coverage reconciliation and release checklist

The local import graph reaches **52 TSX files** from the three entry points, including primitives/icons/entry components. Seven legacy TSX files are not mounted from those entry points: `AgentLane`, `Console`, `DatabaseControl`, `ServiceCard`, `Sidebar`, `SubmoduleMenu`, `WorktreeHeader`. They are not counted as current pages. Active submodule content is inside `StatusBar`.

This inventory establishes source surface coverage, not that every dynamic value or conditional state was observed live. To close runtime coverage, create a disposable fixture matrix covering:

- Zero/one/multiple repositories; no/many services/agents/files/tasks; duplicate and very long names; missing executables/config/database.
- Loading, successful empty, failure, retry, success, partial success, busy, backgrounded and canceled operations.
- Dirty/untracked/ahead/behind/conflicted Git and submodules; stale/deleted worktrees; databases shared/isolated; explicit destructive confirmations.
- Settings dirty exits, repo changes, malformed imports, partial saves, MCP unapplied edits and external config changes.
- Keyboard/screen reader; all themes/accents/densities; minimum window/200% text; macOS, Windows and Linux packaged builds.

Each inventory row should gain a fixture, build identifier and recorded result before claiming complete runtime coverage or a 10/10 release.
