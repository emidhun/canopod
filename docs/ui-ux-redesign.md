# Canopod redesign proposal

Date: 2026-10-03. Design recommendations reviewed with Astra using a compact audit brief and a response capped at 650 words. The implementation specification and interactive concept below synthesize that review. This proposal now has an initial source implementation; see the status below.

Companions: [audit](ui-ux-audit.md), [complete content inventory](ui-ux-surface-inventory.md), [interactive concept](design/canopod-redesign-preview.html).

## Settings becomes a dedicated configuration workspace

Replace the worktree sidebar while Settings is open. Header: Back to workspace → Settings → Search settings. Use a 224px navigation column and content capped around 800px; narrow windows use a labeled section picker. Keep the footer visible without obscuring content.

Preserve all 13 pages. App: General, MCP, Terminal, Notifications, Shortcuts, **Security**, Advanced. Repository: General, Services, Agents, Commands, Files, Setup. Security moves to App because current persistence is global. Every repository editor begins with `Repository · <name>`; selection remains visible. Expanded fields and secondary actions from the content inventory remain available.

Use one draft record per scope. Switching pages or repositories retains edits. Footer: `3 unsaved changes · ToolJet` → Discard changes / Save repository changes; other unsaved scopes are discoverable. Back/close/window exit uses Save / Discard / Keep editing. Failed saves retain drafts and name the failed scope. Appearance is labeled `Applies immediately` and excluded from discard promises. MCP distinguishes Applied access and Pending changes, integrates pending changes into navigation protection, and retains an explicit Apply access changes action.

Editors use labeled native fields, separate disclosure/action buttons and inline errors. Services show command, directory, base port, derived-port example and health check, then environment. Agents retain default ordering, waiting patterns, context and execution limits. Files retain all formats, templates and lifecycle commands, but supported variables come from the backend. Disabled unimplemented options should be moved into contextual documentation rather than occupying primary editor space.

Commands show `Run in ToolJet / fix/history-state` with a valid target selector and command preview. Setup uses the same scope treatment and previews the **draft**, including policy and resolved files/tasks. Imports validate the whole document first, then present changes and Replace/Merge semantics; canceled/rejected imports leave drafts unchanged. Save validates partially authored files/keys/tasks instead of silently filtering them.

## Workspace makes reasons and actions visible

Global chrome: repository scope, worktree search, actionable attention, Activity, Settings. Counters name units. Navigation and overview share filters; bulk actions say `Start services in 3 shown worktrees`. Keep selected branches stable when status groups change.

Overview columns: Branch / Repository → Status and reason → Services → Next action → visible More. Metrics such as CPU/memory/disk are optional columns. Show `Setup failed`, `Agent needs approval`, `Ready · 15 behind` rather than unexplained dots. Start/Open/Review remain reachable when Pull is suggested; no automatic pull.

Worktree hierarchy: repository/branch → task title → setup or health summary → service rail → working panes. Each service has independent Details, Open app/port, and Start/Stop/Restart controls; no nested interactive chip. Actions wrap rather than shrink. Keep database identity concise in the rail and full in its details.

Direct layout picker: Logs, Logs + Agent, Agent, Terminal + Logs, Terminal. Persist layout and splitter per worktree; keyboard resizing and Reset layout remain available. Agent/session navigation has explicit target and lifecycle labels. Logs retain search/levels/services/copy/follow, full sequence ordering and paused new-line count.

## Dialogs show destination, consequences and recovery

| Flow | Required design |
|---|---|
| New worktree | Repository and branch/base → optional task context → resolved path/ports/database/setup summary → Create. Show unavailable refs and field errors; freeze target choices during execution. |
| Setup | Exact worktree and draft/saved distinction → provisioning/tasks → current step/output → retained result. Retry identifies failed step and rerun consequences; background handoff remains explicit. |
| Dirty changes | Exact target/operation → status list → Commit/Stash/Discard choices → operation-specific outcome. Loading can be canceled; errors allow Retry. No guidance to nonexistent actions. |
| Remove/prune | Exact paths/branches/databases and per-target checking/clean/dirty/error. Preserve database by default; opt-in cleanup lists full destinations. Pending/failed checks block deletion. Retain partial results. |
| Database reset | Repository/worktree → full database identifier → configured reset command/known effects → existing snapshot or export recovery option → destination acknowledgment → Reset database. Never claim every custom reset has known effects. |
| Restore | Dump file → Create new database by default → full destination → optional activate. Replace existing is a separate explicit choice with acknowledgment. Retain progress and failure details. |
| Context/service/notice | Keep their existing capabilities; show save status or operation target, clear read failure/retry and independent actions. |

The preview uses sample data and has no backend connection. Backup is represented as export, which current Canopod supports; do not promise a snapshot workflow unless database-target correctness and availability are validated.

## Shared visual and interaction system

Keep Canopod's layered desktop identity. Comfortable: proposed 14px body, 12px metadata, 32px standard controls; Compact stays opt-in. Use readable semantic text tiers, consistent borders/radii and restrained accent. Dark/light/system, all accents and densities must meet contrast checks. Status includes words/icons as well as color; essential actions never depend on hover.

Search derives from real field metadata, includes scope breadcrumbs and moves focus to the matching field. Menus/overlays use shared focus/keyboard behavior and viewport collision handling. Async views distinguish loading, empty, unavailable, failure and success. Short success feedback is announced; actionable failures and background outcomes remain in Activity with target, timestamp, details and recovery action.

## Delivery and acceptance

1. Fix destructive state, wrong-target operations, import validation, unsupported variables and draft loss before visual rollout.
2. Implement shared controls, dedicated Settings shell and all retained editors.
3. Implement shared workspace scope, overview reasons, independent service actions and persisted layouts.
4. Migrate dialogs and Activity; validate onboarding, tray, detached terminal and native surfaces against the complete inventory.

Accept designs through representative screenshots and disposable workflow fixtures at minimum window, laptop and large sizes, with long names and text scaling. Require keyboard/screen-reader coverage and all loading/error/busy outcomes. The interactive concept illustrates hierarchy and interactions; it is not a runtime-tested replacement or proof of a 10/10 score.


## Implementation status — 2026-10-03

Implemented: dedicated Settings navigation with all 13 pages retained; global Security placement; explicit application/repository scope; wider readable editors and persistent footer; unsaved-exit Save/Discard/Keep editing; named shared switch rows and service fields; separate service detail/port/process actions; wrapping service rail; direct layout picker; clearer running counter units; larger default typography; full database destination and reset acknowledgment; explicit database loading/error/retry.

Save currently persists all dirty scopes, so the footer deliberately says Save all changes / Discard all changes. Scope-specific save, MCP integrated pending state, draft-based setup preview, import comparison, overview/Activity redesign and persisted pane layouts remain follow-up work from the broader specification. They are not claimed as implemented.

Verification: production build passed; 19 test files / 181 tests passed, including new dirty-exit and database acknowledgment regressions. Browser review used the Vite development app with sample data. Settings and reset screenshots were inspected; no database reset or real permission changes executed. Native installed app and cross-platform package validation remain pending.


## Agent, Terminal and Logs flow proposal — 2026-10-03

The interactive proposal is `docs/design/canopod-workflow-preview.html`, also linked from the live review gallery. This is a prototype using sample sessions; it does not launch a CLI, execute terminal commands, or send an agent prompt. The running-session implementation is unchanged pending design review.

Proposed hierarchy: stable Logs/Terminal/Agent navigation; separate session strip; agent task context; working output. A top-level “Logs alongside” control preserves Agent and Terminal split preferences independently. Per-lane active session choices remain stable when switching views. Compact empty states offer profile selection and one launch action without requiring a task edit. Session status distinguishes waiting, running and ended; detach leaves a return action; ended output remains available with Restart/Close. Logs preserve reading position while paused, report new output, and provide Return to latest. Error investigation can open Agent alongside without automatically launching a CLI or sending log content.

Astra reviewed the proposal with a short response. It recommended keeping this hierarchy stable, avoiding duplication with bottom layout controls, retaining per-lane selection and split preferences, and making resize keyboard-accessible. Implementation follow-up must use real PTY/session lifecycle and actual new-line counts; the proposal's sample outputs are presentation only.

### Unified Terminal preview consistency audit

Preview: `docs/design/canopod-unified-terminal-preview.html`. Agent and shell sessions share a scrollable strip and one add menu. A single Claude profile starts directly. Controls use compact 24px heights, shared theme surfaces, matching gutters and menu typography. Logs keep source, level and search filters across views and combine filters. The working pane stays on the left with a keyboard-resizable divider. Menus support arrow keys and Escape with focus return. The work area fills the viewport; narrow layouts stack logs below the terminal. Verified direct agent launch, keyboard shell creation, session selection and combined filter persistence in the browser. This remains a dummy-session design preview; production session behavior is unchanged.

### Unified Terminal implemented in the main app

The approved shared Terminal workspace is now in `WorkSurface.tsx`. Agent and shell sessions share one strip and add menu; a single profile starts directly, multiple profiles expose the configured choices. Terminal and log panes remain mounted across view changes, preserving sessions, selection, output and filters. Companion logs appear on the right at a 60/40 initial split with keyboard and mouse resizing; narrow workspaces stack logs below. Context is attached to the selected agent session. Existing pop-out, bring-back and ended-session recovery remain connected to the real session lifecycle. The layout menu, command palette and shortcut settings now expose Logs, Terminal and Terminal + Logs consistently. Logs pause when scrolled away from the bottom, count incoming buffered lines and offer Return to latest. Browser flow and responsive layouts verified; production build and 187 tests passed. Native PTY execution uses the existing desktop integration; browser validation used demo sessions.

## Regression test expansion — 2026-10-03

Added 85 frontend regression tests; 35 files / 272 tests and production build pass. Coverage and native-runtime boundaries are recorded in [UI regression coverage](ui-regression-coverage.md). Tests exposed and fixed UX-01 bulk-removal false-clean/pending/error gating and remaining wrapped-field accessible-name gaps. No real Git, database or agent commands were executed.
