# Backend reference (`src-tauri/src`)

## Modules
| File | Responsibility |
|---|---|
| `lib.rs` | Tauri builder: plugins, state, tray init, orphan sweep, stats task, background git refresh, `invoke_handler` (all commands), `RunEvent::ExitRequested` → kill-all. Also env-gated `WTM_SELFTEST*` / `WTM_SUITE*` test hooks. |
| `main.rs` | thin entry → `canopy_lib::run()` |
| `state.rs` | `AppState` (settings/runtime/tree/statuses), `RepoNode`/`WorktreeNode`/`ServiceNode`, `refresh_tree` (derive tree from `git worktree list` + settings), `refresh_git_meta`, `port_index`, **`effective_port`**, **`worktree_vars`**, `env_value` (read a key from a worktree `.env`) |
| `settings.rs` | `Settings`/`RepoCfg`/`ServiceCfg` (settings.json) and `RuntimeState` (state.json: `port_indices`, `port_overrides`, `orphans`); load/save |
| `git.rs` | shell-outs: list worktrees, status v2 (ahead/behind/dirty), last commit, pull (+submodules), branches, fetch_all, create_worktree (+submodule `--reference`), dirty_report, remove_worktree, validate_repo, submodule_paths |
| `services.rs` | `ProcTable`, spawn (`zsh -lc`, process group, pinned Node), stop (killpg), restart, log pump (ring buffer + batched emit), stats helpers, reset_db, `worktree_svc_keys`, `stop_all`, orphan sweep |
| `setup.rs` | `WtmConfig` (`env`/`setup`/`teardown`/`migrate`), `read_config`/`read_repo_config`/`write_repo_config`, `wt_slug`, `set_env_keys`/`apply_env`/`reapply_env`, `run_setup`/`run_teardown`/`run_migration`, `run_commands` |
| `db.rs` | Postgres helpers reading `PG_*` from the worktree `.env`: `list_databases`, `current_db`, `clone_database` (createdb + `pg_dump\|pg_restore`), `export_database`, `database_exists`. **`pg_path_prefix`** picks the newest available pg_dump/pg_restore (server may be newer than PATH's). |
| `stats.rs` | 2s sysinfo poll, sum CPU/MEM over each service's descendant process tree → `service:stats` |
| `tray.rs` | tray icon (runtime-drawn template), NSPanel conversion, manual popover positioning, blur-hide |
| `toolchain.rs` | read pinned Node (`.nvmrc`/`.node-version`/`.tool-versions`), find its bin under asdf/nvm/fnm, `with_pinned_node` (prepends to a command) |
| `suite.rs` | headless end-to-end test suite (env-gated `WTM_SUITE=<repoId>`) |

## Commands (Tauri `invoke`)
Registered in `lib.rs`; typed wrappers in `src/ipc.ts`.

- Tree/settings: `get_tree`, `refresh`, `get_settings`, `save_settings`, `add_repo`, `remove_repo`,
  `get_repo_config`, `save_repo_config`
- Git: `git_pull`, `list_branches`, `fetch_branches`
- Services: `get_logs`, `service_start`, `service_stop`, `service_restart`, `worktree_start_all`,
  `worktree_stop_all`, `reset_db`, `run_migration`, `set_service_port`
- Open: `open_in_editor`, `reveal_in_finder`, `open_terminal`, `open_port`, `show_main_window`, `quit_app`
- Worktree: `create_worktree`, `run_worktree_setup`, `worktree_dirty_report`, `remove_worktree`
- Database: `list_databases`, `current_database`, `snapshot_database`, `export_database`, `switch_database`

## Tests
`cargo test --lib` covers: `db::q` shell-quoting, `setup::interpolate` + `apply_env` upsert. Run from
`src-tauri/`.

## Env-gated harnesses (not in normal operation)
- `WTM_SELFTEST="<wtPath>::<serviceId>"` — spawn→logs→kill→leak check on startup.
- `WTM_SELFTEST_CREATE="repoId|branch|serviceId"` — create + setup + start once.
- `WTM_SUITE=<repoId>` (+ `WTM_SUITE_FULL=1`) — full discovery/start/stop/create/remove suite, prints `[suite] …`.
- `WTM_NO_BLUR_HIDE=1` — keep the popover open on blur (devtools).

### Windows data-directory moves

While the backend is running, Windows may refuse to rename or move directories containing Canopy's data directory with a sharing violation. Stop the backend before moving those folders; the open directory handles protect credential paths from replacement.
