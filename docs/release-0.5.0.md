# Canopy 0.5.0 release notes

Settings now has separate pages, rejects incomplete rows without discarding entered values, and preserves local edits when a background config read finishes. Files supports editing teardown and migration commands as well as provisioned files.

New worktrees default to `<repo>/.worktrees`. Relative worktree roots resolve against the repository; absolute roots remain absolute. Preview and creation use the same calculation.

`.worktreemanager.json` supports `setupPolicy` and object-form setup entries (`cmd`, `cwd`, `enabled`). Setup completion markers live in `.canopy/setup.json`. Existing unrelated configuration keys survive Settings saves.

Agent waiting transitions now notify according to preferences and contribute to the app badge. Background update checks are opt-in; enabling them contacts GitHub on startup and periodically. Manual checking remains available in General settings.

Repository onboarding now detects npm, pnpm and Yarn, avoids invented Node commands for unknown projects, keeps database configuration conditional, and preserves existing Canopy configuration unless replacement is explicitly requested.

MCP access supports the shared desktop host and independent headless host with repository allowlists and separate grants for worktree setup, service control, and configuration. Settings can configure current Claude Code and Codex clients, copy a read-only first task, and export Codex TOML without embedding the bearer token.

The maintained documentation now distinguishes published `0.4.7` downloads from this unreleased source branch and includes a dependency-free simple web recipe. macOS artifacts remain ad-hoc signed and are not notarized; users must follow the documented unsigned-app installation steps.

Release integration: squash PR #154 with a DCO-signed commit message and no co-author trailers. Do not rewrite the shared release/MCP stack to change historical trailers.
