# MCP client validation

This records local debug-build checks, not packaged release acceptance.

| Component | Tested version/environment |
| --- | --- |
| OS | macOS 27.0 (26A428), arm64 |
| Backend | Canopod 0.4.7, GUI-free debug binary from transport PR |
| Rust MCP SDK | rmcp 3.4.0 |
| Claude Code | 2.1.267 |
| Codex CLI | 0.155.1 |

An isolated temporary Git repository was registered as `smoke-repo`. The backend
used separate temporary config/data/log directories and an explicitly selected
nonzero loopback port. Its private application credential enabled MCP for that
repository only. Neither the user's existing Canopod state nor global client
configuration was changed.

Claude Code used a private mode-0600 HTTP MCP config named `canopod-mcp` with its
Authorization header loaded from the private MCP credential. Codex used temporary
CLI config overrides with `bearer_token_env_var`; the bearer value was passed in
the child environment, never in command arguments. This follows the supported
[Codex HTTP MCP configuration](https://developers.openai.com/codex/mcp/).

Both actual clients discovered and called `canopod_status` against the same running
backend, without spawning another domain owner. Both returned:

```json
{"repoId":"smoke-repo","source":"cache","cacheAvailable":true,"worktrees":1,"services":{"stopped":0,"starting":0,"running":0,"stopping":0,"error":0}}
```

The Claude run initially connected but rejected `tools/list` because its current
protocol expects `ttlMs` and `cacheScope`. The handler now sets `ttlMs: 0` and
`cacheScope: "private"` explicitly; its tool call passed after that fix. Regression
tests assert the cache hints. Claude negotiated `2026-07-28`; Rust integration
tests also exercise legacy `2025-03-26` initialization and calls without sessions.

The fixture was restarted during validation and retained its endpoint, policy
and credential. Local CLI integration tests exercise enable, disable, re-enable,
rotation, status, duplicate-owner rejection and explicit shutdown. Network tests
exercise wrong credentials/Host/Origin, oversized bodies, bounded stalled calls
and cancellation of those calls on rotation.

## Release-branch check — 2026-10-01

This follow-up used the current `0.5.0` release branch on macOS arm64 with Codex
CLI 0.155.1 and Claude Code 2.1.280. A separate `canopod-backend` process used an
isolated Git repository, config, data, logs, credential and port. MCP was enabled
read-only for `smoke-repo`; the fixture and backend were stopped after the run.

Codex connected using `bearer_token_env_var`, then successfully called
`canopod_status`, `canopod_worktrees` and `canopod_services`. It observed one main
worktree, no services and no failures. The installed Canopod desktop host was also
available on its normal endpoint. A second real Codex run used the automatically
managed `http_headers_helper` entry and successfully called `canopod_status` for
an allowed repository. No MCP write capability was granted in either run.

Claude Code established the isolated MCP connection and listed Canopod's tools,
which proves config and transport discovery, but its model request stopped before
a tool call because the installed OAuth session had expired and could not be
refreshed. This is recorded as unavailable, not a connectivity pass. The prior
2026-09-20 Claude Code 2.1.267 tool call above remains historical evidence.

The Settings page now supplies a copyable, read-only first task. Manual Codex
configuration uses `CANOPOD_MCP_TOKEN` through `bearer_token_env_var`, so copying
the TOML does not copy the bearer token. Automatic setup continues to use the
client's dynamic header helper so token rotation works after reconnect.

## Packaged release gate

Every tagged macOS, Linux and Windows package now runs the packaged
`canopod-backend` through a fresh isolated lifecycle: start without a GUI,
register a temporary Git repository, enable read-only MCP, initialize the
official protocol, discover tools and the `canopod_worktree_delivery` prompt,
verify advertised output schemas and typed `structuredContent`, execute 25 cached
status calls, and stop cleanly. The command prints p50/p95/p99 and fails when
warm p95 exceeds 50 ms.
The private bearer is loaded internally and never printed.

This gate is configured but does not count as passed for a release until the
tagged release-smoke matrix is green. Browser attachment, desktop-as-client
migration, destructive approvals, idle CPU/RSS measurement and a current Claude
model/tool call remain unverified.
