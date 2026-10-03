# Backend architecture notes

Decisions made during the 2026-08 hardening pass (`backend-hardening` branch),
plus the seams to use when the backend needs to scale further. Read this before
adding a subsystem — most of the rules below exist because their absence was a
shipped bug.

## Layering

```
commands.rs      the IPC boundary: 47 #[tauri::command]s, all Result<T, CanopodError>
  error.rs       { code, message } — the frontend branches on `code`, never on text
  state.rs       tree model, port allocation, OpLease, tree-query API
  services.rs    dev-service process table + log rings + on-disk log sink
  terminal.rs    PTY sessions (agent lane)
  proc.rs        the ONLY place OS process control lives (pgid / Job Object)
  git.rs/db.rs/  wrappers over external CLIs; they return String errors and the
  setup.rs       command layer stamps the domain code
```

Rules that keep this sound:

- **Locks**: `parking_lot` everywhere; no poisoning. Never hold a lock across
  an `.await`. The `AppState` tree-query API (`wt_context`, `service_context`,
  `wt_service_keys`, `repo_path_by_id`) exists so callers get owned data from a
  brief read lock — don't hand-roll tree traversals in new code.
- **Mutating per-worktree work takes an `OpLease`** (`state::try_lease`).
  One create/setup/remove/migrate/snapshot/restore/switch per worktree at a
  time; the lease is RAII so panics and early returns release it.
- **Every external process has a timeout** (git 300s / network git 900s /
  Postgres 900s / setup steps 60min) and `kill_on_drop`, so a hung tool can't
  wedge a command forever.
- **Persistence is atomic**: `settings::save_json` writes temp + fsync +
  rename, skips unchanged content, and `load_json` quarantines corrupt files
  to `*.json.corrupt` instead of silently defaulting.
- **Events**: high-volume events (`terminal:data`, `service:log`,
  `service:stats`) are `emit_filter`ed to the windows that render them;
  frontend listeners are window-scoped (`getCurrentWebviewWindow().listen`).
  `tree:changed` is diffed before emitting. Anything new and chatty should
  follow the same pattern.
- **Background loops pause while no window is visible** (git refresh, stats).
  A tray-resident app spends most of its life invisible; work nobody can see
  is the default thing to cut. `show_main_window` / the tray toggle kick a
  catch-up refresh.

## Memory model (bounded by construction)

Every unbounded-growth path found in review now has a cap or a reclaim:

| Resource | Bound |
|---|---|
| service log ring | 160 lines in memory; full stream on disk, 2MB + one roll |
| PTY scrollback | 256KB per session |
| exited-session buffers | 24 most recent |
| idle shell sessions | swept after 1h (agents exempt) |
| port indices / overrides / statuses / log rings | released on worktree & repo removal |

When adding retained state, name its cap in a comment next to the constant.

## Scaling expectations

Current design comfortably handles ~10 repos × ~10 worktrees × a few services
each. The known next bottlenecks, in order:

1. **Git refresh fan-out** — parallel (chunks of 6) but still 2 spawns per
   worktree per tick. Past ~50 worktrees, move to one `git for-each-ref` per
   repo plus `core.fsmonitor`, or a filesystem watcher instead of polling.
2. **Stats** — sysinfo refreshes the whole process table per tick. If service
   counts grow, walk only tracked pgids' descendants or lengthen the poll.
3. **Tree broadcast** — the diff gate stops no-op emits, but the payload is
   still the whole tree. If it grows large, emit per-repo or per-worktree
   deltas (the frontend store already reconciles per-key events).

## Container/runtime backend (future)

`proc.rs` is deliberately the only file that knows how a "service" becomes an
OS process, and `services.rs` only consumes its five-function API
(`prepare_group_command` / `attach_group` / `terminate_group` / `kill_group` /
`group_key`). To add container-backed services (Docker/Podman/OrbStack):

- introduce a `Runner` trait with the same five verbs plus `spawn`, implement
  `LocalProcessRunner` (today's proc.rs) and `ContainerRunner`
  (`docker run --rm --label canopod.svc=<key>`, teardown =
  `docker rm -f $(docker ps -q --filter label=…)`);
- the orphan sweep maps to label-filtered container cleanup — simpler and more
  reliable than pgids, since the daemon owns lifecycle;
- port mapping already flows through one place (`state::effective_port` and
  the `WT_*_PORT` env derivation) — container port publishing plugs in there;
- log pumps read from `docker logs --follow` instead of pipes; the ring/disk
  sink in `services.rs` is transport-agnostic already.

Keep `ServiceCfg` the single source of truth and add a `runtime: "process" |
"container"` field there when the time comes; nothing in the UI layer should
know the difference.

## Testing & CI

- `cargo test` covers the pure cores: porcelain parsers, dotenv/JSON/YAML
  upserts, port allocation, path containment, shell quoting, settings
  round-trip/quarantine, PID-recycling guard.
- The end-to-end harness (`suite.rs`, `WTM_SUITE=<repoId>`) is compiled only
  with `--features devtools`; release binaries carry none of it.
- CI (3 OS) runs `cargo check`, `cargo clippy --all-targets --features
  devtools -- -D warnings` (the tree is warning-free — keep it that way), and
  `cargo test`. The Linux/Windows jobs exist to compile the `cfg` branches a
  macOS build never sees.
