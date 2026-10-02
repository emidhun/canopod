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
4. **Independent host bootstrap — partial.** A fresh headless host can register
   an existing Git repository through the authenticated CLI, enable MCP, run a
   credential-safe protocol smoke and operate without a GUI. Complete application
   RPC/event reconciliation, desktop attachment and native capability routing
   before switching desktop ownership. Browser static assets, pairing/session/
   CSRF and disconnect reconciliation remain separate post-v0.5 work.
5. **Approvals and destructive tools — pending.** Authenticated human UI approval
   tied to exact request, single use, expiry, permission/precondition revalidation
   and bounded audit. Then worktree removal/database operations with dirty/main/
   shared-database protections. No destructive tool before its approval path.
6. **Release acceptance — in progress.** A discoverable permission-aware workflow
   prompt and `mcp smoke` now validate initialize, prompt/tool discovery, typed
   cached status and 25-call p50/p95/p99, failing above the 50 ms warm p95 budget.
   Every tagged macOS/Linux/Windows package runs this smoke before publication.
   Real client checks remain separately recorded; unavailable clients/platforms
   stay unverified rather than being replaced by unit tests.

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

Release-gate validation: 208 desktop and 200 headless Rust unit tests plus four
real backend process tests passed, including fresh headless registration and the
credential-safe MCP smoke. Strict desktop/headless Clippy passed. The frontend
passed 182 tests and its production build; the documentation site built 34 pages
with all 80 screenshots resolved. Tagged packaged-platform results remain pending
until a new release workflow runs against rebuilt artifacts.
