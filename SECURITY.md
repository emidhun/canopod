# Security Policy

## Supported versions

Only the latest release receives security fixes.

## Dependency security

- Dependabot monitors npm, Cargo and GitHub Actions dependencies.
- CI runs RustSec against the committed `src-tauri/Cargo.lock`; known vulnerabilities fail the
  security job.
- Security-sensitive Git overrides are pinned to full immutable commit hashes and include a comment
  explaining the upstream constraint and removal condition.
- Advisories are upgraded or backported rather than dismissed solely to clear the alert. RustSec's
  informational maintenance warnings are reviewed separately from vulnerabilities.

Tauri 2's GTK3 dependency graph still requires the `glib` 0.18 API. Canopy pins a minimal fork that
backports the upstream `VariantStrIter` soundness fix until a supported stable Tauri line moves to a
fixed GTK generation. The exact source commit is recorded in `src-tauri/Cargo.toml` and the lockfile.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead:

- Use GitHub's [private vulnerability reporting](https://github.com/emidhun/canopy/security/advisories/new), or
- Email **idhutest@gmail.com** with details and reproduction steps.

You'll get an acknowledgement within a few days. Please allow a reasonable window
for a fix before public disclosure.

## Scope notes

Canopy runs local shell commands **by design** (services, setup/teardown from
`.worktreemanager.json`). Reports along the lines of "a malicious repo config can
run commands" are expected behavior — treat repo configs like you treat a
`Makefile`. In-scope examples: command execution *outside* configured commands,
path traversal writing outside the worktree, privilege escalation, or leaking
secrets between worktrees.
