---
title: Other stacks
description: Rails, Django, Go, Rust and Docker Compose. What works out of the box, what you write yourself, and what doesn't apply.
---

# Other stacks

Canopod's *detection* is Node-centric: it reads `package.json` scripts to propose services and database
commands. Its *execution* isn't. Every command runs through your login shell, so any stack that works
in a terminal works here. For a non-Node repository, detection identifies the stack and you configure
the services and commands yourself.

## Stack-specific behaviour

| Feature | Stack-specific? |
|---|---|
| Worktree create, switch, pull, remove | No, it's pure git. |
| Ports (`basePort + index × 10`) | No. |
| Provisioned files (`dotenv` / `json` / `yaml` / `text`) | No. |
| Setup, migrate and teardown commands | No, any shell command. |
| Services, logs, CPU/memory, restart | No. |
| Terminals and agents | No. |
| Node version pinning | Node-specific (`.nvmrc`, `.node-version`, `.tool-versions`). |
| Service and command **auto-detection** | Node-specific. |
| Database tools (switch, snapshot, export, restore) | **Postgres-specific.** |

Other language version managers (rbenv, pyenv, asdf for Ruby, Python or Go) resolve automatically,
because commands run through a login shell in the worktree directory and those managers' shims read the
directory's version file the same way they do for you.

## Rails

```json
{
  "provision": [
    {
      "path": "config/database.yml",
      "format": "yaml",
      "keys": { "development.database": "${WT_DB_NAME}" }
    },
    {
      "path": ".env",
      "format": "dotenv",
      "keys": { "PORT": "${WT_WEB_PORT}", "PG_DB": "${WT_DB_NAME}" }
    }
  ],
  "setup": ["bundle install", "bin/rails db:create db:migrate"],
  "migrate": ["bin/rails db:migrate"],
  "teardown": ["bin/rails db:drop"]
}
```

Services:

| id | name | kind | command | basePort |
|---|---|---|---|---|
| `web` | Web | `web` | `bin/rails server -p $PORT` | 3000 |
| `jobs` | Jobs | `worker` | `bundle exec sidekiq` | *(none)* |

`.env` also carries `PG_DB` so the database dialog can read the connection. It reads `PG_*` keys from
the worktree's `.env` whatever else your app uses.

## Django

```json
{
  "provision": [
    { "path": ".env", "format": "dotenv",
      "keys": { "PG_DB": "${WT_DB_NAME}", "PORT": "${WT_WEB_PORT}", "DATABASE_URL": "postgres://postgres@localhost:5432/${WT_DB_NAME}" } }
  ],
  "setup": [
    "python -m venv .venv",
    ".venv/bin/pip install -r requirements.txt",
    "createdb ${WT_DB_NAME}",
    ".venv/bin/python manage.py migrate"
  ],
  "migrate": [".venv/bin/python manage.py migrate"],
  "teardown": ["dropdb --if-exists ${WT_DB_NAME}"]
}
```

Service: `web` · `web` · `.venv/bin/python manage.py runserver 0.0.0.0:$PORT` · basePort 8000.

A per-worktree virtualenv inside the worktree is the simplest thing that works, since each worktree is
its own directory anyway.

## Go

```json
{
  "provision": [
    { "path": ".env", "format": "dotenv", "keys": { "PORT": "${WT_API_PORT}", "PG_DB": "${WT_DB_NAME}" } }
  ],
  "setup": ["go mod download", "go build ./...", "migrate -database postgres://localhost/${WT_DB_NAME} up"]
}
```

Service: `api` · `server` · `go run ./cmd/api`, reading `PORT` from the environment · basePort 8080.

Go's module cache is shared, so setup is quick and a whole worktree is often ready in seconds.

## Rust

```json
{
  "provision": [
    { "path": ".env", "format": "dotenv", "keys": { "PORT": "${WT_API_PORT}" } }
  ],
  "setup": ["cargo fetch", "cargo build"]
}
```

Service: `api` · `server` · `cargo run --release` · basePort 8080.

:::tip Share the build cache across worktrees
Each worktree gets its own `target/`, which is slow and large. Point them all at one directory through
the service's extra env or a provisioned file (`CARGO_TARGET_DIR=${REPO_PATH}/.cargo-target`), or use
`sccache`.
:::

## Docker Compose

Compose works, with one thing to watch: the project name has to be per worktree, or two branches will
share the same containers.

```json
{
  "provision": [
    { "path": ".env", "format": "dotenv",
      "keys": { "COMPOSE_PROJECT_NAME": "app_${WT_SLUG}", "WEB_PORT": "${WT_WEB_PORT}", "DB_PORT": "${WT_DB_PORT}" } }
  ],
  "setup": ["docker compose pull"]
}
```

Service: `web` · `web` · `docker compose up` · basePort 8000, and map the host ports from `${WEB_PORT}`
and `${DB_PORT}` in your compose file. Canopod's stop sends `SIGTERM` to the process group, which
`docker compose up` handles by stopping the stack. A `docker compose down` custom command makes a good
companion.

Canopod's database tools talk to a Postgres server directly over `PG_*` settings. With the database
inside Compose, point `PG_HOST` and `PG_PORT` at the published port and they work. Otherwise treat the
database as part of the service and skip those actions.

## A stack with no database at all

Nothing requires one. Leave `PG_DB` out and the database tools and dialog simply don't appear:

```json
{
  "provision": [{ "path": ".env", "format": "dotenv", "keys": { "PORT": "${WT_WEB_PORT}" } }],
  "setup": ["pnpm install"]
}
```

## Polyglot repositories

A repository can mix all of these. A Go API, a Vite frontend and a Python worker are three services with
three commands and three base ports. Canopod doesn't care what language a service is written in, only
what command starts it and which port it should get.
