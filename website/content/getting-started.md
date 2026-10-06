---
title: Canopod documentation
description: Install Canopod, create your first Git worktree, configure local services, and connect Claude Code or Codex through MCP. Guides and reference for version 0.5.
layout: home
---

# Canopod documentation

Get Canopod running, set up your repository, and give each branch a workspace of its own.
Start with a guide below, or search for a setting, command, or problem.

<div class="cards">
<a class="card" href="download.html"><b>Install Canopod</b><span>Choose a download for your platform and follow the installation guide.</span></a>
<a class="card" href="first-worktree.html"><b>Create your first worktree</b><span>Go from a registered repository to a new branch with its own working directory.</span></a>
<a class="card" href="mcp.html"><b>Connect a coding agent with MCP</b><span>Set up Claude Code or Codex, choose repository access, and explore the 15 tools.</span></a>
<a class="card" href="config-worktreemanager.html"><b>Configure your repository</b><span>Define the setup steps, service commands, and port rules your project needs.</span></a>
</div>

## Start on your own machine

New to Canopod? [What Canopod is](overview.html) explains how worktrees, services, and agents fit together.
On a Mac with Apple Silicon, install with Homebrew:

```sh
brew install --cask emidhun/canopod/canopod
```

Follow [Install on macOS](install-macos.html) for the first launch. [Windows](install-windows.html)
and [Linux](install-linux.html) packages are also available, but remain experimental and have not
been validated on a desktop.

Once installed, [add a repository](onboarding.html), review the detected services and setup commands,
then follow [Your first worktree](first-worktree.html). Canopod runs the commands you configure;
what gets installed or provisioned depends on your project.

## Connect Claude Code, Codex, or another MCP client

The optional local MCP server lets an agent inspect worktrees, read service logs, and work with
the repositories you allow. MCP is off by default. You choose repository access and grant worktree
creation, service control, and configuration changes separately.

[MCP and coding agents](mcp.html) covers connection steps, permissions, all 15 tools, and headless
setup. For a guided introduction, [explore Canopod MCP](canopod-mcp.html).
Read [Security](security.html) for the boundaries around local commands and connected clients.

## Find the part you need

<div class="cards">
<a class="card" href="worktrees.html"><b>Branches and worktrees</b><span>Create, switch between, and clean up worktrees without losing track of each branch.</span></a>
<a class="card" href="services-ports.html"><b>Services and ports</b><span>Configure the processes you run and assign ports using each worktree's index.</span></a>
<a class="card" href="databases.html"><b>Postgres databases</b><span>Configure database creation, snapshots, and restore workflows for your project.</span></a>
<a class="card" href="agents-terminals.html"><b>Terminals and agents</b><span>Open a shell or launch an agent with the context of the selected worktree.</span></a>
</div>

For the app itself, start with [The main window](main-window.html), [Logs](logs.html), and
[Keyboard shortcuts](shortcuts.html). [Troubleshooting](troubleshooting.html) connects common
symptoms to checks and fixes.

## Adapt an example to your project

Use a worked configuration for a [simple web app](example-simple-web.html), a
[Node + Postgres app](example-node-postgres.html), the [ToolJet monorepo](example-tooljet.html),
or [Rails, Django, Go, and Rust](example-other-stacks.html).
[Template variables](config-variables.html) explains how paths, branch names, and port values
are passed into your commands.

Working on Canopod itself? See [Building from source](dev-setup.html),
[Building a release](prod-setup.html), and the [command and event reference](reference-ipc.html).

## About these guides

These guides describe **Canopod 0.5.0**. [Limitations](limitations.html) records platform support,
unfinished controls, and known boundaries. Controls marked *coming soon* are visible in the app
but are not implemented yet.
