# Canopy 0.5.0 release notes

Settings now has separate pages, rejects incomplete rows without discarding entered values, and preserves local edits when a background config read finishes. Files supports editing teardown and migration commands as well as provisioned files.

New worktrees default to `<repo>/.worktrees`. Relative worktree roots resolve against the repository; absolute roots remain absolute. Preview and creation use the same calculation.

The top-bar and command-palette **Sync external worktrees** action discovers Git-registered worktrees created by another agent or terminal. It also opens the existing reconciliation flow for registrations whose directories were deleted outside Canopy.

`.worktreemanager.json` supports `setupPolicy` and object-form setup entries (`cmd`, `cwd`, `enabled`). Setup completion markers live in `.canopy/setup.json`. Existing unrelated configuration keys survive Settings saves.

Agent waiting transitions now notify according to preferences and contribute to the app badge. Canopy checks for releases at most daily, announces available versions, and can install Tauri-signed updates automatically when the user opts in. A separate daily GitHub-star reminder can be disabled at any time. Manual checking and installation remain available in General settings.

Repository onboarding now detects npm, pnpm and Yarn, avoids invented Node commands for unknown projects, keeps database configuration conditional, and preserves existing Canopy configuration unless replacement is explicitly requested.

MCP access supports the shared desktop host and independent headless host with repository allowlists and separate grants for worktree setup, service control, and configuration. Headless setup can register a repository entirely from the authenticated CLI. Settings can configure current Claude Code and Codex clients without embedding the bearer token. MCP now publishes allowlisted repository discovery, detailed cached worktree state, a safe worktree-delivery prompt, stable output schemas, and typed structured tool output; every packaged platform runs protocol discovery and a cached-latency smoke before release. Destructive MCP operations remain unavailable until human approval and audit support exists.

The maintained documentation now distinguishes published `0.4.7` downloads from this unreleased source branch and includes a dependency-free simple web recipe. macOS artifacts remain ad-hoc signed and are not notarized; users must follow the documented unsigned-app installation steps.

Dependency security now has a pinned RustSec CI gate. The Tauri 2 `glib` advisory is resolved with the exact upstream soundness fix backported to an immutable fork commit, while compatible `h2`, `quick-xml`, `rustls`, `anyhow`, `event-listener`, and `chacha20` fixes are locked directly.

Release integration: squash PR #154 with a DCO-signed commit message and no co-author trailers. Do not rewrite the shared release/MCP stack to change historical trailers.
