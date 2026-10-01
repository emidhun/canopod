---
title: Simple web app
description: A database-free, dependency-free first project with two branches running on separate ports.
---

# Example: a simple web app

This is the smallest reproducible Canopy project. It uses Python's built-in HTTP
server, has no package install or database, and demonstrates two worktrees running
at once. The flow matches the `0.5.0` release branch; `0.5.0` is not published yet.

## 1. Create the repository

You need Git and Python 3. In a terminal:

```sh
mkdir canopy-simple-web
cd canopy-simple-web
git init -b main
printf '<h1>Canopy main</h1>\n' > index.html
git add index.html
git commit -m "Add simple page"
```

Confirm `python3 --version` works before continuing. On Windows, use a Python 3
command available in your shell and adapt the service command below.

## 2. Add it to Canopy

Choose **Add repository** and select `canopy-simple-web`. Detection correctly
treats this as an unknown stack: it does not invent npm setup or service commands.
Leave setup empty and add one service manually:

| Field | Value |
| --- | --- |
| Name | `Web` |
| Kind | `web` |
| Directory | *(repository root)* |
| Port | `8000` |
| Command | `python3 -m http.server "$PORT" --bind 127.0.0.1` |

Do not add provisioning variables or database commands. Finish with **Add
repository**. Connecting an agent is optional; choose **Skip for now** for this
recipe.

## 3. Check the main service

Select the main checkout and start **Web**. Open the service's port link. The
browser should show **Canopy main** at `http://127.0.0.1:8000`.

If the service exits, verify the Python command first. If port 8000 is occupied,
choose another base port in repository settings before creating worktrees.

## 4. Create two worktrees

Create `feature/one` from `main`, then create `feature/two` from `main`. There is
no setup step to run. Canopy sanitizes the branch names for their directories and
assigns each worktree a port offset from the configured base.

Start **Web** in both worktrees. With the default port step, the first two derived
ports are `8010` and `8020`; use the ports shown in Canopy as the source of truth.
Open both links and confirm both pages load concurrently.

To make the branches visibly different, edit each worktree's `index.html` in its
editor, refresh its browser tab, and confirm the other tab does not change.

## 5. Recover from a setup failure

To practice recovery, temporarily add this setup command in repository settings:

```sh
test -f ready.txt
```

Create `feature/recovery`. Setup fails, but the worktree remains available. Create
`ready.txt` in that worktree and choose **Run setup…** again. The retry succeeds
without recreating the worktree or losing its configuration. Remove the temporary
setup command after the exercise.

## Expected result

- The project needs Git and Python 3, but no Node package manager or database.
- Unknown-project onboarding adds no guessed commands.
- Two worktrees serve simultaneously on distinct displayed ports.
- A failed setup leaves the worktree and entered configuration available for retry.

These behaviors are covered by the release branch's isolated backend acceptance
test. A clean-machine packaged desktop run remains part of release acceptance.
