---
title: .worktreemanager.json
description: The file that makes a branch's setup travel with it. Every field, where it's read from, and worked examples.
---

# `.worktreemanager.json`

The repository's provisioning file. It says which files to seed and template into a new worktree, and
which commands to run afterwards, so that setup travels with the branch instead of living in someone's
shell history.

## Where it is read from

1. `<worktree>/.worktreemanager.json`
2. `<worktree>/wtm.json`
3. `<repo main checkout>/.worktreemanager.json`
4. `<repo main checkout>/wtm.json`

The first file that parses and contains at least one of `provision`, `setup`, `teardown` or `migrate`
wins. Reading the worktree first is what lets a committed config travel per branch; falling back to the
main checkout lets you configure a repository before committing anything.

## Full schema

```jsonc
{
  "$schema": "canopod://worktree-manager/v1",

  // Files seeded and templated into every new worktree, in order.
  "provision": [
    {
      "path": ".env",              // destination, relative to the worktree root
      "format": "dotenv",          // dotenv | json | yaml | text
      "from": ".env",              // source, relative to the repo; omit = same path
      "mode": "upsert",            // written by Canopod for keyed formats
      "keys": {                    // add-or-replace these keys; other lines untouched
        "PG_DB": "${WT_DB_NAME}",
        "PORT": "${WT_SERVER_PORT}",
        "TOOLJET_HOST": "http://localhost:${WT_FRONTEND_PORT}"
      }
    },
    {
      "path": "config/local.yaml",
      "format": "yaml",
      "keys": { "database": "${WT_DB_NAME}" }
    },
    {
      "path": "docker/.env.local",
      "format": "text",            // copy the whole file…
      "from": "docker/.env.example",
      "interpolate": true          // …replacing every ${VAR} while copying
    }
  ],

  // Run in order on create, and again on "Run setup…".
  "setup": [
    "npm install",
    "npm --prefix plugins install && npm --prefix plugins run build",
    "npm run db:create && npm run db:migrate"
  ],

  // Run by the database dialog's "Run migration" (unless Settings overrides it).
  "migrate": ["npm run db:migrate"],

  // Run before a worktree is deleted, when "Drop database" is ticked.
  "teardown": ["npm run db:drop"]
}
```

## `provision`

An ordered array, one entry per destination file.

| Field | Type | Meaning |
|---|---|---|
| `path` | string | **Required.** Destination, relative to the worktree root. |
| `format` | `dotenv` \| `json` \| `yaml` \| `text` | Defaults to `dotenv` if missing or unrecognised. |
| `from` | string | Source path relative to the repo. Omitted or empty means the same path in the main checkout. |
| `keys` | object | For keyed formats, the keys to add or replace. Values are templates. |
| `interpolate` | boolean | `text` only: replace every `${VAR}` while copying. |
| `mode` | string | Written as `upsert` for keyed formats. Not independently honoured yet. |

How the formats behave:

- **`dotenv`, `json`, `yaml`**: if the destination is missing, it's seeded by copying `from` (or the
  same path in the main checkout). The listed `keys` are then upserted, so existing keys take the new
  value, missing ones get appended, and every other line is left alone.
- **`text`**: the whole file is copied over the destination. With `interpolate: true`, every `${VAR}` in
  the copy is replaced.

Values are templates. `${WT_DB_NAME}`, `${WT_SERVER_PORT}` and friends are substituted with this
worktree's values, and [Template variables](config-variables.html) lists them all.

:::note Legacy `env` still works
An older top-level `env` object is folded into a leading `.env` `dotenv` entry when the file is read, so
pre-existing configs keep working. Saving from Settings migrates it into `provision`.

```jsonc
{ "env": { "PG_DB": "${WT_DB_NAME}" } }   // ≡ provision: [{ path: ".env", format: "dotenv", keys: {…} }]
```
:::

## `setup`

Commands run in order, in the worktree root, through your login shell, on the worktree's pinned
toolchain, with every variable exported. They run when a worktree is created, after provisioning, and
whenever you use ⋯ → **Run setup…**

The backend emits an ordered `[k/n]: <command>` marker per step, which is what the setup runner turns
into a step list. A failing step stops the run and is reported with its output.

Order matters and it's yours to get right: install before build, build before migrate.

## `migrate`

Commands run by the database dialog's **Run migration**. The repository's **Migrate command** in
Settings wins if it's set; this array is the fallback, and the place to put a multi-step migration.

## `teardown`

Commands run before a worktree is deleted, when **Drop database** is ticked in the remove dialog.
Dropping the worktree's database belongs here, so removal cleans up after itself.

## Minimal examples

A Node app with one database:

```json
{
  "provision": [
    { "path": ".env", "format": "dotenv", "keys": { "PG_DB": "${WT_DB_NAME}", "PORT": "${WT_SERVER_PORT}" } }
  ],
  "setup": ["npm install", "npm run db:create && npm run db:migrate"],
  "migrate": ["npm run db:migrate"],
  "teardown": ["npm run db:drop"]
}
```

No database at all, just isolated ports:

```json
{
  "provision": [
    { "path": ".env", "format": "dotenv", "keys": { "PORT": "${WT_WEB_PORT}" } }
  ],
  "setup": ["pnpm install"]
}
```

A frontend that needs the API's port:

```json
{
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
  "setup": ["pnpm install", "pnpm db:setup"]
}
```

## Editing the file

Three routes, all equivalent:

- **Settings → Files / Setup**, the structured editor, with `⌘P` to preview what will be written.
- **By hand**, then press **Sync** in the top bar so open views re-read it.
- **Import**: Settings → ⋯ → *Import from file…*, or *Load from repo file* to read the repo's own hidden
  copy by path.

## Recommendations

Commit it. That's the whole point: a branch that needs different setup carries it.

Keep secrets out of any `keys` you commit. Values are written verbatim into the worktree, and masking
isn't implemented yet (see [Security settings](settings-repository.html)).

Prefer `keys` over `text` for `.env`-style files, so hand edits in a worktree survive a re-run. And make
setup idempotent, since *Run setup…* exists and re-running should be safe.
