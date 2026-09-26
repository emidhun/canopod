use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use crate::runtime::RuntimeContext;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    pub editor: EditorCfg,
    pub terminal: String,
    pub repos: Vec<RepoCfg>,
    /// show the in-place "Switch branch" action in the worktree header
    pub show_switch_branch: bool,
    /// Worktrees the user pinned to the top of the sidebar, by `wt_key`.
    ///
    /// Lives here rather than in `RuntimeState` because it is a *preference*,
    /// not derived state: it should travel with the config file, be editable by
    /// hand, and survive a state-file reset. Pruned when a worktree is removed
    /// so the list can't grow without bound.
    #[serde(default)]
    pub pinned_worktrees: Vec<String>,
    #[serde(default)]
    pub security: SecurityCfg,
    /// the embedded PTY + xterm renderer (Settings → Terminal → Embedded shell)
    #[serde(default)]
    pub embedded_terminal: TermCfg,
    /// Opt-in experiment flags, by id (see `EXPERIMENTS` in diagnostics.rs).
    ///
    /// A map rather than named booleans: experiments are meant to appear and
    /// disappear, and every one of them would otherwise be a schema change
    /// plus a migration for something that may not survive the month. An
    /// unknown key is simply an experiment this build no longer has.
    #[serde(default)]
    pub experiments: HashMap<String, bool>,
    #[serde(default)]
    pub notifications: NotifyCfg,
    /// Keybinding overrides: action id → binding ("Mod+k"). Only ids the
    /// running build knows are honoured, so an override for a shortcut that
    /// was removed is ignored rather than being an error.
    ///
    /// A map for the same reason experiments are: shortcuts are added and
    /// renamed, and a named field per action would be a schema change every
    /// time. The registry lives in the frontend (`src/app/keys.ts`), which is
    /// where the handlers are — the backend only needs to persist the map.
    #[serde(default)]
    pub keybindings: HashMap<String, String>,
    #[serde(default)]
    pub updates: UpdatesCfg,
    #[serde(default)]
    pub crash_reports: CrashCfg,
}
/// Secret handling and git credentials.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SecurityCfg {
    /// render secret-looking values as bullets in the config preview and in
    /// streamed setup output
    pub mask_secrets: bool,
    /// export key NAMES but not their values
    pub mask_in_exports: bool,
    /// SSH identity for git network operations; empty = git's own default
    pub ssh_key: String,
    /// git credential helper for HTTPS remotes; empty = git's own default
    pub credential_helper: String,
}

impl Default for SecurityCfg {
    fn default() -> Self {
        Self {
            // On by default: the cost of masking a value that wasn't a secret
            // is one extra click to see it, and the cost of the reverse is a
            // token in a screenshot.
            mask_secrets: true,
            // Off by default: an export is normally a file you commit to your
            // own repo, where the values are the point. Masking silently would
            // produce a config that provisions the string "••••••••".
            mask_in_exports: false,
            ssh_key: String::new(),
            credential_helper: String::new(),
        }
    }
}

/// Embedded-shell configuration.
///
/// Every field has an "unset" value that means *keep the built-in behaviour*
/// (empty string, or 0 for the numbers) rather than a baked-in default. That
/// way a settings file written before this existed behaves exactly as it did,
/// and the renderer's defaults stay in one place — the design's own tokens —
/// instead of being duplicated here as magic numbers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TermCfg {
    /// shell to run; empty = the user's login shell
    pub program: String,
    /// extra arguments, whitespace-separated. Applied only with an explicit
    /// `program`: they would collide with the `-l`/`-i`/`-c` flags Canopy
    /// passes to a login shell it chose itself.
    pub args: String,
    /// CSS font stack; empty = the app's mono stack
    pub font_family: String,
    /// 0 = the app's default size
    pub font_size: f32,
    /// lines of scrollback the renderer keeps; 0 = default
    pub scrollback: u32,
    /// block | underline | bar; empty = block
    pub cursor: String,
    /// blink the cursor
    pub cursor_blink: bool,
    /// flash the pane when a process emits BEL
    pub bell: bool,
    /// open new shells in the worktree root (off = the user's home directory)
    pub cwd_worktree: bool,
    /// expose the worktree's provisioned variables (WT_SLUG, WT_DB_NAME,
    /// WT_<SERVICE>_PORT) to the shell, so a command typed by hand sees the
    /// same environment setup and services do
    pub inherit_env: bool,
}

impl Default for TermCfg {
    fn default() -> Self {
        Self {
            program: String::new(),
            args: String::new(),
            font_family: String::new(),
            font_size: 0.0,
            scrollback: 0,
            cursor: String::new(),
            cursor_blink: true,
            bell: false,
            cwd_worktree: true,
            inherit_env: true,
        }
    }
}

/// Which backend events raise an OS notification.
///
/// Every one of these already appears in the in-app attention queue. A
/// notification is for when Canopy is in the tray and you are looking at
/// something else — so the defaults follow one rule: notify only when a human
/// is BLOCKING something, never for progress.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotifyCfg {
    /// a service exited unexpectedly
    pub service_crash: bool,
    /// an agent is blocked waiting on input
    pub agent_waiting: bool,
    /// provisioning finished (success or failure)
    pub setup_done: bool,
    /// the worktree's branch moved on origin
    pub branch_moved: bool,
    /// play the system sound with the notification
    pub sound: bool,
    /// "count" | "dot" | "off" — the app-icon badge
    pub badge: String,
}

impl Default for NotifyCfg {
    fn default() -> Self {
        Self {
            // the two states that mean "something is stuck on you"
            service_crash: true,
            agent_waiting: true,
            // progress, not a block — you asked for it and you can watch it
            setup_done: false,
            branch_moved: false,
            sound: false,
            badge: "count".into(),
        }
    }
}

/// Update-check preferences. Canopy checks the project's GitHub releases for a
/// newer tag; it never downloads or installs anything on its own (see
/// `updates.rs` for why).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdatesCfg {
    /// check for a newer release in the background
    pub auto_check: bool,
}

impl Default for UpdatesCfg {
    fn default() -> Self {
        // Opt in until the background result has a visible update notice.
        Self { auto_check: false }
    }
}

/// Crash-report preferences.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CrashCfg {
    /// record a stack trace to the log directory when Canopy panics.
    /// Opt-in: off until the user turns it on.
    pub enabled: bool,

}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 0,
            editor: EditorCfg::default(),
            terminal: String::new(),
            repos: Vec::new(),
            show_switch_branch: true,
            pinned_worktrees: Vec::new(),
            security: SecurityCfg::default(),
            embedded_terminal: TermCfg::default(),
            experiments: HashMap::new(),
            notifications: NotifyCfg::default(),
            keybindings: HashMap::new(),
            updates: UpdatesCfg::default(),
            crash_reports: CrashCfg::default(),

        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorCfg {
    pub command: String,
}

impl Default for EditorCfg {
    fn default() -> Self {
        Self { command: "code".into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoCfg {
    pub id: String,
    pub name: String,
    pub path: String,
    /// Directory where new worktrees are created. Absolute, or relative to the
    /// repo root (e.g. ".worktrees"). Empty falls back to `<repo>/.worktrees`.
    pub worktree_dir: String,
    /// Command run in the worktree root for "Reset DB" (empty = action hidden)
    pub reset_db: String,
    /// Command run in the worktree root for "Run migration". Empty = fall back to
    /// the repo's `.worktreemanager.json` `migrate` array.
    #[serde(default)]
    pub migrate_db: String,
    pub services: Vec<ServiceCfg>,
    /// Ad-hoc commands surfaced as buttons in the worktree header; each runs in
    /// the worktree root on the pinned Node.
    #[serde(default)]
    pub custom_commands: Vec<CustomCmd>,
    /// CLI the agent lane's "Start agent" runs in a worktree terminal (e.g.
    /// `claude`, `aider`, `codex`). Empty = fall back to the built-in default.
    #[serde(default)]
    pub agent_command: String,
    /// Selectable agent launchers for the worktree agent lane. Kept alongside
    /// `agent_command` so existing settings files upgrade without data loss.
    #[serde(default)]
    pub agents: Vec<AgentCfg>,
    /// Branch new worktrees are created from when the user doesn't pick one.
    /// Empty = whatever the New-worktree modal defaults to (`main` if present).
    #[serde(default)]
    pub default_base: String,
    #[serde(default)]
    pub worktree_defaults: WorktreeDefaults,
    #[serde(default)]
    pub agent_context: AgentContextCfg,
    /// Most agent sessions allowed to run at once in one repository.
    /// 0 = no limit. Each agent is a real CLI doing real work; several at once
    /// on one machine compete for CPU and for the same dev database.
    #[serde(default)]
    pub max_parallel_agents: u32,
    /// Minutes an agent session may sit with no output or input before Canopy
    /// closes it. 0 = never, which is the default: a quiet agent may simply be
    /// waiting for the user, and killing it loses work.
    #[serde(default)]
    pub agent_idle_timeout_min: u32,
}

/// What `create_worktree` does after `git worktree add`, per repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorktreeDefaults {
    /// provision files and run setup tasks as soon as the worktree exists
    pub run_setup: bool,
    /// start the service list once provisioning finishes
    pub start_services: bool,
    /// give the worktree its own database name (`WT_DB_NAME` = the branch
    /// slug). Off makes `WT_DB_NAME` resolve to the MAIN checkout's PG_DB, so
    /// the worktree shares that database instead of getting one of its own.
    pub isolated_database: bool,
}

impl Default for WorktreeDefaults {
    fn default() -> Self {
        // Matches what create_worktree did before these were configurable, so
        // an existing settings file behaves identically.
        Self { run_setup: true, start_services: false, isolated_database: true }
    }
}

/// What Canopy puts in the handoff every agent receives.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentContextCfg {
    /// the task title, body and linked PR / issue
    pub worktree_context: bool,
    /// branch, path, database name and resolved ports
    pub runtime_facts: bool,
    /// the last error lines from any unhealthy service
    pub failing_logs: bool,
}

impl Default for AgentContextCfg {
    fn default() -> Self {
        // Matches what the handoff contained before this was configurable.
        // Failing logs are opt-in: they are the one part that can carry
        // arbitrary process output — including a value from a .env — into a
        // prompt sent to a third-party CLI.
        Self { worktree_context: true, runtime_facts: true, failing_logs: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentCfg {
    pub id: String,
    pub name: String,
    pub command: String,
    /// Append Canopy's initial handoff as the first CLI prompt argument.
    pub prompt_on_launch: bool,
    /// Extra literal snippets (one per line) that mean "this agent is blocked
    /// on a human". Matched case-insensitively against the terminal tail after
    /// ANSI stripping, on top of the built-in prompt shapes.
    ///
    /// Literal, not regex: a pattern that failed to compile would silently
    /// disable waiting-detection for the profile, which is a worse failure
    /// than a snippet that simply never matches.
    #[serde(default)]
    pub waiting_patterns: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomCmd {
    /// Button label shown in the worktree header
    pub label: String,
    /// Shell command run in the worktree root
    pub command: String,
    /// Optional heading this command sits under in the rail's Commands menu.
    /// Empty = ungrouped, which is where every existing command starts.
    #[serde(default)]
    pub group: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ServiceCfg {
    pub id: String,
    pub name: String,
    /// web | server | worker
    pub kind: String,
    pub command: String,
    /// cwd relative to the worktree root
    pub cwd: String,
    pub base_port: Option<u16>,
    pub env: HashMap<String, String>,
    /// Readiness probe path, e.g. `/api/health`. Empty = none, and the service
    /// counts as running the moment its process is alive (today's behaviour).
    ///
    /// A path, not a URL: the host is always localhost and the port is the
    /// service's own derived one, so accepting a full URL would let a health
    /// check silently point at a different service — or a different machine.
    #[serde(default)]
    pub health: String,
}

/// Persisted runtime state (not user-edited): stable port index per worktree,
/// and spawned process groups for the orphan sweep.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RuntimeState {
    /// repoId -> (wtKey -> index); effective port = basePort + index * 10
    pub port_indices: HashMap<String, HashMap<String, u32>>,
    /// svcKey -> explicit port override (takes precedence over the derived port)
    #[serde(default)]
    pub port_overrides: HashMap<String, u32>,
    /// pgids of spawned services, swept on startup after a crash
    pub orphans: Vec<OrphanProc>,
    /// pgids of embedded terminal sessions, swept on startup after a crash
    #[serde(default)]
    pub terminal_orphans: Vec<TermOrphan>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OrphanProc {
    pub svc_key: String,
    pub pgid: i32,
    pub spawn_time_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TermOrphan {
    pub id: String,
    pub pgid: i32,
    pub spawn_time_secs: u64,
}

fn settings_path(app: &crate::runtime::RuntimePaths) -> PathBuf {
    app
        .app_config_dir()
        .expect("no app config dir")
        .join("settings.json")
}

fn runtime_path(app: &crate::runtime::RuntimePaths) -> PathBuf {
    app
        .app_data_dir()
        .expect("no app data dir")
        .join("state.json")
}

/// Load a JSON state file. A *missing* file is a fresh install (defaults); a
/// file that EXISTS but doesn't parse is user data in danger — quarantine it
/// to `<name>.corrupt` and log loudly, so the repos/services/ports it held can
/// be recovered by hand instead of being silently wiped on the next save.
fn load_json<T: for<'a> Deserialize<'a> + Default>(path: &PathBuf) -> T {
    let Ok(txt) = fs::read_to_string(path) else { return T::default() };
    match serde_json::from_str(&txt) {
        Ok(v) => v,
        Err(e) => {
            let backup = path.with_extension("json.corrupt");
            let _ = fs::copy(path, &backup);
            log::error!(
                "failed to parse {} ({e}) — original preserved at {}; starting from defaults",
                path.display(),
                backup.display()
            );
            T::default()
        }
    }
}

/// Atomic save: write a sibling temp file, fsync, rename over the target. A
/// crash or full disk mid-write can no longer truncate settings/state — the
/// old file stays intact until the rename. Skips the write entirely when the
/// serialized content is unchanged (state.json is saved on every refresh).
fn save_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    if let Ok(existing) = fs::read_to_string(path) {
        if existing == body {
            return Ok(());
        }
    }
    let tmp = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        f.write_all(body.as_bytes()).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        f.sync_all().map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("rename {} → {}: {e}", tmp.display(), path.display()))
}

pub fn load_settings(app: &crate::runtime::RuntimePaths) -> Settings {
    load_json(&settings_path(app))
}

pub fn save_settings(app: &RuntimeContext, s: &Settings) -> Result<(), String> {
    save_json(&settings_path(app.path()), s)
}

pub fn load_runtime(app: &crate::runtime::RuntimePaths) -> RuntimeState {
    load_json(&runtime_path(app))
}

pub fn save_runtime(app: &RuntimeContext, s: &RuntimeState) -> Result<(), String> {
    save_json(&runtime_path(app.path()), s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_is_atomic_and_load_quarantines_corrupt_files() {
        let dir = std::env::temp_dir().join("canopy_settings_test_xyz");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        let s = Settings { terminal: "iTerm".into(), ..Default::default() };
        save_json(&path, &s).unwrap();
        let loaded: Settings = load_json(&path);
        assert_eq!(loaded.terminal, "iTerm", "round-trips");
        assert!(!path.with_extension("json.tmp").exists(), "temp file renamed away");

        // corrupt file → defaults, but the original is preserved
        fs::write(&path, "{ truncated").unwrap();
        let loaded: Settings = load_json(&path);
        assert_eq!(loaded.terminal, "", "defaults on parse failure");
        let backup = path.with_extension("json.corrupt");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "{ truncated", "original quarantined");

        // a settings file written before pinning existed must still load, with
        // an empty pin list rather than falling back to full defaults
        fs::write(&path, r#"{"version":1,"terminal":"iTerm","repos":[]}"#).unwrap();
        let loaded: Settings = load_json(&path);
        assert_eq!(loaded.terminal, "iTerm", "pre-pinning settings still parse");
        assert!(loaded.pinned_worktrees.is_empty(), "absent pin list defaults to empty");

        // pins round-trip
        let s = Settings { pinned_worktrees: vec!["/wt/a".into()], ..Default::default() };
        save_json(&path, &s).unwrap();
        let loaded: Settings = load_json(&path);
        assert_eq!(loaded.pinned_worktrees, vec!["/wt/a".to_string()]);

        // unchanged content → no rewrite (mtime-stable persistence)
        fs::write(&path, serde_json::to_string_pretty(&s).unwrap()).unwrap();
        save_json(&path, &s).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
