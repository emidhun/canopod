---
title: Limitations
description: Everything 0.5.0 can't do yet, including the screens that exist but aren't wired up, with issue numbers.
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

## Remaining gaps

- Shortcut remapping is not supported.
- Layout, split proportions and setup-reminder dismissals are not persisted across app launches.
- Production CSP checks exercise mock rendering; native IPC still needs desktop end-to-end coverage.
- Destructive MCP operations require future human-approval and audit support.
- Not every theme and platform has a full screen-reader and contrast audit.

## Additional limitations

**No stash list.** Stashing works; restoring is `git stash pop` in a terminal. Name your stash if
you'll keep more than one.

**No snapshot list.** Snapshots are databases on the server, named by you.

**Service logs are memory-only**, a 160-line ring buffer per service rather than a file.

**Teardown and migrate are editable** in Settings → Files.

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
