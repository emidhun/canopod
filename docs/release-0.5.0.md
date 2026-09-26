# Canopy 0.5.0 release notes

Settings now has separate pages, rejects incomplete rows without discarding entered values, and preserves local edits when a background config read finishes. Files supports editing teardown and migration commands as well as provisioned files.

New worktrees default to `<repo>/.worktrees`. Relative worktree roots resolve against the repository; absolute roots remain absolute. Preview and creation use the same calculation.

`.worktreemanager.json` supports `setupPolicy` and object-form setup entries (`cmd`, `cwd`, `enabled`). Setup completion markers live in `.canopy/setup.json`. Existing unrelated configuration keys survive Settings saves.

Agent waiting transitions now notify according to preferences and contribute to the app badge. Background update checks are opt-in; enabling them contacts GitHub on startup and periodically. Manual checking remains available in General settings.

Release integration: squash PR #154 with a DCO-signed commit message and no co-author trailers. Do not rewrite the shared release/MCP stack to change historical trailers.
