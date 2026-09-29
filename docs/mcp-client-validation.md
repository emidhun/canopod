# MCP client validation — 2026-09-20

This records local debug-build checks, not packaged release acceptance.

| Component | Tested version/environment |
| --- | --- |
| OS | macOS 27.0 (26A428), arm64 |
| Backend | Canopy 0.4.7, GUI-free debug binary from transport PR |
| Rust MCP SDK | rmcp 3.4.0 |
| Claude Code | 2.1.267 |
| Codex CLI | 0.155.1 |

An isolated temporary Git repository was registered as `smoke-repo`. The backend
used separate temporary config/data/log directories and an explicitly selected
nonzero loopback port. Its private application credential enabled MCP for that
repository only. Neither the user's existing Canopy state nor global client
configuration was changed.

Claude Code used a private mode-0600 HTTP MCP config named `canopy-mcp` with its
Authorization header loaded from the private MCP credential. Codex used temporary
CLI config overrides with `bearer_token_env_var`; the bearer value was passed in
the child environment, never in command arguments. This follows the supported
[Codex HTTP MCP configuration](https://developers.openai.com/codex/mcp/).

Both actual clients discovered and called `canopy_status` against the same running
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

Still unverified: packaged macOS/Linux/Windows client flows, desktop/browser
attachment to this backend, window-close behavior after that migration, client
configuration export UX, and first-connect/idle/performance budgets. These checks
do not mark epic #145 or transport issue #140 complete.
