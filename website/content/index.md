---
title: Canopod
description: Run every branch at once. Canopod checks each one out as its own worktree, gives it a database and ports, and runs it.
layout: home
---

# Run every branch at once

Canopod checks each branch out as its own worktree, gives it its own database and its own ports, and
runs it. Three branches, three apps, all up at the same time. No stashing, no reinstalling, no port
arithmetic.

<div class="hero-actions">
<a class="btn btn--primary" href="install-macos.html">Install Canopod</a>
<a class="btn" href="overview.html">See what it does</a>
</div>

<p class="hero-note">macOS on Apple Silicon. Linux and Windows builds exist but haven't been tested on a desktop.</p>

!shot main-worktree | Two branches serving on different ports, with one merged log stream underneath.

## What Canopod does

<div class="cards">
<a class="card" href="worktrees.html"><b>A worktree per branch</b><span>Create one from any branch or tag. Canopod installs it, migrates it, and hands it back ready to run.</span></a>
<a class="card" href="services-ports.html"><b>Ports that don't collide</b><span>Every worktree gets a stable index, and every service a port derived from it. Run five branches, nothing fights.</span></a>
<a class="card" href="databases.html"><b>Its own database</b><span>One database per worktree, named after the branch. Snapshot it, switch it, reset it, drop it on delete.</span></a>
<a class="card" href="agents-terminals.html"><b>Agents that know where they are</b><span>Launch a coding agent with the branch, ports, database and your task already written down for it.</span></a>
</div>

## Getting started

One command:

```sh
brew install --cask emidhun/canopod/canopod   # or grab the DMG
```

Open Canopod from the menu bar, point it at a repository, and it reads your `package.json` to work out
what to run. Then `⌘N` for a branch, `⏎` to start it.

<div class="cards">
<a class="card" href="onboarding.html"><b>Add your first repo →</b><span>What detection finds, what it proposes, and what it writes to disk.</span></a>
<a class="card" href="first-worktree.html"><b>Your first worktree →</b><span>Create, provision, run, open, and clean up. The whole loop once through.</span></a>
</div>

## Where to go next

**New to Canopod?** [What Canopod is](overview.html) explains the idea in about a minute, then
[Install on macOS](install-macos.html) gets it running.

**Setting it up for a repository?** [.worktreemanager.json](config-worktreemanager.html) is the file that
makes setup travel with the branch, and [Template variables](config-variables.html) lists everything
you can reference in it. There are worked configs for a
[Node + Postgres app](example-node-postgres.html), the [ToolJet monorepo](example-tooljet.html), and
[Rails, Django, Go and Rust](example-other-stacks.html).

**Using it day to day?** [The main window](main-window.html) covers every region,
[The next action](next-action.html) explains the one button that's usually right, and
[Keyboard shortcuts](shortcuts.html) is the whole map.

**Something not working?** [Troubleshooting](troubleshooting.html) is symptom, cause, fix.

**Working on Canopod itself?** [Building from source](dev-setup.html) and
[Building a release](prod-setup.html).

## Scope of this documentation

This documentation describes **v0.5.0**, including its settings, MCP and unified Terminal improvements. Some screens
exist with no backend behind them; those are marked *coming soon*, and
[Limitations](limitations.html) lists them with their issue numbers.
