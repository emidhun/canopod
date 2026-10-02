---
title: MCP and coding agents
description: Connect Claude Code, Codex or another local MCP client to Canopy with explicit repository and capability grants.
---

# MCP and coding agents

Canopy 0.5 can expose its existing backend to local coding agents through MCP Streamable HTTP. The
agent sees the same repositories, worktrees, services, jobs and configuration as Canopy. It does not
start a second service manager or receive a general shell tool.

MCP is **off by default**. Open **Settings → MCP**, choose the repositories an agent may access, then
enable only the capabilities it needs:

- Discover allowlisted repositories and read cached status, detailed worktree Git/setup state, jobs,
  configured services, bounded redacted logs and public config.
- Create worktrees and run their configured setup scripts.
- Start, stop or restart configured services.
- Update explicitly supported repository and existing-service fields with revision checks.

Destructive worktree, database and command operations are not exposed in 0.5. They remain disabled
until Canopy has a human approval and audit flow.

## Connect a client

Settings can configure current Claude Code and Codex installations automatically. Manual setup shows
the loopback endpoint and client-specific configuration. Canopy stores the MCP bearer separately from
the application credential and never puts it in a URL. Rotate the token if it may have been exposed,
then reconnect clients.

After connecting, clients can discover the `canopy_worktree_delivery` prompt. It requires an allowed
repository ID and a task, never invents a branch, resolves only the configured or explicit base, polls
durable jobs to completion and distinguishes a running process from verified readiness.

## Headless setup

The packaged `canopy-backend` can run without opening the desktop app:

```sh
canopy-backend serve
canopy-backend repo add /path/to/repository
canopy-backend mcp enable --repo REPOSITORY_ID --read-only
canopy-backend mcp smoke --repo REPOSITORY_ID
```

Run `serve` under your own process supervisor. The control commands attach using Canopy's private
application credential; they do not print either credential. `mcp smoke` checks protocol negotiation,
prompt and tool discovery, advertised output schemas, typed cached status, and 25-call p50/p95/p99 latency. It fails when warm p95
exceeds the 50 ms release budget.

:::note One owner at a time
The desktop app and the headless backend use the same runtime ownership lock and default data. Do not
start both for the same directories. In 0.5 the desktop does not attach as a client to an already
running independent backend.
:::

## Recovery

- **Connection refused:** launch Canopy or start `canopy-backend serve`.
- **Unauthorized after rotation:** reconnect the client so it reloads the private token.
- **Repository denied:** enable that exact registered repository in Settings or with `mcp enable`.
- **Revision conflict:** read repository configuration again, reconcile, then retry once.
- **Interrupted job:** inspect the durable job and output; Canopy never silently replays it.

Browser management and destructive approvals are post-0.5 work. The MCP listener binds to loopback;
remote exposure is unsupported.
