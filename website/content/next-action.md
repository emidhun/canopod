---
title: The next action
description: Canopod picks the one thing worth doing next in each worktree. Here's how it decides, and where it tells you.
---

# The next action

Canopod answers one question per worktree: what would you do next here? It then offers that one thing
as a button, with the reason sitting in front of it. Four surfaces render the same answer, so they
can't drift apart:

1. The button in the worktree bar, and `⏎`.
2. Each row of the [overview](palette-overview.html).
3. The **Suggested** section of the [command palette](palette-overview.html).
4. The attention queue, which stretches the idea across every worktree.

## Priority order

Evaluated top to bottom. First match wins.

| # | State | The action | The reason shown | Kind |
|---|---|---|---|---|
| 1 | A service exited with an error | **Restart `<service>`** | `port <n> is down` / `the process exited` | crash |
| 2 | An agent is waiting on a decision | **Answer agent** | `<agent> needs a decision` | urgent |
| 3 | The worktree was never provisioned | **Run setup** | `never provisioned` | primary |
| 4 | A service is starting or stopping | **Starting `<service>`…** | `waiting for the port` | busy |
| 5 | Behind origin | **Pull `n` commits** | `behind origin — pull first` | primary |
| 6 | Every service stopped | **Start services** | `N stopped` | primary |
| 7 | Some services stopped | **Start `<service>`** | `N of M stopped` | primary |
| 8 | An agent is working | **Agent working…** | `<agent> is editing files` | busy |
| 9 | Ahead of origin with uncommitted work | **Review changes** | `N ahead · uncommitted work` | primary |
| 10 | A web service is running on a port | **Open :`<port>`** | `everything healthy` | calm |
| 11 | Nothing else applies | **Start agent** | `everything healthy` | calm |

Read down the list and you're reading the workflow. A crash blocks everything after it. A blocked
agent means a machine is waiting on a human. An unprovisioned worktree isn't usable yet, and stale
code shouldn't be booted. Review changes sits at the end of a session, and Open :port is a convenience
rather than something you owe anyone.

## Action styles

| Kind | Appearance | Behaviour |
|---|---|---|
| `crash` | Accent fill | Red is used for the problem. The button that fixes it stays constructive. |
| `urgent` | Amber | Something is blocked on you. |
| `primary` | Accent fill | The ordinary next step. |
| `busy` | Muted, disabled | Acting again would double-start it. |
| `calm` | Quiet outline | Optional. |

## Pressing ⏎

`⏎` runs the next action. It stands down while a terminal, text field or dialog has focus, and while
the action is `busy`. The button shows the `⏎` hint when the binding is live, and not otherwise.

## The attention queue

The same idea, ranked across every worktree. The top bar's **Needs you** chip opens it:

!shot attention | The attention queue: crashes and failed background jobs first, then blocked agents, then completions.

| Severity | Row | Offered action |
|---|---|---|
| 0 | A background job **failed** (create, remove, migrate, reset, snapshot, export, restore) | **View**, which opens the notice with the full error and log tail |
| 0 | A service **crashed** | **Restart** |
| 1 | An agent is **waiting** | **Answer** |
| 2 | Setup **never ran** | **Run setup** |
| 9 | A background job **finished** | **Dismiss** |

Crashes have no dismiss. They leave the queue by being fixed. Notices carry an ✕.

A failure notice is a detail, not a destination. The worktree it names might not exist any more if a
create failed, so picking it opens the notice instead of navigating. Completions clear, and navigate
only when the worktree is still there.

When nothing needs you the chip reads **All clear** and the popover says so.

## Background jobs and notices

Creating a worktree, removing one, and every database job can be dismissed while they run. The work
belongs to the backend and carries on either way. But a dismissed dialog has nowhere to report back
to, and an error that only ever existed inside it is an error you never see. An op whose dialog was
sent away records its outcome as a **notice**, and the attention queue shows those next to crashes,
since it's the place that already promises to hold everything needing a human.

The notice carries the full error text and the tail of the operation's log, untruncated, and the
notice modal offers it for copying.

## Setup and waiting states

Setup markers track the last run, and agent prompt detection supplies waiting transitions. These states participate in Needs you. Dismissing a setup reminder hides it for the current app session without changing the setup marker.
