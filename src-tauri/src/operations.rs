use crate::error::CanopyError;
use crate::git;
use crate::runtime::RuntimeContext;
use crate::services::{self, LogLine, ProcTable};
use crate::settings::{self, RepoCfg, Settings};
use crate::state::{refresh_all_git_meta, refresh_git_meta, refresh_tree, AppState, RepoNode};
use crate::terminal::{self, TermTable};

/// Uniform containment: commands that act on a `wt_key` only accept keys the
/// tree actually knows. Without this, a compromised webview could point
/// git/db/terminal operations at arbitrary filesystem paths.
fn ensure_known_worktree(app: &RuntimeContext, wt_key: &str) -> Result<(), CanopyError> {
    if app.state::<AppState>().wt_context(wt_key).is_some() {
        Ok(())
    } else {
        Err(CanopyError::not_found("unknown worktree"))
    }
}

pub async fn get_tree(app: RuntimeContext) -> Result<Vec<RepoNode>, CanopyError> {
    let cached = {
        let state = app.state::<AppState>();
        let tree = state.tree.read();
        tree.clone()
    };
    if cached.is_empty() {
        refresh_tree(&app).await.map_err(CanopyError::internal)
    } else {
        Ok(cached)
    }
}

pub async fn refresh(app: RuntimeContext, wt_key: Option<String>) -> Result<(), CanopyError> {
    match wt_key {
        Some(key) => refresh_git_meta(&app, &key).await,
        None => {
            refresh_tree(&app).await.map_err(CanopyError::internal)?;
            refresh_all_git_meta(&app).await;
        }
    }
    Ok(())
}

pub fn get_settings(state: &AppState) -> Settings {
    state.settings.read().clone()
}

pub async fn save_settings(app: RuntimeContext, new_settings: Settings) -> Result<(), CanopyError> {
    {
        let state = app.state::<AppState>();
        *state.settings.write() = new_settings.clone();
    }
    // re-publish git credentials before the rescan, so the refresh it triggers
    // already uses the key the user just chose
    git::apply_credentials(
        &new_settings.security.ssh_key,
        &new_settings.security.credential_helper,
    );
    settings::save_settings(&app, &new_settings).map_err(CanopyError::config)?;
    // await only the structural rebuild (the tree must reflect the new
    // services/repos when this resolves); git meta is 2 spawns per worktree
    // and arrives via worktree:git events — holding the Save button on it
    // meant seconds of spinner for a millisecond write
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    let app2 = app.clone();
    app.executor()
        .spawn(async move { refresh_all_git_meta(&app2).await });
    Ok(())
}

/// Validate + register a repo; returns the canonical repo config that was added.
pub async fn add_repo(app: RuntimeContext, path: String) -> Result<RepoCfg, CanopyError> {
    let top = git::validate_repo(&path).await.map_err(CanopyError::git)?;
    let name = std::path::Path::new(&top)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| top.clone());

    let repo = RepoCfg {
        id: name.to_lowercase().replace(' ', "-"),
        name: name.clone(),
        // Default new worktrees to a hidden dir INSIDE the repo. Keeping them
        // under the repo root (rather than a `<repo>-worktrees` sibling) means
        // one self-contained tree to back up, move, or delete.
        worktree_dir: format!("{top}/.worktrees"),
        path: top,
        reset_db: String::new(),
        migrate_db: String::new(),
        services: Vec::new(),
        custom_commands: Vec::new(),
        agent_command: String::new(),
        agents: Vec::new(),
        default_base: String::new(),
        worktree_defaults: Default::default(),
        agent_context: Default::default(),
        max_parallel_agents: 0,
        agent_idle_timeout_min: 0,
    };

    let updated = {
        let state = app.state::<AppState>();
        let mut s = state.settings.write();
        if s.repos.iter().any(|r| r.path == repo.path) {
            return Err(CanopyError::conflict("Repository already registered"));
        }
        // repo lookups key on `id`, so two different paths must never share one
        // (e.g. ~/work/tooljet + ~/client/tooljet) — suffix until unique.
        let mut repo = repo;
        let base = repo.id.clone();
        let mut n = 2;
        while s.repos.iter().any(|r| r.id == repo.id) {
            repo.id = format!("{base}-{n}");
            n += 1;
        }
        s.repos.push(repo.clone());
        let updated = s.clone();
        drop(s);
        (repo, updated)
    };
    let (repo, updated) = updated;
    settings::save_settings(&app, &updated).map_err(CanopyError::config)?;
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    // meta arrives via worktree:git events — same reasoning as save_settings
    let app2 = app.clone();
    app.executor()
        .spawn(async move { refresh_all_git_meta(&app2).await });
    Ok(repo)
}

/// What onboarding shows for a repo: identity (name/branch/origin), a best-guess
/// stack, and the package.json scripts it can map into services + commands.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDetection {
    pub top: String,
    pub name: String,
    pub branch: String,
    pub origin: String,
    /// node | next | nest | rails | django | go | rust | other
    pub stack: String,
    pub scripts: Vec<ScriptEntry>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptEntry {
    pub name: String,
    pub command: String,
}

/// Inspect a repo path for onboarding: validate it's a git repo, read its
/// branch/origin, guess the stack from manifest files, and list package.json
/// scripts. Read-only — registers nothing.
pub async fn detect_repo(path: String) -> Result<RepoDetection, CanopyError> {
    let top = git::validate_repo(&path).await.map_err(CanopyError::git)?;
    let name = std::path::Path::new(&top)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| top.clone());

    let branch = git::run_git(&top, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let origin = git::run_git(&top, &["remote", "get-url", "origin"])
        .await
        .map(|s| {
            s.trim()
                .trim_end_matches(".git")
                .replace("git@github.com:", "github.com/")
                .replace("https://", "")
        })
        .unwrap_or_default();

    let has = |f: &str| std::path::Path::new(&top).join(f).exists();
    let has_glob = |stem: &str| {
        ["js", "ts", "mjs", "cjs"].iter().any(|ext| {
            std::path::Path::new(&top)
                .join(format!("{stem}.{ext}"))
                .exists()
        })
    };
    let stack = if has_glob("next.config") {
        "next"
    } else if has("nest-cli.json") {
        "nest"
    } else if has("Gemfile") {
        "rails"
    } else if has("manage.py") {
        "django"
    } else if has("go.mod") {
        "go"
    } else if has("Cargo.toml") {
        "rust"
    } else if has("package.json") {
        "node"
    } else {
        "other"
    }
    .to_string();

    // package.json scripts → ordered list (preserves file order)
    let mut scripts = Vec::new();
    if let Ok(txt) = std::fs::read_to_string(std::path::Path::new(&top).join("package.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(obj) = v.get("scripts").and_then(|s| s.as_object()) {
                for (name, cmd) in obj {
                    if let Some(c) = cmd.as_str() {
                        scripts.push(ScriptEntry {
                            name: name.clone(),
                            command: c.to_string(),
                        });
                    }
                }
            }
        }
    }

    Ok(RepoDetection {
        top,
        name,
        branch,
        origin,
        stack,
        scripts,
    })
}

pub async fn remove_repo(app: RuntimeContext, repo_id: String) -> Result<(), CanopyError> {
    // Deregistering a repo must not leave its dev servers running untracked
    // or its runtime state (port indices/overrides, statuses, logs) behind.
    let wt_keys: Vec<String> = {
        let state = app.state::<AppState>();
        let tree = state.tree.read();
        tree.iter()
            .filter(|r| r.repo_id == repo_id)
            .flat_map(|r| r.worktrees.iter().map(|w| w.wt_key.clone()))
            .collect()
    };
    for wt in &wt_keys {
        for key in services::worktree_svc_keys(&app, wt) {
            let _ = services::stop_service(&app, &key).await;
        }
        terminal::close_worktree(&app, app.state::<TermTable>(), wt);
    }

    let updated = {
        let state = app.state::<AppState>();
        let mut s = state.settings.write();
        s.repos.retain(|r| r.id != repo_id);
        s.clone()
    };
    settings::save_settings(&app, &updated).map_err(CanopyError::config)?;

    for wt in &wt_keys {
        crate::state::release_worktree_runtime(&app, &repo_id, wt);
    }
    // drop the repo's whole port-index map (covers worktrees no longer listed)
    {
        let state = app.state::<AppState>();
        let runtime = {
            let mut rt = state.runtime.write();
            rt.port_indices.remove(&repo_id);
            rt.clone()
        };
        let _ = settings::save_runtime(&app, &runtime);
    }
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    Ok(())
}

pub async fn git_pull(app: RuntimeContext, wt_key: String) -> Result<String, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    let summary = git::pull(&wt_key).await.map_err(CanopyError::git)?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(summary)
}

// ── submodules ──

pub async fn submodule_status(
    app: RuntimeContext,
    wt_key: String,
) -> Result<Vec<git::SubmoduleStatus>, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    Ok(git::submodule_status(&wt_key).await)
}

pub async fn pull_submodule(
    app: RuntimeContext,
    wt_key: String,
    path: String,
) -> Result<String, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    let summary = git::pull_submodule(&wt_key, &path)
        .await
        .map_err(CanopyError::git)?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(summary)
}

pub async fn switch_submodule_branch(
    app: RuntimeContext,
    wt_key: String,
    path: String,
    branch: String,
) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    git::switch_submodule_branch(&wt_key, &path, &branch)
        .await
        .map_err(CanopyError::git)?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(())
}

pub async fn list_submodule_branches(
    app: RuntimeContext,
    wt_key: String,
    path: String,
) -> Result<git::Branches, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    git::list_submodule_branches(&wt_key, &path)
        .await
        .map_err(CanopyError::git)
}

pub async fn fetch_submodules(app: RuntimeContext, wt_key: String) -> Result<usize, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    Ok(git::fetch_submodules(&wt_key).await)
}

/// Re-pin every submodule to the commit the parent records (⇧⌘S in the UI).
pub async fn sync_submodules(app: RuntimeContext, wt_key: String) -> Result<String, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    // shares the worktree lease with pull/setup: a sync rewriting submodule
    // checkouts under a running `pnpm install` is exactly the collision leases exist for
    let _lease = crate::state::try_lease(&app, &wt_key, "sync submodules")?;
    let n = git::sync_submodules(&wt_key)
        .await
        .map_err(CanopyError::git)?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(match n {
        0 => "No submodules to sync".to_string(),
        1 => "1 submodule back on its pinned commit".to_string(),
        n => format!("{n} submodules back on their pinned commits"),
    })
}

/// Check out a different branch in this worktree (in place — deps reused).
pub async fn switch_worktree_branch(
    app: RuntimeContext,
    wt_key: String,
    branch: String,
    create: bool,
    base: Option<String>,
) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    git::switch_branch(&wt_key, &branch, create, base.as_deref())
        .await
        .map_err(CanopyError::git)?;
    let _ = refresh_tree(&app).await;
    refresh_git_meta(&app, &wt_key).await;
    Ok(())
}

// ── services ──

pub fn get_logs(table: &ProcTable, svc_key: String) -> Vec<LogLine> {
    table
        .logs
        .lock()
        .get(&svc_key)
        .map(|b| b.iter().cloned().collect())
        .unwrap_or_default()
}

// ── embedded terminals (agent lane) ──

// async so they run on the runtime thread pool: open does openpty + spawn,
// get_buffer base64-encodes up to 256KB, and write can block on a stalled
// child — none of that belongs on the main (UI) thread.

pub async fn terminal_open(
    app: RuntimeContext,
    table: &TermTable,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &cwd)?;
    terminal::open(&app, table, &id, &cwd, cols, rows, command).map_err(CanopyError::terminal)
}

pub async fn terminal_store_image(
    app: RuntimeContext,
    id: String,
    data: Vec<u8>,
) -> Result<String, CanopyError> {
    tokio::task::spawn_blocking(move || terminal::store_image(app.state::<TermTable>(), &id, &data))
        .await
        .map_err(|e| CanopyError::terminal(e.to_string()))?
        .map_err(CanopyError::terminal)
}

pub async fn terminal_write(
    app: RuntimeContext,
    table: &TermTable,
    id: String,
    data: String,
) -> Result<(), CanopyError> {
    terminal::write(&app, table, &id, &data).map_err(CanopyError::terminal)
}

pub async fn terminal_resize(
    table: &TermTable,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), CanopyError> {
    terminal::resize(table, &id, cols, rows).map_err(CanopyError::terminal)
}

pub async fn terminal_get_buffer(
    table: &TermTable,
    id: String,
) -> Result<Option<terminal::BufferSnapshot>, CanopyError> {
    Ok(terminal::get_buffer(table, &id))
}

pub async fn terminal_close(
    app: RuntimeContext,
    table: &TermTable,
    id: String,
) -> Result<(), CanopyError> {
    terminal::close_and_persist(&app, table, &id);
    Ok(())
}

/// Ensure a worktree's `.canopy/` exists with a self-ignoring `.gitignore`, then
/// write `context.md`. Never truncates an existing `.gitignore`.
pub fn write_worktree_context(
    app: RuntimeContext,
    wt_path: String,
    contents: String,
) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_path)?;
    let dir = std::path::Path::new(&wt_path).join(".canopy");
    std::fs::create_dir_all(&dir)
        .map_err(|e| CanopyError::setup(format!("mkdir {}: {e}", dir.display())))?;
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        std::fs::write(&ignore, "*\n")
            .map_err(|e| CanopyError::setup(format!("write {}: {e}", ignore.display())))?;
    }
    let file = dir.join("context.md");
    std::fs::write(&file, contents)
        .map_err(|e| CanopyError::setup(format!("write {}: {e}", file.display())))
}

/// The agent CLI to run for a worktree: the repo's configured `agentCommand`,
/// or the built-in default when unset.
pub fn resolve_agent_command(state: &AppState, wt_key: String) -> String {
    const DEFAULT_AGENT: &str = "claude";
    let repo_id = state.wt_context(&wt_key).map(|c| c.repo_id);
    let cmd = repo_id.and_then(|id| {
        let settings = state.settings.read();
        settings
            .repos
            .iter()
            .find(|r| r.id == id)
            .map(|r| r.agent_command.trim().to_string())
    });
    match cmd {
        Some(c) if !c.is_empty() => c,
        _ => DEFAULT_AGENT.to_string(),
    }
}

/// Every environment variable a service runs with, with its source, masked.
/// Answers "why is this talking to the wrong database?" without printing the
/// repo's secrets into a modal.
pub fn service_env(
    app: RuntimeContext,
    svc_key: String,
) -> Result<Vec<services::EnvEntry>, CanopyError> {
    services::resolved_env(&app, &svc_key).map_err(CanopyError::not_found)
}

fn service_lease(app: &RuntimeContext, key: &str) -> Result<crate::state::OpLease, CanopyError> {
    let (wt, _, _) = app.state::<AppState>().service_context(key).ok_or_else(|| CanopyError::not_found("unknown service"))?;
    crate::state::try_lease(app, &wt, "service control")
}

pub async fn service_start(app: RuntimeContext, svc_key: String) -> Result<(), CanopyError> {
    let _lease = service_lease(&app, &svc_key)?;
    services::start_service(&app, &svc_key)
        .await
        .map_err(CanopyError::process)
}

pub async fn service_stop(app: RuntimeContext, svc_key: String) -> Result<(), CanopyError> {
    let _lease = service_lease(&app, &svc_key)?;
    services::stop_service(&app, &svc_key).await.map_err(CanopyError::process)?;
    if !services::wait_reaped(&app, &svc_key, 60).await { return Err(CanopyError::process("service did not stop")); }
    Ok(())
}

pub async fn service_restart(app: RuntimeContext, svc_key: String) -> Result<(), CanopyError> {
    let _lease = service_lease(&app, &svc_key)?;
    services::restart_service(&app, &svc_key)
        .await
        .map_err(CanopyError::process)
}

pub async fn worktree_start_all(app: RuntimeContext, wt_key: String) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    let _lease = crate::state::try_lease(&app, &wt_key, "service control")?;
    // start every service, collecting failures — one bad service must not
    // silently prevent its siblings from starting
    let mut errors: Vec<String> = Vec::new();
    for key in services::worktree_svc_keys(&app, &wt_key) {
        if let Err(e) = services::start_service(&app, &key).await {
            errors.push(format!("{key}: {e}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(CanopyError::process(format!(
            "some services failed to start — {}",
            errors.join("; ")
        )))
    }
}

pub async fn worktree_stop_all(app: RuntimeContext, wt_key: String) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    let _lease = crate::state::try_lease(&app, &wt_key, "service control")?;
    let mut errors: Vec<String> = Vec::new();
    for key in services::worktree_svc_keys(&app, &wt_key) {
        if let Err(e) = services::stop_service(&app, &key).await {
            errors.push(format!("{key}: {e}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(CanopyError::process(format!(
            "some services failed to stop — {}",
            errors.join("; ")
        )))
    }
}

pub async fn reset_db(app: RuntimeContext, wt_key: String) -> Result<(), CanopyError> {
    let _lease = crate::state::try_lease(&app, &wt_key, "reset db")?;
    services::reset_db(&app, &wt_key)
        .await
        .map_err(CanopyError::db)
}

/// Run the worktree's configured DB migration (`migrate` in .worktreemanager.json).
pub async fn run_migration(app: RuntimeContext, wt_key: String) -> Result<(), CanopyError> {
    let (repo_path, repo_id) = repo_for_wt(&app, &wt_key)?;
    let _lease = crate::state::try_lease(&app, &wt_key, "migrate")?;
    // prefer the Settings "Migrate cmd"; fall back to .worktreemanager.json `migrate`
    let settings_cmd = {
        let state = app.state::<AppState>();
        let s = state.settings.read();
        s.repos
            .iter()
            .find(|r| r.id == repo_id)
            .map(|r| r.migrate_db.clone())
            .unwrap_or_default()
    };
    let vars = crate::state::worktree_vars(&app, &repo_id, &wt_key, false);
    let app2 = app.clone();
    let wt2 = wt_key.clone();
    emit_op(&app, &wt_key, "migrate", "progress", "running migration…");
    let result = if !settings_cmd.trim().is_empty() {
        crate::setup::run_custom_command(&wt_key, &repo_path, &settings_cmd, &vars, move |p| {
            emit_progress(&app2, &wt2, "migrate", p)
        })
        .await
    } else {
        crate::setup::run_migration(&wt_key, &repo_path, &vars, move |p| {
            emit_progress(&app2, &wt2, "migrate", p)
        })
        .await
    };
    match result {
        Ok(()) => {
            emit_op(&app, &wt_key, "migrate", "done", "migration complete");
            Ok(())
        }
        Err(e) => {
            emit_op(&app, &wt_key, "migrate", "error", e.clone());
            Err(CanopyError::setup(e))
        }
    }
}

/// Run a repo-defined custom command in the worktree root, on the pinned Node,
/// streaming progress via `worktree:op` (op="custom") — same model as migrate.
pub async fn run_custom_command(
    app: RuntimeContext,
    wt_key: String,
    command: String,
) -> Result<(), CanopyError> {
    if command.trim().is_empty() {
        return Err(CanopyError::invalid_input("Empty command"));
    }
    let (repo_path, repo_id) = repo_for_wt(&app, &wt_key)?;
    let _lease = crate::state::try_lease(&app, &wt_key, "command")?;
    let vars = crate::state::worktree_vars(&app, &repo_id, &wt_key, false);
    let app2 = app.clone();
    let wt2 = wt_key.clone();
    emit_op(
        &app,
        &wt_key,
        "custom",
        "progress",
        format!("running: {command}"),
    );
    match crate::setup::run_custom_command(&wt_key, &repo_path, &command, &vars, move |p| {
        emit_progress(&app2, &wt2, "custom", p)
    })
    .await
    {
        Ok(()) => {
            emit_op(&app, &wt_key, "custom", "done", "command finished");
            Ok(())
        }
        Err(e) => {
            emit_op(&app, &wt_key, "custom", "error", e.clone());
            Err(CanopyError::setup(e))
        }
    }
}

/// Pin or unpin a worktree in the sidebar. Persists to `Settings` and
/// republishes the tree, which is what carries the flag to every window.
pub async fn set_worktree_pinned(
    app: RuntimeContext,
    wt_key: String,
    pinned: bool,
) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    let updated = {
        let state = app.state::<AppState>();
        let mut s = state.settings.write();
        let has = s.pinned_worktrees.iter().any(|k| k == &wt_key);
        if has == pinned {
            return Ok(()); // already in the requested state — no write, no event
        }
        if pinned {
            s.pinned_worktrees.push(wt_key.clone());
        } else {
            s.pinned_worktrees.retain(|k| k != &wt_key);
        }
        s.clone()
    };
    settings::save_settings(&app, &updated).map_err(CanopyError::config)?;
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    Ok(())
}

// ── worktree create / remove ──

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorktreeOpEvent {
    wt_key: String,
    op: &'static str,
    state: &'static str,
    detail: String,
    /// 1-based step this event belongs to; 0 = the provisioning phase, which
    /// runs before the numbered commands. Only set on result events.
    #[serde(skip_serializing_if = "Option::is_none")]
    step: Option<usize>,
    /// short quantity the step produced ("1,842 packages"). Absent whenever the
    /// command's output matched no known pattern — a step never claims a count
    /// it wasn't given.
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
}

fn emit_op(
    app: &RuntimeContext,
    wt_key: &str,
    op: &'static str,
    state: &'static str,
    detail: impl Into<String>,
) {
    emit_op_with_notification(app, wt_key, op, state, detail, true);
}

fn emit_op_with_notification(
    app: &RuntimeContext,
    wt_key: &str,
    op: &'static str,
    state: &'static str,
    detail: impl Into<String>,
    notify: bool,
) {
    let detail = detail.into();
    // A provisioning run that finished is the one "op" worth telling someone
    // about who isn't watching — it is the gate on the worktree being usable.
    if notify && matches!(op, "create") && matches!(state, "done" | "error") {
        let branch = app
            .state::<AppState>()
            .wt_context(wt_key)
            .map(|c| c.branch)
            .unwrap_or_else(|| wt_key.to_string());
        crate::notify::notify(
            app,
            crate::notify::Kind::SetupDone,
            wt_key,
            if state == "error" {
                "Setup failed"
            } else {
                "Setup finished"
            },
            &format!("{branch} — {detail}"),
        );
    }
    let _ = app.emit(
        "worktree:op",
        &WorktreeOpEvent {
            wt_key: wt_key.to_string(),
            op,
            state,
            detail,
            step: None,
            result: None,
        },
    );
}

/// Where a worktree for `branch` lands. The single definition — `create_worktree`
/// and `preview_worktree` both call it, so the path the modal promises is the
/// path creation uses.
pub(crate) fn derive_worktree_path(repo: &RepoCfg, branch: &str) -> String {
    std::path::Path::new(&derive_worktree_root(repo))
        .join(sanitize_branch(branch))
        .to_string_lossy()
        .into_owned()
}

fn derive_worktree_root(repo: &RepoCfg) -> String {
    let configured = repo.worktree_dir.trim();
    let root = std::path::Path::new(if configured.is_empty() {
        ".worktrees"
    } else {
        configured
    });
    if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::path::Path::new(&repo.path).join(root)
    }
    .to_string_lossy()
    .into_owned()
}

/// Forward one `setup::Progress` as a `worktree:op` event: output lines keep
/// the existing shape, step results carry `step` + `result` instead.
fn emit_progress(app: &RuntimeContext, wt_key: &str, op: &'static str, p: crate::setup::Progress) {
    match p {
        crate::setup::Progress::Line(line) => emit_op(app, wt_key, op, "progress", line),
        crate::setup::Progress::StepResult { index, text } => {
            let _ = app.emit(
                "worktree:op",
                &WorktreeOpEvent {
                    wt_key: wt_key.to_string(),
                    op,
                    state: "progress",
                    detail: String::new(),
                    step: Some(index),
                    result: Some(text),
                },
            );
        }
    }
}

pub(crate) fn sanitize_branch(branch: &str) -> String {
    branch
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Write a self-ignoring `.gitignore` (`*`) into `dir`, creating it if needed.
/// A worktree root that lives INSIDE the repo (the `.worktrees` default) would
/// otherwise show up as untracked in the parent checkout — polluting `git
/// status`, risking a stray `git add .`, and tripping Canopy's own dirty
/// detection. This is the same self-ignore `.canopy/` uses. Never truncates an
/// existing `.gitignore`.
fn ensure_dir_self_ignored(dir: &str) -> Result<(), String> {
    let p = std::path::Path::new(dir);
    std::fs::create_dir_all(p).map_err(|e| format!("mkdir {dir}: {e}"))?;
    let ignore = p.join(".gitignore");
    if !ignore.exists() {
        std::fs::write(&ignore, "*\n").map_err(|e| format!("write {}: {e}", ignore.display()))?;
    }
    Ok(())
}

/// One service's port in the preview, with whether anything already holds it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPort {
    pub service_id: String,
    pub name: String,
    pub port: u32,
    /// the branch of the worktree already using this port, if any
    pub taken_by: Option<String>,
}

/// What creating a worktree for this branch would produce. Read-only: it
/// allocates no port index, touches no disk, and registers nothing.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePreview {
    pub path: String,
    pub slug: String,
    /// `None` when the repo's provisioning never references `${WT_DB_NAME}` —
    /// no isolated database would be created, and naming one would be a
    /// promise the setup doesn't keep
    pub db_name: Option<String>,
    pub ports: Vec<PreviewPort>,
    /// the derived path is already on disk, so creation would be refused
    pub path_exists: bool,
}

/// Preview a worktree before creating it.
///
/// Shares every derivation with `create_worktree` — the path via
/// `derive_worktree_path`, the port index via `peek_port_index` (the same
/// first-free-slot rule, with `assign: false`), and the database name via
/// `derived_db_name`, which is also what `worktree_vars` exposes as
/// `${WT_DB_NAME}`. The panel's entire value is that it matches what you
/// actually get; a parallel implementation that drifts would be worse than no
/// panel at all.
pub fn preview_worktree(
    app: RuntimeContext,
    repo_id: String,
    branch: String,
) -> Result<WorktreePreview, CanopyError> {
    let repo = {
        let state = app.state::<AppState>();
        let s = state.settings.read();
        s.repos
            .iter()
            .find(|r| r.id == repo_id)
            .cloned()
            .ok_or_else(|| CanopyError::not_found("unknown repo"))?
    };
    let path = derive_worktree_path(&repo, &branch);

    let state = app.state::<AppState>();
    // peek, never assign: opening the modal must not consume a port slot that
    // a worktree created moments later from a different branch would then skip
    let idx = {
        let mut rt = state.runtime.write();
        crate::state::peek_port_index(&mut rt, &repo_id, &path)
    };
    let overrides = state.runtime.read().port_overrides.clone();

    // every port already spoken for, and by which branch
    let held: std::collections::HashMap<u32, String> = {
        let tree = state.tree.read();
        tree.iter()
            .flat_map(|r| r.worktrees.iter())
            .flat_map(|w| {
                w.services
                    .iter()
                    .filter_map(|s| s.port.map(|p| (p, w.branch.clone())))
            })
            .collect()
    };

    let ports = repo
        .services
        .iter()
        .filter_map(|s| {
            let base = s.base_port? as u32;
            let key = crate::state::svc_key(&path, &s.id);
            let port = crate::state::effective_port(&overrides, &key, base, idx);
            Some(PreviewPort {
                service_id: s.id.clone(),
                name: s.name.clone(),
                port,
                taken_by: held.get(&port).cloned(),
            })
        })
        .collect();

    // Only claim a database if provisioning would actually create one.
    let cfg = crate::setup::read_repo_config(&repo.path);
    let uses_db = cfg
        .provision
        .iter()
        .any(|p| p.keys.iter().any(|(_, tpl)| tpl.contains("${WT_DB_NAME}")));
    let db_name = uses_db.then(|| crate::state::derived_db_name(&repo_id, &path));

    Ok(WorktreePreview {
        slug: crate::setup::wt_slug(&path),
        path_exists: std::path::Path::new(&path).exists(),
        path,
        db_name,
        ports,
    })
}

pub async fn create_worktree(
    app: RuntimeContext,
    repo_id: String,
    branch: String,
    base: Option<String>,
    create_branch: bool,
) -> Result<String, CanopyError> {
    let repo = {
        let state = app.state::<AppState>();
        let s = state.settings.read();
        s.repos
            .iter()
            .find(|r| r.id == repo_id)
            .cloned()
            .ok_or_else(|| CanopyError::not_found("unknown repo"))?
    };
    create_worktree_for_repo(app, repo, branch, base, create_branch, None).await
}

pub(crate) async fn create_worktree_for_repo(
    app: RuntimeContext, repo: RepoCfg, branch: String, base: Option<String>, create_branch: bool,
    tracking: Option<crate::jobs::Tracking>,
) -> Result<String, CanopyError> {
    let repo_id = repo.id.clone();
    // Resolve the worktree root: empty falls back to `<repo>/.worktrees`, a
    // relative dir (e.g. ".worktrees") is taken relative to the repo — so it
    // lands inside the repo instead of wherever the process CWD happens to be —
    // and an absolute dir is used verbatim.
    let wt_dir = derive_worktree_root(&repo);
    let wt_path = derive_worktree_path(&repo, &branch);
    if std::path::Path::new(&wt_path).exists() {
        return Err(CanopyError::conflict(format!(
            "Path already exists: {wt_path}"
        )));
    }

    // Keep a worktree root that sits inside the repo from polluting the parent
    // checkout. Best-effort: an unwritable root is the git command's problem to
    // report, not a reason to abort before we've even tried to create.
    if std::path::Path::new(&wt_dir).starts_with(&repo.path) {
        if let Err(e) = ensure_dir_self_ignored(&wt_dir) {
            emit_op(
                &app,
                &wt_path,
                "create",
                "progress",
                format!("gitignore skipped — {e}"),
            );
        }
    }

    let _lease = crate::state::try_lease(&app, &wt_path, "create")?;

    emit_op(
        &app,
        &wt_path,
        "create",
        "progress",
        format!("creating worktree for {branch}…"),
    );

    // Refresh remote-tracking refs (and submodule objects) BEFORE `git worktree
    // add`, so a worktree made from an origin branch — and the submodule commits
    // it pins — reflects the remote rather than a stale local ref. Best-effort:
    // an offline or remote-less repo still creates from whatever it has locally.
    emit_op(&app, &wt_path, "create", "progress", "fetching origin…");
    if let Err(e) = git::fetch_all(&repo.path).await {
        emit_op(
            &app,
            &wt_path,
            "create",
            "progress",
            format!("fetch skipped — {e}"),
        );
    }

    let app2 = app.clone();
    let wt_path2 = wt_path.clone();
    let result = git::create_worktree_tracked(
        &repo.path,
        &wt_path,
        &branch,
        base.as_deref(),
        create_branch,
        move |line| emit_op(&app2, &wt_path2, "create", "progress", line),
        tracking.as_ref(),
    )
    .await;

    if let Err(e) = result {
        emit_op(&app, &wt_path, "create", "error", e.clone());
        return Err(CanopyError::git(e));
    }

    // post-create provisioning (env overrides + setup commands) — see setup.rs.
    // Assign the worktree's ports first so .env overrides can reference them.
    let vars = crate::state::worktree_vars(&app, &repo_id, &wt_path, false);
    // The worktree exists either way; surface setup failure but keep the tree fresh.
    let parallel = !crate::jobs::is_tracked() && crate::diagnostics::experiment_enabled(&app, "parallel-setup");
    let setup_result = if repo.worktree_defaults.run_setup {
        let app3 = app.clone();
        let wt_path3 = wt_path.clone();
        crate::setup::run_setup(&wt_path, &repo.path, &vars, false, parallel, move |p| {
            emit_progress(&app3, &wt_path3, "create", p)
        })
        .await
    } else {
        // Skipping is a choice, not a silent no-op: the worktree exists but is
        // not provisioned, and the runner is one click away.
        emit_op(
            &app,
            &wt_path,
            "create",
            "progress",
            "setup skipped — Run setup when you're ready",
        );
        Ok(())
    };

    // Record the outcome before the rescan, so the tree this create publishes
    // already carries the marker rather than reading as unprovisioned until
    // the next 60s refresh.
    crate::setup::write_setup_marker(&wt_path, setup_result.is_ok());

    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    refresh_git_meta(&app, &wt_path).await;

    // installing dependencies is the single biggest change a worktree's
    // footprint ever sees — measure it now rather than serving a stale figure
    crate::disk::request(&app, vec![wt_path.clone()], true);

    match setup_result {
        Ok(()) => {
            // Starting services is only meaningful once provisioning has run;
            // booting a service against an unprovisioned worktree just crashes it.
            if !crate::jobs::is_cancelled() && repo.worktree_defaults.start_services && repo.worktree_defaults.run_setup {
                emit_op(&app, &wt_path, "create", "progress", "starting services…");
                for key in services::worktree_svc_keys(&app, &wt_path) {
                    if let Err(e) = services::start_service(&app, &key).await {
                        emit_op(
                            &app,
                            &wt_path,
                            "create",
                            "progress",
                            format!("{key} did not start: {e}"),
                        );
                    }
                }
            }
            emit_op(&app, &wt_path, "create", "done", "worktree ready");
            Ok(wt_path)
        }
        Err(e) => {
            emit_op(
                &app,
                &wt_path,
                "create",
                "error",
                format!("worktree created, but {e}"),
            );
            Err(CanopyError::setup(format!(
                "Worktree created, but setup failed:\n{e}"
            )))
        }
    }
}

/// Manually (re)run a worktree's setup commands — for worktrees created before
/// setup was configured, or to retry after a failure.
pub async fn run_worktree_setup(
    app: RuntimeContext,
    wt_key: String,
    dry_run: bool,
) -> Result<(), CanopyError> {
    let ctx = app
        .state::<AppState>()
        .wt_context(&wt_key)
        .ok_or_else(|| CanopyError::not_found("unknown worktree"))?;
    let (repo_path, repo_id, is_main) = (ctx.repo_path, ctx.repo_id, ctx.is_main);
    if !crate::setup::has_config(&wt_key, &repo_path) {
        return Err(CanopyError::invalid_input(
            "Nothing to run — add provisioned files or setup commands in .worktreemanager.json",
        ));
    }
    let _lease = crate::state::try_lease(&app, &wt_key, "setup")?;
    let vars = crate::state::worktree_vars(&app, &repo_id, &wt_key, is_main);
    let app3 = app.clone();
    let wt3 = wt_key.clone();
    emit_op(
        &app,
        &wt_key,
        "create",
        "progress",
        if dry_run {
            "dry run — nothing will be executed"
        } else {
            "running setup…"
        },
    );
    let parallel = !crate::jobs::is_tracked() && crate::diagnostics::experiment_enabled(&app, "parallel-setup");
    let result = crate::setup::run_setup(&wt_key, &repo_path, &vars, dry_run, parallel, move |p| {
        emit_progress(&app3, &wt3, "create", p)
    })
    .await;
    // A dry run executed nothing and provisioned nothing, so it must not
    // record that setup ran — that would mark the worktree usable on the
    // strength of a preview.
    if !dry_run {
        crate::setup::write_setup_marker(&wt_key, result.is_ok());
    }
    // the marker is part of the tree, so republish it rather than making the
    // caller wait for the next background refresh
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    match result {
        Ok(()) => {
            // Installing dependencies is the biggest change a footprint ever
            // sees, so a real run invalidates the cached size. A dry run wrote
            // nothing, so re-walking the tree would be pure cost.
            if !dry_run {
                crate::disk::request(&app, vec![wt_key.clone()], true);
            }
            emit_op_with_notification(
                &app,
                &wt_key,
                "create",
                "done",
                if dry_run {
                    "dry run complete — nothing was executed"
                } else {
                    "setup complete"
                },
                !dry_run,
            );
            Ok(())
        }
        Err(e) => {
            emit_op_with_notification(&app, &wt_key, "create", "error", e.clone(), !dry_run);
            Err(CanopyError::setup(e))
        }
    }
}

pub async fn worktree_dirty_report(
    app: RuntimeContext,
    wt_key: String,
) -> Result<git::DirtyReport, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    git::dirty_report(&wt_key).await.map_err(CanopyError::git)
}

/// Full working-tree status for the Uncommitted changes modal (every entry, not
/// the capped dirty_report).
pub async fn worktree_status(
    app: RuntimeContext,
    wt_key: String,
) -> Result<Vec<git::StatusEntry>, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    git::status(&wt_key).await.map_err(CanopyError::git)
}

pub async fn worktree_commit(
    app: RuntimeContext,
    wt_key: String,
    message: String,
    add_untracked: bool,
) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    git::commit(&wt_key, &message, add_untracked)
        .await
        .map_err(CanopyError::git)?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(())
}

pub async fn worktree_stash(
    app: RuntimeContext,
    wt_key: String,
    name: Option<String>,
    include_untracked: bool,
) -> Result<String, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    let summary = git::stash(&wt_key, name.as_deref(), include_untracked)
        .await
        .map_err(CanopyError::git)?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(summary)
}

pub async fn worktree_discard(
    app: RuntimeContext,
    wt_key: String,
    clean_untracked: bool,
) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    git::discard(&wt_key, clean_untracked)
        .await
        .map_err(CanopyError::git)?;
    refresh_git_meta(&app, &wt_key).await;
    Ok(())
}

/// Remove one worktree — everything except the final tree refresh, so a batch
/// can remove many and refresh once. Guards the main checkout, stops services,
/// closes terminals, drops the db (best-effort), then removes the git worktree.
async fn remove_worktree_inner(
    app: &RuntimeContext,
    wt_key: &str,
    delete_branch: bool,
    drop_db: bool,
) -> Result<(), CanopyError> {
    let ctx = app
        .state::<AppState>()
        .wt_context(wt_key)
        .ok_or_else(|| CanopyError::not_found("unknown worktree"))?;
    let (repo_path, repo_id, branch, is_main) =
        (ctx.repo_path, ctx.repo_id, ctx.branch, ctx.is_main);
    if is_main {
        return Err(CanopyError::invalid_input(
            "Refusing to remove the main checkout",
        ));
    }
    let _lease = crate::state::try_lease(app, wt_key, "remove")?;

    // stop its services first
    for key in services::worktree_svc_keys(app, wt_key) {
        let _ = services::stop_service(app, &key).await;
    }
    // and close its embedded terminals, so no shell/agent lingers with no UI
    terminal::close_worktree(app, app.state::<TermTable>(), wt_key);

    // run teardown (e.g. drop the worktree's database) while the worktree still
    // exists. Best-effort: a teardown failure shouldn't block removal.
    if drop_db && crate::setup::has_teardown(wt_key, &repo_path) {
        emit_op(
            app,
            wt_key,
            "remove",
            "progress",
            "running teardown (dropping database)…",
        );
        let vars = crate::state::worktree_vars(app, &repo_id, wt_key, false);
        let app_t = app.clone();
        let wt_t = wt_key.to_string();
        if let Err(e) = crate::setup::run_teardown(wt_key, &repo_path, &vars, move |p| {
            emit_progress(&app_t, &wt_t, "remove", p)
        })
        .await
        {
            emit_op(
                app,
                wt_key,
                "remove",
                "progress",
                format!("teardown warning: {e}"),
            );
        }
    }

    emit_op(app, wt_key, "remove", "progress", "removing worktree…");
    match git::remove_worktree(&repo_path, wt_key, Some(&branch), delete_branch).await {
        Ok(()) => {
            // reclaim the port index + overrides + statuses + log buffers —
            // without this, months of worktree churn leak indices and derived
            // ports creep permanently upward
            crate::state::release_worktree_runtime(app, &repo_id, wt_key);
            emit_op(app, wt_key, "remove", "done", "worktree removed");
            Ok(())
        }
        Err(e) => {
            emit_op(app, wt_key, "remove", "error", e.clone());
            Err(CanopyError::git(e))
        }
    }
}

pub async fn remove_worktree(
    app: RuntimeContext,
    wt_key: String,
    delete_branch: bool,
    drop_db: bool,
) -> Result<(), CanopyError> {
    remove_worktree_inner(&app, &wt_key, delete_branch, drop_db).await?;
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    Ok(())
}

/// Remove several worktrees in one action, refreshing the tree once at the end.
/// Best-effort per item: a failure on one is collected and reported but does not
/// stop the rest (each is independent).
pub async fn remove_worktrees(
    app: RuntimeContext,
    wt_keys: Vec<String>,
    delete_branch: bool,
    drop_db: bool,
) -> Result<(), CanopyError> {
    let mut failures: Vec<String> = Vec::new();
    for wt_key in &wt_keys {
        if let Err(e) = remove_worktree_inner(&app, wt_key, delete_branch, drop_db).await {
            let name = std::path::Path::new(wt_key)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| wt_key.clone());
            failures.push(format!("{name}: {}", e.message));
        }
    }
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    if failures.is_empty() {
        Ok(())
    } else {
        Err(CanopyError::internal(format!(
            "{} of {} could not be removed — {}",
            failures.len(),
            wt_keys.len(),
            failures.join("; ")
        )))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrunableWorktree {
    pub repo_id: String,
    pub repo_name: String,
    pub path: String,
    pub branch: String,
}

/// Worktrees whose folder was deleted outside Canopy (git marks them prunable),
/// across every registered repo. Drives the Sync-prune prompt.
pub async fn list_prunable_worktrees(
    app: RuntimeContext,
) -> Result<Vec<PrunableWorktree>, CanopyError> {
    let repos: Vec<(String, String, String)> = {
        let state = app.state::<AppState>();
        let tree = state.tree.read();
        tree.iter()
            .map(|r| (r.repo_id.clone(), r.name.clone(), r.path.clone()))
            .collect()
    };
    let mut out = Vec::new();
    for (repo_id, repo_name, repo_path) in repos {
        if let Ok(list) = git::list_prunable(&repo_path).await {
            for w in list {
                out.push(PrunableWorktree {
                    repo_id: repo_id.clone(),
                    repo_name: repo_name.clone(),
                    path: w.path,
                    branch: w.branch,
                });
            }
        }
    }
    Ok(out)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneItem {
    pub repo_id: String,
    pub branch: String,
    pub delete_branch: bool,
    pub drop_db: bool,
    /// the vanished worktree's database name, recovered by the frontend from its
    /// pre-Sync snapshot (the folder's .env is gone)
    pub db_name: Option<String>,
}

/// Reconcile worktrees whose folders were deleted externally: optionally delete
/// each one's branch and drop its database, then `git worktree prune` each
/// affected repo (repo-wide by git's design) and refresh once.
pub async fn prune_worktrees(
    app: RuntimeContext,
    items: Vec<PruneItem>,
) -> Result<(), CanopyError> {
    let repo_paths: std::collections::HashMap<String, String> = {
        let state = app.state::<AppState>();
        let tree = state.tree.read();
        tree.iter()
            .map(|r| (r.repo_id.clone(), r.path.clone()))
            .collect()
    };
    let mut failures: Vec<String> = Vec::new();
    // Prune the stale git registrations FIRST: git refuses `branch -D` for a
    // branch it still believes is checked out in a (now-missing) worktree.
    let affected: std::collections::HashSet<&String> = items
        .iter()
        .filter_map(|i| repo_paths.get(&i.repo_id))
        .collect();
    for repo_path in &affected {
        let _ = git::prune_worktrees(repo_path).await;
    }
    // Now the branches are free to delete and the databases free to drop.
    for item in &items {
        let Some(repo_path) = repo_paths.get(&item.repo_id) else {
            failures.push(format!("{}: unknown repository", item.branch));
            continue;
        };
        if item.delete_branch && !item.branch.is_empty() && item.branch != "(detached)" {
            if let Err(e) = git::delete_local_branch(repo_path, &item.branch).await {
                failures.push(format!("branch {}: {e}", item.branch));
            }
        }
        if item.drop_db {
            if let Some(db) = item.db_name.as_deref().filter(|s| !s.is_empty()) {
                if let Err(e) = crate::db::drop_database_named(repo_path, db).await {
                    failures.push(format!("database {db}: {e}"));
                }
            }
        }
    }
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    if failures.is_empty() {
        Ok(())
    } else {
        Err(CanopyError::internal(format!(
            "pruned with {} issue(s): {}",
            failures.len(),
            failures.join("; ")
        )))
    }
}

fn is_running(app: &RuntimeContext, key: &str) -> bool {
    let table = app.state::<services::ProcTable>();
    let procs = table.procs.lock();
    procs.contains_key(key)
}

// ── database: list / snapshot / export / switch ──

/// repo path + repo_id for a worktree key.
fn repo_for_wt(app: &RuntimeContext, wt_key: &str) -> Result<(String, String), CanopyError> {
    app.state::<AppState>()
        .wt_context(wt_key)
        .map(|c| (c.repo_path, c.repo_id))
        .ok_or_else(|| CanopyError::not_found("unknown worktree"))
}

pub async fn list_databases(
    app: RuntimeContext,
    wt_key: String,
) -> Result<Vec<String>, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    crate::db::list_databases(&wt_key)
        .await
        .map_err(CanopyError::db)
}

pub fn current_database(
    app: RuntimeContext,
    wt_key: String,
) -> Result<Option<String>, CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    Ok(crate::db::current_db(&wt_key))
}

pub async fn snapshot_database(
    app: RuntimeContext,
    wt_key: String,
    name: String,
) -> Result<(), CanopyError> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(CanopyError::invalid_input("Snapshot name is required"));
    }
    ensure_known_worktree(&app, &wt_key)?;
    let _lease = crate::state::try_lease(&app, &wt_key, "snapshot")?;
    let app2 = app.clone();
    let wt2 = wt_key.clone();
    crate::db::clone_database(&wt_key, &name, move |line| {
        emit_op(&app2, &wt2, "snapshot", "progress", line)
    })
    .await
    .map_err(CanopyError::db)?;
    emit_op(
        &app,
        &wt_key,
        "snapshot",
        "done",
        format!("snapshot '{name}' created"),
    );
    Ok(())
}

pub async fn export_database(
    app: RuntimeContext,
    wt_key: String,
    file_path: String,
) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    let _lease = crate::state::try_lease(&app, &wt_key, "export")?;
    let app2 = app.clone();
    let wt2 = wt_key.clone();
    crate::db::export_database(&wt_key, &file_path, move |line| {
        emit_op(&app2, &wt2, "snapshot", "progress", line)
    })
    .await
    .map_err(CanopyError::db)?;
    emit_op(&app, &wt_key, "snapshot", "done", "exported to file");
    Ok(())
}

pub async fn restore_database(
    app: RuntimeContext,
    wt_key: String,
    file_path: String,
    options: Option<crate::db::RestoreOptions>,
) -> Result<(), CanopyError> {
    ensure_known_worktree(&app, &wt_key)?;
    let _lease = crate::state::try_lease(&app, &wt_key, "restore")?;
    // quiesce: a live connection pool holds locks against --clean drops and
    // can observe (or block) a half-restored schema. Stop the worktree's
    // running services, restore, then bring the same ones back.
    let mut was_running: Vec<String> = Vec::new();
    let mut stop_error = None;
    for key in services::worktree_svc_keys(&app, &wt_key) {
        if is_running(&app, &key) {
            was_running.push(key.clone());
            if let Err(error) = services::stop_service(&app, &key).await {
                stop_error = Some(format!("cannot stop {key} before restore: {error}"));
                break;
            }
        }
    }
    let app2 = app.clone();
    let wt2 = wt_key.clone();
    let mut restore = if let Some(error) = stop_error {
        Err(error)
    } else {
        crate::db::restore_database(&wt_key, &file_path, options.as_ref(), move |line| {
            emit_op(&app2, &wt2, "snapshot", "progress", line)
        })
        .await
    };

    if restore.is_ok() {
        if let Some(options) = options.as_ref().filter(|o| o.activate) {
            let activate = async {
                let (repo_path, _) = repo_for_wt(&app, &wt_key).map_err(|e| e.to_string())?;
                crate::setup::activate_restored_database(&wt_key, &repo_path, &options.target)?;
                refresh_tree(&app).await
            }
            .await;
            if let Err(error) = activate {
                restore = Err(format!(
                    "database restored, but switching this worktree failed: {error}"
                ));
            }
        }
    }

    // restart what we stopped, whether or not the restore succeeded — the
    // worktree shouldn't be left dead because a dump file was bad
    let mut restart_errors: Vec<String> = Vec::new();
    for key in &was_running {
        if let Err(e) = services::restart_service(&app, key).await {
            restart_errors.push(format!("{key}: {e}"));
        }
    }

    restore.map_err(CanopyError::db)?;
    if restart_errors.is_empty() {
        emit_op(&app, &wt_key, "snapshot", "done", "restore complete");
        Ok(())
    } else {
        Err(CanopyError::process(format!(
            "restore complete, but restart failed — {}",
            restart_errors.join("; ")
        )))
    }
}

pub async fn switch_database(
    app: RuntimeContext,
    wt_key: String,
    db_name: String,
) -> Result<(), CanopyError> {
    let (repo_path, _repo_id) = repo_for_wt(&app, &wt_key)?;
    let _lease = crate::state::try_lease(&app, &wt_key, "switch database")?;
    // repoint PG_DB in the worktree's root .env AND in any provisioned dotenv
    // file (e.g. server/.env) that declares it
    let pairs = [("PG_DB".to_string(), db_name.clone())];
    crate::setup::set_env_keys(&wt_key, &repo_path, &pairs).map_err(CanopyError::setup)?;
    crate::setup::set_env_keys_in_provisioned(&wt_key, &repo_path, &pairs)
        .map_err(CanopyError::setup)?;
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    // auto-restart the server so it connects to the new DB
    let mut errors: Vec<String> = Vec::new();
    for key in services::worktree_svc_keys(&app, &wt_key) {
        if is_running(&app, &key) {
            if let Err(e) = services::restart_service(&app, &key).await {
                errors.push(format!("{key}: {e}"));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(CanopyError::process(format!(
            "database switched, but restart failed — {}",
            errors.join("; ")
        )))
    }
}

/// Override a service's port. Validates range + cross-worktree conflict, updates
/// the override, re-derives env (so dependent keys follow), and auto-restarts
/// the worktree's running services so the change takes effect.
pub async fn set_service_port(
    app: RuntimeContext,
    svc_key: String,
    port: u32,
) -> Result<(), CanopyError> {
    if !(1024..=65535).contains(&port) {
        return Err(CanopyError::invalid_input(
            "Port must be between 1024 and 65535",
        ));
    }
    // check cross-worktree conflicts: another service already on this port
    {
        let state = app.state::<AppState>();
        let tree = state.tree.read();
        for r in tree.iter() {
            for w in r.worktrees.iter() {
                for s in w.services.iter() {
                    if s.svc_key != svc_key && s.port == Some(port) {
                        return Err(CanopyError::conflict(format!(
                            "Port {port} is already used by {} ({})",
                            s.name, w.branch
                        )));
                    }
                }
            }
        }
    }
    let (wt_key, repo_id, repo_path) = app
        .state::<AppState>()
        .service_context(&svc_key)
        .ok_or_else(|| CanopyError::not_found("unknown service"))?;

    // record the override + persist
    {
        let state = app.state::<AppState>();
        state
            .runtime
            .write()
            .port_overrides
            .insert(svc_key.clone(), port);
        let rt = state.runtime.read().clone();
        let _ = settings::save_runtime(&app, &rt);
    }

    // re-derive .env (TOOLJET_SERVER_PORT etc.) from the declarative env block
    let vars = crate::state::worktree_vars(&app, &repo_id, &wt_key, false);
    let _ = crate::setup::reapply_provision(&wt_key, &repo_path, &vars);
    refresh_tree(&app).await.map_err(CanopyError::internal)?;

    // auto-restart running services of this worktree to apply the new port(s)
    let mut errors: Vec<String> = Vec::new();
    for key in services::worktree_svc_keys(&app, &wt_key) {
        if is_running(&app, &key) {
            if let Err(e) = services::restart_service(&app, &key).await {
                errors.push(format!("{key}: {e}"));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(CanopyError::process(format!(
            "port set, but restart failed — {}",
            errors.join("; ")
        )))
    }
}

pub(crate) fn repo_path(app: &RuntimeContext, repo_id: &str) -> Result<String, CanopyError> {
    app.state::<AppState>()
        .repo_path_by_id(repo_id)
        .ok_or_else(|| CanopyError::not_found("unknown repo"))
}

pub async fn list_branches(
    app: RuntimeContext,
    repo_id: String,
) -> Result<git::Branches, CanopyError> {
    let path = repo_path(&app, &repo_id)?;
    git::list_branches(&path).await.map_err(CanopyError::git)
}

/// One provisioned-file entry as exchanged with the Settings UI.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionEntry {
    pub path: String,
    /// dotenv | json | yaml | text
    pub format: String,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub interpolate: bool,
    /// ordered (key, value-template) pairs
    #[serde(default)]
    pub keys: Vec<(String, String)>,
}

/// One setup task as exchanged with the Settings UI.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupTaskEntry {
    pub cmd: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetupPolicyEntry {
    #[serde(default)]
    pub continue_on_failure: bool,
    #[serde(default)]
    pub timeout_secs: u64,
}

impl From<crate::setup::SetupTask> for SetupTaskEntry {
    fn from(t: crate::setup::SetupTask) -> Self {
        SetupTaskEntry {
            cmd: t.cmd,
            cwd: t.cwd,
            enabled: t.enabled,
        }
    }
}

impl From<SetupTaskEntry> for crate::setup::SetupTask {
    fn from(e: SetupTaskEntry) -> Self {
        crate::setup::SetupTask {
            cmd: e.cmd,
            cwd: e.cwd,
            enabled: e.enabled,
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoConfig {
    /// files provisioned into each new worktree (the root `.env` is one entry)
    pub provision: Vec<ProvisionEntry>,
    pub setup: Vec<SetupTaskEntry>,
    #[serde(default)]
    pub setup_policy: SetupPolicyEntry,
    /// read-only in the Settings UI today — surfaced so the preview/export
    /// match what's actually on disk
    #[serde(default)]
    pub teardown: Vec<String>,
    #[serde(default)]
    pub migrate: Vec<String>,
}

impl From<crate::setup::ProvisionFile> for ProvisionEntry {
    fn from(p: crate::setup::ProvisionFile) -> Self {
        ProvisionEntry {
            path: p.path,
            format: p.format,
            from: p.from,
            interpolate: p.interpolate,
            keys: p.keys,
        }
    }
}

impl From<ProvisionEntry> for crate::setup::ProvisionFile {
    fn from(e: ProvisionEntry) -> Self {
        crate::setup::ProvisionFile {
            path: e.path,
            format: e.format,
            from: e.from,
            interpolate: e.interpolate,
            keys: e.keys,
        }
    }
}

/// Read the repo's `.worktreemanager.json` (provisioned files + setup) for the editor.
pub fn get_repo_config(app: RuntimeContext, repo_id: String) -> Result<RepoConfig, CanopyError> {
    let path = repo_path(&app, &repo_id)?;
    let c = crate::setup::read_repo_config(&path);
    Ok(RepoConfig {
        provision: c.provision.into_iter().map(Into::into).collect(),
        setup: c.setup.into_iter().map(Into::into).collect(),
        setup_policy: SetupPolicyEntry {
            continue_on_failure: c.setup_policy.continue_on_failure,
            timeout_secs: c.setup_policy.timeout_secs,
        },
        teardown: c.teardown,
        migrate: c.migrate,
    })
}

/// Write text to a path, creating parent directories as needed. Used by the
/// Settings config Export and by the agent lane (writing `.canopy/context.md`,
/// whose parent dir may not exist yet).
pub fn save_text_file(path: String, contents: String) -> Result<(), CanopyError> {
    if let Some(dir) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| CanopyError::config(format!("mkdir {}: {e}", dir.display())))?;
    }
    std::fs::write(&path, contents).map_err(|e| CanopyError::config(format!("write {path}: {e}")))
}

/// Write provisioned files + setup commands to the repo's `.worktreemanager.json`.
pub fn save_repo_config(
    app: RuntimeContext,
    repo_id: String,
    provision: Vec<ProvisionEntry>,
    setup: Vec<SetupTaskEntry>,
    setup_policy: Option<SetupPolicyEntry>,
    teardown: Option<Vec<String>>,
    migrate: Option<Vec<String>>,
) -> Result<(), CanopyError> {
    let path = repo_path(&app, &repo_id)?;
    let files: Vec<crate::setup::ProvisionFile> = provision.into_iter().map(Into::into).collect();
    let tasks: Vec<crate::setup::SetupTask> = setup.into_iter().map(Into::into).collect();
    let policy = setup_policy.map(|p| crate::setup::SetupPolicy {
        continue_on_failure: p.continue_on_failure,
        timeout_secs: p.timeout_secs,
    });
    crate::setup::write_repo_config_sections(
        &path,
        &files,
        &tasks,
        policy.as_ref(),
        teardown.as_deref(),
        migrate.as_deref(),
    )
    .map_err(CanopyError::config)
}

// ── disk usage ──

/// Every measurement Canopy currently holds, keyed by `wt_key`. Returns
/// instantly from cache — a window that opens the overview gets whatever
/// earlier scans found rather than waiting on a fresh walk.
pub fn get_disk_usage(
    app: RuntimeContext,
) -> std::collections::HashMap<String, crate::disk::DiskUsage> {
    crate::disk::snapshot(&app)
}

/// Queue worktrees for measurement and return immediately; results arrive as
/// `worktree:disk` events. Unknown keys are dropped rather than walked — this
/// is the one command that takes a caller-supplied path list, so it applies the
/// same containment rule as every other `wt_key` entry point.
pub fn scan_disk_usage(
    app: RuntimeContext,
    wt_keys: Vec<String>,
    force: bool,
) -> Result<(), CanopyError> {
    let known: Vec<String> = {
        let state = app.state::<AppState>();
        let tree = state.tree.read();
        wt_keys
            .into_iter()
            .filter(|k| {
                tree.iter()
                    .flat_map(|r| r.worktrees.iter())
                    .any(|w| &w.wt_key == k)
            })
            .collect()
    };
    crate::disk::request(&app, known, force);
    Ok(())
}

// ── diagnostics / caches / reset (Settings → Advanced) ──

/// An environment summary for a bug report, plus the same thing as markdown so
/// the UI can put one string on the clipboard.
pub fn gather_diagnostics(app: RuntimeContext) -> (crate::diagnostics::Diagnostics, String) {
    let d = crate::diagnostics::gather(&app);
    let md = crate::diagnostics::as_markdown(&d);
    (d, md)
}

/// The experiments this build ships, so Settings renders the ones that exist
/// rather than a hardcoded list that drifts from what the app honours.
pub fn list_experiments() -> Vec<crate::diagnostics::Experiment> {
    crate::diagnostics::EXPERIMENTS.to_vec()
}

/// Delete Canopy's own regenerable files (rotated service logs). Never touches
/// a worktree, a database, a repository or a settings file.
pub fn clear_caches(app: RuntimeContext) -> crate::diagnostics::ClearedCaches {
    crate::diagnostics::clear_caches(&app)
}

/// Restore default settings, keeping registered repositories. The confirmation
/// lives in the UI; this command is the irreversible half and does exactly
/// what its name says.
pub async fn reset_settings(app: RuntimeContext) -> Result<Settings, CanopyError> {
    crate::diagnostics::reset_settings(&app).map_err(CanopyError::config)?;
    refresh_tree(&app).await.map_err(CanopyError::internal)?;
    Ok(app.state::<AppState>().settings.read().clone())
}

/// Check GitHub for a newer release now, regardless of the auto-check
/// preference — pressing the button IS the consent.
pub async fn check_for_update(
    app: RuntimeContext,
) -> Result<crate::updates::UpdateStatus, CanopyError> {
    Ok(crate::updates::check_now(&app).await)
}

/// How many crash reports are on disk, so the UI offers the folder only when
/// there is something in it.
pub fn crash_report_count(app: RuntimeContext) -> usize {
    crate::updates::crash_report_count(&app)
}

/// `git fetch --all --prune` then return the refreshed branch lists.
pub async fn fetch_branches(
    app: RuntimeContext,
    repo_id: String,
) -> Result<git::Branches, CanopyError> {
    let path = repo_path(&app, &repo_id)?;
    git::fetch_all(&path).await.map_err(CanopyError::git)?;
    git::list_branches(&path).await.map_err(CanopyError::git)
}

#[cfg(test)]
mod tests {
    use super::{derive_worktree_path, detect_repo, sanitize_branch};

    #[test]
    fn worktree_paths_resolve_against_repository() {
        let base = std::env::temp_dir().join("canopy-repo");
        let mut repo = crate::settings::RepoCfg {
            path: base.to_string_lossy().into_owned(),
            ..Default::default()
        };
        assert_eq!(
            std::path::PathBuf::from(derive_worktree_path(&repo, "feature/test")),
            base.join(".worktrees/feature_test")
        );
        repo.worktree_dir = "custom".into();
        assert_eq!(
            std::path::PathBuf::from(derive_worktree_path(&repo, "test")),
            base.join("custom/test")
        );
        let absolute = std::env::temp_dir().join("elsewhere");
        repo.worktree_dir = absolute.to_string_lossy().into_owned();
        assert_eq!(
            std::path::PathBuf::from(derive_worktree_path(&repo, "test")),
            absolute.join("test")
        );
    }
    use crate::git::run_git;

    #[test]
    fn sanitize_branch_maps_separators() {
        assert_eq!(sanitize_branch("feature/foo-bar"), "feature_foo-bar");
        assert_eq!(sanitize_branch("v1.2.3"), "v1.2.3");
        assert_eq!(sanitize_branch("fix db reset"), "fix_db_reset");
    }

    fn tmp(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("canopy-cmd-{tag}-{}", std::process::id()))
    }

    async fn init(dir: &std::path::Path) {
        std::fs::create_dir_all(dir).unwrap();
        let d = dir.to_str().unwrap();
        run_git(d, &["init"]).await.unwrap();
        run_git(d, &["config", "user.email", "t@localhost"])
            .await
            .unwrap();
        run_git(d, &["config", "user.name", "t"]).await.unwrap();
        run_git(d, &["config", "commit.gpgsign", "false"])
            .await
            .unwrap();
    }

    /// The add-repo-from-sidebar flow (#122) shows detect_repo's result — name,
    /// stack, package.json scripts, and a normalized origin — before adding.
    #[tokio::test]
    async fn detect_repo_reads_name_stack_scripts_and_normalizes_origin() {
        let dir = tmp("detect");
        let _ = std::fs::remove_dir_all(&dir);
        init(&dir).await;
        let d = dir.to_str().unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"dev":"vite","build":"tsc"}}"#,
        )
        .unwrap();
        run_git(d, &["add", "."]).await.unwrap();
        run_git(d, &["commit", "-m", "init"]).await.unwrap();
        // an ssh remote to exercise the origin normalization
        run_git(
            d,
            &["remote", "add", "origin", "git@github.com:acme/widgets.git"],
        )
        .await
        .unwrap();

        let det = detect_repo(d.to_string()).await.unwrap();
        assert_eq!(det.name, dir.file_name().unwrap().to_string_lossy());
        assert_eq!(det.stack, "node");
        assert_eq!(
            det.origin, "github.com/acme/widgets",
            "git@…:…git → github.com/…"
        );
        let names: Vec<&str> = det.scripts.iter().map(|s| s.name.as_str()).collect();
        assert!(
            names.contains(&"dev") && names.contains(&"build"),
            "scripts parsed: {names:?}"
        );
        assert!(!det.branch.is_empty(), "branch resolved: {:?}", det.branch);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Cargo.toml wins the stack sniff over package.json, and a non-repo path
    /// is rejected (the same guard validate_repo enforces).
    #[tokio::test]
    async fn detect_repo_prefers_rust_and_rejects_non_repos() {
        let dir = tmp("detect-rs");
        let _ = std::fs::remove_dir_all(&dir);
        init(&dir).await;
        std::fs::write(dir.join("Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        let det = detect_repo(dir.to_str().unwrap().to_string())
            .await
            .unwrap();
        assert_eq!(
            det.stack, "rust",
            "Cargo.toml is checked before package.json"
        );

        let plain = tmp("detect-plain");
        let _ = std::fs::remove_dir_all(&plain);
        std::fs::create_dir_all(&plain).unwrap();
        assert!(
            detect_repo(plain.to_str().unwrap().to_string())
                .await
                .is_err(),
            "a non-repo must error"
        );

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&plain);
    }
}
