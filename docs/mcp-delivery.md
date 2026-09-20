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
subsequent transition. The foreground headless executable is described below; the attach protocol is still pending.

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
still needs a visible recovery dialog before concurrent hosts ship. Future attach support must validate the backend handshake
without constructing a second runtime.

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
build. The foreground backend below uses this core.

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

## Foreground backend lifecycle

Build with `cargo build --manifest-path src-tauri/Cargo.toml --no-default-features
--bin canopy-backend`. Run `src-tauri/target/debug/canopy-backend serve` under a
process supervisor. Directory defaults match Tauri's platform paths and bundle
identifier. `--config-dir`, `--data-dir`, and `--log-dir` accept existing directories
for isolated installations; invalid paths and duplicate flags fail explicitly.
The authenticated control listener is described below; MCP and browser
management are not implemented yet. The desktop still hosts its own runtime and must be closed first.

Startup acquires the data-directory lock before reading state. It also refuses
startup if a known legacy Canopy desktop process is visible. This conservative
name check can reject a desktop using another directory; it is not a proof of
process identity or protection against launching an old incompatible binary
later. Unlike one suggestion in Claude's plan, detecting a legacy owner refuses
startup entirely: merely disabling sweeping would still permit duplicate state
writers. Existing invalid/unreadable settings or runtime JSON abort startup
without quarantine or replacement.

Unix recovery checks each recorded live group before any sweep. A matching
process whose parent is not verifiably init is left alone, and headless startup
refuses takeover. Both desktop and headless sweepers now retain skipped records.
Unknown legacy spawn times also refuse headless recovery. Containers with a
subreaper may require manually stopping the old children; no force-takeover flag
bypasses this. This improves migration safety but is deliberately conservative.

The foreground host owns periodic refresh, statistics, update and terminal
monitor tasks. An unexpected loop exit triggers cleanup and a nonzero exit,
allowing an external supervisor to report or restart it. Ctrl-C and Unix SIGTERM
use the same stop path; Windows console close/shutdown are handled subject to OS
time limits. Cleanup aborts periodic loops, closes PTYs and stops/reaps services.
Every task context retains the ownership lock, so a detached waiter cannot
release ownership while it is still using state. Client subscription drop has
no shutdown effect. Tests exercise a real long-running service across client
detach and explicit shutdown, and an actual backend subprocess through duplicate
launch and SIGTERM. Windows console-signal runtime testing remains pending.

Desktop bootstrap, full application RPC, MCP transport,
service installation and moving the desktop to client-only operation remain
acceptance gates for #156; the foreground binary alone does not complete it.

## Private credential storage

The credential primitive keeps application and MCP secrets in separate files
under the data directory's `credentials` directory. Each token has 32 bytes of
OS entropy, encoded as exactly 64 lowercase hexadecimal bytes. Bearer checks
use `subtle` constant-time comparison; secret types have no Debug/Serialize
implementation and zeroize their owned buffers on drop. Export is explicitly
named `expose()` for the later private client-config flow.

Unix creation uses directory mode 0700 and file mode 0600, refusing foreign
ownership, public permissions, symlinks, hard links and non-regular files.
Operations use openat/renameat/unlinkat against the retained directory handle,
so replacing its pathname cannot redirect an existing store. Windows installs
a protected, current-user-only DACL at creation and checks owner/ACL/reparse
attributes through opened handles. It pins directory path components without
delete sharing to prevent replacement between validation and later operations.
Root/Administrators and processes using this same user identity are trusted;
confidentiality against them is not claimed. The protection is against other
unprivileged local users. On Windows the pinned ancestor handles prevent rename
or deletion of that path chain while the store is open (ordinary read/write
access is unaffected). Stop the backend before relocating the data directory or
its ancestors. This conservative tradeoff closes redirection even for an
explicitly supplied data path; it is not narrowed to a presumed safe ancestor.

Rotation writes a random sibling file, flushes it, and atomically replaces the
selected token. A pre-commit failure preserves the previous token. Unix flushes
the directory after rename (macOS also uses F_FULLFSYNC on the written file);
Windows uses write-through replacement. A post-rename directory-flush error is
returned alongside the committed new token as a durability warning, so callers
cannot accidentally retain an old in-memory token after committing a new file.
Single runtime ownership and serialized rotation are caller requirements.

The primitive itself opens no sockets and changes no permission profiles. The
application host below explicitly creates its own credential when needed. MCP
revocation and session invalidation belong to its later transport layer.

## Authenticated application control API

`canopy-backend serve` now listens at `http://127.0.0.1:47831` by default.
`serve --port <nonzero-port>` selects and persists an explicit port in
`backend.json` in the config directory. A bind failure never chooses another
port. The application token is loaded or created in private storage after
binding succeeds; it is never printed. MCP remains disabled and `/mcp` is absent.
This application listener is independent of future MCP enablement.

`canopy-backend status` and `canopy-backend stop` read the existing private
application credential and attach without creating state or launching a GUI.
They disable proxy use and redirects and bound connect/request/response sizes.
The API requires the application bearer plus `X-Canopy-Api-Version: 1`; unknown
versions fail explicitly. Host must match the exact IPv4 endpoint, and any Origin
must match its origin. Native clients without Origin still require the bearer.
MCP credentials are rejected on application routes. No wildcard CORS is enabled.

`GET /api/v1/status` returns only cached aggregate counts, API/backend versions,
pid and uptime. It does not spawn subprocesses, claim services are ready, or
return repository settings/secrets. Initial cached worktree counts can be zero
while the first background scan runs. `POST /api/v1/stop` returns 202 and asks the
independent supervisor to stop. Disconnecting a client does not request shutdown.

The control server admits 32 connections and 8 authenticated requests, limits
bodies to 64 KiB, gives headers and request bodies five seconds each, and caps
handlers at ten seconds. Control connections have a 60-second maximum lifetime.
Header timeout is applied in Hyper itself; request middleware alone cannot time
out headers it has not received yet. Shutdown closes admission and gives accepted
connections two seconds to flush while child cleanup proceeds independently.
The core remains owned until its runtime and connection contexts are released.

These are native application control endpoints, not browser pairing or general
RPC. Snapshot reconciliation, browser sessions/CSRF, desktop attachment, MCP
transport and live token-rotation/session invalidation remain later slices.
