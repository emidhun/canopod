---
title: Node + Postgres app
description: A Vite frontend, an API and one database, taken from an unregistered repo to three branches running at once.
---

# Example: a Node + Postgres app

The common case, end to end. The app has a Vite frontend, an Express or Nest-style API, and one
Postgres database.

## The starting point

```text
my-app/
  package.json
  .env                    # committed example or local file with PG_* + PORT
  frontend/  package.json
  server/    package.json
```

```json
// package.json (root) — scripts Canopod will read
{
  "scripts": {
    "dev:web": "npm --prefix frontend run dev",
    "dev:api": "npm --prefix server run start:dev",
    "build": "npm --prefix frontend run build",
    "db:create": "createdb $PG_DB",
    "db:migrate": "npm --prefix server run migration:run",
    "db:reset": "dropdb --if-exists $PG_DB && npm run db:create && npm run db:migrate",
    "db:drop": "dropdb --if-exists $PG_DB"
  }
}
```

## 1. Register the repository

`⇧⌘N`, point at `my-app`. Detection finds the stack (`node`) and the scripts. `dev:web` and `dev:api`
match the service pattern and are proposed; `build` is added as a worker, off.

Adjust the two services:

| Field | Frontend | Server |
|---|---|---|
| Name | `Frontend` | `Server` |
| Kind | `web` | `server` |
| Directory | *(root, the script already uses `--prefix`)* | *(root)* |
| Port | `5173` | `3000` |
| Command | `npm --prefix frontend run dev -- --port $PORT` | `npm --prefix server run start:dev` |

Open **Provisioning and setup** and make the env block:

```text
PG_DB  = ${WT_DB_NAME}
PORT   = ${WT_SERVER_PORT}
```

Setup steps:

```text
1. npm install
2. npm --prefix frontend install && npm --prefix server install
3. npm run db:create && npm run db:migrate
```

Database commands: migrate `npm run db:migrate`, reset `npm run db:reset`. Worktrees go in
`my-app/.worktrees`.

**Add repository**.

## 2. Finish the config file

Onboarding wrote a `.worktreemanager.json`. Open **Settings → `my-app` → Files** and add the frontend's
API URL so both services agree on where the API is. Then add teardown by hand, since the Settings
editor doesn't write `teardown` yet: edit the file and press Sync, or export and import it.

```json
{
  "$schema": "canopod://worktree-manager/v1",
  "provision": [
    {
      "path": ".env",
      "format": "dotenv",
      "keys": {
        "PG_DB": "${WT_DB_NAME}",
        "PORT": "${WT_SERVER_PORT}",
        "VITE_API_URL": "http://localhost:${WT_SERVER_PORT}"
      }
    }
  ],
  "setup": [
    "npm install",
    "npm --prefix frontend install && npm --prefix server install",
    "npm run db:create && npm run db:migrate"
  ],
  "migrate": ["npm run db:migrate"],
  "teardown": ["npm run db:drop"]
}
```

Commit it. Any branch that needs different setup now carries its own version.

:::tip Why `VITE_API_URL` goes in the file, not the command
Both services have to agree on the value, and the provisioned `.env` is the one place they both read.
`$PORT` is for a service telling itself which port to bind.
:::

## 3. Create three worktrees

`⌘N` three times: `feat/checkout`, `fix/tax-rounding`, and `chore/deps`.

Each one gets:

| | main | feat/checkout | fix/tax-rounding | chore/deps |
|---|---|---|---|---|
| Index | 0 | 1 | 2 | 3 |
| Frontend | 5173 | 5183 | 5193 | 5203 |
| Server | 3000 | 3010 | 3020 | 3030 |
| Database | `my_app_my_app` | `my_app_feat_checkout` | `my_app_fix_tax_rounding` | `my_app_chore_deps` |

The database name comes from the worktree folder name, which is the branch name sanitised:
`feat/checkout` becomes the folder `feat_checkout` and then `my_app_feat_checkout`.

## 4. Run two of them at once

Select `feat/checkout` and press `⏎` (**Start services**). Select `fix/tax-rounding` and press `⏎`.
Both are serving now:

- `http://localhost:5183` is the checkout branch's UI, talking to `:3010`, on its own database.
- `http://localhost:5193` is the tax-rounding branch's UI, talking to `:3020`, on its own database.

`⌘O` shows both with their CPU and memory. Nothing collides, and neither branch has touched the other's
data.

## 5. Day-to-day moves

| Situation | Do this |
|---|---|
| A migration landed on main and you need it here | Status bar → **Pull**, then the database dialog → **Run migration**. |
| You want a clean database | Database dialog → **Reset database**. |
| You want to keep this state before a risky migration | Database dialog → **Save snapshot…**, accept the default name. |
| Something else grabbed port 3010 | Click the service chip, change the port, **Save & restart**. Canopod warns you if another worktree holds it. |
| A review request lands and you don't want a whole new worktree | `⌘\` **Switch branch** in an idle worktree; dependencies are reused. |
| The frontend crashed | The logs fix bar: **Jump to error**, then **Restart**. |
| You want an agent on the checkout work | ⋯ → **Context…**, write the task, **Start agent** (`⌘⏎`). |

## 6. Retire a branch

⋯ → **Remove worktree…** on `chore/deps`. The precheck reports the tree is clean. Leave **Drop
database** ticked so `npm run db:drop` runs, and tick **Also delete the branch** if it's merged. The
freed index (3) goes to the next worktree you create, so ports don't creep upwards.

## What this bought you

Three branches installed, migrated and runnable at any moment. No stashing, no reinstalling, no port
arithmetic in your head. And setup that a teammate gets for free by cloning the repo, because it's in
`.worktreemanager.json`.
