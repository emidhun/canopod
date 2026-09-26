# Headless Canopy and MCP delivery

Tracking epic: [#145](https://github.com/emidhun/canopy/issues/145).
Implementation base: `release/0.5.0` at `d294dc3`.

Claude planning was obtained through Claude MCP on 2026-09-19 using the fetched
issue bodies and Codex's repository inspection. Codex implements the changes;
Claude reviews each PR and Codex addresses verified findings. A plan or a PR
does not count as a completed issue: acceptance evidence is required.

## Architecture and ordering

The newer #156 and #157 supersede the epic's original desktop-only lifecycle.
The final backend runs independently of a window or Tauri event loop. Desktop,
browser and MCP attach to one state owner. During extraction, desktop can keep
hosting the existing runtime, but that intermediate state is not headless
completion. Desktop exit can only become a detach after ownership has moved to
the independent backend. MCP disablement must leave the application listener
and browser available.

Claude recommended staged context extraction, a headless host, ownership,
bounded events, then client attachment. The ownership guard is small and has no
dependency on that extraction, so it is implemented first to protect the
subsequent transition. There is no headless executable or attach protocol yet.

| Issue | Implementation and verification gates |
| --- | --- |
| #156 | Ownership lock before state reads/sweeps; inject paths, state, Tokio handle and event delivery; extract shared operations; GUI-free executable; authenticated versioned app API; desktop becomes a client; graceful stop/crash/duplicate-start tests. |
| #139 | Durable bounded jobs, request-key deduplication, reconnectable redacted output, one shared lease; preserve seven UI commands' awaited results; interruption, disk failure and partial-create tests. |
| #140 | Official Rust SDK Streamable HTTP on the backend; MCP settings/CLI, private credentials, per-call authorization, bounded admission/sessions; Host/Origin, rotation, disablement, port collision and packaged-client tests. |
| #157 | Static assets, separate browser pairing/auth and CSRF protection, snapshot/event reconciliation, explicit IPC transports and capability inventory; disconnects preserve work and never silently enable mock data. |
| #141 | Scoped status/worktree/log/job/config reads; canonical root inference; public-field output policy, cursors and 32 KiB cap; no-subprocess cached status and cross-repo/redaction tests. |
| #142 | Revisioned shared settings/repo writes, atomic ordered persistence, stable-ID updates, explicit configure/execute permissions, shared mutation operations/jobs and leases; UI/MCP and external-edit conflict tests. |
| #143 | Exact-request, single-use human approval through authenticated UI, permission/precondition revalidation and bounded audit; replay/revocation/restart/dirty/main/shared-DB tests before destructive tools ship. |
| #144 | Workflow prompt, real Claude Code/Codex examples, diagnostics and reproducible four-client benchmarks; report measured p50/p95/p99 and packaging/platform coverage honestly. |

The browser approval UI gates #143. Jobs need the shared runtime interfaces and
gate long-running writes; they do not gate the transport or cached status.
Completed #138 and #84 are reused. Backend changes associated with #16 do not
close its separate UI editor work.

## Ownership guard

`runtime.lock` lives in the existing Tauri application data directory. Every
participating host must acquire the same OS lock before reading runtime state,
sweeping child processes, or writing state. Keep the open file for the owner's
entire lifetime; never unlink it. An occupied lock currently gives a clear
startup error in the backend log. Packaged desktop presentation of that error
now displays a native error dialog before exiting. Future
attach support must validate the backend handshake without constructing a
second runtime.

This guard coordinates upgraded hosts only. Old versions do not acquire it.
Before shipping concurrent headless/desktop startup, the takeover path must
also detect an old live owner and refuse to sweep its children. Process identity
checks alone prevent PID-reuse mistakes; they do not prove an old owner died.

## Baseline verification

On the starting release commit, macOS Rust tests: 80 passed; frontend tests:
144 passed; production frontend build passed. Headless, browser, MCP client and
performance acceptance remain unverified until their implementation slices.

## Runtime context extraction

The Rust library now builds with `--no-default-features` without Tauri, its
plugins, or its build script. `desktop` remains the default feature so existing
Tauri development and packaging commands keep working. This is a reusable core
build, not a standalone backend executable yet.

`RuntimeContext` owns the state, process, terminal, disk and notification tables.
Its clones share those exact tables and the existing worktree leases. Domain
commands live in `operations.rs`; Tauri commands are adapters preserving the
same command names, arguments and awaited results. Hosts supply filesystem
paths, a Tokio handle and event/native capability callbacks. `DesktopHost`
preserves the existing event target filters and visibility behavior. The
subscriber event bus and independent backend lifecycle are subsequent slices.

The service log directory cache belongs to the runtime rather than a
process-global static. Tests construct and use the context without a Tauri
application, check shared leases/state, preserve event payloads, skip unobserved
serialization, and schedule work from a synchronous caller. The `core` CI job
builds and tests on Linux without installing desktop system libraries.

## Runtime event subscribers

The runtime event hub admits at most 16 subscribers, with 32 queued events per
subscriber and a 64 KiB encoded-event limit. Consumers share encoded frames.
Publishing never awaits a consumer; sequence allocation and enqueueing occur
under one short coordinator lock. A full queue or oversized event invalidates
that subscription, whose next read requires a fresh snapshot. Its subscriber
slot remains occupied until it disconnects, bounding memory even when a stalled
transport retains an invalid queue.

Application subscriptions exclude PTY bytes. Terminal streams require a
separate subscription kind, to be authenticated by the future host. Native
desktop delivery remains independent of subscriber backpressure. With no native
or subscribed consumer, event payloads are not serialized; process monitoring
and the existing log buffers continue normally.

This is an internal delivery primitive, not a network API. It has no replay
buffer and makes no atomic snapshot guarantee. The authenticated application
API still needs the #157 snapshot/event reconciliation and connection timeouts
before exposing it to browsers. A reconnect must load a new authoritative
snapshot; a cursor alone cannot recover dropped history.
