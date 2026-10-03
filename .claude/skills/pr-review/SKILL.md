---
name: pr-review
description: Review a Canopod pull request against project-specific conventions. Use when asked to review a PR, a diff, or a contribution — locally (/pr-review <number>) or in CI.
---

# Canopod PR review

Fetch the PR first (`gh pr view <n>`, `gh pr diff <n>`), read any files the diff
touches for context, then review against the checklist below. Be specific and
kind — many contributors here are first-timers picking up `good first issue`s.

## Project invariants (block on violations)

1. **Config writes fail closed.** Anything writing user-editable files
   (`.worktreemanager.json`, `.env`, provisioned files) must error on malformed
   input — never `unwrap_or(json!({}))` / silently rewrite. Pattern + tests:
   `src-tauri/src/setup.rs`.
2. **Platform code is cfg-gated with a fallback.** macOS-only APIs
   (NSPanel, `open`, activation policy) live behind `cfg(target_os = "macos")`
   with a working non-macOS path — see `src-tauri/src/tray.rs`. Both CI jobs
   (linux, macos) must pass; don't approve if a change can only compile on one.
3. **Provisioning preserves user content.** Upserts touch only the declared
   keys; every other line/comment survives. Paths from config are containment-
   checked (no absolute, no `..`).
4. **Port/DB derivation stays deterministic.** Effective port =
   `basePort + index*10` (+ explicit overrides); DB name from `wt_slug`.
   Changes here need a test and a look at `reapply_provision` implications.
5. **IPC stays in sync in three places:** command in `src-tauri/src/commands.rs`,
   registered in `lib.rs` `generate_handler!`, typed wrapper in `src/ipc.ts`
   (camelCase serde on both sides).

## Conventions (request changes politely)

- Frontend colors/spacing come from `src/styles/tokens.css` variables — no
  hardcoded hex in components; new CSS goes in `app.css` using existing vars.
- Rust: match the surrounding module's comment density and error-string style
  (lowercase, actionable, includes the path/command that failed).
- Engine changes (`setup.rs`) come with pure-string unit tests in the same
  file's `tests` module; run `cargo test` from `src-tauri/`.
- Frontend must pass `npx tsc --noEmit` and `npm run build`.
- Commits carry DCO sign-off (`Signed-off-by:`) per CONTRIBUTING.md.
- No `Co-Authored-By` trailers.

## Judgment calls

- Modal/UX flows: long-running ops must not trap the user (see issues #7/#8) —
  prefer dismissible progress that continues in background.
- Prefer small diffs that match the issue scope; flag scope creep gently and
  suggest a follow-up issue instead of blocking.
- New dependencies need justification — this app ships as a small binary and
  builds offline-friendly.

## Output format

1. **Verdict**: approve / approve-with-nits / request-changes
2. **Findings** ordered by severity, each with `file:line` and a concrete fix
3. If request-changes: end with what's *good* about the PR and the shortest
   path to approval — keep first-time contributors moving.
