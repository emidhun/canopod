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
| #156 | Ownership lock before state reads/sweeps; inject paths, state, Tokio handle and event delivery; extract shared operations; GUI-free executable; authenticated versioned app API and terminal repository bootstrap; desktop becomes a client; graceful stop/crash/duplicate-start tests. |
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

Unix recovery checks each recorded live group before any sweep. New records
include the spawning owner's PID and raw kernel start identity; after that owner
dies, verified groups can be recovered even under a Linux subreaper. Legacy
records require a recognized init parent and matching group birth time. Both
hosts retain unverified or inaccessible live records through later state writes;
headless startup reports the exact record requiring manual recovery.

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

Rotation writes a fixed private temporary per credential kind, flushes it, and atomically replaces the
selected token. A pre-commit failure preserves the previous token. Unix flushes
the directory after rename (macOS also uses F_FULLFSYNC on the written file);
Windows renames the validated temporary by handle with POSIX replacement semantics, preserving existing readers of the previous token. It does not promise power-loss durability for directory metadata. A post-rename directory-flush error is
returned alongside the committed new token as a durability warning, so callers
cannot accidentally retain an old in-memory token after committing a new file.
The matching runtime ownership guard enforces serialized rotations across stores; process-local generation numbers let concurrent publishers reject stale results.

The primitive itself opens no sockets and changes no permission profiles. The
application host below explicitly creates its own credential when needed. MCP
revocation and session invalidation belong to its later transport layer.

## Authenticated application control API

`canopy-backend serve` now listens at `http://127.0.0.1:47831` by default.
`serve --port <nonzero-port>` selects and persists an explicit port in
`backend.json` in the config directory. A bind failure never chooses another
port. The application token is loaded or created in private storage after
binding succeeds; it is never printed. MCP defaults to disabled; its route returns 404 until explicitly enabled.
This application listener is independent of future MCP enablement.

`canopy-backend status` and `canopy-backend stop` read the existing private
application credential and attach without creating state or launching a GUI.
They disable proxy use and redirects and bound connect/request/response sizes.
The API requires the application bearer plus `X-Canopy-Api-Version: 1`; unknown
versions fail explicitly. Host must match the exact IPv4 endpoint, and any Origin
must match its origin. Native clients without Origin still require the bearer.
MCP credentials are rejected on application routes. No wildcard CORS is enabled.

This loopback HTTP mode is for trusted-user workstations, not shared or
multi-tenant hosts with mutually hostile local users/processes. Private credential
files protect stored secrets, but TCP loopback does not authenticate the process
owning a port: an impostor can bind the configured port while the backend is
stopped and capture a bearer from an attaching client. Proxy/redirect blocking,
Host/Origin checks and file ACLs do not prevent that attack. Supporting hostile
co-resident users requires an authenticated peer transport or TLS with client
pinning; this implementation does not claim that isolation.

`GET /api/v1/status` returns only cached aggregate counts, API/backend versions,
pid and uptime. It does not spawn subprocesses, claim services are ready, or
return repository settings/secrets. Initial cached worktree counts can be zero
while the first background scan runs. `POST /api/v1/stop` returns 202 and asks the
independent supervisor to stop. Disconnecting a client does not request shutdown.

The control server admits 32 connections and 8 authenticated requests, limits
bodies to 64 KiB, gives headers and request bodies five seconds each, and caps
handlers at ten seconds. Control connections retire after 60 seconds, with up
to twenty seconds to drain an active request. Silent sockets have a five-second
first-byte deadline.
Header timeout is applied in Hyper itself; request middleware alone cannot time
out headers it has not received yet. Shutdown closes admission and gives accepted
connections two seconds to flush while child cleanup proceeds independently.
The core remains owned until its runtime and connection contexts are released.

These are native application control endpoints, not browser pairing or general
RPC. Snapshot reconciliation, browser sessions/CSRF and desktop attachment remain
later slices. MCP transport is implemented below.


## Opt-in MCP transport and cached probe

Both the desktop app and independent backend mount official `rmcp = 3.4.0` Streamable HTTP at `/mcp`
on the same IPv4 listener. The SDK requires Rust 1.88; Canopy's owner locking
already requires a newer standard library. Protocol negotiation and metadata
validation belong to the SDK. Tests exercise legacy `2025-03-26` and current
`2026-07-28` calls. Stateless JSON responses retain zero sessions. Each bounded
request gets its own SDK service, including its tool-schema cache: rmcp caches
unknown tool names, so a process-long service would otherwise grow that cache.

The desktop app starts this listener against its existing runtime, so GUI and
MCP clients see the same registered repositories and cached state. Closing the
main window hides it to the tray and keeps MCP available. Quitting the app drains
the listener and stops child processes; `canopy-backend stop` also quits the
running desktop app. Desktop and headless hosts use the same default directories,
endpoint, credentials and policy; run only one host for those directories.

To use MCP with the headed build, launch Canopy, then run the controls below
without starting `canopy-backend serve`. The CLI attaches to either host. MCP is
still disabled until explicitly enabled. A saved enabled policy is restored when
switching between headed and headless mode. Desktop reads the port from
`backend.json` (default 47831); configuration or bind failures fail startup rather
than silently moving the endpoint.

Native controls (also available under the application-authenticated
`/api/v1/mcp/` routes):

```sh
canopy-backend repo add /path/to/repository
canopy-backend mcp status
canopy-backend mcp enable --repo <registered-repo-id>
canopy-backend mcp rotate-token
canopy-backend mcp disable
canopy-backend mcp enable
canopy-backend mcp smoke --repo <registered-repo-id>
```

`repo add` is the headless bootstrap path. It calls the same canonicalizing,
revisioned registration operation as the desktop and requires the private
application credential. `mcp smoke` reads the private MCP credential without
printing it, negotiates the protocol, discovers tools and the
`canopy_worktree_delivery` prompt, performs 25 cached status calls, reports
p50/p95/p99, and fails when warm p95 exceeds 50 ms.

Repeating `enable` with `--repo` replaces the allowlist; omitting it preserves the
previous list. Enable requires a nonempty list of registered IDs. The policy is
stored separately in `mcp.json`, never in a legacy desktop whole-object save.
Malformed or externally changed policy is preserved. MCP status reports recovery
instructions while application control remains available. Enable requires repair;
disable always revokes live access and reports any persistence failure in status.
If disable reports a persistence error, repair the policy before restarting: the
old enabled policy can otherwise become active again. Successful policy writes
commit before becoming live. Credentials remain in
the private MCP token file; no control command prints them. Ordinary restart and
re-enable preserve the token and endpoint. Rotation requires updating the client
credential. Missing credentials fault MCP without preventing backend startup;
use application administration to rotate the MCP token.

MCP authorization runs before body collection/SDK dispatch. It rejects app
credentials, foreign/duplicate Host or Origin, and invalid bearer values; native
clients may omit Origin. MCP credentials cannot configure their own permissions.
Eight MCP requests are admitted independently of the eight application requests,
with 64 KiB bodies, five-second body reads, ten-second dispatch deadlines and the
shared 32-connection/60-second connection limits. Rotating, disabling or changing
the allowlist cancels the old authorization generation, including stalled bodies;
each tool call checks live policy again. Request cancellation cleans up its SDK
workers. Disabling leaves the application listener and domain runtime running.

Every advertised tool includes a stable output schema. All tool successes include
typed `structuredContent` plus a compact JSON text fallback for clients that
render only text. Read tools cover allowlisted repository discovery, cached
status, worktree listings and detailed Git/setup state, durable jobs and output,
configured services and bounded redacted logs, and public revisioned repository configuration. Mutating tools are listed
only when their explicit capability is enabled. `canopy_status` still requires
`repoId`, launches no subprocesses, and never claims readiness from process
state alone.

The discoverable `canopy_worktree_delivery` prompt requires an allowed
repository ID and user task. Branch is never invented; omitted branch input is
sent back to the user. Omitted base uses the repository's configured default or
requires clarification. The workflow polls durable jobs, preserves retry keys,
uses only configured operations, and distinguishes running from verified ready.

### Desktop setup

Settings → MCP and the optional Connect to agent step after repository onboarding
share live MCP controls. Select registered repositories, enable or disable access,
refresh status, or rotate the token. These changes apply immediately and remain
separate from the Settings save button. Ordinary page loads never export a token.

Connect Claude Code / Connect Codex merges a user-level `canopy` entry into
`~/.claude.json` or `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). The
UI shows the resolved target before writing. Malformed files and unrelated
servers already named `canopy` are refused; other settings are preserved. Custom
`CLAUDE_CONFIG_DIR` setups use the manual fields. No agent is launched and no
successful remote connection is claimed: restart/reconnect the agent afterward.
The configuration uses [Claude Code's `headersHelper`](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication)
and [Codex's `http_headers_helper`](https://developers.openai.com/codex/mcp/)
to read Canopy's private token on reconnect. This requires current clients and
avoids storing another token copy in agent configuration. Configuration replacement
uses a private temporary file and refuses a detected concurrent edit.

Manual setup exposes individually copyable endpoint, transport, bearer token and
Authorization value fields. Complete Claude JSON / Codex TOML snippets are also
available; only deliberate Copy actions retrieve secrets. Claude and generic
snippets contain a static token that must be refreshed after rotation. Codex TOML
instead references `CANOPY_MCP_TOKEN` through `bearer_token_env_var`, and the token
is copied separately. No secret is shown in the on-screen preview. The page also
provides a copyable read-only first task that checks status, worktrees and services.
Reads include `canopy_status`, `canopy_worktrees`, and `canopy_job`. Worktree
creation and setup require an explicit write grant.

Destructive MCP tools remain intentionally unavailable in v0.5 because the
human approval and audit path is not implemented. Browser controls, desktop
attachment to the independent owner, roots inference, destructive approvals,
and broader database/removal jobs remain post-v0.5 work. Tagged packages now run
the protocol and 50 ms cached-status smoke on macOS, Linux and Windows; a green
release-smoke matrix is required before publishing the draft release.

## Durable job journal foundation

`jobs::Registry` owns durable records for MCP worktree creation and setup.
Existing UI operations retain their awaited completion behavior. An accepted MCP
job is not yet a completed operation; clients must poll `canopy_job`.

A registry retains at most 128 jobs, with four queued/running jobs and eight
owned journal transactions at once. Busy responses include a 500 ms retry hint.
Retry identity includes operation, repository, target and client request key;
canonical payload hashes reject reuse with different arguments. Raw request keys
and operation payloads are not persisted. Matching retries return the retained
job even when active admission is full. Deduplication ends when the job expires
or is evicted; clients must not treat it as permanent exactly-once execution.

Each job uses one of 128 fixed private snapshot slots. A snapshot contains
metadata and up to 256 KiB of encoded output; the entire file is capped at
288 KiB. Main and temporary files therefore occupy at most 72 MiB of managed
snapshot data. Unix directory/file modes are 0700/0600 and Windows uses the same
owner ACL/retained-handle implementation as credentials. Startup visits only the
known slots, removes validated leftover temporary files, preserves malformed
snapshots with an explicit error, and marks queued/running jobs interrupted.
It never replays work. The runtime owner must outlive all journal transactions.

Terminal jobs expire after seven days, checked on access and cleaned at startup.
Capacity reclaims the oldest durable terminal slot; queued/running or uncommitted
terminal state is never evicted. The single writer lock is acquired before slot
selection or snapshot capture. A pending write for an old job ID cannot overwrite
a reused slot. Accepted transactions own their tasks through both disk commit
and memory publication, even if the requesting client disconnects.

Output is filtered before entering the bounded memory ring. Known secrets are
matched simultaneously; credential-shaped assignments, JSON log fields, URL
passwords and bearer strings receive conservative additional filtering. This is
best-effort filtering, not a guarantee against arbitrary secret-printing programs.
Lines are capped at 4 KiB after filtering; inputs over 64 KiB are omitted wholesale.
Truncation and rotation clear `outputComplete`; an expired cursor returns an
explicit error. Pages contain at most 500 lines and fit a 32 KiB wire budget.
Outcome details are bounded too, with an explicit `detailsTruncated` indicator.

Appending performs no disk I/O. The execution integration must flush on its
250 ms timer and before completion; only `persistedSequence` is crash-durable.
An interrupted job cannot claim its final in-memory output survived a crash.
A failed final write retains the truthful live operation outcome with
`persistencePending` and `durabilityError`; restart may instead recover the last
committed running state as interrupted. A checkpoint records a created worktree
path before provisioning so later failure does not erase that partial result.
`close()` stops admission and joins owned transactions; the execution owner must
stop operations and flush/finish jobs before calling it.

Owned execution, process cleanup and setup-output capture are implemented for MCP
creation/setup. Remaining: shared progress recording and seven-operation UI
integration. The journal alone does not complete #139.

### Job journal recovery

Startup errors identify the exact `jobs/job-NNN.json` or `.tmp` file. Stop the backend before inspecting it. Preserve a copy for diagnosis. If a damaged snapshot cannot be repaired, move only that identified snapshot outside `jobs/` and restart; this discards its retry identity, so inspect the worktree before resubmitting the operation. Never remove the entire journal to repair one record. Private crash-leftover temporary files are discarded only after validation; insecure or hard-linked files are preserved and reported.

Targets and checkpoint paths are limited to 4 KiB of JSON-encoded bytes. Caller outcomes retain their 16 KiB bound; a merged checkpoint path has a separate 4 KiB allowance. Every snapshot write, including interruption recovery, enforces the same 288 KiB cap.

### Orphan recovery diagnostics

The backend logs to stderr (`RUST_LOG=debug` increases detail; this CLI accepts a level, not module directives), so supervisors can capture sweep warnings. New process records include the spawning backend PID and start identity: adopted children are recoverable after that owner dies, including under Linux subreapers. Legacy records without that identity only recover automatically under a recognized init process and with a matching group birth time. Unverified live records survive subsequent service and terminal state writes.

If startup names an unverifiable `state.json` record, stop Canopy, preserve a backup, inspect the named `orphans` or `terminalOrphans` entry and the running PID identity, then remove only an entry confirmed stale. Do not kill an unrelated process merely because its PID matches an old record. Library hosts and CLI hosts with both config and data explicitly isolated do not reject an unrelated default-directory desktop; shared-default CLI hosts retain the legacy-desktop exclusion check.

Credential rotation requires the matching `RuntimeOwner` and serializes across all stores using that guard. Read-only opens never clean files. A writer validates and removes private crash leftovers under the ownership guard; new rotations use one fixed temporary name per credential kind, bounding crash debris. Unsafe leftovers are preserved.
The declared Rust minimum is 1.95, matching the locked `sysinfo` dependency; the ownership APIs alone require 1.89.

HTTP review follow-up: silent sockets have an explicit five-second first-byte deadline; retiring connections drain for twenty seconds to cover headers, body and handler deadlines. Shutdown still drains for at most two seconds. Protocol parse errors generated before application middleware may omit the API version header. `stop` acknowledges asynchronous cleanup.

### Transport review corrections

Malformed MCP policy or credential content faults only the MCP endpoint (503); application status, stop and administration remain available. MCP status reports the recovery error. Disable revokes live access even when policy bytes are malformed and preserves those bytes. Back up and repair the named file before explicitly enabling again; a missing path binding in an older enabled policy requires setting enabled=false then enabling the selected repositories. Token rotation repairs malformed token content only after file privacy checks pass.

Policy stores both the registered path and its canonical path for each explicitly selected ID. Cached requests compare the current registration against that binding; removing a repository or reusing its ID for another path does not inherit permission. Administrative filesystem work runs in an owned blocking transaction that publishes committed state even if the requester disconnects. Shutdown returns 503 stopping; token/policy revocation returns 401 authorization_changed.


## MCP worktree creation and setup

Both the desktop host and headless backend expose the same tools. Settings →
MCP and the onboarding Connect to agent page offer **Allow worktree creation
and setup** for the selected repository allowlist. Existing policies default to
read-only. Headless administrators can use:

```sh
canopy-backend mcp enable --repo REPO_ID --allow-worktree-write
canopy-backend mcp enable --read-only
```

Omitting a permission flag preserves the existing grant. The authenticated
application endpoint `POST /api/v1/mcp/enable` accepts `allowWorktreeWrite`;
MCP credentials cannot alter their own permissions.

| Tool | Arguments | Result |
| --- | --- | --- |
| `canopy_status` | `repoId` | Cached repository counts |
| `canopy_worktrees` | `repoId`, optional `cursor`, `limit` | Cached worktree keys, branch, main/setup flags, next cursor |
| `canopy_job` | `repoId`, `jobId` | Status, timestamps, created path, safe error code |
| `canopy_create_worktree` | `repoId`, `branch`, `requestKey`, optional `base`, `createBranch` | Durable job admission |
| `canopy_run_setup` | `repoId`, `worktreeKey`, `requestKey`, optional `dryRun` | Durable job admission |

The last two tools are listed only with write access. Creation uses the configured
worktree directory and provisioning/setup/service defaults. `createBranch`
defaults to true; an omitted `base` uses HEAD. Setup accepts a current, linked,
non-main Git worktree from the allowed repository. Both operations share the
same worktree leases as the UI. They accept no arbitrary command or environment
arguments, but configured scripts can modify files and databases.

Clients should reuse the exact arguments and request key when retrying an
uncertain submission. Matching retained jobs are returned without rerunning;
different arguments for the same operation/repository/target/key are rejected.
A new intentional setup run needs a new request key. Retention is bounded as
described above. Job status responses contain no raw setup output, commands or environment.
Redacted subprocess output is available separately through `canopy_job_output`.
Progress still appears through Canopy's normal operation events.

Accepted work survives an HTTP disconnect. Permission changes prevent new work
and jobs that have not passed their execution authorization check; already
executing work continues. Host shutdown cancels active Git/setup process groups,
records interrupted jobs, and drains journal writes before runtime cleanup.
Startup never replays interrupted work. Creation checkpoints the new path after
Git reports successful creation, before submodules and setup; later failures
preserve that path. A crash during Git creation can precede this checkpoint, so
clients should reconcile worktrees before submitting a new request key.

MCP setup runs serially even when the UI parallel-setup experiment is enabled,
so cancellation covers every active setup subprocess. A damaged journal leaves
read tools available and reports an execution error; write grants require a
healthy journal.


## MCP diagnostics

`canopy_job_output(repoId, jobId, cursor?, limit?)` captures setup stdout/stderr
before the renderer throttle. Omit cursor to start at the earliest retained line;
use nextCursor afterward. An expired cursor is an error, never a silently skipped
range. Output flushes every 250 ms and at completion; persistedSequence and
persistencePending distinguish in-memory output from durable output. Earlier jobs
have no recorded output. Dry runs and provisioning messages are not shell output.

Secret filtering uses Canopy credentials, secret-shaped inherited variables,
configured service environment values, dotenv values and provision templates.
It happens before journal storage. Missing optional dotenv files are accepted;
unreadable, malformed or excessive secret sources suppress capture and mark it
incomplete. Filtering is best-effort: arbitrary scripts can print unknown or
encoded secrets. Oversized lines are omitted, not partially exposed. Reads and
retention are bounded; MCP output pages use a 12 KiB data budget to accommodate
JSON-in-text encoding under the 32 KiB response limit.

`canopy_services(repoId, worktreeKey, cursor?, limit?)` lists cached keys, names,
status and ports without commands/environment. Status is not a readiness probe.

`canopy_service_logs(repoId, serviceKey, snapshot?, cursor?, limit?)` reads the
existing 160-line memory ring with redaction. It does not read arbitrary files or
claim complete history. Repeat snapshot and nextCursor to paginate. If the ring
changes, snapshot_changed requires a fresh first page. Logs disappear on restart;
redaction uses the current known secret sources. Log content is untrusted output.

## MCP service execution

A separate **Allow service start, stop and restart** grant is available in
Settings/onboarding. Existing worktree-write grants do not imply service control.
CLI controls are `mcp enable --allow-service-control` and
`mcp enable --no-service-control`; `--read-only` revokes both execution grants.
The application API accepts `allowServiceControl`.

`canopy_start_service`, `canopy_stop_service` and `canopy_restart_service`
take `repoId`, `serviceKey` from `canopy_services`, and `requestKey`. They
return durable jobs with the same bounded retry rules as creation/setup.
Only configured services in currently registered Git worktrees are accepted,
including the main checkout. No arbitrary command or environment arguments.

Shared desktop/MCP service operations acquire the worktree lease, so they cannot
race setup or another service operation. A stop job waits for the tracked process
to exit. Start/restart success means launch completed; readiness is reported
separately by cached service status and logs. Shutdown prevents a restart from
spawning a new process after cancellation, then the runtime reaps services.

## MCP configuration

`canopy_repository_config(repoId, cursor?, limit?)` returns an opaque settings
revision, repository defaults and paged public service metadata. Command text
and environment values are omitted.

`canopy_update_configuration(repoId, revision, repository?, serviceId?, service?)`
requires the separate **Allow repository and service configuration** grant.
CLI: `mcp enable --allow-configuration` / `--no-configuration`.
`--read-only` revokes configuration as well as both execution grants.

Repository patches accept name, defaultBase, worktreeDir and worktreeDefaults.
Service patches target one existing stable ID and accept name, kind, command,
cwd, basePort (null clears it) and health. Unknown fields, repository/path/ID
replacement, service addition/deletion and environment writes are refused.
Changing a configured command affects a future start; it does not restart a
running service. Configuration permission should be granted with that authority
in mind, especially alongside an execution grant.

Native and MCP settings changes share one ordered transaction. It clones and
validates current state, writes a private temporary file, syncs and atomically
replaces settings.json, then publishes memory and its new opaque revision.
Failed patches leave disk and memory unchanged. An outdated UI/MCP revision is
rejected. MCP retries after an uncertain response must read again and reconcile.

The writer also compares the original file fingerprint before writing and
immediately before replacement; detected external edits are preserved. Restart
Canopy to adopt an external edit. A non-cooperating editor racing in the final
check/rename interval cannot be made transactional by this protocol. Settings
are capped at 4 MiB. Revisions cover app settings; the repository's separate
.worktreemanager.json editor is not exposed as a configuration write tool here.
