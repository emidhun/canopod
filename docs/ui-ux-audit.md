# Canopy UI/UX audit and revamp plan

Audit date: 2026-10-02. Source baseline: `469612d` (0.5.0).

## Verdict

Canopy has a coherent visual foundation and useful workflow primitives, but it does not yet meet a 10/10 quality bar. The first investment should be trustworthy state, safe operations, accessible controls, and clear navigation. Refine the existing desktop workspace identity: layered surfaces, restrained accent, readable branch names, and a large working area.

This is a planning deliverable; application behavior has not been changed. “10/10” is a product quality target, not a defensible score from one evaluator. Release readiness requires the validation gates below and observed user success.

## Evidence and limits

- **Live:** inspected all 13 Settings pages, expanded editor/advanced sections, JSON preview, More menu, settings search, repository removal confirmation, reset and token-rotation confirmation disclosures (canceled), workspace/overview/attention, New worktree, Database, snapshot and restore prompts. Database contents populated after its initial empty presentation; long identifiers visibly crowd action labels.
- **Source:** reconciled three UI entry points, 13 Settings pages, all 13 shared-Modal consumer components and their variants, onboarding, workspace panels, menus, tray, detached terminal and native dialog entry points. See the [complete surface/content inventory](ui-ux-surface-inventory.md) for contents and evidence per surface.
- **Version mismatch:** installed 0.5.0 and source 0.5.0 differ in updates, shortcuts and setup attention behavior. Record the exact packaged build/commit before runtime regression testing.
- **Not exercised:** actual create/setup/delete/reset/restore/update execution, fresh onboarding, live agent approval, tray interaction, detached-window lifecycle, Windows/Linux, other theme/accent/density combinations, small-window/zoom behavior, screen-reader operation and performance under load. These remain explicit validation work. No destructive operations were executed.
- Source coverage is comprehensive at the surface/component level; runtime state coverage remains incomplete. Dynamic user-created contents and every conditional execution path require disposable fixtures. This is not a completed conformance certification.

## Strengths to preserve

- Shared `nextAction()` keeps primary actions consistent across surfaces.
- Attention-first grouping, pinned worktrees, repository filtering, and command search support frequent switching.
- Shared modal implements focus trapping, Escape handling, and focus restoration.
- Long operations have background handoff and persistent failure notices in several flows.
- Restore defaults to a fresh database and requires acknowledgment before replacing data.
- Single-worktree removal fails closed when its dirty check fails.
- Theme tokens, bundled fonts, text zoom, density options, container queries, and reduced-motion support provide a useful foundation.
- MCP has explicit repository access, explained write capabilities, a masked token, manual fallback, and a suggested read-only first task.

## Findings

Severity: **P0** risks consequential loss/misleading destructive state; **P1** blocks or undermines a core workflow; **P2** creates recurring friction; **P3** polish. “Source” means the behavior is established in implementation but was not executed against real data.

| ID | Priority / evidence | Finding and impact | Proposed change / acceptance |
|---|---|---|---|
| UX-01 | P0 / Source | Bulk removal initializes an empty dirty map, calls that “all clean,” and maps dirty-check failures to `false`. Unlike single removal, the bulk primary is gated only by busy state. Users can see false reassurance before checks finish or after failure. `src/app/RemoveWorktreesModal.tsx`. | Model checking/clean/dirty/error per worktree. Block deletion while any probe is pending or failed; show retry and concrete per-item results. Never render “all clean” without successful probes for every target. |
| UX-02 | P1 / Source | Settings close directly invokes `onClose` despite dirty state. Unsaved configuration can disappear. `src/app/settings/SettingsView.tsx` close button; `src/app/App.tsx` settings lifecycle. | One guarded exit path for button, keyboard, navigation and window closure. Offer Save / Discard / Keep editing; failed save keeps edits. Clearly exclude already-applied appearance changes from Discard. |
| UX-03 | P1 / Source | Custom command testing calls `runCustomCommand(selKey, cmd)` while Settings can show a different repository. “Current worktree” does not reveal that mismatch. `src/app/settings/pages/CommandsPage.tsx`. | Require a worktree from the settings repository; show `Run in <repo> / <branch>` and command/directory preview. Block or choose a valid target when scopes differ. Verify invocation receives the displayed target. |
| UX-04 | P1 / Live + Source | General/Notifications/Security switches have state but no accessible name; many form labels are neighboring spans rather than associated labels. Live tree reports anonymous switches and unlabeled selects/fields. `settings/primitives.tsx`, `pages/GeneralPage.tsx`, other settings pages. | Shared Field and SwitchRow with unique IDs, labels, descriptions and field-level validation. Every control has a meaningful accessible name, state, and error association; verify with VoiceOver and DOM checks. |
| UX-05 | P1 / Source | Settings object headers contain clickable spans for run, move, duplicate and remove. They are pointer-only subactions within a button. `pages/CommandsPage.tsx`, `pages/ServicesPage.tsx`, `pages/AgentsPage.tsx`. | Separate disclosure button and sibling native action buttons; expose expanded state. Every action works through Tab + Enter/Space with distinct names. |
| UX-06 | P1 / Source | Palette and settings search use visual highlighted rows without dialog/combobox semantics, focus trap/return, or active-result announcements. `canopy/Palette.tsx`, `settings/SearchOverlay.tsx`. | Reuse accessible overlay behavior; implement a documented search pattern with result count, active item, focus containment, Escape and restored focus. Do not route typing/Enter to background workspace actions. |
| UX-07 | P1 / Live + Source | Failed database/settings/service-env/ref reads can become empty state or indefinite loading. Live Database initially said “No databases found” before later populating; source suppresses list errors. Some settings reads have a loading message, but others lack a clear failed/retry state. `DatabaseModal.tsx`, `SettingsView.tsx`, `ServiceDetailModal.tsx`, `SwitchBranchModal.tsx`. | Separate loading, successful empty, unavailable and failed states. Persistent inline error, retry, context and relevant disabled actions. Failure never masquerades as empty data. |
| UX-08 | P1 / Source + measured tokens | Small text contrast fails the planned AA bar for several token pairs. Metadata gets hard to read. See measurements below. `styles/tokens.css`, `styles/canopy-components.css`. | Correct semantic text/fill tokens across every theme/accent combination. Verify computed foreground/background pairs for actual rendered states, including hover, dim washes, disabled exceptions and focus indicators. |
| UX-09 | P1 / Source | All feedback toasts share a 2-second timeout; toast markup lacks a live region. Errors can vanish before users understand them. `store.ts: showToast`, `App.tsx: cx-toast`. | Typed success/info/error feedback. Announced success; persistent actionable errors until dismissed/resolved; operation history for background outcomes. Coalesce duplicates rather than overwrite useful failures. |
| UX-10 | P2 / Live + Source | “5 need you” includes a worktree-ready informational notice while “Needs you” groups contain 4 worktrees. Topbar “4 running” counts services; sidebar “Running 1” counts worktrees. Counts are valid different quantities but identical wording creates apparent contradictions. `TopBar.tsx`, `Overview.tsx`, `SidebarNav.tsx`. | Separate actionable issues and activity; label units (`4 services running`, `1 running worktree`, `4 need attention`, `1 update`). Counts derive from explicitly defined sets; group by worktree with expandable issue counts. |
| UX-11 | P2 / Live + Source | Overview presents dots, ratios and Git symbols but does not say why a worktree needs attention. Row actions are invisible until hover/focus. Visually empty action columns obscure what to do. `Overview.tsx`, `canopy-shell.css: cxs-rowact`. | Add a visible Status/Reason column and stable labeled next action; keep secondary actions in a visible overflow menu. Name Git states (`15 behind`, `uncommitted changes`) with accessible descriptions. |
| UX-12 | P1 / Source | Overview rows and measured disk cells are click targets without native keyboard access. Split divider only supports mouse drag. `Overview.tsx`, `WorkSurface.tsx`. | Branch links/buttons, disk remeasure buttons, and keyboard-operable separator with value/limits. Keep row click as a convenience; never make it the sole path. |
| UX-13 | P2 / Source | Overview Start all / Stop all operates across `flat` from the full tree, while sidebar filtering does not scope the overview. Generic labels hide the operation's scope. `Overview.tsx`, `SidebarNav.tsx`. | Make filters common to sidebar/overview or explicitly independent. Bulk actions state repository/worktree/service scope before execution and return per-item progress/results; avoid universal confirmation for ordinary scoped start/stop. |
| UX-14 | P2 / Live + Source | Comfortable body text is 12.5px and micro/label text is 10.5/9.5px. Several controls are 20–22px high. This makes dense metadata and inline actions demanding, especially on laptops. `tokens.css`. | Proposed comfortable baseline: 14px body, 12px metadata, 32px controls and 28px icon targets. Compact remains opt-in. Validate density with users; meet target-size/spacing requirements rather than equating icon size with hit area. |
| UX-15 | P2 / Source | Light scrollbars retain translucent white thumbs; light/accent combinations need full contrast review. `tokens.css`. | Semantic scrollbar and accent-ink tokens; no invisible scroll affordance on light surfaces. Review all 3 theme modes × 4 accents × 2 densities. |
| UX-16 | P2 / Live + Source | Long branch/database names dominate rails or truncate identifying suffixes; sidebar rows in all-repository mode make repository identity less immediate. | Resizable sidebar, repository sublabel, deliberate middle truncation for branch names, full name on focus/hover and copy action. Database chip uses a concise label with full destination in its detail view. |
| UX-17 | P2 / Source | A single changing next action can recommend Pull before Start when behind origin, even though running local work may be the user's intent. “Review changes” requires both dirty and ahead. `nextAction.ts`. | Keep a suggested next action plus stable explicit Start/Open/Review affordances. Make rationale visible; test behind+dirty, dirty-only, ahead-only and working-agent cases. Do not silently auto-pull. |
| UX-18 | P2 / Source | Pane layout and split ratio are component state and reset on app remount. Layout names “Shell” and “Terminal” are easy to confuse; status button cycles rather than offering direct selection. `App.tsx`, `WorkSurface.tsx`, `StatusBar.tsx`. | Named presets based on content (`Logs`, `Logs + Agent`, `Agent`, `Terminal + Logs`, `Terminal`), direct picker with previews, persisted last layout/split and reset. Define whether persistence is global or per worktree. |
| UX-19 | P2 / Source | Ref picker ArrowDown/Enter opens the menu but does not implement an active-option arrow selection model. Various small menus have inconsistent Escape, focus and expanded-state behavior. `RefPick.tsx`, `LogsPane.tsx: LevelFilter`, `settings/primitives.tsx: InsertVar`. | Shared menu/listbox/combobox primitives appropriate to each interaction; support arrows, Enter, Escape and focus return. Preserve in-use refs with a reason rather than hiding them. |
| UX-20 | P2 / Source | “Learn more” only emits “Documentation isn't wired yet.” Insert variable advertises `⌘/` without a handler in its component. Some comments describe settings/light theme as unimplemented despite working implementations. | Wire contextual help to existing documentation, remove unimplemented shortcut hints, and update obsolete comments. Verify every visible action/hint against actual behavior and remapped/platform shortcuts. |
| UX-21 | P2 / Source | Single/bulk removal preselects database dropping; source comment claims typed confirmation that the single UI does not implement. Clean Git does not establish database disposability. | Default to preserving databases; present exact directory/branch/database consequences separately. Require stronger acknowledgment when deleting dirty work, unpushed submodule commits or database contents. Match implementation and documentation. |
| UX-22 | P2 / Source | Merged log ordering sorts `HH:MM:SS` strings; streams spanning midnight can read out of order. Follow uses shown length, which may stop advancing once ring buffers remain constant-sized. `LogsPane.tsx`. | Sort by full timestamp/sequence with stable tie-break; follow incoming sequence while enabled. Clearly show paused/following state and number of new lines; preserve user's scroll position when paused. |
| UX-23 | P2 / Source | Snapshot failure uses transient toast even when the step is backgrounded; several other jobs create persistent outcome notices. `DatabaseModal.tsx: createSnapshot`. | Unified operation lifecycle for create/setup/snapshot/migrate/export/restore/delete with target, phase, outcome and retry/details. Background success/failure must remain discoverable. |


| UX-24 | P1 / Source | Setup Dry run uses global `selKey` and saved backend config, while its success count comes from the settings draft. The hint promises the setup runner but the action only emits a toast. `SetupPage.tsx`, `operations.rs: run_worktree_setup`. | Name and validate the repository/worktree target; preview the actual draft or explicitly label saved config. Display the resolved plan and count from one authoritative result. |
| UX-25 | P1 / Live + Source | Security is grouped under the selected repository but edits global `settings.security`. Users can misunderstand the reach of secret/export/credential choices. | Move global security to App Settings or show explicit global scope on every affected field. Repository navigation must not imply repository-local persistence. |
| UX-26 | P2 / Live + Source | Settings search misses visible fields: searching `update` returned no matches. Static INDEX omits update controls and several advanced/default fields; navigation highlights a page rather than the requested field. `catalog.ts`, `SearchOverlay.tsx`. | Generate search from field metadata; include descriptions/synonyms, exact field anchors and disabled explanations. Every editable field is discoverable by label. |
| UX-27 | P1 / Source | Files variable picker suggests `${INT_DB_NAME}`, `${INT_SLUG}`, `${WT_SERVICE_PORT}` that the backend does not define. Supported names include `${WT_DB_NAME}`, `${WT_SLUG}` and service-specific port variables. `catalog.ts`, `state.rs`, onboarding comments. | Derive variable options from backend-supported names and selected services; show real target examples and validate unknown placeholders before Save. |
| UX-28 | P1 / Source | Config import mutates file drafts before lifecycle validation; later rejection can say invalid JSON after partial mutation. Import and Load repo file omit setup policy although export includes it. Missing provision data clears files. `SettingsView.tsx`. | Parse/validate the entire document before any mutation; show a diff and clear replace/merge semantics; roundtrip setup policy; rejected imports leave drafts untouched. |
| UX-29 | P1 / Source | Incomplete Files/Setup edits can be silently filtered out on serialization: blank file paths/key names/task commands are excluded, while incomplete guards focus on services/commands/agents. `provision.ts`, `incomplete.ts`. | Validate all authored rows; distinguish untouched blank placeholders from partially completed drafts. Save must identify missing fields rather than silently discard entered values. |
| UX-30 | P1 / Source | MCP keeps local unapplied selections outside Settings dirty tracking. The shell may say All changes saved while Apply is still needed; navigating away/Refresh can replace those edits. `McpPage.tsx`, `SettingsView.tsx`. | Integrate unapplied MCP state with guarded navigation or clearly independent apply/discard controls and retained drafts. Show applied vs pending access without ambiguity. |
| UX-31 | P0 / Source | Database Reset directly invokes the configured reset operation without a separate destination/consequence confirmation, unlike Restore's replacement acknowledgment. Long destination names can be clipped. `DatabaseModal.tsx`. | Confirm the full database/worktree target and configured reset consequences before execution; show backup/recovery options and prevent duplicate invocation. Validate using disposable databases. |
| UX-32 | P1 / Source | Service rail nests action buttons in a role-button chip; live port span is pointer-only, and database role-button lacks keyboard activation. Compound targets have unclear accessible action boundaries. `ServiceRail.tsx`. | Separate detail, open-port and start/stop/restart buttons, each named and keyboard-operable. Keyboard and pointer activation must perform the same displayed action. |
| UX-33 | P1 / Source | Uncommitted-change loading uses a busy modal with no footer, disabling dismissal during a stalled read. Failure offers Close without Retry. Copy refers to Push/Commit actions in the status-bar pull menu that are absent there. `UncommittedChangesModal.tsx`, `StatusBar.tsx`. | Read operations remain cancelable, timed and retryable; correct guidance to actual recovery paths. Report partial Git effects accurately when a later step fails. |
| UX-34 | P2 / Source | Prune preselects database cleanup yet says only worktree registration is removed unless more is ticked. Generic branch/db row choices conceal exact targets. `PruneWorktreesModal.tsx`. | Preserve databases by default; show full branch/database destinations and summarize actual selected consequences. Align helper text with defaults. |
| UX-35 | P2 / Live + Source | Settings retains the workspace sidebar alongside its own navigation, crowding content at laptop size and leaving unrelated workspace controls active. Long database names also wrap snapshot/export action labels awkwardly. | Give Settings a dedicated, clearly scoped layout; use resilient action rows and explicit full destination details. Review minimum-window and long-string screenshots before rollout. |

### Contrast measurements

Calculated from opaque hex values in current source using sRGB relative luminance; these are token-pair measurements, not pixel measurements or a whole-app certification.

| Foreground / background | Ratio | Usage to review |
|---|---:|---|
| `#7c7e86` / `#1d1e22` | 4.11:1 | Dark tertiary text on app background |
| `#7c7e86` / `#24262b` | 3.74:1 | Dark tertiary text on card |
| `#5d5f66` / `#191a1d` | 2.73:1 | Log timestamps |
| White / `#0b8b92` | 4.10:1 | Light teal filled action |
| White / `#e0533d` | 3.84:1 | Dark filled danger action |
| `#838994` / white | 3.52:1 | Light metadata token when used as text |

For the small text involved, target at least 4.5:1. W3C explains the contrast thresholds and relevant exceptions in [Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Target-size assessment must include actual clickable area, spacing, and exceptions; use [WCAG 2.2](https://www.w3.org/TR/WCAG22/) as the acceptance reference. The proposed 14px/32px product defaults are design choices, not WCAG mandates.

## Surface coverage and target experience

The [page-by-page content inventory](ui-ux-surface-inventory.md) supersedes the initial runtime coverage notes in the table below. All 13 Settings pages now have live inspection; execution states remain pending.

| Surface | Target design and remaining validation |
|---|---|
| First run / add repository | Folder → detected suggestions → editable services/setup → exact write/run summary → progress → ready. Show successful detection vs failure/manual fallback. Validate fresh/invalid/existing-config/non-Node repos and recovery from a failed save/setup. Source reviewed; fresh live flow pending. |
| Global shell / sidebar | Clear repository identity, named counters, stable selection, resizable navigation, discoverable Add repository even with one repo. Test no repos, no worktrees, filter no matches, duplicate names, 100 worktrees, multi-select and live regrouping. |
| Overview | Shared scope/filter bar; status reason + labeled next action; optional CPU/memory/size columns; readable Git states. Retain a table for comparison and handle horizontal overflow intentionally. Live populated view reviewed; minimum-window and keyboard tests pending. |
| Worktree header / service rail | Branch + repo identity, concise health, explicit setup failure details, readable service states/ports, stable secondary actions. Test no services, portless worker, many services, busy/crash/stopping and long names. |
| Logs | Search, service/level filters with states, copy/export, pause/follow, no-results vs no-logs vs unavailable. Validate midnight ordering, high-volume output and fixed-buffer follow. |
| Terminal / Agent / detached window | Clear session ownership and status, named close/restart/detach/return actions, accessible session navigation, saved split layout. Test agent choice, missing CLI, approval waiting, exit, multiple sessions and close behavior without terminating the wrong session. Ended terminal observed; execution/lifecycle pending. |
| Command palette / attention | Separate search/navigation/action results; contextual target and reason; announced active result. Distinguish decisions/errors from informational activity. Live attention contents reviewed; full keyboard/screen-reader validation pending. |
| New worktree / refs / branch switch | Preview path, ports, database and setup before commit; explain unavailable refs and errors; accessible branch selection; named background progress. Creation dialog opened; actual creation/switching pending in disposable fixtures. |
| Setup runner / service detail | Phase and elapsed time, exact failing step, useful tail, retry details and explicit background handoff. Service state remains live while open. Source reviewed; progress/failure/crash simulation pending. |
| Database tools / restore | Loaded list vs load failure, visible current destination, snapshot/export/restore scope, preserving existing data by default, persistent operation outcome. Database dialog inspected; destructive paths pending in disposable fixtures. |
| Removal / prune / dirty changes | Verified per-worktree safety state, separately named branch/database consequences, partial-result handling, retry failed items. Source reviewed; execution pending in disposable fixtures. |
| Settings General / Terminal / Notifications | Explicit instant-vs-Save behavior; named inputs; readable descriptions; clarify new-session vs existing-session effects. General and Notifications live reviewed; Terminal source reviewed. |
| Settings MCP / Security | Preserve access explanations and manual fallback. Clear connection verification, token rotation effects, disabled-action reasons and per-repository scope. MCP/Security live inspected; connection/permission lifecycle not changed. |
| Settings Shortcuts / Advanced | Searchable mappings, conflict explanation, actual displayed bindings, diagnostics loading/failure/retry and reset consequences. Source reviewed; runtime interaction pending. |
| Settings Repository / Services / Agents / Commands | Persistent repo banner, field errors, keyboard-accessible row actions, visibly scoped test target, draft-preserving navigation/exit. Services live inspected; other editors source reviewed. |
| Settings Files / Setup / preview / import/export | Explain template variables and computed outputs; highlight incomplete fields; distinguish draft preview from saved files; successful empty vs unavailable configuration. Scope-preserving import/export and partial-save results. Source reviewed; runtime fixtures pending. |
| Tray / notifications / app lifecycle | Consistent counters/status language, named quick actions, clean return to selected worktree, clear hiding vs quitting consequences. Tray source reviewed; macOS tray and OS notifications pending; Windows/Linux behavior pending. |

## Revamp direction

### Information architecture

1. Global topbar: current scope, command search, actionable attention, activity and Settings. Counts always name their unit.
2. Sidebar: repository switch/add, worktree filter, attention/pinned/running/idle groups. Repository identity remains visible in all-repository mode. Stable selection survives state transitions.
3. Overview: shared explicit scope, status/reason, next action, optional diagnostics and clearly scoped bulk operations.
4. Worktree: repo/branch identity → service health → working panes. The suggested next action assists without hiding common alternatives.
5. Settings: App and Repository groups with persistent repository context, one guarded save/exit model, and field-level validation. Appearance visibly applies immediately.
6. Activity: operation progress/results separated from items that require a decision. Every background job can be found after its dialog closes.

### Visual system

- Retain Canopy's dark layered desktop appearance and restrained accent.
- Raise comfortable typography/targets; retain Compact as an explicit preference.
- Use three readable text tiers, semantic status colors, and text/icon redundancy for meaningful states.
- Keep primary action visible; use consistent secondary and destructive button treatments.
- Use a small set of shared primitives: Field, SwitchRow, DisclosureRow, Menu, SearchOverlay, EmptyState, ErrorState, OperationStatus and ScopeLabel.
- Make long strings, 200% text zoom, the 980×600 minimum window, and narrow split panes first-class design inputs.
- Produce reviewable before/after screen designs for onboarding, overview, workspace, settings and high-risk dialogs before applying the new visual system widely.

## Delivery sequence

### Phase 1 — Trust and correctness

Address UX-01–03, UX-07, UX-09, UX-21, UX-23–25 and UX-27–34 (accessibility portions of UX-32 follow Phase 2). Fix the bulk-delete state model first. Define operation feedback and settings draft/exit behavior before restyling.

Exit: no “clean” state from unknown/failed checks; no silent draft loss; no command tested in the wrong repository; visible retry after failed reads; background failures remain discoverable. Test using disposable repositories and databases.

### Phase 2 — Accessibility and foundations

Address UX-04–06, UX-08, UX-12, UX-14, UX-15 and UX-19. Build reusable controls and overlay semantics; fix token contrast and hit areas. Migrate existing screens incrementally.

Exit: every interactive control is named and keyboard-operable; overlay focus works; split resize works without dragging; measured contrast meets targets; comfortable/compact and theme/accent combinations have reviewed screenshots.

### Phase 3 — Navigation and workspace redesign

Address UX-10, UX-11, UX-13, UX-16–18 and UX-22. Implement clear counters/scopes, visible reasons/actions, layout persistence and reliable log interaction. Start with representative screen designs, then implement the accepted direction.

Exit: users can identify repository, health, next action and operation scope at a glance; filter/bulk scope agrees; restarting the app preserves the chosen layout; long names and minimum-window layouts remain usable.

### Phase 4 — Onboarding, configuration and finishing

Address UX-20, UX-26, UX-35 and the detailed inventory’s surface-specific validation gaps. Tighten detection/manual fallback, help, preview/import/export, empty/error/loading states, tray and detached-window lifecycle. Validate the packaged app on macOS/Windows/Linux.

Exit: all visible affordances work, help links resolve, shortcuts reflect actual bindings/platform, fixture workflows pass, and build/version provenance is recorded.

### Phase 5 — Observed usability and release gate

Use 5–8 representative developers, including first-time worktree users and keyboard-heavy users. This is a practical evaluation sample, not statistically representative proof. Give tasks without coaching; observe confusion, recovery and target mistakes. Fix recurring problems and repeat affected tasks before release.

## Definition of the 10/10 quality bar

These are proposed acceptance targets to validate, not current results:

- Zero unresolved P0/P1 audit findings; each finding has an owner, linked implementation and recorded verification.
- Core tasks: add repo, create worktree, recover setup failure, start/open service, find error log, launch/select agent, test command in named target, safely remove a worktree, restore into a fresh database, and save settings.
- At least 90% unassisted completion across observed core task attempts; no wrong-target or accidental destructive actions. Report task-level failures rather than hiding them in an average.
- Experienced users reach an existing worktree or its primary action in no more than two intentional navigation steps from the workspace.
- All core tasks have a keyboard path; actual screen-reader testing confirms names, state, result announcements and focus return.
- Normal text contrast ≥4.5:1; meaningful non-text controls/states meet applicable 3:1 requirements. Target areas meet applicable WCAG 2.2 size/spacing requirements. Color is never the sole meaningful status cue.
- No critical action, error or destination is clipped at 980×600, 1240×760, a large display, or 200% text scaling. Tables/terminals can scroll where appropriate.
- Dark/light/system, all four accents, comfortable/compact, reduced motion, long names, no data and error states have visual review.
- Every async view has explicit loading/empty/error/success states; every long operation has a visible target, progress and retained result.
- No advertised but inert buttons, help links or shortcuts. No success message from merely starting an operation.
- Navigation/control feedback target: p95 within 100ms on a documented reference machine; longer tasks show progress promptly. Measure before claiming this target is met.

## Verification plan

| Area | Meaningful verification |
|---|---|
| Safety | Failed/pending dirty checks, partial bulk deletion, database drop opt-in, submodule unpushed work, double-click/busy handling. |
| Settings | Exit with dirty draft, failed/partial save, repo switching, external config changes, import errors, appearance already applied. |
| Target scope | Edit repository A while worktree B is selected; command testing and bulk actions must name and invoke the intended target. |
| Accessibility | Control names, native keyboard actions, nested overlay Escape, tab containment/return, active search result, splitter keyboard input, VoiceOver plus Windows screen reader. |
| Async states | Simulate backend unavailable, config read failure, database list failure, no refs, agent executable missing, interrupted job and late result. |
| Visual | Screenshots of representative populated/loading/empty/error/busy screens across themes, densities, sizes and text scaling. Review actual packaged webviews. |
| Logs/sessions | Buffer rotation, equal timestamps, midnight crossover, follow/pause behavior, switching/detaching/reattaching and session exit. |
| Usability | Record task completion, recovery, time, misclicks, misunderstood labels and confidence; use findings to revise designs. |

Build/test execution was not needed for this documentation-only change. Current automated tests are useful supporting evidence but do not replace the missing live workflow and assistive-technology checks.


## Settings and logs re-audit — 2026-10-03

Reviewed all 13 Settings categories in the browser sample workspace: application General, MCP, Terminal, Notifications, Shortcuts, Security, Advanced, repository General, Services, Agents, Commands, Files, and Setup. Also inspected the Files JSON preview and logs level popup. This is a visual and control audit; no live settings were saved or Git/database operations executed.

Implemented consistent 24px logs controls (pane navigation, service filter, levels, search, follow, clear), shared spacing and radii, theme-based surfaces, narrow-width wrapping, accessible search/filter state, and Escape dismissal for Levels. DOM measurements confirmed every toolbar control is 24px in comfortable density. Settings icon actions are native keyboard-focusable buttons; setup tasks and agent prompt switches now have accessible names. Setup reorder buttons disable at the bounds. Settings action focus indicators and button layout are shared. JSON switches to a full-width reader below 1400px rather than compressing the editor beside a wide preview.

Remaining validation from the original audit still applies: packaged-webview checks across themes/densities and window sizes, screen reader use, live backend workflows, and unresolved behavioral findings such as draft-versus-saved setup dry runs. The re-audit does not certify these as complete.


## Consistency follow-up — 2026-10-03

Checked the shared menus, Settings forms, modal chrome, runtime/Git indicators, load/error handling, and keyboard behavior. Browser checks covered all four dark/light × compact/comfortable combinations on General, light/compact Services and Files at 760×700, and the stacked changes-review modal at 600×650. Temporary viewport and appearance overrides were restored. Measured no document horizontal overflow on the inspected settings views. Inspected the open desktop app: its older chrome confirms it has not yet incorporated the source changes, so current packaged-webview validation remains pending.

Fixed nested settings action buttons by making expansion and icon actions siblings; labelled adjacent settings inputs; added popup Escape focus return, shared anchored-menu Arrow/Home/End navigation and viewport-aware placement; allowed modal footer hints to wrap while retaining actions. Narrow log panes keep their search input and dirty-review control reachable. Initial settings read errors now show Retry rather than a blank workspace. Added regression checks for nested buttons on all settings pages and recovery from initial settings load failure. Build and 182 tests pass; source review and browser interactions do not substitute for screen-reader testing or running destructive/live-backend actions.


## Database dialog review — 2026-10-03

Visually checked Database tools, Save snapshot, Reset confirmation, and Restore database in create/replace modes using browser-only dummy data. No restore, reset, export, migration, or snapshot operation was executed against a live database. Added these destinations to the live review gallery.

Restore now gates actions while its database list is loading or unavailable, provides Retry, validates destination names against backend length/maintenance-name rules, shows worktree/current database context, displays the chosen filename with full-path tooltip, and explains temporary service stopping. Replacement explicitly says the database is dropped and recreated, no automatic backup is made, and original data is not recovered after a failed import. Confirmation follows the selected target and the final action uses theme danger styling. Database tools disable snapshot/export/reset/migration when no current database is configured; snapshot guidance explains switching to the copy. Modal checkboxes use theme colors. Added restore load-error/retry coverage; 183 tests pass. Live-backend restore and packaged-webview verification remain pending.

## Regression test expansion — 2026-10-03

Added 82 frontend regression tests; 35 files / 269 tests and production build pass. Coverage and native-runtime boundaries are recorded in [UI regression coverage](ui-regression-coverage.md). Tests exposed and fixed UX-01 bulk-removal false-clean/pending/error gating and remaining wrapped-field accessible-name gaps. No real Git, database or agent commands were executed.
