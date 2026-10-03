# Canopod adoption plan

Date: 2026-10-01 (Asia/Kolkata). Status: all six bounded checkpoints below are
complete; external release acceptance and the follow-through backlog remain open.

## Today: October 1

Today's goal is an accurate installation story and a validated first-workspace
path for a simple project. The sequence below replaces the weekly schedule.
Allow approximately seven focused hours from the start of implementation; these
are effort budgets, not fixed clock times or guaranteed completion times.

| Order | Budget | Task and deliverable | Completion check |
| --- | --- | --- | --- |
| 1 | 45 min | Verify published release/artifacts and current UI; reconcile README and maintained install/onboarding pages. Record signing and platform evidence. | Download/version claims agree with the verified release; development-only behavior is labeled; prerequisites are conditional on project needs. |
| 2 | 2 hr | Fix the smallest onboarding gaps: respect detected package manager, avoid invented npm commands for unknown projects, make database defaults conditional, preserve existing configuration. Verify agent setup can be skipped. | npm/pnpm/Yarn suggestions match fixtures; unknown stacks use manual configuration; a database-free project has no Postgres dependency. |
| 3 | 90 min | Exercise a simple project through create → setup → start → open; run two worktrees concurrently. Reproduce one setup failure and check retained input and retry. Fix blockers within this scope. | Record commands, environment and results; distinct ports and a working app are observed; failure/retry behavior is documented accurately. |
| 4 | 60 min | Verify existing MCP connection instructions in Settings/onboarding and prepare a copyable first-task example. Attempt desktop/headless real-client smoke checks with available clients. | Record pass/fail/unavailable per host and client; never count generated configuration as proof of connectivity. |
| 5 | 45 min | Write one reproducible simple-project recipe plus an early-user session script and feedback checklist. | Recipe matches today's verified behavior; session captures completion, elapsed time, interventions and abandonment. |
| 6 | 60 min | Run relevant checks, inspect the final diff, and update this document with completed work, evidence and remaining blockers. | UI build and relevant tests pass; shared backend changes receive desktop/headless checks; documentation builds; unfinished acceptance items remain explicit. |

Execute one checkpoint at a time. If a task exceeds its budget, preserve a tested
slice and record the remainder; correctness and validation take precedence over
finishing every row. First-use blockers outrank MCP polishing and launch assets.

### Dependencies and limits for today

- Signing/notarization and clean-machine install acceptance require credentials
  and an appropriate test environment. Audit and prepare missing steps today;
  do not claim a signed release unless an actual artifact is verified.
- If an agent client is unavailable or its authentication has expired, record
  that acceptance gap and continue with recipe/documentation work.
- Full Workspace Doctor, service dependency orchestration, browser attachment,
  destructive MCP actions and additional platform certification remain backlog.
- Prepare user-research materials today. Recruitment, public posting and a
  10–15-user study are later activities; seven-day retention cannot be measured
  today. No new analytics infrastructure is required for this first pass.
- Broad promotion follows validated installation and first use. A release is
  not promised merely because today's code checks pass.

### End-of-day record

Update each row with evidence as implementation proceeds. Planning does not
count as completion of a delivery task.

| Checkpoint | Status | Evidence / remaining work |
| --- | --- | --- |
| Release and documentation audit | Complete | GitHub release `v0.4.7` (published 2026-08-13) contains Apple Silicon DMG/app, Linux deb/rpm/AppImage and Windows NSIS/MSI artifacts. Source is `0.5.0` and remains unreleased. README/install/release docs now distinguish those scopes and make project runtimes/databases conditional. macOS is ad-hoc signed; notarization is explicitly deferred for this release. Clean-machine packaged acceptance remains open. |
| Onboarding fixes | Complete | Detection now reports npm/pnpm/Yarn and existing configuration. Suggestions use the detected package manager, unknown projects receive no invented Node commands, database variables appear only with database scripts, existing settings/config are preserved by default, and agent setup remains skippable. Covered by seven frontend fixture cases, two backend detection tests, production build and Clippy. |
| First-workspace and recovery validation | Complete | `simple_project_recovers_setup_and_serves_two_worktrees` runs against an isolated real Git repository and loopback backend. A seeded setup failure preserves the created worktree, input artifact and configuration; retry succeeds. A second worktree then starts concurrently on a distinct derived port, and both local HTTP services return success before clean stop. Targeted test passed on macOS arm64 in 10.24s. |
| Agent connection validation | Complete | On the current `0.5.0` branch, Codex CLI 0.155.1 called status/worktree/service tools through an isolated read-only headless host, then called status through the running desktop host and its automatic dynamic-token configuration. Claude Code 2.1.280 discovered and connected to the isolated server but could not make a model/tool call because its OAuth session is expired; it is recorded unavailable. Settings now includes a copyable read-only first task, and manual Codex TOML references `CANOPOD_MCP_TOKEN` instead of embedding the secret. Packaged and browser-host checks remain open. |
| Recipe and user-session materials | Complete | The maintained site now includes a database-free simple web recipe using the exact Python HTTP service command exercised by backend acceptance. It covers unknown-stack onboarding, two derived ports and retained-worktree setup recovery. `docs/early-user-session.md` provides a timed moderator script, intervention/abandonment record, privacy-safe feedback checklist and opt-in follow-up. No participants or retention results are claimed. |
| Final checks and delivery summary | Complete | Frontend: 18 files / 179 tests and production build passed. Rust: desktop 204 unit + 3 process tests, headless 196 unit + 3 process tests, and both Clippy configurations passed with warnings denied. Website built 32 pages with all 80 screenshots resolved. PR #154 CI passed its core, Linux and macOS jobs; every functional Windows step passed, including the full Rust suite and junction proof. `git diff --check` passed. Remaining release work is clean-machine packaged acceptance, Claude reauthentication, browser attachment, PR integration and the actual `0.5.0` publish; notarization is deferred. |

## Outcome and audience

Make it easy to install Canopod, run an isolated workspace, and return to it the
following week. Start with developers running multiple branches or coding agents
locally. Support ordinary single-service projects as the entry point, then expand
to multi-service teams and additional platforms using observed demand.

Product promise: **Run branches side by side, with their services and setup managed
in one place.** Accounts, agents and databases must be optional for local use.

## Baseline from the repository

- Adaptive repository detection and editable onboarding already exist, as does
  agent connection setup in onboarding and Settings. Extend these flows.
- `src/onboarding/Onboarding.tsx` offers multiple stack choices, but `derive()`
  defaults to `npm install`, `npm run dev` and a database environment entry.
  A stack label is not evidence of a working project recipe.
- `package.json` is 0.5.0; README download links/version remain 0.4.7. Verify the
  published release before changing links; a source version is not a release.
- README describes unsigned/not-notarized installation and experimental Linux
  and Windows support. Packaged desktop validation remains pending.
- The maintained user documentation lives in `website/content/`; older `docs/`
  guides and the roadmap contain historical descriptions.
- MCP diagnostics, service control and revision-checked configuration are
  implemented. Remaining MCP work is tracked in `mcp-next-steps.md`.

## Follow-through backlog and full acceptance criteria

Today's checklist above selects bounded work from these broader outcomes. The
remaining requirements stay open after today until their acceptance criteria
are met. Keep changes reviewable and record evidence, including unavailable
credentials, machines or participants.

### 1. Accurate installation and release information

- Audit published artifacts, release workflow, Homebrew instructions and update
  behavior. Align README and maintained site with verified released behavior.
- Publish a support matrix distinguishing compiled, packaged and desktop-tested
  platforms. State project-specific runtime/database requirements conditionally.
- Prepare macOS signing/notarization and release verification. Actual signing
  requires maintainer-provided Apple credentials; never mark it complete from
  pipeline configuration alone.
- Exercise download → install → first launch → reopen → update on a clean macOS
  environment. Preserve settings and workspaces through the update.

Acceptance: links resolve to the intended artifacts; instructions match the
packaged UI; a signed/notarized macOS install launches with Gatekeeper enabled
without quarantine-removal commands. If credentials are unavailable, record the
release blocker and continue independent onboarding work.

### 2. First working workspace

- Detect package manager and existing configuration; suggest editable commands
  with their source visible. Preserve existing configuration.
- Start with validated Node recipes for npm, pnpm and Yarn. Unknown stacks get
  explicit manual configuration, without invented Node commands.
- Make database configuration conditional and agent connection skippable.
- Guide repository selection → configuration → setup → service start → open app.
  Distinguish a running process from a ready service; report readiness only when
  a configured check succeeds.
- Preserve input on failure and offer retry from the failed operation. Verify
  retry behavior for partial setup; do not claim arbitrary scripts are idempotent.
- Check keyboard navigation, focus, labels and readable errors in this path.

Acceptance: each supported fixture works without hand-editing a config file;
two worktrees run concurrently on distinct ports; a database-free project needs
no Postgres; unknown projects receive no automatic npm setup.

### 3. Explain failures and prove agent connectivity

- Add a focused preflight/Workspace Doctor for Git, required runtime, configured
  working directories, port conflicts and configured database connectivity.
- Show the failed check, relevant redacted output and a specific next action.
  Separate read-only checks from actions that modify the machine or repository.
- Add or verify an end-to-end agent connection check, visible capabilities and
  a copyable example: create worktree → run setup → inspect output/start service.
- Validate both desktop-hosted and headless MCP with real supported clients;
  include grant/revoke and reconnect behavior.

Acceptance: missing-runtime, occupied-port and setup-failure scenarios are
diagnosable from the UI; retry retains configuration; real client acceptance
is recorded separately from unit tests, without exposing tokens or secrets.

### 4. Observe early users and fix repeated friction

- Prepare a short session guide and a feedback form using existing issue
  templates. Recruit 10–15 target users, subject to maintainer outreach.
- Watch users install and create a workspace on their own repositories. Record
  completion, elapsed time, interventions and the point of abandonment.
- Rank problems by affected users, severity and effort. Fix the three most
  frequent blockers, then repeat the affected tasks with users.
- Ask participants after seven days whether they returned and what they used.

Acceptance: report actual participant counts and raw outcomes, including failed
attempts. Small-cohort results guide decisions; they are not market-wide proof.
No outreach or public posting is authorized merely by this planning document.

### 5. Focused public launch — after the first-use gate

- Publish tested recipes for a simple web app and a frontend/API project; add a
  database-backed example only after its isolation behavior is verified.
- Update the landing page with the product promise, supported platforms, one
  primary download action and a clear first-run guide.
- Record two short demos: concurrent branches and the agent-assisted workflow.
- Prepare release notes, community-specific launch drafts and small contribution
  issues for recipes/docs. Existing contribution and issue templates are reused.
- Have the maintainer publish to relevant communities and recruit the next cohort.

Acceptance: a newcomer can follow each published example from a clean install;
claims match release evidence; promotional assets link to the same release.

### 6. Expand from evidence — after the launch

Use support requests and retention feedback to choose the next platform or stack.
Validate Linux/Windows on real desktops before promoting them as fully supported.
Prioritize service dependencies/readiness, resource controls or team recipes when
observed workflow failures justify them. Preserve generic command configuration.

## Measurement and initial decision gates

Use observed sessions and voluntary follow-up first; analytics infrastructure is
not a launch prerequisite. Any later telemetry must be opt-in and exclude paths,
repository names, command text, logs, environment values and credentials.

| Measure | Definition | Initial target, not an observed result |
| --- | --- | --- |
| Activation | First isolated workspace reaches a working app / users attempting the task | At least 8 of the first 10 complete without facilitator intervention |
| Time to value | Repository selection to working app, including setup | Median under 5 minutes on the documented reference fixture/machine; separately report real-project times |
| Recovery | Seeded runtime/port/setup failure resolved with UI guidance | Each reference scenario recoverable without losing entered configuration |
| Retention | Activated participants reporting another workspace session on days 7–14 | At least half; show numerator and denominator |
| Installation | Successful clean-machine launch per supported package/platform | No unresolved install blocker on the primary supported platform |

These thresholds are provisional. If activation fails, fix first use before a
broad launch. If activation passes but retention fails, interview users about
recurring value before adding features. Track setup time separately from user
interaction time so slow downloads remain visible rather than excluded.

## Ownership, validation and existing backlog

- Engineering: checkpoints 1–3, fixes from 4, recipe validation and documentation.
- Maintainer: signing credentials, access to test machines, recruitment, user
  interviews and publishing. Prepare reviewable assets before requesting action.
- For code changes, run relevant UI/backend tests and both desktop/headless checks
  when shared behavior changes. Package tests cannot be replaced by unit tests.
- This is the proposed adoption-first order. It leaves MCP browser/independent
  host attachment and approval-gated destructive actions pending, without deleting
  their requirements. Pull useful release acceptance work forward from MCP stage 6.
- Defer cloud hosting, mandatory accounts, broad integration catalogs and full
  stack/platform coverage until user evidence supports the investment.

**First implementation task:** audit release/install facts and reconcile README
and maintained website documentation with the verified release and current UI.
