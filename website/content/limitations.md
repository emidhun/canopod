---
title: Limitations
description: Everything 0.4.7 can't do yet, including the screens that exist but aren't wired up, with issue numbers.
---

# Limitations

One list, so nothing else in this documentation has to be read twice to work out whether it's real.

## Platform

| Limitation | Detail |
|---|---|
| macOS arm64 is the only validated platform | Linux and Windows builds compile in CI and are published, but haven't been validated on a desktop. |
| No Intel or universal macOS build | It would need `x86_64-apple-darwin` and `--target universal-apple-darwin`. |
| Not notarized | Ad-hoc signed only, so installing from the DMG needs one `xattr -dr com.apple.quarantine`. |
| No Mac App Store build | Canopy can't be sandboxed: arbitrary process trees, arbitrary paths, private window APIs. |
| Linux tray has no click events | Linux and Windows get a tray menu instead of the macOS click-to-toggle panel. |

## Assumptions

| Assumption | Consequence |
|---|---|
| **Postgres** for the database tooling | Switch, snapshot, export, restore and reset are Postgres-only. Other databases work as services; those actions don't apply. |
| Postgres client binaries matching the server's major version | A mismatch fails the dump and restore actions. Canopy picks the best available; it can't install one. |
| **Node** for auto-detection | Service and command detection reads `package.json`. Other stacks are detected but configured by hand. |
| A login shell that sets up your `PATH` | Commands inherit your `$SHELL` as a login shell, so setup that only lives in an interactive rc file won't be there. |

## Screens that are not wired yet

These render, and say so, instead of pretending:

| Where | What isn't wired |
|---|---|
| Settings → Terminal | Embedded shell program, font, size, scrollback. |
| Settings → Notifications | Every toggle: crash alerts, agent-blocked alerts, setup-finished. The in-app attention queue works regardless. |
| Settings → Advanced | Copy diagnostics, open logs, experiments (parallel setup, predictive warmup), clear caches, reset all settings. |
| Settings → Security | Secret masking, keeping secrets out of exports, SSH key selection. |
| Settings → Repository | Default base branch, and the "defaults for new worktrees" toggles. |
| Settings → Services | Per-service health check. |
| Settings → Files | On-conflict policy, apply-on trigger, file mode, and an independent strategy (it's derived from the format). |
| Settings → Setup | Per-task enable toggle, per-task working directory, on-failure and timeout policy, dry run. |
| Settings → Repository | "Reveal in Finder" for the repo path. |
| Settings → Agents | Per-agent context toggles and a concurrency limit. |
| Settings, repo pages | The "Learn more" documentation link. |
| Shortcuts | Remapping. |

## Known gaps

| Gap | Effect | Issue |
|---|---|---|
| Agent "waiting" is never detected | `LaneSession` only knows whether the process runs, so the *Answer agent* action and the waiting badge can't be reached. Every render path exists. | [#54](https://github.com/emidhun/canopy/issues/54) |
| No provisioning record per worktree | "Setup never run" is always false, so that next-action state and attention row can't be reached. | [#53](https://github.com/emidhun/canopy/issues/53) |
| No disk-usage measurement | The overview's **Size** column always reads `—`. | [#55](https://github.com/emidhun/canopy/issues/55) |
| No parsed per-step results | The setup runner shows each step but not a result ("1,842 packages", "37 migrations"). | [#60](https://github.com/emidhun/canopy/issues/60) |
| No resolved-environment IPC | Service detail can't show the computed `PORT` or `DATABASE_URL` for a service. | [#59](https://github.com/emidhun/canopy/issues/59) |
| Ports and database not previewed at create time | The New worktree dialog says "assigned at creation" instead of duplicating backend logic that could drift. | [#58](https://github.com/emidhun/canopy/issues/58) |
| IPC bridge not covered by the CSP check | The check runs without a Tauri runtime, so `connect-src ipc:` is unverified. It needs tauri-driver and WebdriverIO. | [#93](https://github.com/emidhun/canopy/issues/93) |

## Additional limitations

**No stash list.** Stashing works; restoring is `git stash pop` in a terminal. Name your stash if
you'll keep more than one.

**No snapshot list.** Snapshots are databases on the server, named by you.

**Service logs are memory-only**, a 160-line ring buffer per service rather than a file.

**Teardown and migrate aren't editable in Settings' structured editor.** They round-trip through the
JSON preview, export and import, and you can edit them in the file directly.

**Layout and sidebar visibility aren't persisted** across launches.

**Context is per machine.** Worktree context lives in `localStorage`, not in the repo. Whether it
should become a committed file that travels with the branch is still an open question.

**Package-specific update fallback.** Signed in-app installation is available for updater-supported
bundles. If the current package cannot replace itself, use the release download or your package
manager instead.

**No telemetry.** Canopy sends no analytics. Daily release checks, the manual **Check now** action,
and signed update downloads contact GitHub. The star reminder itself makes no network request.

## Reading "coming soon"

Each one is a surface that already exists with its real layout and copy, disabled, behind a banner.
That keeps the wiring purely additive, and it means this documentation can be specific about what a
build does instead of describing an intention.
