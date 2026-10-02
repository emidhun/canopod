---
title: Security
description: Canopy's trust boundaries, dependency checks, update policy and private vulnerability reporting process.
---

# Security

Canopy is a local developer tool with intentionally powerful access: it creates worktrees, launches
shell commands, manages process trees, reads project configuration and can connect to local
databases. Treat a repository's `.worktreemanager.json` the way you treat its `Makefile` or package
scripts: review it before running setup or teardown from an untrusted repository.

## What Canopy protects

- Application and MCP credentials are stored separately and are not included in ordinary command
  output or exported configuration.
- MCP access is off by default and can be restricted by repository and by capability.
- Filesystem paths, worktree ownership and process identities are validated before destructive
  operations.
- Release builds use a committed lockfile so CI and local release builds resolve the same Rust
  dependency versions.

## Dependency checks

Dependabot monitors the JavaScript, Rust and GitHub Actions dependency graphs. Every pull request and
push to the default branch also runs RustSec against `src-tauri/Cargo.lock`; known vulnerabilities
fail the CI security job. The audit action is pinned to an immutable commit rather than a moving tag.

Informational notices such as an unmaintained transitive crate are still printed for review, but do
not have the same meaning as an exploitable advisory. When a framework dependency blocks a normal
upgrade, the repository records and pins any reviewed backport until the supported framework line
contains the fix.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/emidhun/canopy/security/advisories/new),
or email `idhutest@gmail.com` with the affected version, reproduction steps and impact.

Reports about command execution explicitly requested by a trusted repository configuration are
normally expected behavior. Examples that are in scope include command execution outside configured
commands, path traversal outside the selected worktree, privilege escalation, cross-worktree secret
leakage, or bypassing MCP permissions.

Only the latest published release receives security fixes. Update to the newest release before
reporting an issue that may already be resolved.
