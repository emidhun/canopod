# MCP implementation sequence

User requested sequential implementation on 2026-09-30. Baseline: 0815c01.
Claude review was attempted through MCP (no available agent types) and the
installed CLI (expired OAuth session); no Claude review has been obtained.

Each stage is implemented, tested in desktop and headless builds, documented,
then committed before the next stage. Existing permission grants never silently
gain new capabilities. Keep the shared operations and worktree leases.

1. **Diagnostics — complete.** Capture setup stdout/stderr before the UI
   throttle, with bounded lines, secret filtering before journal persistence,
   periodic flush and final durability reporting. Expose paged job output,
   cached service identities/status, and bounded redacted service-log snapshots.
   Verify unauthorized/cross-repository reads, bursts, rotation, secret values,
   failures, restart recovery and response size.
2. **Service execution — complete.** Explicit service-control grant in UI/CLI,
   durable start/stop/restart jobs using shared operations. Verify retry identity,
   worktree lease conflicts, shutdown, permission changes, actual processes.
3. **Configuration — complete for existing repository/service patches.** Public-field configuration reads, revisions and
   stable-ID patches, external/UI/MCP conflict checks and atomic ordered writes.
   Separate configure permission; never expose environment values.
4. **Independent host and browser — next.** Complete authenticated application
   RPC/event reconciliation, desktop attachment/bootstrap and native capability
   routing, browser static assets/pairing/session/CSRF, disconnect preservation.
   Do not switch desktop ownership until attachment is working end-to-end.
5. **Approvals and destructive tools — pending.** Authenticated human UI approval
   tied to exact request, single use, expiry, permission/precondition revalidation
   and bounded audit. Then worktree removal/database operations with dirty/main/
   shared-database protections. No destructive tool before its approval path.
6. **Release acceptance — pending.** Real client workflow examples and diagnostics,
   reproducible latency/resource measurements and packaged platform matrix.
   Record unavailable platforms as unverified; never substitute unit tests for
   packaged client acceptance.

The stages are independent delivery checkpoints, not a claim that all roadmap
issues are complete. Detailed requirements remain in mcp-delivery.md.

Diagnostics validation: 200 desktop and 192 headless Rust unit tests, three
process tests per build, 169 frontend tests, frontend production build and
Clippy passed locally on macOS. Packaged platform acceptance remains pending.

Service validation: 201 desktop and 193 headless Rust unit tests, three
process tests per build (including CLI grant/revoke), nine MCP UI tests,
frontend production build and Clippy passed locally on macOS.

Configuration validation: 203 desktop and 195 headless Rust unit tests, three
process tests per build, targeted settings/MCP UI tests, frontend production
build, and desktop/headless Clippy passed locally. Concurrent stale revisions,
failed patches and external edits preserve the winning configuration.
