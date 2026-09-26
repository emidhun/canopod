use crate::git::{self, GitMeta};
use crate::settings::{RepoCfg, RuntimeState, Settings};
use serde::Serialize;
use std::collections::HashMap;
use parking_lot::{Mutex, RwLock};
use crate::runtime::RuntimeContext;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SvcStatus {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceNode {
    pub svc_key: String,
    pub service_id: String,
    pub name: String,
    pub kind: String,
    /// the port the service actually uses — an override if one is set, else
    /// the derived one
    pub port: Option<u32>,
    /// what `base_port + index*10` yields, ignoring any override. Carried
    /// alongside `port` so the detail modal can say whether the current value
    /// is derived or overridden, and so Esc can revert to something meaningful
    /// rather than to whatever the modal happened to open with.
    pub derived_port: Option<u32>,
    pub status: SvcStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeNode {
    pub wt_key: String,
    pub branch: String,
    pub path: String,
    pub is_main: bool,
    pub git: Option<GitMeta>,
    /// database name from the worktree's .env (PG_DB), if present
    pub db_name: Option<String>,
    /// what Canopy knows about this worktree's provisioning; `None` = never
    /// provisioned as far as it can tell. Read from `.canopy/setup.json`, or
    /// inferred from the presence of every declared provisioned file.
    pub setup: Option<crate::setup::SetupState>,
    /// does the owning repo declare anything to provision or run at all? A
    /// repo with no `.worktreemanager.json` can't have "unprovisioned"
    /// worktrees, so `setup: None` there means "nothing to do", not "act".
    pub setup_configured: bool,
    /// pinned to the top of the sidebar. Denormalized onto the tree (the list
    /// itself lives in `Settings`) so every window — including the popover —
    /// gets it from the `tree:changed` it already subscribes to, with no extra
    /// fetch and no second source of truth to drift.
    pub pinned: bool,
    pub services: Vec<ServiceNode>,
}

/// Read a single key's value from a worktree's `.env` (no quoting/expansion).
fn env_value(wt_path: &str, key: &str) -> Option<String> {
    let txt = std::fs::read_to_string(std::path::Path::new(wt_path).join(".env")).ok()?;
    for line in txt.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(v) = rest.strip_prefix('=') {
                let v = v.trim().trim_matches('"').trim_matches('\'');
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoNode {
    pub repo_id: String,
    pub name: String,
    pub path: String,
    pub worktrees: Vec<WorktreeNode>,
}

pub struct AppState {
    #[cfg(unix)]
    pub(crate) retained_orphans: Mutex<Vec<crate::settings::OrphanProc>>,
    #[cfg(unix)]
    pub(crate) retained_terminal_orphans: Mutex<Vec<crate::settings::TermOrphan>>,
    /// Per-runtime, cancellation-safe admission for the periodic refresh.
    refresh: tokio::sync::Mutex<()>,
    pub settings: RwLock<Settings>,
    pub runtime: RwLock<RuntimeState>,
    pub tree: RwLock<Vec<RepoNode>>,
    /// svcKey -> current status (process table lands here in Phase 4)
    pub statuses: RwLock<HashMap<String, SvcStatus>>,
    /// wt_key -> label of the mutating operation currently holding the lease
    /// (see `try_lease`)
    pub ops: Mutex<HashMap<String, &'static str>>,
}

/// RAII lease for a mutating per-worktree operation. Exactly one of
/// create/setup/remove/migrate/snapshot/restore/switch may run per worktree at
/// a time — without this, `remove_worktree` could race `run_worktree_setup`,
/// two creates could TOCTOU the same path, and a restore could race a
/// snapshot. Dropped (including on panic/early return) it frees the slot.
pub struct OpLease {
    app: RuntimeContext,
    key: String,
}

impl Drop for OpLease {
    fn drop(&mut self) {
        let state = self.app.state::<AppState>();
        state.ops.lock().remove(&self.key);
    }
}

/// Release everything runtime-side that belongs to a removed worktree: its
/// port index (so the slot is reclaimed and derived ports stop creeping up),
/// its port overrides, its statuses, and its in-memory log buffers. Persists
/// the runtime file. Idempotent.
pub fn release_worktree_runtime(app: &RuntimeContext, repo_id: &str, wt_key: &str) {
    let state = app.state::<AppState>();
    let prefix = format!("{wt_key}::");
    let runtime = {
        let mut rt = state.runtime.write();
        if let Some(map) = rt.port_indices.get_mut(repo_id) {
            map.remove(wt_key);
        }
        rt.port_overrides.retain(|k, _| !k.starts_with(&prefix));
        rt.clone()
    };
    let _ = crate::settings::save_runtime(app, &runtime);
    state.statuses.write().retain(|k, _| !k.starts_with(&prefix));
    // a measurement for a path that no longer exists would otherwise sit in the
    // cache forever, and be served to the overview if the path is ever reused
    crate::disk::forget(app, wt_key);
    // Drop the pin too. Nothing else prunes this list, so without it every
    // removed worktree leaves an entry that grows the config file forever and
    // silently re-pins the path if it is ever recreated.
    let settings = {
        let mut s = state.settings.write();
        let before = s.pinned_worktrees.len();
        s.pinned_worktrees.retain(|k| k != wt_key);
        (before != s.pinned_worktrees.len()).then(|| s.clone())
    };
    if let Some(s) = settings {
        let _ = crate::settings::save_settings(app, &s);
    }
    {
        let table = app.state::<crate::services::ProcTable>();
        table.logs.lock().retain(|k, _| !k.starts_with(&prefix));
        // close the on-disk log handles too, or a removed worktree keeps file
        // descriptors open for the rest of the run
        table.log_files.lock().retain(|k, _| !k.starts_with(&prefix));
    }
}

/// Take the operation lease for `wt_key`, or fail with a conflict naming the
/// operation already running.
pub fn try_lease(app: &RuntimeContext, wt_key: &str, op: &'static str) -> Result<OpLease, crate::error::CanopyError> {
    let state = app.state::<AppState>();
    let mut ops = state.ops.lock();
    if let Some(existing) = ops.get(wt_key) {
        return Err(crate::error::CanopyError::conflict(format!(
            "'{existing}' is already running on this worktree — wait for it to finish"
        )));
    }
    ops.insert(wt_key.to_string(), op);
    Ok(OpLease { app: app.clone(), key: wt_key.to_string() })
}

/// A worktree resolved to its owning repo — the answer every command needs
/// before it can act on a `wt_key`.
#[derive(Debug, Clone)]
pub struct WtContext {
    pub repo_id: String,
    pub repo_path: String,
    pub branch: String,
    pub is_main: bool,
}

impl AppState {
    pub fn new(settings: Settings, runtime: RuntimeState) -> Self {
        Self {
            refresh: tokio::sync::Mutex::new(()),
            settings: RwLock::new(settings),
            #[cfg(unix)]
            retained_orphans: Mutex::new(runtime.orphans.clone()),
            #[cfg(unix)]
            retained_terminal_orphans: Mutex::new(runtime.terminal_orphans.clone()),
            runtime: RwLock::new(runtime),
            tree: RwLock::new(Vec::new()),
            statuses: RwLock::new(HashMap::new()),
            ops: Mutex::new(HashMap::new()),
        }
    }

    // ── tree queries ──
    //
    // The tree is the single navigable model (repos → worktrees → services);
    // every command used to hand-roll the same triple-nested loop with subtly
    // different miss behavior. These are the only sanctioned lookups — they
    // take the tree read lock briefly and return owned data, so callers never
    // hold a lock across an await point.

    /// Resolve a worktree key to its owning repo.
    pub fn wt_context(&self, wt_key: &str) -> Option<WtContext> {
        let tree = self.tree.read();
        for r in tree.iter() {
            for w in r.worktrees.iter() {
                if w.wt_key == wt_key {
                    return Some(WtContext {
                        repo_id: r.repo_id.clone(),
                        repo_path: r.path.clone(),
                        branch: w.branch.clone(),
                        is_main: w.is_main,
                    });
                }
            }
        }
        None
    }

    /// Resolve a service key to `(wt_key, repo_id, repo_path)`.
    pub fn service_context(&self, svc_key: &str) -> Option<(String, String, String)> {
        let tree = self.tree.read();
        for r in tree.iter() {
            for w in r.worktrees.iter() {
                if w.services.iter().any(|s| s.svc_key == svc_key) {
                    return Some((w.wt_key.clone(), r.repo_id.clone(), r.path.clone()));
                }
            }
        }
        None
    }

    /// All service keys of one worktree.
    pub fn wt_service_keys(&self, wt_key: &str) -> Vec<String> {
        let tree = self.tree.read();
        tree.iter()
            .flat_map(|r| r.worktrees.iter())
            .filter(|w| w.wt_key == wt_key)
            .flat_map(|w| w.services.iter().map(|s| s.svc_key.clone()))
            .collect()
    }

    /// A registered repo's path by id.
    pub fn repo_path_by_id(&self, repo_id: &str) -> Option<String> {
        let s = self.settings.read();
        s.repos.iter().find(|r| r.id == repo_id).map(|r| r.path.clone())
    }
}

pub fn svc_key(wt_key: &str, service_id: &str) -> String {
    format!("{wt_key}::{service_id}")
}

/// The port index a worktree has, or would be given: main checkout = 0, others
/// take the first free slot. Effective port = basePort + index*10.
///
/// `assign` is the only difference between allocating and previewing. Keeping
/// them one function is the point — the New-worktree modal's whole value is
/// that the ports it shows are the ports you get, and a second implementation
/// of "first free slot" would drift silently the first time this rule changes.
fn resolve_port_index(
    runtime: &mut RuntimeState,
    repo_id: &str,
    wt_key: &str,
    is_main: bool,
    assign: bool,
) -> u32 {
    let map = runtime.port_indices.entry(repo_id.to_string()).or_default();
    if let Some(i) = map.get(wt_key) {
        return *i;
    }
    let idx = if is_main {
        0
    } else {
        let mut used: Vec<u32> = map.values().copied().collect();
        used.sort_unstable();
        let mut i = 1;
        while used.contains(&i) {
            i += 1;
        }
        i
    };
    if assign {
        map.insert(wt_key.to_string(), idx);
    }
    idx
}

/// Stable per-worktree port index, persisted so ports never shuffle.
fn port_index(runtime: &mut RuntimeState, repo_id: &str, wt_key: &str, is_main: bool) -> u32 {
    resolve_port_index(runtime, repo_id, wt_key, is_main, true)
}

/// What a worktree that doesn't exist yet would be given. Allocates nothing.
pub fn peek_port_index(runtime: &mut RuntimeState, repo_id: &str, wt_key: &str) -> u32 {
    resolve_port_index(runtime, repo_id, wt_key, false, false)
}

/// The database name a worktree gets — the same `WT_DB_NAME` that
/// `worktree_vars` exposes to provisioning templates.
pub fn derived_db_name(repo_id: &str, wt_key: &str) -> String {
    let slug = crate::setup::wt_slug(wt_key);
    let repo_slug: String = repo_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
        .collect();
    format!("{repo_slug}_{slug}")
}

/// A service's effective port: an explicit override if set, else the derived
/// `base_port + index*10`.
pub fn effective_port(overrides: &HashMap<String, u32>, svc_key: &str, base_port: u32, idx: u32) -> u32 {
    overrides.get(svc_key).copied().unwrap_or(base_port + idx * 10)
}

/// Uppercase slug for an env-var name segment: non-alphanumerics become '_',
/// leading/trailing '_' trimmed. Mirrors `envSlug` in the onboarding UI.
pub fn env_slug(s: &str) -> String {
    let up: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
        .collect();
    up.trim_matches('_').to_string()
}

/// Build the `WT_*` / `WM_*` variables a worktree's commands see: WT_SLUG,
/// WT_INDEX, WT_DB_NAME, and each service's port under both its id and its
/// human name. `services` is (service_id, service_name, resolved_port).
///
/// EVERY path that hands these to a command must come through here. The
/// provisioning path and the service-runtime path each built their own map
/// once, and drifted: the name-slug ports were added to provisioning only, so
/// `$WT_SERVER_PORT` resolved in a setup command and was empty in a service
/// command for the same service.
/// The database name ${WT_DB_NAME} resolves to. With per-worktree databases
/// off it is the MAIN checkout's PG_DB, so provisioning points this worktree
/// at the shared database instead of naming one of its own; falling back to
/// the derived name when the main checkout has no PG_DB keeps the worktree
/// working rather than provisioning an empty name.
///
/// Both the provisioning path and the service-runtime path call this, for the
/// same reason they share build_wt_vars: two implementations of one name is
/// how $WT_DB_NAME would come to mean different things in a setup command and
/// in a service command.
pub fn resolve_db_name(app: &RuntimeContext, repo_id: &str, wt_key: &str) -> String {
    let state = app.state::<AppState>();
    let derived = derived_db_name(repo_id, wt_key);
    let isolated = {
        let s = state.settings.read();
        s.repos.iter().find(|r| r.id == repo_id).map(|r| r.worktree_defaults.isolated_database).unwrap_or(true)
    };
    if isolated {
        return derived;
    }
    let main_path = state.settings.read().repos.iter().find(|r| r.id == repo_id).map(|r| r.path.clone());
    main_path.and_then(|p| env_value(&p, "PG_DB")).unwrap_or(derived)
}

/// `db_name` is resolved by the caller, which is the only side with access to
/// settings: with per-worktree databases off it is the MAIN checkout's PG_DB
/// rather than the derived name. Passing it in keeps this function pure, and
/// therefore directly testable — which is the point of having one builder.
pub fn build_wt_vars(
    wt_key: &str,
    idx: u32,
    db_name: String,
    services: &[(String, String, u32)],
) -> HashMap<String, String> {
    let slug = crate::setup::wt_slug(wt_key);

    let mut m = HashMap::new();
    m.insert("WT_SLUG".into(), slug.clone());
    m.insert("WT_INDEX".into(), idx.to_string());
    m.insert("WT_DB_NAME".into(), db_name);
    m.insert("WM_WT_SLUG".into(), slug); // back-compat alias

    for (id, name, port) in services {
        let port = port.to_string();
        let id_up = id.to_uppercase();
        m.insert(format!("WT_{id_up}_PORT"), port.clone());
        m.insert(format!("WM_PORT_{id_up}"), port.clone()); // back-compat alias
        // Also expose the port under the service's human NAME, so an .env
        // template can use `${WT_SERVER_PORT}` for a service named "Server"
        // regardless of its internal id (ids like `svc-19` never matched a
        // human-authored template). Additive: `or_insert` never clobbers an
        // id-based var, and a name collision keeps the first service's port.
        let name_slug = env_slug(name);
        if !name_slug.is_empty() {
            m.entry(format!("WT_{name_slug}_PORT")).or_insert(port);
        }
    }
    m
}

/// Assign (or look up) the worktree's port index and return the variables setup
/// can use to provision isolated resources. Idempotent; persists the index.
/// Called before setup so .env overrides can reference these.
pub fn worktree_vars(app: &RuntimeContext, repo_id: &str, wt_key: &str, is_main: bool) -> HashMap<String, String> {
    let state = app.state::<AppState>();
    let idx = {
        let mut rt = state.runtime.write();
        port_index(&mut rt, repo_id, wt_key, is_main)
    };
    {
        let rt = state.runtime.read().clone();
        let _ = crate::settings::save_runtime(app, &rt);
    }

    let overrides = state.runtime.read().port_overrides.clone();
    let services: Vec<(String, String, u32)> = {
        let settings = state.settings.read();
        settings
            .repos
            .iter()
            .find(|r| r.id == repo_id)
            .map(|repo| {
                repo.services
                    .iter()
                    .filter_map(|s| {
                        let bp = s.base_port?;
                        let key = svc_key(wt_key, &s.id);
                        Some((s.id.clone(), s.name.clone(), effective_port(&overrides, &key, bp as u32, idx)))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    build_wt_vars(wt_key, idx, resolve_db_name(app, repo_id, wt_key), &services)
}

/// The worktree's already-assigned port index, without allocating or persisting
/// one. Service startup happens long after setup claimed the index; 0 (the main
/// checkout's slot) is the only sane fallback if it is somehow absent.
pub fn existing_port_index(app: &RuntimeContext, repo_id: &str, wt_key: &str) -> u32 {
    let state = app.state::<AppState>();
    let rt = state.runtime.read();
    rt.port_indices.get(repo_id).and_then(|m| m.get(wt_key)).copied().unwrap_or(0)
}

/// Rebuild the structural tree (repos -> worktrees -> services) from settings +
/// `git worktree list`. Git meta is carried over from the previous snapshot and
/// refreshed separately. Emits `tree:changed`.
pub async fn refresh_tree(app: &RuntimeContext) -> Result<Vec<RepoNode>, String> {
    let state = app.state::<AppState>();
    let repos_cfg: Vec<RepoCfg> = state.settings.read().repos.clone();

    // previous git meta, preserved across rebuilds
    let prev_git: HashMap<String, GitMeta> = state
        .tree
        .read()
        .iter()
        .flat_map(|r| r.worktrees.iter())
        .filter_map(|w| w.git.clone().map(|g| (w.wt_key.clone(), g)))
        .collect();

    let pinned: std::collections::HashSet<String> =
        state.settings.read().pinned_worktrees.iter().cloned().collect();

    let mut tree = Vec::new();
    for repo in &repos_cfg {
        let wts = match git::list_worktrees(&repo.path).await {
            Ok(w) => w,
            Err(e) => {
                log::warn!("list_worktrees failed for {}: {e}", repo.path);
                Vec::new()
            }
        };

        let mut worktrees = Vec::new();
        for wt in wts {
            // a worktree whose folder was deleted outside Canopy is `prunable` —
            // don't render it as a live row; the Sync-prune flow reconciles it
            if wt.prunable {
                continue;
            }
            let (idx, overrides) = {
                let mut runtime = state.runtime.write();
                let idx = port_index(&mut runtime, &repo.id, &wt.path, wt.is_main);
                (idx, runtime.port_overrides.clone())
            };
            let statuses = state.statuses.read();
            let services = repo
                .services
                .iter()
                .map(|s| {
                    let key = svc_key(&wt.path, &s.id);
                    ServiceNode {
                        port: s.base_port.map(|p| effective_port(&overrides, &key, p as u32, idx)),
                        derived_port: s.base_port.map(|p| p as u32 + idx * 10),
                        status: statuses.get(&key).copied().unwrap_or(SvcStatus::Stopped),
                        svc_key: key,
                        service_id: s.id.clone(),
                        name: s.name.clone(),
                        kind: s.kind.clone(),
                    }
                })
                .collect();

            let (setup, setup_configured) = crate::setup::setup_status(&wt.path, &repo.path);
            worktrees.push(WorktreeNode {
                db_name: env_value(&wt.path, "PG_DB"),
                setup,
                setup_configured,
                pinned: pinned.contains(&wt.path),
                wt_key: wt.path.clone(),
                git: prev_git.get(&wt.path).cloned(),
                branch: wt.branch,
                path: wt.path,
                is_main: wt.is_main,
                services,
            });
        }

        tree.push(RepoNode {
            repo_id: repo.id.clone(),
            name: repo.name.clone(),
            path: repo.path.clone(),
            worktrees,
        });
    }

    // swap in the new tree; emit only when something actually changed — the
    // unconditional broadcast forced every window through a full JSON
    // serialize + React reconcile once a minute even when nothing moved
    let changed = {
        let mut cached = state.tree.write();
        let changed = *cached != tree;
        *cached = tree.clone();
        changed
    };
    // self-heal the statuses map: a service's exit waiter can fire set_status
    // AFTER its worktree was removed and cleaned (stop is async), re-inserting
    // an orphan key — prune anything the rebuilt tree doesn't know.
    {
        let known: std::collections::HashSet<&str> = tree
            .iter()
            .flat_map(|r| r.worktrees.iter())
            .flat_map(|w| w.services.iter().map(|s| s.svc_key.as_str()))
            .collect();
        state.statuses.write().retain(|k, _| known.contains(k.as_str()));
    }
    {
        let runtime = state.runtime.read().clone();
        let _ = crate::settings::save_runtime(app, &runtime);
    }
    if changed {
        let _ = app.emit("tree:changed", &tree);
    }
    Ok(tree)
}

/// Refresh git meta for one worktree; updates the cached tree and emits `worktree:git`.
pub async fn refresh_git_meta(app: &RuntimeContext, wt_path: &str) {
    if let Ok(meta) = git::git_meta(wt_path).await {
        let state = app.state::<AppState>();
        let mut changed = false;
        // "moved on origin" is a RISE in behind-count, not a nonzero one: the
        // latter would re-notify on every refresh for as long as you stay
        // behind, which is exactly the noise that trains people to ignore
        // notifications.
        let mut moved_from: Option<(u32, String)> = None;
        {
            let mut tree = state.tree.write();
            for r in tree.iter_mut() {
                for w in r.worktrees.iter_mut() {
                    if w.wt_key == wt_path && w.git.as_ref() != Some(&meta) {
                        let was = w.git.as_ref().map(|g| g.behind).unwrap_or(0);
                        if meta.behind > was {
                            moved_from = Some((was, w.branch.clone()));
                        }
                        w.git = Some(meta.clone());
                        changed = true;
                    }
                }
            }
        }
        if let Some((_, branch)) = moved_from {
            let n = meta.behind;
            crate::notify::notify(
                app,
                crate::notify::Kind::BranchMoved,
                wt_path,
                "A branch moved on origin",
                &format!("{branch} is {n} commit{} behind", if n == 1 { "" } else { "s" }),
            );
        }
        if changed {
            #[derive(Serialize, Clone)]
            #[serde(rename_all = "camelCase")]
            struct GitEvent<'a> {
                wt_key: &'a str,
                #[serde(flatten)]
                meta: &'a GitMeta,
            }
            let _ = app.emit("worktree:git", &GitEvent { wt_key: wt_path, meta: &meta });
        }
    }
}

/// Full refresh (tree + git meta), collapsed under an in-flight guard: the
/// 60s loop, the tray catch-up paths and show_main_window can all fire at
/// once (tray click + window show is exactly that), and each full refresh is
/// 2 git spawns per worktree — no reason to run three copies concurrently.
pub async fn refresh_all(app: &RuntimeContext) {
    let Ok(_refresh) = app.state::<AppState>().refresh.try_lock() else { return };
    let _ = refresh_tree(app).await;
    refresh_all_git_meta(app).await;
}

/// Refresh git meta for every worktree. Worktrees are independent, so the
/// per-worktree refreshes run concurrently (chunked so a many-worktree setup
/// doesn't fork dozens of git processes at once) — the old sequential loop
/// could take longer than the 60s refresh interval on large repos.
pub async fn refresh_all_git_meta(app: &RuntimeContext) {
    let paths: Vec<String> = {
        let state = app.state::<AppState>();
        let tree = state.tree.read();
        tree.iter()
            .flat_map(|r| r.worktrees.iter().map(|w| w.wt_key.clone()))
            .collect()
    };
    for chunk in paths.chunks(6) {
        let handles: Vec<_> = chunk
            .iter()
            .map(|p| {
                let app = app.clone();
                let p = p.clone();
                app.executor().spawn(async move { refresh_git_meta(&app, &p).await })
            })
            .collect();
        for h in handles {
            let _ = h.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_index_is_stable_and_reclaims_gaps() {
        let mut rt = RuntimeState::default();
        assert_eq!(port_index(&mut rt, "repo", "/main", true), 0, "main is always 0");
        assert_eq!(port_index(&mut rt, "repo", "/wt-a", false), 1);
        assert_eq!(port_index(&mut rt, "repo", "/wt-b", false), 2);
        // stable across repeat calls
        assert_eq!(port_index(&mut rt, "repo", "/wt-a", false), 1);
        // freeing an index lets the next worktree take the first gap
        rt.port_indices.get_mut("repo").unwrap().remove("/wt-a");
        assert_eq!(port_index(&mut rt, "repo", "/wt-c", false), 1);
        // separate repos have independent index spaces
        assert_eq!(port_index(&mut rt, "other", "/wt-x", false), 1);
    }

    #[test]
    fn peek_matches_assignment_without_consuming_a_slot() {
        let mut rt = RuntimeState::default();
        port_index(&mut rt, "repo", "/main", true);
        port_index(&mut rt, "repo", "/wt-a", false);

        // the preview reports exactly what an assignment would hand out …
        let peeked = peek_port_index(&mut rt, "repo", "/wt-new");
        assert_eq!(peeked, 2, "first free slot");
        // … twice, because peeking never consumes it
        assert_eq!(peek_port_index(&mut rt, "repo", "/wt-other"), 2, "a preview reserves nothing");
        // and the real assignment then agrees with the preview
        assert_eq!(port_index(&mut rt, "repo", "/wt-new", false), peeked, "preview == what you get");
        // only now is the slot gone
        assert_eq!(peek_port_index(&mut rt, "repo", "/wt-other"), 3);
    }

    #[test]
    fn derived_db_name_is_shared_with_worktree_vars() {
        // the same value the ${WT_DB_NAME} template resolves to
        assert_eq!(derived_db_name("ToolJet", "/w/.worktrees/Feature-X.2"), "tooljet_feature_x_2");
        assert_eq!(derived_db_name("my repo", "/w/plain"), "my_repo_plain");
    }

    #[test]
    fn env_slug_uppercases_and_trims() {
        assert_eq!(env_slug("Server"), "SERVER");
        assert_eq!(env_slug("ToolJet Server"), "TOOLJET_SERVER");
        assert_eq!(env_slug("api:dev"), "API_DEV");
        assert_eq!(env_slug("  "), "", "all-separator names slug to empty and are skipped");
    }

    #[test]
    fn wt_vars_expose_ports_under_both_id_and_name() {
        let services = vec![
            ("svc-19".to_string(), "Server".to_string(), 3150u32),
            ("frontend".to_string(), "Front End".to_string(), 8232u32),
        ];
        let m = build_wt_vars("/repo/.worktrees/lts-3.16", 4, derived_db_name("ToolJet-CE", "/repo/.worktrees/lts-3.16"), &services);

        assert_eq!(m.get("WT_SLUG").unwrap(), "lts_3_16");
        assert_eq!(m.get("WT_INDEX").unwrap(), "4");
        assert_eq!(m.get("WT_DB_NAME").unwrap(), "tooljet_ce_lts_3_16");
        assert_eq!(m.get("WM_WT_SLUG").unwrap(), "lts_3_16", "back-compat alias");

        // the id form, its WM_ alias, and the human-name form all resolve
        assert_eq!(m.get("WT_SVC-19_PORT").unwrap(), "3150");
        assert_eq!(m.get("WM_PORT_SVC-19").unwrap(), "3150");
        assert_eq!(m.get("WT_SERVER_PORT").unwrap(), "3150", "a template can say ${{WT_SERVER_PORT}}");
        assert_eq!(m.get("WT_FRONT_END_PORT").unwrap(), "8232");
    }

    #[test]
    fn name_slug_never_clobbers_an_id_var() {
        // a service literally named after another service's id must not steal it
        let services = vec![
            ("server".to_string(), "Server".to_string(), 3000u32),
            ("svc-2".to_string(), "server".to_string(), 4000u32),
        ];
        let m = build_wt_vars("/w/main", 0, derived_db_name("r", "/w/main"), &services);
        assert_eq!(m.get("WT_SERVER_PORT").unwrap(), "3000", "id-based var wins");

    }

    #[test]
    fn effective_port_prefers_override() {
        let mut overrides = HashMap::new();
        assert_eq!(effective_port(&overrides, "k", 3000, 2), 3020, "derived = base + idx*10");
        overrides.insert("k".to_string(), 4321);
        assert_eq!(effective_port(&overrides, "k", 3000, 2), 4321, "override wins");
    }
}
