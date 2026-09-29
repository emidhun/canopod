// Diagnostics, cache clearing and settings reset (Settings → Advanced).
//
// The three destructive-ish actions here share one rule: each says exactly
// what it will touch, and none of them can take out anything the user cannot
// rebuild. "Clear caches" never deletes a worktree, a database or a settings
// file; "Reset all settings" never deletes a repository from disk.
use serde::Serialize;
use crate::runtime::RuntimeContext;

/// The experiments this build actually has.
///
/// A registry rather than named `Settings` booleans: experiments are meant to
/// appear and disappear, and each one would otherwise be a schema change plus
/// a migration for something that may not survive the month. The map in
/// `Settings.experiments` is keyed by these ids; a key with no entry here is
/// simply an experiment this build no longer ships, and is ignored.
///
/// Nothing is listed here that the app does not honour. A toggle that persists
/// a flag nothing reads is the "coming soon" state with extra steps.
pub const EXPERIMENTS: &[Experiment] = &[Experiment {
    id: "parallel-setup",
    label: "Parallel setup tasks",
    hint: "Run the repo's setup tasks at the same time instead of one after another. Only safe when they don't depend on each other — an install that must finish before a migration will break.",
}];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Experiment {
    pub id: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
}

/// Is an experiment turned on? Unknown ids are off, so a settings file naming
/// an experiment this build dropped behaves as though it never had it.
pub fn experiment_enabled(app: &RuntimeContext, id: &str) -> bool {
    if !EXPERIMENTS.iter().any(|e| e.id == id) {
        return false;
    }
    app.state::<crate::state::AppState>().settings.read().experiments.get(id).copied().unwrap_or(false)
}

/// A copy-pasteable environment summary for a bug report.
///
/// Deliberately shaped as "what would someone need to reproduce this?" and
/// nothing more. It reports counts and versions, never repository paths,
/// branch names, service commands or environment values — a diagnostics blob
/// people paste into a public issue must not carry their filesystem layout or
/// anything resembling a credential.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    /// how many repos are registered — not which, or where
    pub repos: usize,
    pub worktrees: usize,
    pub services: usize,
    pub running_services: usize,
    pub terminal_sessions: usize,
    /// directories a maintainer might ask for, which the user is choosing to
    /// share by pressing the button
    pub config_dir: String,
    pub log_dir: String,
    pub crash_reports: usize,
}

pub fn gather(app: &RuntimeContext) -> Diagnostics {
    let state = app.state::<crate::state::AppState>();
    let (repos, worktrees, services) = {
        let tree = state.tree.read();
        (
            tree.len(),
            tree.iter().map(|r| r.worktrees.len()).sum(),
            tree.iter().flat_map(|r| r.worktrees.iter()).map(|w| w.services.len()).sum(),
        )
    };
    let running = app.state::<crate::services::ProcTable>().procs.lock().len();
    let terminals = app.state::<crate::terminal::TermTable>().sessions.lock().len();

    Diagnostics {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        repos,
        worktrees,
        services,
        running_services: running,
        terminal_sessions: terminals,
        config_dir: app.path().app_config_dir().map(|p| p.display().to_string()).unwrap_or_default(),
        log_dir: app.path().app_log_dir().map(|p| p.display().to_string()).unwrap_or_default(),
        crash_reports: crate::updates::crash_report_count(app),
    }
}

/// The same thing as markdown, ready to paste into an issue.
pub fn as_markdown(d: &Diagnostics) -> String {
    format!(
        "**Canopy {}** · {} {}\n\n\
         | | |\n|---|---|\n\
         | Repositories | {} |\n\
         | Worktrees | {} |\n\
         | Services | {} ({} running) |\n\
         | Terminal sessions | {} |\n\
         | Config | `{}` |\n\
         | Logs | `{}` |\n",
        d.app_version, d.os, d.arch, d.repos, d.worktrees, d.services, d.running_services, d.terminal_sessions, d.config_dir, d.log_dir
    )
}

/// What `clear_caches` removed, so the UI can report a number instead of
/// "done".
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearedCaches {
    /// rotated service log files removed
    pub service_logs: usize,
    /// bytes reclaimed
    pub bytes: u64,
}

/// Delete Canopy's rotated per-service logs.
///
/// Scoped by construction — it only ever walks `<app-log-dir>/services`. It
/// cannot touch a worktree, a database, a repository or a settings file,
/// because it never looks anywhere else.
pub fn clear_caches(app: &RuntimeContext) -> ClearedCaches {
    let mut out = ClearedCaches::default();
    let Ok(log_dir) = app.path().app_log_dir() else { return out };
    let services = log_dir.join("services");
    let Ok(rd) = std::fs::read_dir(&services) else { return out };

    // Live sinks hold an open handle to the CURRENT log of each running
    // service; deleting those would silently stop that service's log from
    // reaching disk for the rest of the run. Rotated files (`*.1.log`) have no
    // handle, so only those are removed.
    for entry in rd.flatten() {
        let path = entry.path();
        let is_rotated = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.contains(".1.log"));
        if !is_rotated {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if std::fs::remove_file(&path).is_ok() {
            out.service_logs += 1;
            out.bytes += size;
        }
    }
    out
}

/// Restore default settings, keeping the registered repositories.
///
/// Wiping the repo list would mean re-adding every repository by hand — a
/// disproportionate outcome for someone who wanted their editor command and
/// toggles back. Repositories are *what Canopy manages*, not a preference, so
/// they survive; everything else returns to defaults.
pub fn reset_settings(app: &RuntimeContext) -> Result<(), String> {
    let state = app.state::<crate::state::AppState>();
    let fresh = {
        let mut s = state.settings.write();
        let keep = s.repos.clone();
        *s = crate::settings::Settings { repos: keep, ..Default::default() };
        s.clone()
    };
    crate::settings::save_settings(app, &fresh)?;
    crate::git::apply_credentials(&fresh.security.ssh_key, &fresh.security.credential_helper);
    crate::notify::refresh_badge(app);
    Ok(())
}
