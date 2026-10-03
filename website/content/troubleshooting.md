---
title: Troubleshooting
description: Symptom, cause, fix. The failures that actually happen, and what to do about each one.
---

# Troubleshooting

## Installing and launching

| Symptom | Cause | Fix |
|---|---|---|
| "Canopy is damaged and can't be opened" | macOS quarantine on a non-notarized app | `xattr -dr com.apple.quarantine /Applications/Canopy.app` |
| "unidentified developer" / "can't check for malicious software" | Same | Same, or System Settings → Privacy & Security → **Open Anyway** |
| No window and no menu-bar icon | It launched into the tray and the icon is easy to miss | Look for the fork mark in the menu bar. On Linux with GNOME you may need an AppIndicator extension |
| Nothing happens on launch, or an old version reappears | Another instance is already running | Canopy is single-instance by design, so the running one gets focused. Quit it from the tray first |
| The window is blank | A CSP or asset failure in a release build | Check the log file. This is what `npm run csp:check` guards against in CI |

## Adding a repository

| Symptom | Cause | Fix |
|---|---|---|
| "not a git repository" while typing a path | The path isn't inside a git work tree | Point at the repository root, not a subdirectory of something else |
| Detection finds no services | No `package.json`, or no script names matching the service pattern | Add the services by hand. The pattern is Node-specific; the execution isn't |
| Detection needs the desktop app | You're running the UI in a browser (mock mode) | Detection is a backend call, so use the app |
| A dotfile can't be chosen in the file picker | macOS hides dotfiles in the picker | Type the path, or use Settings → ⋯ → **Load from repo file**, which reads the hidden config by path |

## Creating a worktree

| Symptom | Cause | Fix |
|---|---|---|
| The branch row is disabled and tagged **in use** | git won't check the same branch out twice | Use the worktree that already has it, or pick another branch |
| The worktree lands in an unexpected folder | The name is sanitised: anything outside letters, digits, `-` and `.` becomes `_` | Expected. The destination panel shows the exact path before you commit |
| Creation succeeded but setup failed | A setup command failed | Open the notice in **Needs you** for the log tail, fix the command, then ⋯ → **Run setup…** |
| Setup fails with `notsup` or the wrong Node | The pinned Node version isn't installed | `asdf install nodejs <version>`, or the nvm/fnm equivalent, for the version in `.nvmrc` or `.tool-versions` |
| `Cannot find module @tooljet/plugins/dist/server` | A package that has to be built per worktree wasn't | Add the build step to `setup`, before migrations |
| Nothing appears in the sidebar for minutes | Creation is a minutes-long job | It shows as an in-progress row with the current step. Leave it and keep working |

## Services and ports

| Symptom | Cause | Fix |
|---|---|---|
| A service shows stopped but its port is busy | Another worktree, or a stale process, holds it | Stop the other worktree, or override this service's port in service detail |
| Port `N` is already used by `<branch> · <service>` | Clash detection found the real holder | Pick another port. The message names who has it |
| The frontend talks to the wrong API | The server URL was baked from the environment at launch | Set it from a port variable in the provisioned `.env` (`http://localhost:${WT_SERVER_PORT}`), and give the frontend `--port $PORT` |
| A command can't find your tools | Commands run through `$SHELL` as a login shell | Make sure your `PATH` and version-manager setup live in that shell's profile, not only in an interactive rc file |
| A service exits immediately | Usually a bad command or a missing dependency | Read the fix bar → **Jump to error**. The exit code is in service detail |
| Stopping leaves child processes behind | Shouldn't happen: services run in their own process group | If it does, quit Canopy, which kills every group. The next launch also sweeps recorded orphans |

## Databases

| Symptom | Cause | Fix |
|---|---|---|
| "PG_DB not set in this worktree's .env" | The provisioned `.env` has no `PG_DB` | Add `"PG_DB": "${WT_DB_NAME}"` to your provision keys, then ⋯ → **Run setup…** |
| A snapshot or export fails on version | Client and server major versions don't match | Install the Postgres version matching your server. `Postgres.app/Versions/<major>` is preferred |
| Restore fails on a file that dumped fine elsewhere | A newer `pg_dump` produced an archive the older server rejects | Dump and restore with the server's own major version |
| **Database tools** is missing from the rail's ⋯ menu | The worktree has no database name | Same as the first row: no `PG_DB`, no database features |
| A database job seems stuck | They take seconds to minutes and hold the worktree's operation lease | Use **Run in background**. Each Postgres invocation is capped at 15 minutes |
| Two worktrees share data | They're pointing at the same database name | Check the worktree's `.env`: `PG_DB` should be its own `${WT_DB_NAME}` |

## Agents and terminals

| Symptom | Cause | Fix |
|---|---|---|
| "`<Agent>` exited immediately — check the agent command" | The configured CLI isn't on `PATH`, or rejected its arguments | Run the command in a terminal in that worktree. If it takes no positional prompt, turn **Prompt on launch** off |
| The agent ignores your brief | The brief was written after launch | The handoff is composed at launch. Edit the context, then start a new session |
| An agent tab says it's running but nothing happens | The process ended without exiting the shell | Use the tab's **Restart**, or close it and start a new one |
| A popped-out terminal is empty | Its PTY is gone | Close the window and **Restart** the session inline |
| Shell tabs disappeared overnight | Idle shell sessions are swept after an hour | Expected. Agent sessions are exempt |

## Sync and state

| Symptom | Cause | Fix |
|---|---|---|
| A worktree you deleted by hand still appears | git keeps a stale registration | **Sync**, then use the prune dialog it opens |
| Ports changed after you deleted `state.json` | Indices get reassigned from scratch | Don't hand-edit `state.json`. Re-set any overrides you needed |
| Settings edits you made in a text editor didn't appear | The app holds the authoritative copy while running | Edit `settings.json` with Canopy closed. For `.worktreemanager.json`, press **Sync** |
| Settings shows an old `.worktreemanager.json` | It changed outside the app | **Sync** re-reads it, except for a repository you have unsaved changes on, which is never clobbered |

## Further diagnostics

**Needs you** holds every failed background job with its error and log tail, and the notice modal lets
you copy it.

The app's own log is `canopy.log` in the platform log directory (see
[Where settings live](settings-storage.html)). `RUST_LOG=debug` raises the level for a run started from
a terminal.

A service's last error lines are in its detail dialog, alongside the exit code.
