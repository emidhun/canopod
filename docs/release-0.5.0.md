# Canopod 0.5.0 release notes

Settings now has separate pages, rejects incomplete rows without discarding entered values, and preserves local edits when a background config read finishes. Files supports editing teardown and migration commands as well as provisioned files.

New worktrees default to `<repo>/.worktrees`. Relative worktree roots resolve against the repository; absolute roots remain absolute. Preview and creation use the same calculation.

The top-bar and command-palette **Sync external worktrees** action discovers Git-registered worktrees created by another agent or terminal. It also opens the existing reconciliation flow for registrations whose directories were deleted outside Canopod.

`.worktreemanager.json` supports `setupPolicy` and object-form setup entries (`cmd`, `cwd`, `enabled`). Setup completion markers live in `.canopod/setup.json`. Existing unrelated configuration keys survive Settings saves.

Agent waiting transitions now notify according to preferences and contribute to the app badge. Canopod checks for releases at most daily, announces available versions, and can install Tauri-signed updates automatically when the user opts in. A separate daily GitHub-star reminder can be disabled at any time. Manual checking and installation remain available in General settings.

Repository onboarding now detects npm, pnpm and Yarn, avoids invented Node commands for unknown projects, keeps database configuration conditional, and preserves existing Canopod configuration unless replacement is explicitly requested.

MCP access supports the shared desktop host and independent headless host with repository allowlists and separate grants for worktree setup, service control, and configuration. Headless setup can register a repository entirely from the authenticated CLI. Settings can configure current Claude Code and Codex clients without embedding the bearer token. MCP now publishes allowlisted repository discovery, detailed cached worktree state, a safe worktree-delivery prompt, stable output schemas, and typed structured tool output; every packaged platform runs protocol discovery and a cached-latency smoke before release. Destructive MCP operations remain unavailable until human approval and audit support exists.

Documentation and download links now target 0.5.0 and include a dependency-free simple web recipe. macOS artifacts remain ad-hoc signed and are not notarized; users must follow the documented unsigned-app installation steps.

Dependency security now has a pinned RustSec CI gate. The Tauri 2 `glib` advisory is resolved with the exact upstream soundness fix backported to an immutable fork commit, while compatible `h2`, `quick-xml`, `rustls`, `anyhow`, `event-listener`, and `chacha20` fixes are locked directly.


The workspace now combines shell and agent sessions in one Terminal view. One **+** menu starts either type, and a single configured agent profile launches in one click. **Logs alongside** adds a resizable companion pane. Switching views preserves sessions and log filters; paused logs show new output counts and a return-to-latest action. Layout shortcuts are **⌘1 Logs**, **⌘2 Terminal**, and **⌘3 Terminal + logs**.

Settings has a focused file list and editor, wider readable JSON previews, accessible controls and guarded saving. Service controls use consistent heights and theme status dots, with additional services and database tools under **⋯**. Change review uses compact filenames with full-path tooltips. The status bar retains Pull and its submodule menu.

Database restore validates destination names, distinguishes creating a database from replacing one, and requires explicit acknowledgement before replacement. Reset can continue in the background. Bulk worktree removal blocks on incomplete or failed safety checks and offers retry.

The attention popup offers individual dismissal and **Clear notifications** for saved notices and setup reminders. Setup reminders are hidden for the current app session; dismissal never marks setup complete. A changed setup outcome can reappear. Live service crashes and agent requests remain actionable.

Validation includes **276 frontend tests**, production TypeScript/build checks, cross-platform Rust tests and Clippy, a production CSP rendering check, and dependency auditing. Packaged installers also run version, launch and headless MCP smoke checks before publication. Signed updater metadata and installer SHA-256 checksums accompany the release.
