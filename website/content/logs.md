---
title: Logs
description: One merged stream per worktree, filters that stay out of the way, and a crash you can fix without leaving.
---

# Logs

The Logs pane shows one stream for the whole worktree instead of a tab per service. What you usually
want to read is what happened here, in order, across processes, so the service is a filter and not a
destination.

!shot layout-split | Terminal + logs (`⌘3`): service output on the right; each line carries its time and its service.

## Log line format

```
14:22:07  Server   POST /api/orders 201 — 88ms
```

| Part | Notes |
|---|---|
| Time | `HH:MM:SS`, local, from the backend. Lines from different services are interleaved by it. |
| Service | Which process emitted it. |
| Message | The raw line. Errors are red, warnings amber, `ok` lines green-tinted, info plain. |

The backend assigns levels as `info`, `ok`, `warn` or `err`.

## The toolbar

!shot logs-filters | Service chips, the level filter, search, Follow, and Clear.

| Control | Behaviour |
|---|---|
| **All** plus one chip per service | Filters the stream to one service. Each chip carries a live status dot. |
| **Levels** | A popover with **Errors**, **Warnings** and **Info**. `ok` lines ride with Info instead of earning a fourth filter nobody would think to turn off. The chip shows how many levels are on when any are off. |
| **Search logs…** | Case-insensitive substring match over the message text. Cleared when you switch worktree. |
| **Follow** | Auto-scroll. It turns itself off the moment you scroll up, and back on when you click it. |
| **Clear** (✕) | Empties the buffers of every service in this worktree. |

If a filter combination hides everything, the pane says *"No lines match these filters"*. With nothing
logged at all it says *"Nothing logged yet — start a service to see output here."*

## Inline crash recovery

When a service exits with an error, a bar appears above the stream:

- **`<Service>` exited.** The stack trace is at the end of this log.
- **Jump to error** filters to that service, turns off Warnings and Info, re-enables Follow and scrolls
  to the end.
- **Restart** restarts the service without leaving the pane.

You can act on the failure where you're already reading it.

## Buffer limits

Each service gets a **160-line ring buffer** in the Rust backend, and the oldest lines fall off the
end. The backend batches emissions every 200 ms, which caps store updates at five per second per noisy
service. That's noticeable during a webpack burst and invisible as tail latency.

Log events only go to windows that consume them, and not at all while every window is hidden, so a
busy service doesn't keep an offscreen webview warm. Switching worktree primes every service's buffer
from the backend, so the merged view starts complete instead of filling in one service at a time.

## Operation logs are separate

Provisioning, migrations, custom commands and database jobs stream into a per-worktree operation buffer
of 300 lines rather than into a service's log. That buffer is what the setup runner turns into a step
list, what the sidebar's in-progress row reads its current step from, and what a failure notice carries
the tail of. A failed `npm install` stays readable after the dialog is gone, in the notice the
attention queue holds.

## No log file for services

Service output lives in memory, in the ring buffer above. Canopy's own log (the Rust side: IPC errors,
spawn failures, sweep decisions) goes to the platform log directory as `canopy.log`, rolling at 2 MB
with one rotation kept, at `INFO` by default and controllable with `RUST_LOG`.

:::note Coming soon
**Open logs** in Settings → Advanced isn't wired yet, so open the log directory yourself for now.
[Where settings live](settings-storage.html) has the path for each platform.
:::
