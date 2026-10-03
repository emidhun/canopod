# ToolJet `.worktreemanager.json` (reference)

This is a working config for ToolJet (CE), kept as an end-to-end example. It lives at the ToolJet
repo root (`<ToolJet>/.worktreemanager.json`). Commit it on the ToolJet branch so teammates/QA
inherit it per-branch.

```json
{
  "env": {
    "PG_DB": "${WT_DB_NAME}",
    "PORT": "${WT_SERVER_PORT}",
    "TOOLJET_SERVER_PORT": "${WT_SERVER_PORT}"
  },
  "setup": [
    "npm --prefix frontend install --no-audit --no-fund",
    "npm --prefix server install --no-audit --no-fund",
    "npm --prefix plugins install --no-audit --no-fund",
    "npm --prefix plugins run build",
    "npm run db:create && npm run db:migrate"
  ],
  "migrate": [
    "npm run db:migrate"
  ],
  "teardown": [
    "npm run db:drop"
  ]
}
```

## Why each line
- **`env.PG_DB = ${WT_DB_NAME}`** → isolated database per worktree (`tooljet_<slug>`).
- **`env.PORT = ${WT_SERVER_PORT}`** → the server (NestJS, reads `process.env.PORT`) listens on the
  worktree's server port.
- **`env.TOOLJET_SERVER_PORT = ${WT_SERVER_PORT}`** → the frontend (webpack, reads this at launch)
  connects to that server port instead of the 3000 default.
- **setup:** install frontend + server deps; **install + build plugins** (the server imports
  `@tooljet/plugins/dist/server` — without the build, migrations fail with `Cannot find module`);
  then create + migrate the worktree's DB.
- **migrate:** `npm run db:migrate` for the "Run migration" button.
- **teardown:** `npm run db:drop` runs on worktree delete when "Drop database" is checked.

## ToolJet-specific facts baked into this
- Server requires **Node 22.15.1** (engine-strict). Canopod supplies it via the pinned-Node prepend.
- Reset DB command (app Settings `resetDb`) for ToolJet = `npm run db:reset` (= `db:drop && db:setup`).
- Service base ports in Settings: frontend `8082`, server `3000`. Frontend command should be
  `npm start -- --port $PORT` so its own port is per-worktree; the server honors `$PORT` via env.
- DB connection (`PG_HOST/PORT/USER/PASS`) is copied verbatim from the main checkout's `.env`, so on a
  different machine those must be valid for that machine's Postgres.
