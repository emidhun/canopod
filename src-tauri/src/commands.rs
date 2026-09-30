// Thin Tauri adapters. All domain execution lives in operations.rs.
use crate::error::CanopyError;
use crate::operations::*;
use crate::runtime::RuntimeContext;
use crate::services::{self, LogLine, ProcTable};
use crate::settings::{RepoCfg, Settings};
use crate::state::{AppState, RepoNode};
use crate::terminal::TermTable;
use crate::{git, terminal};
use tauri::{AppHandle, Manager};

fn runtime(app: &AppHandle) -> RuntimeContext {
    app.state::<RuntimeContext>().inner().clone()
}

#[tauri::command]
pub async fn get_tree(app: AppHandle) -> Result<Vec<RepoNode>, CanopyError> {
    let context = runtime(&app);
    crate::operations::get_tree(context).await
}

#[tauri::command]
pub async fn refresh(app: AppHandle, wt_key: Option<String>) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::refresh(context, wt_key).await
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    let context = runtime(&app);
    crate::operations::get_settings(context.state::<AppState>())
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, new_settings: Settings) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::save_settings(context, new_settings).await
}

#[tauri::command]
pub async fn add_repo(app: AppHandle, path: String) -> Result<RepoCfg, CanopyError> {
    let context = runtime(&app);
    crate::operations::add_repo(context, path).await
}

#[tauri::command]
pub async fn detect_repo(path: String) -> Result<RepoDetection, CanopyError> {
    crate::operations::detect_repo(path).await
}

#[tauri::command]
pub async fn remove_repo(app: AppHandle, repo_id: String) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::remove_repo(context, repo_id).await
}

#[tauri::command]
pub async fn git_pull(app: AppHandle, wt_key: String) -> Result<String, CanopyError> {
    let context = runtime(&app);
    crate::operations::git_pull(context, wt_key).await
}

#[tauri::command]
pub async fn submodule_status(
    app: AppHandle,
    wt_key: String,
) -> Result<Vec<git::SubmoduleStatus>, CanopyError> {
    let context = runtime(&app);
    crate::operations::submodule_status(context, wt_key).await
}

#[tauri::command]
pub async fn pull_submodule(
    app: AppHandle,
    wt_key: String,
    path: String,
) -> Result<String, CanopyError> {
    let context = runtime(&app);
    crate::operations::pull_submodule(context, wt_key, path).await
}

#[tauri::command]
pub async fn switch_submodule_branch(
    app: AppHandle,
    wt_key: String,
    path: String,
    branch: String,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::switch_submodule_branch(context, wt_key, path, branch).await
}

#[tauri::command]
pub async fn list_submodule_branches(
    app: AppHandle,
    wt_key: String,
    path: String,
) -> Result<git::Branches, CanopyError> {
    let context = runtime(&app);
    crate::operations::list_submodule_branches(context, wt_key, path).await
}

#[tauri::command]
pub async fn fetch_submodules(app: AppHandle, wt_key: String) -> Result<usize, CanopyError> {
    let context = runtime(&app);
    crate::operations::fetch_submodules(context, wt_key).await
}

#[tauri::command]
pub async fn sync_submodules(app: AppHandle, wt_key: String) -> Result<String, CanopyError> {
    let context = runtime(&app);
    crate::operations::sync_submodules(context, wt_key).await
}

#[tauri::command]
pub async fn switch_worktree_branch(
    app: AppHandle,
    wt_key: String,
    branch: String,
    create: bool,
    base: Option<String>,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::switch_worktree_branch(context, wt_key, branch, create, base).await
}

#[tauri::command]
pub fn get_logs(app: AppHandle, svc_key: String) -> Vec<LogLine> {
    let context = runtime(&app);
    crate::operations::get_logs(context.state::<ProcTable>(), svc_key)
}

// Keep PTY adapters async: writes and scrollback reads must not block the UI thread.
#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::terminal_open(
        context.clone(),
        context.state::<TermTable>(),
        id,
        cwd,
        cols,
        rows,
        command,
    )
    .await
}

#[tauri::command]
pub async fn terminal_store_image(
    app: AppHandle,
    id: String,
    data: Vec<u8>,
) -> Result<String, CanopyError> {
    crate::operations::terminal_store_image(runtime(&app), id, data).await
}

#[tauri::command]
pub async fn terminal_write(app: AppHandle, id: String, data: String) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::terminal_write(context.clone(), context.state::<TermTable>(), id, data).await
}

#[tauri::command]
pub async fn terminal_resize(
    app: AppHandle,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::terminal_resize(context.state::<TermTable>(), id, cols, rows).await
}

#[tauri::command]
pub async fn terminal_get_buffer(
    app: AppHandle,
    id: String,
) -> Result<Option<terminal::BufferSnapshot>, CanopyError> {
    let context = runtime(&app);
    crate::operations::terminal_get_buffer(context.state::<TermTable>(), id).await
}

#[tauri::command]
pub async fn terminal_close(app: AppHandle, id: String) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::terminal_close(context.clone(), context.state::<TermTable>(), id).await
}

#[tauri::command]
pub fn write_worktree_context(
    app: AppHandle,
    wt_path: String,
    contents: String,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::write_worktree_context(context, wt_path, contents)
}

#[tauri::command]
pub fn resolve_agent_command(app: AppHandle, wt_key: String) -> String {
    let context = runtime(&app);
    crate::operations::resolve_agent_command(context.state::<AppState>(), wt_key)
}

#[tauri::command]
pub fn service_env(
    app: AppHandle,
    svc_key: String,
) -> Result<Vec<services::EnvEntry>, CanopyError> {
    let context = runtime(&app);
    crate::operations::service_env(context, svc_key)
}

#[tauri::command]
pub async fn service_start(app: AppHandle, svc_key: String) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::service_start(context, svc_key).await
}

#[tauri::command]
pub async fn service_stop(app: AppHandle, svc_key: String) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::service_stop(context, svc_key).await
}

#[tauri::command]
pub async fn service_restart(app: AppHandle, svc_key: String) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::service_restart(context, svc_key).await
}

#[tauri::command]
pub async fn worktree_start_all(app: AppHandle, wt_key: String) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::worktree_start_all(context, wt_key).await
}

#[tauri::command]
pub async fn worktree_stop_all(app: AppHandle, wt_key: String) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::worktree_stop_all(context, wt_key).await
}

#[tauri::command]
pub async fn reset_db(app: AppHandle, wt_key: String) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::reset_db(context, wt_key).await
}

#[tauri::command]
pub async fn run_migration(app: AppHandle, wt_key: String) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::run_migration(context, wt_key).await
}

#[tauri::command]
pub async fn run_custom_command(
    app: AppHandle,
    wt_key: String,
    command: String,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::run_custom_command(context, wt_key, command).await
}

#[tauri::command]
pub async fn open_in_editor(app: AppHandle, wt_key: String) -> Result<(), CanopyError> {
    let context = runtime(&app);
    let editor = {
        let state = context.state::<AppState>();
        let s = state.settings.read();
        s.editor.command.clone()
    };
    let editor = if editor.trim().is_empty() {
        "code".to_string()
    } else {
        editor
    };
    let (shell, shargs) =
        crate::toolchain::shell_argv(&format!("{editor} {}", crate::toolchain::sh_quote(&wt_key)));
    tokio::process::Command::new(shell)
        .args(&shargs)
        .spawn()
        .map_err(|e| CanopyError::process(e.to_string()))?;
    Ok(())
}

/// Open a file only after canonicalizing both paths and checking containment.
/// This rejects traversal and symlinks outside the selected worktree before
/// passing the shell-quoted path to the configured editor.
#[tauri::command]
pub async fn open_file_in_editor(
    app: AppHandle,
    wt_key: String,
    path: String,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    let root = std::fs::canonicalize(&wt_key)
        .map_err(|e| CanopyError::invalid_input(format!("worktree path: {e}")))?;
    let requested = std::path::PathBuf::from(&path);
    let candidate = if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    };
    let file = std::fs::canonicalize(&candidate)
        .map_err(|e| CanopyError::invalid_input(format!("file path: {e}")))?;
    if !file.starts_with(&root) {
        return Err(CanopyError::invalid_input(
            "File must be inside the selected worktree",
        ));
    }
    let editor = {
        let state = context.state::<AppState>();
        let s = state.settings.read();
        s.editor.command.clone()
    };
    let editor = if editor.trim().is_empty() {
        "code".to_string()
    } else {
        editor
    };
    let file = crate::toolchain::sh_quote(&file.to_string_lossy());
    let (shell, shargs) = crate::toolchain::shell_argv(&format!("{editor} {file}"));
    tokio::process::Command::new(shell)
        .args(&shargs)
        .spawn()
        .map_err(|e| CanopyError::process(e.to_string()))?;
    Ok(())
}

/// Reveal the selected worktree in the platform file manager.
#[tauri::command]
pub fn reveal_in_finder(wt_key: String) -> Result<(), CanopyError> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.args(["-R", &wt_key]);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer");
        c.arg(&wt_key);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        // no portable "select this file", so open the containing directory
        let dir = std::path::Path::new(&wt_key)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| wt_key.clone());
        let mut c = std::process::Command::new("xdg-open");
        c.arg(dir);
        c
    };
    cmd.spawn()
        .map_err(|e| CanopyError::process(e.to_string()))?;
    Ok(())
}

/// Accept a registered repo ID so a webview cannot open arbitrary directories.
#[tauri::command]
pub fn reveal_repo(app: AppHandle, repo_id: String) -> Result<(), CanopyError> {
    let path = crate::operations::repo_path(&runtime(&app), &repo_id)?;
    reveal_in_finder(path)
}

#[tauri::command]
#[allow(clippy::needless_return)] // cfg-gated per-OS tails; return keeps them uniform
pub fn open_terminal(app: AppHandle, wt_key: String) -> Result<(), CanopyError> {
    let context = runtime(&app);
    let term = {
        let state = context.state::<AppState>();
        let s = state.settings.read();
        s.terminal.clone()
    };

    #[cfg(target_os = "macos")]
    {
        let term = if term.trim().is_empty() {
            "Terminal".to_string()
        } else {
            term
        };
        std::process::Command::new("open")
            .args(["-a", &term, &wt_key])
            .spawn()
            .map_err(|e| CanopyError::process(e.to_string()))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // honor an explicit setting first, then fall back through common emulators.
        // gnome-terminal wants `--working-directory`; most others accept a `cwd`
        // spawn plus a shell, so we set current_dir and let the emulator inherit it.
        let mut candidates: Vec<String> = Vec::new();
        if !term.trim().is_empty() {
            candidates.push(term.trim().to_string());
        }
        candidates.extend(
            [
                "x-terminal-emulator",
                "gnome-terminal",
                "konsole",
                "xfce4-terminal",
                "alacritty",
                "kitty",
                "xterm",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
        for bin in candidates {
            let mut cmd = std::process::Command::new(&bin);
            cmd.current_dir(&wt_key);
            if bin.contains("gnome-terminal") {
                cmd.arg(format!("--working-directory={wt_key}"));
            }
            if cmd.spawn().is_ok() {
                return Ok(());
            }
        }
        return Err(CanopyError::process(
            "No terminal emulator found — set one in Settings",
        ));
    }

    #[cfg(target_os = "windows")]
    {
        let _ = term;
        std::process::Command::new("cmd")
            .args(["/C", "start", "cmd", "/K", "cd", "/D", &wt_key])
            .spawn()
            .map_err(|e| CanopyError::process(e.to_string()))?;
        Ok(())
    }
}

#[tauri::command]
pub fn open_port(app: AppHandle, port: u32) -> Result<(), CanopyError> {
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(format!("http://localhost:{port}"), None::<String>)
        .map_err(|e| CanopyError::process(e.to_string()))
}

#[tauri::command]
pub async fn show_main_window(app: AppHandle) -> Result<(), CanopyError> {
    // macOS: return to the Dock when a real window is on screen
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    if let Some(pop) = app.get_webview_window("popover") {
        let _ = pop.hide();
    }
    // the background refresh pauses while every window is hidden — catch up now
    crate::tray::catch_up_refresh(&app);
    Ok(())
}

#[tauri::command]
pub async fn quit_app(app: AppHandle) -> Result<(), CanopyError> {
    services::stop_all(&runtime(&app)).await;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn set_worktree_pinned(
    app: AppHandle,
    wt_key: String,
    pinned: bool,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::set_worktree_pinned(context, wt_key, pinned).await
}

#[tauri::command]
pub fn preview_worktree(
    app: AppHandle,
    repo_id: String,
    branch: String,
) -> Result<WorktreePreview, CanopyError> {
    let context = runtime(&app);
    crate::operations::preview_worktree(context, repo_id, branch)
}

#[tauri::command]
pub async fn create_worktree(
    app: AppHandle,
    repo_id: String,
    branch: String,
    base: Option<String>,
    create_branch: bool,
) -> Result<String, CanopyError> {
    let context = runtime(&app);
    crate::operations::create_worktree(context, repo_id, branch, base, create_branch).await
}

#[tauri::command]
pub async fn run_worktree_setup(
    app: AppHandle,
    wt_key: String,
    dry_run: bool,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::run_worktree_setup(context, wt_key, dry_run).await
}

#[tauri::command]
pub async fn worktree_dirty_report(
    app: AppHandle,
    wt_key: String,
) -> Result<git::DirtyReport, CanopyError> {
    let context = runtime(&app);
    crate::operations::worktree_dirty_report(context, wt_key).await
}

#[tauri::command]
pub async fn worktree_status(
    app: AppHandle,
    wt_key: String,
) -> Result<Vec<git::StatusEntry>, CanopyError> {
    let context = runtime(&app);
    crate::operations::worktree_status(context, wt_key).await
}

#[tauri::command]
pub async fn worktree_commit(
    app: AppHandle,
    wt_key: String,
    message: String,
    add_untracked: bool,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::worktree_commit(context, wt_key, message, add_untracked).await
}

#[tauri::command]
pub async fn worktree_stash(
    app: AppHandle,
    wt_key: String,
    name: Option<String>,
    include_untracked: bool,
) -> Result<String, CanopyError> {
    let context = runtime(&app);
    crate::operations::worktree_stash(context, wt_key, name, include_untracked).await
}

#[tauri::command]
pub async fn worktree_discard(
    app: AppHandle,
    wt_key: String,
    clean_untracked: bool,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::worktree_discard(context, wt_key, clean_untracked).await
}

#[tauri::command]
pub async fn remove_worktree(
    app: AppHandle,
    wt_key: String,
    delete_branch: bool,
    drop_db: bool,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::remove_worktree(context, wt_key, delete_branch, drop_db).await
}

#[tauri::command]
pub async fn remove_worktrees(
    app: AppHandle,
    wt_keys: Vec<String>,
    delete_branch: bool,
    drop_db: bool,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::remove_worktrees(context, wt_keys, delete_branch, drop_db).await
}

#[tauri::command]
pub async fn list_prunable_worktrees(app: AppHandle) -> Result<Vec<PrunableWorktree>, CanopyError> {
    let context = runtime(&app);
    crate::operations::list_prunable_worktrees(context).await
}

#[tauri::command]
pub async fn prune_worktrees(app: AppHandle, items: Vec<PruneItem>) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::prune_worktrees(context, items).await
}

#[tauri::command]
pub async fn list_databases(app: AppHandle, wt_key: String) -> Result<Vec<String>, CanopyError> {
    let context = runtime(&app);
    crate::operations::list_databases(context, wt_key).await
}

#[tauri::command]
pub fn current_database(app: AppHandle, wt_key: String) -> Result<Option<String>, CanopyError> {
    let context = runtime(&app);
    crate::operations::current_database(context, wt_key)
}

#[tauri::command]
pub async fn snapshot_database(
    app: AppHandle,
    wt_key: String,
    name: String,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::snapshot_database(context, wt_key, name).await
}

#[tauri::command]
pub async fn export_database(
    app: AppHandle,
    wt_key: String,
    file_path: String,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::export_database(context, wt_key, file_path).await
}

#[tauri::command]
pub async fn restore_database(
    app: AppHandle,
    wt_key: String,
    file_path: String,
    options: Option<crate::db::RestoreOptions>,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::restore_database(context, wt_key, file_path, options).await
}

#[tauri::command]
pub async fn switch_database(
    app: AppHandle,
    wt_key: String,
    db_name: String,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::switch_database(context, wt_key, db_name).await
}

#[tauri::command]
pub async fn set_service_port(
    app: AppHandle,
    svc_key: String,
    port: u32,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::set_service_port(context, svc_key, port).await
}

#[tauri::command]
pub async fn list_branches(app: AppHandle, repo_id: String) -> Result<git::Branches, CanopyError> {
    let context = runtime(&app);
    crate::operations::list_branches(context, repo_id).await
}

#[tauri::command]
pub fn get_repo_config(app: AppHandle, repo_id: String) -> Result<RepoConfig, CanopyError> {
    let context = runtime(&app);
    crate::operations::get_repo_config(context, repo_id)
}

#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<(), CanopyError> {
    crate::operations::save_text_file(path, contents)
}

#[tauri::command]
pub fn save_repo_config(
    app: AppHandle,
    repo_id: String,
    provision: Vec<ProvisionEntry>,
    setup: Vec<SetupTaskEntry>,
    setup_policy: Option<SetupPolicyEntry>,
    teardown: Option<Vec<String>>,
    migrate: Option<Vec<String>>,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::save_repo_config(
        context,
        repo_id,
        provision,
        setup,
        setup_policy,
        teardown,
        migrate,
    )
}

// ── disk usage ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_disk_usage(app: AppHandle) -> std::collections::HashMap<String, crate::disk::DiskUsage> {
    let context = runtime(&app);
    crate::operations::get_disk_usage(context)
}

#[tauri::command]
pub fn scan_disk_usage(
    app: AppHandle,
    wt_keys: Vec<String>,
    force: bool,
) -> Result<(), CanopyError> {
    let context = runtime(&app);
    crate::operations::scan_disk_usage(context, wt_keys, force)
}

#[tauri::command]
pub fn gather_diagnostics(app: AppHandle) -> (crate::diagnostics::Diagnostics, String) {
    let context = runtime(&app);
    crate::operations::gather_diagnostics(context)
}

#[tauri::command]
pub fn list_experiments() -> Vec<crate::diagnostics::Experiment> {
    crate::operations::list_experiments()
}

/// Reveal the app log directory for diagnosis without exposing arbitrary paths.
#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), CanopyError> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| CanopyError::not_found(format!("no log directory: {e}")))?;
    std::fs::create_dir_all(&dir).map_err(|e| CanopyError::internal(e.to_string()))?;
    reveal_in_finder(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn clear_caches(app: AppHandle) -> crate::diagnostics::ClearedCaches {
    let context = runtime(&app);
    crate::operations::clear_caches(context)
}

#[tauri::command]
pub async fn reset_settings(app: AppHandle) -> Result<Settings, CanopyError> {
    let context = runtime(&app);
    crate::operations::reset_settings(context).await
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<crate::updates::UpdateStatus, CanopyError> {
    let context = runtime(&app);
    crate::operations::check_for_update(context).await
}

#[tauri::command]
pub fn crash_report_count(app: AppHandle) -> usize {
    let context = runtime(&app);
    crate::operations::crash_report_count(context)
}

/// Reveal the crash-report directory used by this application.
#[tauri::command]
pub fn open_crash_reports(app: AppHandle) -> Result<(), CanopyError> {
    let dir = crate::updates::crash_dir(&runtime(&app))
        .ok_or_else(|| CanopyError::not_found("no log directory"))?;
    reveal_in_finder(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn fetch_branches(app: AppHandle, repo_id: String) -> Result<git::Branches, CanopyError> {
    let context = runtime(&app);
    crate::operations::fetch_branches(context.clone(), repo_id).await
}

// These native controls share the live HTTP controller. Policy remains outside
// whole-object settings saves, and credentials leave Rust only on explicit copy.
fn mcp_controller(app: &AppHandle) -> Result<std::sync::Arc<crate::mcp::Controller>, String> {
    app.try_state::<crate::desktop_api::DesktopApi>()
        .map(|server| server.mcp.clone())
        .ok_or_else(|| "MCP server is unavailable".into())
}

#[tauri::command]
pub fn mcp_status(app: AppHandle) -> Result<serde_json::Value, String> {
    Ok(mcp_controller(&app)?.status())
}

#[tauri::command]
pub async fn mcp_configure(app: AppHandle, enabled: bool, repo_ids: Option<Vec<String>>) -> Result<serde_json::Value, String> {
    let controller = mcp_controller(&app)?;
    controller.configure(enabled, repo_ids).await?;
    Ok(controller.status())
}

#[tauri::command]
pub async fn mcp_rotate_token(app: AppHandle) -> Result<serde_json::Value, String> {
    let controller = mcp_controller(&app)?;
    controller.rotate().await?;
    Ok(controller.status())
}

#[tauri::command]
pub fn mcp_connection(app: AppHandle) -> Result<serde_json::Value, String> {
    mcp_controller(&app)?.connection()
}

#[tauri::command]
pub fn mcp_agent_target(client: String) -> Result<String, String> {
    Ok(crate::agent_config::target(&client)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn mcp_connect_agent(app: AppHandle, client: String) -> Result<String, String> {
    crate::agent_config::connect(client, mcp_controller(&app)?, runtime(&app)).await
}
