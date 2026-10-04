---
title: Worktrees
description: Creating, switching, pulling, committing, removing and pruning, with the git command behind each one.
---

# Worktrees

Everything Canopod does to a worktree, and the git operation behind it.

## Create

`⌘N`, the sidebar's **New worktree**, the palette, or the popover footer.

!shot modal-new-worktree | New worktree: repository, mode, ref, destination, and an optional agent handoff.

| Control | Behaviour |
|---|---|
| Repository | Switching it clears the base and branch. Refs are repo-scoped, and carrying one across would submit a ref that doesn't exist. |
| **New branch** / **Existing** | New branch takes a name plus a base. Existing takes a ref that's already there. |
| Ref picker | Searches local branches, remote branches and tags. Rows checked out elsewhere are shown but disabled. |
| **Fetch all** | `git fetch --all --prune --recurse-submodules`, then reports local, remote and tag counts. |
| **You'll get** | The destination path, resolved the way the backend will resolve it. |
| **Agent handoff** | Optional PR and issue links that seed the worktree's context. |
| **Run in background** | Dismisses the dialog. The job continues and reports into *Needs you*. |

What creation does:

1. `git worktree add <path> <ref>`, creating the branch when the mode calls for it.
2. Submodules initialised and updated recursively, using `--reference` so objects are shared with the
   main checkout instead of cloned again.
3. A port index assigned (the lowest free slot) and the worktree's variables computed.
4. Provisioned files seeded and templated.
5. `setup` commands run in order.

The destination path is the repo's worktree directory (absolute, or relative to the repo, defaulting to
`<repo>/.worktrees`) plus the branch name with every character outside `[letters, digits, -, .]`
replaced by `_`, case preserved.

## Sync worktrees created elsewhere

:::note Available in the 0.5.0
This action is available in 0.5.0.
:::

Use the **Sync external worktrees** button in the top bar, or run the same action from `⌘K`, after
another agent or terminal creates a worktree outside Canopod.

Sync asks Git for the registered worktrees of every repository already configured in Canopod, refreshes
the sidebar, and reports how many new worktrees it found. The new worktree is immediately available to
select, configure and run; you do not need to add the repository again.

:::note Git registration is the source of truth
The directory must have been created with `git worktree add` (or otherwise appear in
`git worktree list`). Sync does not import arbitrary copied folders, scan unrelated directories, or
register a new repository.
:::

The same action also detects registrations whose folders were deleted outside Canopod and opens the
prune reconciliation described below.

## Re-running setup

⋯ → **Run setup…** re-applies provisioned files and re-runs `setup` on an existing worktree.

The runner reads the backend's ordered `[k/n]: <command>` markers and shows them as a step list.
Finished steps get a tick, the current one spins, and a failure gets a cross plus the raw tail, so you
read the error instead of guessing at it. **Run in background** closes the dialog and leaves the run
going. Reopening it attaches to the run in flight rather than starting another, because the backend
has no per-worktree guard and a second invocation would mean two `npm install`s in one directory.

On success the footer offers **Start services** (`⏎`).

## Switching branch in place

`⌘\`, or ⋯ → **Switch branch…**, or the branch in the status bar.

!shot modal-switch-branch | Switch branch: type to filter, or type a new name to create one off the current branch.

It reuses everything already installed here, so it costs roughly no setup time where a new worktree
costs a full provision. Type a name that doesn't exist and you get **Create branch `<name>` off
`<current>`**. Pick a remote row and Canopod resolves to the local short name, reusing the local branch
if it's there and creating it from the remote if not, since `git checkout origin/foo` would detach
HEAD. Branches checked out in another worktree of the same repo are disabled and tagged **in use**.

:::warn Uncommitted changes carry over
Switching doesn't stash. Your working-tree changes follow you to the new branch. Sometimes that's what
you want and sometimes it's a surprise, so the dialog says it in the footer.
:::

You can turn this action off entirely in **Settings → General → Show the Switch-branch action**. The
shortcut obeys the setting, so turning it off doesn't leave the feature one keystroke away.

## Pull

The status bar's **Pull** (or ⋯ → Pull) runs `git pull --ff-only`, then advances each submodule rather
than only re-pinning it:

- pulled, if the submodule is checked out on a branch,
- moved to its pinned branch tip, if `.gitmodules` tracks one (say `branch = lts-3.16`),
- otherwise synced to the commit the parent records.

The toast summarises what happened: *"pulled, 2 submodule(s) pulled"*.

!shot pull-menu | The pull popover: pull everything, re-pin submodules, or act on one submodule at a time.

The caret opens the popover:

| Row | What it does |
|---|---|
| **Pull everything** (`⌘⏎`) | The worktree plus every submodule. |
| **Sync submodules** (`⇧⌘S`) | `git submodule sync` + `update --init --recursive`, putting every submodule back on the commit the parent pins. The repair after a branch change. |
| Per submodule | A status dot, the branch (or `detached <sha>`), an **ahead of pin** marker, a branch switcher, and a pull button. |

A submodule with uncommitted changes can't have its branch switched from here, and the row says why.

:::note Pull moves submodules forward; Sync moves them back
Two different operations, on purpose. Pull advances a submodule onto its own branch tip. Sync re-pins
it to the commit this worktree's parent commit records, which is what you want after switching the
parent's branch.
:::

## Uncommitted changes

The uncommitted-changes dot beside the branch name in the worktree bar opens one dialog with three modes. The file list is there to be
read, not selected from: it annotates itself per mode so you can see what the chosen git invocation
will touch, and the exact command is printed above it.

!shot modal-uncommitted | Commit mode with eight changed files: the four tracked changes go into the commit, and the four untracked files stay out unless you tick *Also add 4 untracked files*.

| Mode | Runs | Options |
|---|---|---|
| **Commit** | `git commit -a -m "<subject>"` | *Also add N untracked files* (off, since `-a` only picks up tracked files) prepends `git add -A`. Subject length is counted against 72. |
| **Stash** | `git stash push [-u] [-m "<name>"]` | *Include N untracked files* adds `-u`. Naming it is optional, though Canopod has no stash list yet, so name it if you'll keep more than one. |
| **Discard** | `git restore --source=HEAD --staged --worktree -- .` | *Also delete N untracked files from disk* adds `git clean -fd` and makes you type `discard` before the button arms. |

The guards are specific:

- **Conflicts** block commit and stash, since git refuses until the markers are gone, but not discard,
  which is the documented way out of a merge you don't want.
- **Submodule-only changes** block all three modes. A commit, stash or discard in the parent doesn't
  reach into a submodule's working tree; commit it inside the submodule first.
- Rows open in your editor when clicked, except a deletion, which no longer exists on disk.
- If the status can't be read, the dialog fails closed: it shows the error and disables every action
  instead of claiming the tree is clean.
- `⌘⏎` submits when the dialog is ready. A failing pre-commit hook lands as an inline error and keeps
  everything you typed.

## Remove

⋯ → **Remove worktree…**, absent on the main checkout.

!shot modal-remove-worktree | Remove worktree: the dirty precheck lists what would be lost.

A dirty precheck runs first, including submodules, and fails closed. The report lists up to ten paths;
at exactly ten it says "at least ten" rather than implying that's the total. **Drop database** is on by
default when the worktree has one, and runs the repo's `teardown` commands. **Also delete the branch**
is off by default and warns when the branch has commits that aren't on origin.

Then: stop services, run `teardown`, `git worktree remove --force`, optionally delete the branch, prune.
**Run in background** hands the job over; the sidebar row goes inert and the outcome reports into
*Needs you*.

Select several rows in the sidebar (`⌘`-click or `⇧`-click) and press **Delete N** for the multi-worktree
version, which applies the same two choices to the whole set.

## Pruning deleted worktrees

`rm -rf` a worktree folder and git still holds a stale registration for it. **Sync external
worktrees** in the top bar finds those and offers to reconcile them. Pruning removes git's stale
entry, and per item you can also delete the branch and drop the leftover database (on by default,
since it's orphaned now).

The folder is already gone, so there's nothing left to warn you about losing. The database name comes
from the snapshot Canopod took before refreshing, because the worktree's `.env` doesn't exist any more.

## Pinning

Every sidebar row has a pin, and pinned worktrees sit in their own group above Running and Idle. Pins
are per machine, stored in `localStorage`.
