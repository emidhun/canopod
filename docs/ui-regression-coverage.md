# UI regression coverage

Updated 2026-10-03. Frontend suite: **35 files, 269 passing tests**. This expansion added **82 tests** to the 187-test baseline. Production build and `git diff --check` pass.

Run `npm test` for the suite and `npm run build` for TypeScript and production bundling. The existing Linux CI job runs both on pull requests and pushes to main; new test files are discovered automatically. Tests mock IPC or use browser-mode store state, so they do not execute real Git, database, filesystem, shell or agent operations.

## Coverage of the discussed changes

| Area | Regression contracts | Main tests |
| --- | --- | --- |
| All 13 Settings pages | Rendering, accessible control names, unnested actions, page switching, dirty-exit choices, save-on-exit and initial read recovery | `SettingsView.test.tsx` |
| Settings persistence | Late reads, retained edits, repository setup preservation, incomplete-row rejection and repository draft isolation | `asyncLoad.test.tsx`, `incompleteSave.test.tsx` |
| Files editor | Selection, edits, independent duplication, removal, empty/add state, formats, keys, interpolation, lifecycle commands, variable target identity and Escape focus return | `FilesPage.interactions.test.tsx`, `FilesPage.test.ts`, `provision.test.ts` |
| Appearance and shortcuts | Stored appearance, defaults/overrides, binding conflicts and key notation | `appearance.test.ts`, `keys.test.ts` |
| Shared menus | Portal placement, enabled-item Arrow/Home/End navigation, outside dismissal, Escape and focus restoration | `AnchoredMenu.test.tsx` |
| Shared modal shell | Initial/restored focus, no focus theft on updates, Tab boundaries, busy dismissal, inner-popup Escape, safe keyboard submission | `Modal.test.tsx` |
| Service rail | Independent detail/port/process actions, correct targets, disabled stopped ports, busy transitions, overflow/database access and narrow-width service reduction | `ServiceRail.test.tsx` |
| Workspace chrome | One dirty-review action, no redundant sidebar Git marker, named global counters and correctly routed actions | `WorkspaceChrome.test.tsx` |
| Bottom bar | Labelled Pull, separate submodule menu, supported unified layouts, selected state and focus return | `StatusBar.test.tsx` |
| Commit/Stash/Discard | Filename/tooltips/renames, deleted-file behavior, informational filtering, operation scope/counts, untracked confirmation, conflicts, submodule-only guard, error/retry input retention and unreadable-status guard | `UncommittedChangesModal.test.tsx` |
| Database tools | Reset acknowledgement/cancel, failed reads/retry and operations unavailable without a current database | `DatabaseModal.test.tsx` |
| Restore | Create/replace payload, activation, target-bound acknowledgement, cancelled file choice, duplicate/reserved/oversized names, read failures/retry, full-path tooltip and failed-operation input retention | `RestoreDatabaseModal.test.tsx` |
| Unified Terminal | Mixed session selection, mounted-output preservation across views, one add control, one-profile direct launch, multiple-profile choice, read-only ended output/restart/close, detach/reattach, keyboard split bounds and task/worktree scope | `WorkSurface.sessions.test.tsx` |
| Agent/shell launch | Unique titles, exact worktree, configured profiles/prompt opt-out, repository concurrency limit and context-write failure | `laneLaunch.test.tsx` |
| Logs | Pause only away from latest, incoming-line count with buffer rotation, return to latest, combined source/level/search filters, popup focus and scoped clear | `LogsPane.test.tsx` |
| New worktree | Branch validation, displayed repository target, creation payload, retained input/errors and operation event helpers | `NewWorktreeModal.interactions.test.tsx`, `NewWorktreeModal.test.ts` |
| Removal/prune | Single/bulk pending or failed checks block removal, no false clean state, retry, explicit target/options and per-item prune failure retention | `RemovalModals.test.tsx` |
| Branch switching | Current/in-use branches disabled, exact target, remote tracking creation and retry | `SwitchBranchModal.test.tsx` |
| Context | Per-worktree persistence, Write/Preview state and explicit agent start | `ContextModal.test.tsx` |
| Service details | Port validity/conflicts, selected-service save, failure retention and live crash/restart state | `ServiceDetailModal.test.tsx` |
| Setup | Provisioning/task outcomes, retained output, failure copying and runner actions | `SetupRunnerModal.test.tsx` |
| Notices | Full operation output/target, selected notice dismissal and disabled copy without details | `NoticeModal.test.tsx` |
| Repository removal | Explicit confirmation, target/consequence text and side-effect-free cancellation | `RepoGeneralPage.test.tsx` |
| Existing adjacent functionality | MCP panel actions, command groups, overview disk behavior, onboarding detection/provision helpers and terminal image handling | Existing component/helper suites |

## Bugs exposed and fixed

- Bulk removal no longer interprets a failed dirty probe as clean. Removal remains disabled until every probe succeeds, and failed probes offer Retry checks.
- Accessible names now cover wrapped fields in General, Repository General, Terminal, Advanced, Agents, Setup and shortcut filtering.

## Remaining validation boundaries

These tests do not promise an unbreakable app. jsdom cannot validate CSS geometry, contrast, screen-reader announcements or native window behavior. Prior browser reviews cover representative sizes/themes, but automated screenshot comparison has not been added. The existing CSP check is a separate smoke check for the three production entry points.

Real PTY input/output, agent approval, native detach/reattach, tray behavior, notification delivery, actual Git/submodule and database execution, high-volume/midnight log ordering, and packaged macOS/Windows/Linux workflows still need integration fixtures. Onboarding and MCP retain their existing helper/component coverage; full native connection and installation flows are not exercised by this suite. Planned redesign features remain outside these acceptance claims.
