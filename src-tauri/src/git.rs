use serde::Serialize;
use std::time::Duration;
use tokio::process::Command;

/// Local git operations (status, rev-parse, checkout…). Generous — a checkout
/// on a huge repo takes time — but bounded: an unresponsive git (dead network
/// mount, wedged index.lock) must not hang a command forever.
const GIT_TIMEOUT: Duration = Duration::from_secs(300);
/// Network operations (fetch, pull, submodule clone/update) get longer.
const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(900);

pub async fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    run_git_with_timeout(cwd, args, GIT_TIMEOUT).await
}

/// For fetch/pull/submodule-transfer calls — same semantics, longer leash.
async fn run_git_net(cwd: &str, args: &[&str]) -> Result<String, String> {
    run_git_with_timeout(cwd, args, GIT_NETWORK_TIMEOUT).await
}

/// The user's configured git credentials, captured once per run.
///
/// A process-wide `OnceLock` rather than a lookup per git call: `run_git` has
/// no `AppHandle`, is called from dozens of places including hot refresh
/// paths, and threading state through all of them to read two rarely-changed
/// strings would be a large diff for no behavioural gain. `apply_credentials`
/// is called at startup and after every settings save.
static GIT_CREDENTIALS: std::sync::OnceLock<parking_lot::RwLock<(String, String)>> = std::sync::OnceLock::new();

fn credentials() -> &'static parking_lot::RwLock<(String, String)> {
    GIT_CREDENTIALS.get_or_init(|| parking_lot::RwLock::new((String::new(), String::new())))
}

/// Publish the configured SSH key and credential helper to every later git
/// call. Idempotent; safe to call on every settings save.
pub fn apply_credentials(ssh_key: &str, credential_helper: &str) {
    *credentials().write() = (ssh_key.trim().to_string(), credential_helper.trim().to_string());
}

async fn run_git_with_timeout(cwd: &str, args: &[&str], dur: Duration) -> Result<String, String> {
    let (ssh_key, helper) = credentials().read().clone();
    let mut cmd = Command::new("git");
    // `-c` before the subcommand, so it applies to this invocation only and
    // never edits the user's repo or global config
    if !helper.is_empty() {
        // Clear the inherited multi-valued helper list before selecting one.
        cmd.args(["-c", "credential.helper="]).arg("-c").arg(format!("credential.helper={helper}"));
    }
    cmd.arg("-C").arg(cwd).args(args);
    if !ssh_key.is_empty() {
        // IdentitiesOnly stops ssh-agent offering every other key first, which
        // is what makes "I selected a key and it still used the wrong one"
        // happen. The path is quoted for the shell git builds from this string.
        cmd.env("GIT_SSH_COMMAND", format!("ssh -i '{}' -o IdentitiesOnly=yes", ssh_key.replace('\'', "'\\''")));
    }
    if crate::jobs::is_cancelled() { return Err("operation interrupted by shutdown".into()); }
    cmd.kill_on_drop(true).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    crate::proc::prepare_group_command(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("failed to run git: {e}"))?;
    let mut group = match crate::proc::CommandGroup::attach(child.id().unwrap_or(0)) {
        Ok(group) => group,
        Err(error) => { let _ = child.kill().await; return Err(error); }
    };
    let out = tokio::select! {
        biased;
        _ = crate::jobs::cancelled() => return Err("operation interrupted by shutdown".into()),
        result = tokio::time::timeout(dur, child.wait_with_output()) => match result {
            Ok(res) => { group.disarm(); res.map_err(|e| format!("failed to run git: {e}"))? },
            Err(_) => return Err(format!("git {} timed out after {}s", args.first().copied().unwrap_or(""), dur.as_secs())),
        },
    };
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub is_main: bool,
    /// git flags this when the worktree's directory is gone (deleted outside
    /// Canopod). Such an entry is dead weight until `git worktree prune`.
    pub prunable: bool,
}

/// `git worktree list --porcelain` — first entry is the main working tree.
pub async fn list_worktrees(repo_path: &str) -> Result<Vec<WorktreeInfo>, String> {
    let out = run_git(repo_path, &["worktree", "list", "--porcelain"]).await?;
    Ok(parse_worktree_list(&out)
        .into_iter()
        .map(|mut worktree| {
            if let Ok(path) = std::fs::canonicalize(&worktree.path) {
                worktree.path = display_path(&path);
            }
            worktree
        })
        .collect())
}

fn display_path(path: &std::path::Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_owned();
        }
    }
    value.into_owned()
}

/// Pure parser for `git worktree list --porcelain` output.
fn parse_worktree_list(porcelain: &str) -> Vec<WorktreeInfo> {
    struct Entry {
        path: String,
        branch: Option<String>,
        bare: bool,
        prunable: bool,
    }
    let mut entries: Vec<Entry> = Vec::new();
    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            entries.push(Entry { path: p.to_string(), branch: None, bare: false, prunable: false });
        } else if let Some(e) = entries.last_mut() {
            if let Some(b) = line.strip_prefix("branch ") {
                e.branch = Some(b.trim_start_matches("refs/heads/").to_string());
            } else if line == "bare" {
                e.bare = true;
            } else if line == "detached" {
                e.branch = Some("(detached)".into());
            } else if line == "prunable" || line.starts_with("prunable ") {
                // git emits `prunable <reason>` when the working dir is gone
                e.prunable = true;
            }
        }
    }

    entries
        .into_iter()
        .filter(|e| !e.bare)
        .enumerate()
        .map(|(i, e)| WorktreeInfo {
            path: e.path,
            branch: e.branch.unwrap_or_else(|| "(detached)".into()),
            is_main: i == 0,
            prunable: e.prunable,
        })
        .collect()
}

/// Prunable worktrees for a repo — entries whose directory was deleted outside
/// Canopod. Drives the Sync-prune prompt.
pub async fn list_prunable(repo_path: &str) -> Result<Vec<WorktreeInfo>, String> {
    Ok(list_worktrees(repo_path).await?.into_iter().filter(|w| w.prunable).collect())
}

/// Delete a local branch (best-effort at the call site is fine; here we surface
/// the error so the prune flow can report it).
pub async fn delete_local_branch(repo_path: &str, branch: &str) -> Result<(), String> {
    run_git(repo_path, &["branch", "-D", branch]).await.map(|_| ())
}

/// `git worktree prune` — drops the admin entries of every worktree whose
/// directory is missing. Repo-wide by git's design (there is no per-path prune).
pub async fn prune_worktrees(repo_path: &str) -> Result<(), String> {
    run_git(repo_path, &["worktree", "prune"]).await.map(|_| ())
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitMeta {
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,
    pub last_commit_ts: i64,
    pub last_commit_msg: String,
}

pub async fn git_meta(wt_path: &str) -> Result<GitMeta, String> {
    let status = run_git(wt_path, &["status", "--porcelain=v2", "--branch"]).await?;
    let mut meta = parse_status_meta(&status);
    if let Ok(log) = run_git(wt_path, &["log", "-1", "--format=%ct%x09%s"]).await {
        let (ts, msg) = parse_last_commit(&log);
        meta.last_commit_ts = ts;
        meta.last_commit_msg = msg;
    }
    Ok(meta)
}

/// Pure parser for `git status --porcelain=v2 --branch`: ahead/behind + dirty.
fn parse_status_meta(status: &str) -> GitMeta {
    let mut meta = GitMeta::default();
    for line in status.lines() {
        if let Some(ab) = line.strip_prefix("# branch.ab ") {
            // "+A -B"
            for part in ab.split_whitespace() {
                if let Some(a) = part.strip_prefix('+') {
                    meta.ahead = a.parse().unwrap_or(0);
                } else if let Some(b) = part.strip_prefix('-') {
                    meta.behind = b.parse().unwrap_or(0);
                }
            }
        } else if !line.starts_with('#') && !line.trim().is_empty() {
            meta.dirty = true;
        }
    }
    meta
}

/// Pure parser for `git log -1 --format=%ct%x09%s`.
fn parse_last_commit(log: &str) -> (i64, String) {
    let mut it = log.trim_end().splitn(2, '\t');
    let ts = it.next().and_then(|t| t.trim().parse().ok()).unwrap_or(0);
    let msg = it.next().unwrap_or("").to_string();
    (ts, msg)
}

/// (name, path) pairs from a worktree's .gitmodules (empty if none).
async fn submodule_entries(wt_path: &str) -> Vec<(String, String)> {
    if !std::path::Path::new(wt_path).join(".gitmodules").exists() {
        return Vec::new();
    }
    let out = run_git(
        wt_path,
        &["config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$"],
    )
    .await
    .unwrap_or_default();
    out.lines()
        .filter_map(|l| {
            let (key, path) = l.split_once(' ')?;
            let name = key.strip_prefix("submodule.")?.strip_suffix(".path")?;
            Some((name.to_string(), path.to_string()))
        })
        .collect()
}

/// Fast-forward pull, then bring submodules up to date. A bare
/// `submodule update` only pins submodules back to the superproject's recorded
/// commit — it never advances them (the reported "pull skips submodules" bug).
/// Per submodule:
///   - checked out on a branch → `git pull --ff-only` inside it
///   - detached but .gitmodules pins a branch (the ToolJet flow:
///     `branch = lts-3.16`) → `submodule update --remote` to that branch's tip
///   - otherwise → sync to the recorded commit as before
pub async fn pull(wt_path: &str) -> Result<String, String> {
    // Superproject fast-forward. A worktree branch with no upstream (or a
    // non-ff remote) shouldn't block pulling submodules that DO track a branch,
    // so this failure is soft — recorded, then we still update submodules.
    let super_res = run_git_net(wt_path, &["pull", "--ff-only"]).await;

    let mods = submodule_entries(wt_path).await;
    if mods.is_empty() {
        return super_res.map(|_| "pulled".into());
    }

    let mut pulled = 0usize;
    let mut synced = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for (name, sm) in &mods {
        let sm_path = format!("{wt_path}/{sm}");
        // on a branch? (fails when detached or not yet initialized)
        let on_branch = run_git(&sm_path, &["symbolic-ref", "-q", "--short", "HEAD"])
            .await
            .map(|b| !b.trim().is_empty())
            .unwrap_or(false);
        let tracks_branch = run_git(
            wt_path,
            &["config", "-f", ".gitmodules", "--get", &format!("submodule.{name}.branch")],
        )
        .await
        .map(|b| !b.trim().is_empty())
        .unwrap_or(false);
        // -c protocol.file.allow=always: submodules with local/relative URLs
        // would otherwise be blocked by git's file-protocol default
        let result = if on_branch {
            run_git_net(&sm_path, &["pull", "--ff-only"]).await.map(|_| pulled += 1)
        } else if tracks_branch {
            run_git_net(
                wt_path,
                &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--remote", "--recursive", "--", sm],
            )
            .await
            .map(|_| pulled += 1)
        } else {
            run_git_net(
                wt_path,
                &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "--", sm],
            )
            .await
            .map(|_| synced += 1)
        };
        if let Err(e) = result {
            errors.push(format!("{sm}: {e}"));
        }
    }

    if !errors.is_empty() {
        // include the superproject failure too — it would otherwise be lost
        let super_note = match &super_res {
            Err(e) => format!("; superproject: {}", e.lines().next().unwrap_or("not pulled").trim()),
            Ok(_) => String::new(),
        };
        return Err(format!("submodule(s) failed — {}{super_note}", errors.join("; ")));
    }
    let mut parts = Vec::new();
    match &super_res {
        Ok(_) => parts.push("pulled".to_string()),
        Err(e) => {
            let short = e.lines().next().map(|l| l.trim()).unwrap_or("superproject not pulled").to_string();
            parts.push(format!("superproject skipped ({short})"));
        }
    }
    if pulled > 0 {
        parts.push(format!("{pulled} submodule(s) pulled"));
    }
    if synced > 0 {
        parts.push(format!("{synced} submodule(s) synced"));
    }
    Ok(parts.join(", "))
}

/// Per-submodule state for the pull menu: which branch it's on (or detached),
/// whether it has local changes, and whether it has moved ahead of the commit
/// the superproject pins (the same-branch workflow drifts here by design).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleStatus {
    pub name: String,
    /// path relative to the worktree root
    pub path: String,
    /// branch name, or None when detached
    pub branch: Option<String>,
    /// short HEAD sha
    pub sha: String,
    pub dirty: bool,
    /// HEAD is a descendant of the pinned commit (moved forward on a branch)
    pub ahead: bool,
    /// "clean" | "attention" | "detached" — drives the row's status dot
    pub status: String,
}

/// Status of every submodule in a worktree (empty when the repo has none).
pub async fn submodule_status(wt_path: &str) -> Vec<SubmoduleStatus> {
    let mut out = Vec::new();
    for (name, sm) in submodule_entries(wt_path).await {
        let sm_path = format!("{wt_path}/{sm}");
        let branch = run_git(&sm_path, &["symbolic-ref", "-q", "--short", "HEAD"])
            .await
            .ok()
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty());
        let sha = run_git(&sm_path, &["rev-parse", "--short", "HEAD"])
            .await
            .unwrap_or_default()
            .trim()
            .to_string();
        let dirty = run_git(&sm_path, &["status", "--porcelain"])
            .await
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);

        // compare HEAD against the commit the superproject records for this path
        let pinned = run_git(wt_path, &["rev-parse", &format!("HEAD:{sm}")])
            .await
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let head_full = run_git(&sm_path, &["rev-parse", "HEAD"]).await.unwrap_or_default().trim().to_string();
        let drifted = pinned.as_deref().map(|p| !head_full.is_empty() && p != head_full).unwrap_or(false);
        // ahead = pinned commit is an ancestor of HEAD (moved forward, not diverged)
        let ahead = if drifted {
            if let Some(p) = &pinned {
                run_git(&sm_path, &["merge-base", "--is-ancestor", p, "HEAD"]).await.is_ok()
            } else {
                false
            }
        } else {
            false
        };
        let diverged = drifted && !ahead;

        let status = if branch.is_none() {
            "detached"
        } else if dirty || diverged {
            "attention"
        } else {
            "clean"
        };

        out.push(SubmoduleStatus {
            name,
            path: sm,
            branch,
            sha,
            dirty,
            ahead,
            status: status.to_string(),
        });
    }
    out
}

/// Pull a single submodule — same rules as the worktree-wide `pull`:
///   - on a branch → `git pull --ff-only` inside it
///   - detached but .gitmodules pins a branch (the ToolJet flow) →
///     `submodule update --remote` to that branch's tip
///   - otherwise → sync to the superproject's recorded commit
pub async fn pull_submodule(wt_path: &str, sm: &str) -> Result<String, String> {
    let sm_path = format!("{wt_path}/{sm}");
    // .gitmodules keys are by submodule NAME (usually == path, but resolve it)
    let name = submodule_entries(wt_path)
        .await
        .into_iter()
        .find(|(_, p)| p == sm)
        .map(|(n, _)| n)
        .unwrap_or_else(|| sm.to_string());
    let on_branch = run_git(&sm_path, &["symbolic-ref", "-q", "--short", "HEAD"])
        .await
        .map(|b| !b.trim().is_empty())
        .unwrap_or(false);
    let tracks_branch = run_git(
        wt_path,
        &["config", "-f", ".gitmodules", "--get", &format!("submodule.{name}.branch")],
    )
    .await
    .map(|b| !b.trim().is_empty())
    .unwrap_or(false);

    if on_branch {
        run_git_net(&sm_path, &["pull", "--ff-only"]).await?;
        Ok("pulled".into())
    } else if tracks_branch {
        run_git_net(
            wt_path,
            &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--remote", "--recursive", "--", sm],
        )
        .await?;
        Ok("pulled".into())
    } else {
        run_git_net(
            wt_path,
            &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "--", sm],
        )
        .await?;
        Ok("synced".into())
    }
}

/// Check out `branch` in a submodule. Refuses when the submodule is dirty.
/// Accepts a local name or a remote-qualified ref (origin/x) → creates a
/// tracking branch; falls back to creating the branch from HEAD if it's new.
pub async fn switch_submodule_branch(wt_path: &str, sm: &str, branch: &str) -> Result<(), String> {
    let sm_path = format!("{wt_path}/{sm}");
    let dirty = run_git(&sm_path, &["status", "--porcelain"])
        .await
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if dirty {
        return Err(format!("{sm} has uncommitted changes — commit or stash before switching branch"));
    }

    let short = branch.strip_prefix("origin/").unwrap_or(branch);
    let local_exists = run_git(&sm_path, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{short}")])
        .await
        .is_ok();
    if local_exists {
        run_git(&sm_path, &["checkout", short]).await?;
        return Ok(());
    }

    let remote_ref = if branch.starts_with("origin/") { branch.to_string() } else { format!("origin/{short}") };
    let remote_exists = run_git(&sm_path, &["rev-parse", "--verify", "--quiet", &remote_ref]).await.is_ok();
    if remote_exists {
        run_git(&sm_path, &["checkout", "-b", short, "--track", &remote_ref]).await?;
    } else {
        run_git(&sm_path, &["checkout", branch]).await?;
    }
    Ok(())
}

/// Branches available inside a submodule (for the switch picker).
pub async fn list_submodule_branches(wt_path: &str, sm: &str) -> Result<Branches, String> {
    let sm_path = format!("{wt_path}/{sm}");
    list_branches(&sm_path).await
}

/// Switch a worktree to a different branch IN PLACE — same folder, so
/// node_modules / build output are reused (no reinstall). `create` makes a new
/// branch from `base` (defaults to current HEAD). Git refuses if the branch is
/// already checked out in another worktree; that error is surfaced as-is.
/// After the checkout, submodules are re-pinned to the new branch's recorded
/// commits — a plain checkout leaves them on the old branch's pins, which reads
/// as spurious dirt/drift on submodule-heavy repos.
pub async fn switch_branch(wt_path: &str, branch: &str, create: bool, base: Option<&str>) -> Result<(), String> {
    if create {
        match base {
            Some(b) if !b.trim().is_empty() => {
                run_git(wt_path, &["checkout", "-b", branch, b]).await?;
            }
            _ => {
                run_git(wt_path, &["checkout", "-b", branch]).await?;
            }
        }
    } else {
        // plain checkout; git DWIMs a tracking branch from origin/<branch> if needed
        run_git(wt_path, &["checkout", branch]).await?;
    }
    // sync submodules to the new branch's pins (no-op when there are none).
    // The branch HAS switched at this point, so a sync failure says so.
    if !submodule_entries(wt_path).await.is_empty() {
        run_git_net(
            wt_path,
            &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"],
        )
        .await
        .map_err(|e| format!("switched to {branch}, but submodule update failed:\n{e}"))?;
    }
    Ok(())
}

/// Put every submodule back on the commit the parent pins: `submodule sync`
/// (re-reads URLs from .gitmodules, which a branch change can rewrite) then
/// `submodule update --init --recursive`.
///
/// This is the counterpart to Pull, not a variant of it: Pull moves submodules
/// FORWARD onto their own branches, while this moves them back to what the
/// parent commit says — the repair for "my submodules are on the wrong commit".
/// Returns how many submodules the worktree has.
pub async fn sync_submodules(wt_path: &str) -> Result<usize, String> {
    let subs = submodule_entries(wt_path).await;
    if subs.is_empty() {
        return Ok(0);
    }
    run_git(wt_path, &["submodule", "sync", "--recursive"]).await?;
    run_git_net(
        wt_path,
        &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"],
    )
    .await?;
    Ok(subs.len())
}

/// `git fetch --prune` inside every submodule so ahead/behind-of-remote and
/// drift are computed against fresh remote refs. Best-effort per submodule.
pub async fn fetch_submodules(wt_path: &str) -> usize {
    let mut n = 0usize;
    for (_name, sm) in submodule_entries(wt_path).await {
        let sm_path = format!("{wt_path}/{sm}");
        if run_git_net(&sm_path, &["fetch", "--prune"]).await.is_ok() {
            n += 1;
        }
    }
    n
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub local: Vec<String>,
    pub remote: Vec<String>,
    pub tags: Vec<String>,
}

/// `git fetch --all --prune` to refresh remote-tracking branches, recursing
/// into submodules so their objects are fetched too.
pub async fn fetch_all(repo_path: &str) -> Result<(), String> {
    run_git_net(repo_path, &["fetch", "--all", "--prune", "--recurse-submodules"])
        .await
        .map(|_| ())
}

pub async fn list_branches(repo_path: &str) -> Result<Branches, String> {
    let local = run_git(
        repo_path,
        &["for-each-ref", "refs/heads", "--format=%(refname:short)"],
    )
    .await?;
    let remote = run_git(
        repo_path,
        &["for-each-ref", "refs/remotes", "--format=%(refname:short)"],
    )
    .await?;
    // newest tags first — release tags are usually what worktrees branch from
    let tags = run_git(
        repo_path,
        &["for-each-ref", "refs/tags", "--sort=-creatordate", "--format=%(refname:short)"],
    )
    .await
    .unwrap_or_default();
    Ok(Branches {
        local: local.lines().map(|s| s.to_string()).collect(),
        remote: remote
            .lines()
            .filter(|s| !s.ends_with("/HEAD"))
            .map(|s| s.to_string())
            .collect(),
        tags: tags.lines().map(|s| s.to_string()).collect(),
    })
}

/// Validate a path is a git repo work-tree root; returns canonical top-level path.
pub async fn validate_repo(path: &str) -> Result<String, String> {
    let top = run_git(path, &["rev-parse", "--show-toplevel"]).await?;
    Ok(top.trim().to_string())
}

/// Submodule paths declared in a worktree's .gitmodules (empty if none).
pub async fn submodule_paths(wt_path: &str) -> Vec<String> {
    if !std::path::Path::new(wt_path).join(".gitmodules").exists() {
        return Vec::new();
    }
    let out = run_git(
        wt_path,
        &["config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$"],
    )
    .await
    .unwrap_or_default();
    out.lines()
        .filter_map(|l| l.split_once(' ').map(|(_, p)| p.to_string()))
        .collect()
}

/// `git worktree add` + submodule init with object sharing against the main
/// checkout. Progress lines stream through `progress`.
pub async fn create_worktree(
    repo_path: &str,
    wt_path: &str,
    branch: &str,
    base: Option<&str>,
    create_branch: bool,
    progress: impl FnMut(String),
) -> Result<(), String> {
    create_worktree_tracked(repo_path, wt_path, branch, base, create_branch, progress, None).await
}

pub(crate) async fn create_worktree_tracked(
    repo_path: &str, wt_path: &str, branch: &str, base: Option<&str>, create_branch: bool,
    mut progress: impl FnMut(String), tracking: Option<&crate::jobs::Tracking>,
) -> Result<(), String> {
    progress(format!("git worktree add {wt_path}"));
    if create_branch {
        let base = base.unwrap_or("HEAD");
        run_git(repo_path, &["worktree", "add", wt_path, "-b", branch, base]).await?;
        if let Some(tracking) = tracking { tracking.created(wt_path).await.map_err(|e| e.to_string())?; }
    } else {
        run_git(repo_path, &["worktree", "add", wt_path, branch]).await?;
        if let Some(tracking) = tracking { tracking.created(wt_path).await.map_err(|e| e.to_string())?; }
        // A remote pick reusing an existing local branch passes the origin ref
        // as `base`. Fast-forward the checkout to it so the worktree (and the
        // submodule commits it pins) reflect origin rather than a stale local
        // branch — the "created before pulling" regression. ff-only never
        // discards local commits; a diverged branch simply stays put.
        if let Some(b) = base.map(str::trim).filter(|b| !b.is_empty()) {
            if let Err(e) = run_git(wt_path, &["merge", "--ff-only", b]).await {
                progress(format!("note: could not fast-forward {branch} to {b} — left as-is ({e})"));
            }
        }
    }

    let subs = submodule_paths(wt_path).await;
    if subs.is_empty() {
        return Ok(());
    }

    progress(format!("initializing {} submodule(s)…", subs.len()));
    run_git(wt_path, &["submodule", "init"]).await?;

    for sm in &subs {
        // Share objects with the main checkout's submodule clone (near-zero
        // transfer); plain clone as fallback. NOTE: alternates mean the main
        // checkout's .git/modules must never be deleted/GC'd while linked
        // worktrees exist.
        let reference = format!("{repo_path}/{sm}");
        let with_ref = std::path::Path::new(&reference).exists();
        progress(format!("submodule {sm}{}", if with_ref { " (sharing objects)" } else { "" }));

        // -c protocol.file.allow=always: submodules with relative/local URLs
        // would otherwise be blocked by git's file-protocol default
        let result = if with_ref {
            run_git_net(
                wt_path,
                &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "--reference", &reference, "--", sm],
            )
            .await
        } else {
            Err("no reference".into())
        };
        if result.is_err() {
            progress(format!("submodule {sm}: falling back to full clone"));
            run_git_net(
                wt_path,
                &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "--", sm],
            )
            .await?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyReport {
    pub dirty: bool,
    /// first entries only (see `total` for the full count)
    pub details: Vec<String>,
    /// total changed paths — `details` is capped for display
    pub total: usize,
}

/// Dirty check covering the worktree AND its submodules. A failed `git status`
/// (index.lock held, corrupt repo, permissions) is an ERROR, never "clean" —
/// this report is what arms a `worktree remove --force`.
pub async fn dirty_report(wt_path: &str) -> Result<DirtyReport, String> {
    let out = run_git(wt_path, &["status", "--porcelain", "--ignore-submodules=none"]).await?;
    let lines: Vec<&str> = out.lines().filter(|l| !l.trim().is_empty()).collect();
    Ok(DirtyReport {
        dirty: !lines.is_empty(),
        details: lines.iter().take(10).map(|l| l.to_string()).collect(),
        total: lines.len(),
    })
}

/// One row of `git status --porcelain`, resolved enough for the Uncommitted
/// changes modal to group and annotate it without re-parsing on the frontend.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    /// the two-character XY porcelain code, verbatim (" M", "MM", "??", "UU", …)
    pub code: String,
    /// path relative to the worktree root (the NEW name for a rename)
    pub path: String,
    /// the pre-rename path for R/C entries; None otherwise
    pub from: Option<String>,
    /// this path is a submodule — a commit/stash/discard here does not reach in
    pub sub: bool,
    /// for a dirty submodule, how many paths are changed INSIDE it
    pub sub_files: Option<usize>,
}

/// Full working-tree status for the modal. Unlike `dirty_report` (which caps at
/// 10 to arm a destructive delete) this returns every entry — the modal lists
/// them all and scrolls, never truncates. A failed `git status` is an ERROR,
/// same fail-closed contract as `dirty_report`.
pub async fn status(wt_path: &str) -> Result<Vec<StatusEntry>, String> {
    // -z NUL-separates records AND path fields, so paths with spaces or the
    // rename "->" survive intact; --ignore-submodules=none surfaces a submodule
    // whose content changed as a ` M` on the submodule path.
    let out = run_git(wt_path, &["status", "--porcelain=v1", "-z", "--ignore-submodules=none"]).await?;
    let subs: std::collections::HashSet<String> = submodule_paths(wt_path).await.into_iter().collect();
    let mut entries = parse_status_z(&out, &subs);
    // annotate dirty submodules with their inner change count (one extra spawn
    // per submodule, and there are rarely more than a handful)
    for e in entries.iter_mut() {
        if e.sub {
            let sm_path = format!("{}/{}", wt_path, e.path);
            if let Ok(o) = run_git(&sm_path, &["status", "--porcelain"]).await {
                e.sub_files = Some(o.lines().filter(|l| !l.trim().is_empty()).count());
            }
        }
    }
    Ok(entries)
}

/// Pure parser for `git status --porcelain=v1 -z`. Each record is `XY<space>path`;
/// a rename/copy (R/C) carries the origin path as the very next NUL field, so we
/// pull it from the same iterator rather than mis-reading it as a fresh entry.
fn parse_status_z(z: &str, subs: &std::collections::HashSet<String>) -> Vec<StatusEntry> {
    let mut fields = z.split('\0');
    let mut entries = Vec::new();
    while let Some(rec) = fields.next() {
        // the trailing NUL yields a final empty field; a real record is "XY p"
        if rec.len() < 4 {
            continue;
        }
        let code = rec[..2].to_string();
        let path = rec[3..].to_string();
        let from = if code.starts_with('R') || code.starts_with('C') {
            fields.next().map(str::to_string)
        } else {
            None
        };
        let sub = subs.contains(&path);
        entries.push(StatusEntry { code, path, from, sub, sub_files: None });
    }
    entries
}

/// Commit the worktree. `git commit -a` picks up tracked modifications and
/// deletions; `add_untracked` first stages new files with `git add -A`. Errors
/// (a failing pre-commit hook, nothing staged) propagate so the modal can show
/// them and keep the message the user typed.
pub async fn commit(wt_path: &str, message: &str, add_untracked: bool) -> Result<(), String> {
    if add_untracked {
        run_git(wt_path, &["add", "-A"]).await?;
    }
    run_git(wt_path, &["commit", "-a", "-m", message]).await?;
    Ok(())
}

/// Stash the worktree. `-u` also stashes untracked files; a non-empty name maps
/// to `-m`. Returns git's own summary line (the stash ref it created).
pub async fn stash(wt_path: &str, name: Option<&str>, include_untracked: bool) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["stash", "push"];
    if include_untracked {
        args.push("-u");
    }
    if let Some(m) = name.map(str::trim).filter(|m| !m.is_empty()) {
        args.push("-m");
        args.push(m);
    }
    run_git(wt_path, &args).await
}

/// Discard tracked changes back to HEAD (`git restore --source=HEAD --staged
/// --worktree -- .`). `clean_untracked` additionally deletes untracked files
/// from disk with `git clean -fd` — irreversible, so the caller must have armed
/// it behind a typed confirmation.
pub async fn discard(wt_path: &str, clean_untracked: bool) -> Result<(), String> {
    run_git(wt_path, &["restore", "--source=HEAD", "--staged", "--worktree", "--", "."]).await?;
    if clean_untracked {
        run_git(wt_path, &["clean", "-fd"]).await?;
    }
    Ok(())
}

/// Remove a worktree. `--force` is required for any worktree containing
/// submodules, even a clean one — the caller must have confirmed with the user.
pub async fn remove_worktree(
    repo_path: &str,
    wt_path: &str,
    branch: Option<&str>,
    delete_branch: bool,
) -> Result<(), String> {
    run_git(repo_path, &["worktree", "remove", "--force", wt_path]).await?;
    if delete_branch {
        if let Some(b) = branch {
            // best-effort: branch may be checked out elsewhere or unmerged
            let _ = run_git(repo_path, &["branch", "-D", b]).await;
        }
    }
    let _ = run_git(repo_path, &["worktree", "prune"]).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worktree_porcelain() {
        let out = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n\
                   worktree /repo-worktrees/feat\nHEAD def456\nbranch refs/heads/feat\n\n\
                   worktree /repo-worktrees/det\nHEAD 987fed\ndetached\n";
        let wts = parse_worktree_list(out);
        assert_eq!(wts.len(), 3);
        assert!(wts[0].is_main && wts[0].branch == "main" && wts[0].path == "/repo");
        assert!(!wts[1].is_main && wts[1].branch == "feat");
        assert_eq!(wts[2].branch, "(detached)");
        assert!(wts.iter().all(|w| !w.prunable), "nothing prunable in a healthy list");
    }

    #[test]
    fn parses_prunable_worktree() {
        // git emits `prunable <reason>` for a worktree whose folder is gone
        let out = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n\
                   worktree /repo-worktrees/gone\nHEAD def\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location\n";
        let wts = parse_worktree_list(out);
        assert_eq!(wts.len(), 2);
        assert!(!wts[0].prunable, "main is healthy");
        assert!(wts[1].prunable && wts[1].branch == "gone");
    }

    #[test]
    fn skips_bare_entries() {
        let out = "worktree /repo.git\nbare\n\nworktree /wt\nHEAD abc\nbranch refs/heads/x\n";
        let wts = parse_worktree_list(out);
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].path, "/wt");
        // NOTE: is_main is positional over the filtered list — a bare main repo
        // promotes the first linked worktree, which matches git's ordering.
        assert!(wts[0].is_main);
    }

    #[test]
    fn parses_status_ahead_behind_dirty() {
        let s = "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +3 -1\n\
                 1 .M N... 100644 100644 100644 abc def src/x.rs\n";
        let m = parse_status_meta(s);
        assert_eq!((m.ahead, m.behind, m.dirty), (3, 1, true));
        let clean = "# branch.oid abc\n# branch.head main\n# branch.ab +0 -0\n";
        let m = parse_status_meta(clean);
        assert_eq!((m.ahead, m.behind, m.dirty), (0, 0, false));
    }

    #[test]
    fn parses_last_commit_line() {
        let (ts, msg) = parse_last_commit("1722500000\tfix: tab\tin message\n");
        assert_eq!(ts, 1722500000);
        assert_eq!(msg, "fix: tab\tin message", "only the first tab splits");
        assert_eq!(parse_last_commit(""), (0, String::new()));
    }

    // ── integration: the real git CLI against throwaway repos ──
    //
    // These exercise the actual plumbing (worktree add/list/remove, status,
    // meta) on whatever git the machine has — the same binary users run.
    // Paths are compared by count/branch, never by string equality, because
    // git canonicalizes (macOS /var → /private/var) and Windows mixes
    // separators.

    fn unique_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("canopod-git-{tag}-{}", std::process::id()))
    }

    async fn init_repo(dir: &std::path::Path) {
        std::fs::create_dir_all(dir).unwrap();
        let d = dir.to_str().unwrap();
        run_git(d, &["init"]).await.unwrap();
        // CI runners have no global identity; commits fail without one
        run_git(d, &["config", "user.email", "canopod-test@localhost"]).await.unwrap();
        run_git(d, &["config", "user.name", "canopod-test"]).await.unwrap();
        run_git(d, &["config", "commit.gpgsign", "false"]).await.unwrap();
        // Windows git defaults to core.autocrlf=true, which rewrites LF→CRLF on
        // checkout/restore and breaks exact-content assertions. Pin it so the
        // round-trip test compares the same bytes on every platform.
        run_git(d, &["config", "core.autocrlf", "false"]).await.unwrap();
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        run_git(d, &["add", "."]).await.unwrap();
        run_git(d, &["commit", "-m", "init"]).await.unwrap();
    }

    #[tokio::test]
    async fn worktree_lifecycle_against_a_real_repo() {
        let repo = unique_dir("life");
        let _ = std::fs::remove_dir_all(&repo);
        init_repo(&repo).await;
        let rp = repo.to_str().unwrap();

        let wts = list_worktrees(rp).await.unwrap();
        assert_eq!(wts.len(), 1, "fresh repo = one main checkout");
        assert!(wts[0].is_main);

        // meta: clean → dirty → clean
        let m = git_meta(rp).await.unwrap();
        assert!(!m.dirty);
        assert_eq!(m.last_commit_msg, "init");
        assert!(m.last_commit_ts > 0);
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        assert!(git_meta(rp).await.unwrap().dirty, "edit must show as dirty");
        run_git(rp, &["checkout", "--", "."]).await.unwrap();

        // linked worktree on a new branch
        let wt = unique_dir("life-wt");
        let _ = std::fs::remove_dir_all(&wt);
        let wtp_owned = wt.to_str().unwrap().to_string();
        let wtp = wtp_owned.as_str();
        create_worktree(rp, wtp, "feat-x", Some("HEAD"), true, |_| {}).await.unwrap();
        assert!(wt.join("a.txt").exists(), "checkout materialized");
        assert_eq!(list_worktrees(rp).await.unwrap().len(), 2);
        let head = run_git(wtp, &["rev-parse", "--abbrev-ref", "HEAD"]).await.unwrap();
        assert_eq!(head.trim(), "feat-x");

        // dirty report: clean, then counts an untracked file
        let r = dirty_report(wtp).await.unwrap();
        assert!(!r.dirty && r.total == 0, "{r:?}");
        std::fs::write(wt.join("b.txt"), "x").unwrap();
        let r = dirty_report(wtp).await.unwrap();
        assert!(r.dirty && r.total == 1, "{r:?}");

        // remove (--force covers the untracked file) + branch deletion
        remove_worktree(rp, wtp, Some("feat-x"), true).await.unwrap();
        assert!(!wt.exists(), "worktree directory removed");
        assert_eq!(list_worktrees(rp).await.unwrap().len(), 1);
        let branches = run_git(rp, &["branch", "--list", "feat-x"]).await.unwrap();
        assert!(branches.trim().is_empty(), "branch deleted: {branches:?}");

        let _ = std::fs::remove_dir_all(&repo);
    }

    /// Sync-prune path: a worktree whose folder is deleted outside Canopod shows
    /// up as prunable, and `prune_worktrees` clears it (+ its branch on request).
    #[tokio::test]
    async fn detects_and_prunes_a_deleted_worktree() {
        let repo = unique_dir("prune");
        let _ = std::fs::remove_dir_all(&repo);
        init_repo(&repo).await;
        let rp = repo.to_str().unwrap();

        let wt = unique_dir("prune-wt");
        let _ = std::fs::remove_dir_all(&wt);
        let wtp = wt.to_str().unwrap().to_string();
        create_worktree(rp, &wtp, "throwaway", Some("HEAD"), true, |_| {}).await.unwrap();
        assert_eq!(list_worktrees(rp).await.unwrap().len(), 2);
        assert!(list_prunable(rp).await.unwrap().is_empty(), "healthy worktree is not prunable");

        // delete the folder out from under git (what a user does in Finder)
        std::fs::remove_dir_all(&wt).unwrap();
        let prunable = list_prunable(rp).await.unwrap();
        assert_eq!(prunable.len(), 1, "the vanished worktree is prunable: {prunable:?}");
        assert_eq!(prunable[0].branch, "throwaway");

        // prune the stale entry FIRST — git won't delete a branch it thinks a
        // (missing) worktree still holds — then delete the branch
        prune_worktrees(rp).await.unwrap();
        delete_local_branch(rp, "throwaway").await.unwrap();
        assert_eq!(list_worktrees(rp).await.unwrap().len(), 1, "only main remains");
        let branches = run_git(rp, &["branch", "--list", "throwaway"]).await.unwrap();
        assert!(branches.trim().is_empty(), "branch deleted: {branches:?}");

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn switch_branch_in_place_and_back() {
        let repo = unique_dir("switch");
        let _ = std::fs::remove_dir_all(&repo);
        init_repo(&repo).await;
        let rp = repo.to_str().unwrap();
        let original = list_worktrees(rp).await.unwrap()[0].branch.clone();

        switch_branch(rp, "feat-y", true, None).await.unwrap();
        let head = run_git(rp, &["rev-parse", "--abbrev-ref", "HEAD"]).await.unwrap();
        assert_eq!(head.trim(), "feat-y");

        // plain checkout back (create=false path)
        switch_branch(rp, &original, false, None).await.unwrap();
        let head = run_git(rp, &["rev-parse", "--abbrev-ref", "HEAD"]).await.unwrap();
        assert_eq!(head.trim(), original);

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn parses_porcelain_z_including_renames_and_submodules() {
        // " M app.tsx\0MM reducer.ts\0?? notes.md\0R  new.ts\0old.ts\0 M ee\0"
        let z = " M app.tsx\0MM reducer.ts\0?? notes.md\0R  new.ts\0old.ts\0 M ee\0";
        let subs: std::collections::HashSet<String> = ["ee".to_string()].into_iter().collect();
        let e = parse_status_z(z, &subs);
        assert_eq!(e.len(), 5, "the rename's origin field must not become a 6th entry");
        assert_eq!(e[0].code, " M");
        assert_eq!(e[0].path, "app.tsx");
        assert_eq!(e[2].code, "??");
        // rename: path is the new name, `from` is the old
        assert_eq!(e[3].code, "R ");
        assert_eq!(e[3].path, "new.ts");
        assert_eq!(e[3].from.as_deref(), Some("old.ts"));
        // submodule flagged from the submodule set
        assert!(e[4].sub && e[4].path == "ee");
        assert!(!e[0].sub);
    }

    #[tokio::test]
    async fn commit_stash_discard_round_trip() {
        let repo = unique_dir("dirty-actions");
        let _ = std::fs::remove_dir_all(&repo);
        init_repo(&repo).await;
        let rp = repo.to_str().unwrap();

        // status reflects a tracked edit + an untracked file
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        std::fs::write(repo.join("new.txt"), "x\n").unwrap();
        let s = status(rp).await.unwrap();
        assert_eq!(s.len(), 2);
        assert!(s.iter().any(|e| e.path == "a.txt" && e.code == " M"));
        assert!(s.iter().any(|e| e.path == "new.txt" && e.code == "??"));

        // commit tracked-only leaves the untracked file behind
        commit(rp, "edit a", false).await.unwrap();
        let s = status(rp).await.unwrap();
        assert_eq!(s.len(), 1, "only the untracked file remains: {s:?}");
        assert_eq!(s[0].path, "new.txt");

        // stash -u sweeps the untracked file; tree goes clean
        stash(rp, Some("wip"), true).await.unwrap();
        assert!(status(rp).await.unwrap().is_empty(), "stash -u clears untracked too");
        run_git(rp, &["stash", "pop"]).await.unwrap();
        assert_eq!(status(rp).await.unwrap().len(), 1);

        // discard with clean removes the untracked file from disk
        std::fs::write(repo.join("a.txt"), "three\n").unwrap();
        discard(rp, true).await.unwrap();
        assert!(status(rp).await.unwrap().is_empty(), "discard + clean = clean tree");
        assert!(!repo.join("new.txt").exists(), "git clean -fd deleted the untracked file");
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "two\n", "restored to HEAD");

        let _ = std::fs::remove_dir_all(&repo);
    }

    /// The add-repo flow (#122) leans on validate_repo to accept a real repo
    /// and reject a plain folder before it registers anything.
    #[tokio::test]
    async fn validate_repo_returns_toplevel_and_rejects_non_repos() {
        let repo = unique_dir("validate");
        let _ = std::fs::remove_dir_all(&repo);
        init_repo(&repo).await;
        let rp = repo.to_str().unwrap();

        let top = validate_repo(rp).await.unwrap();
        // git canonicalizes (/var → /private/var on macOS); compare by basename
        assert_eq!(
            std::path::Path::new(top.trim()).file_name(),
            std::path::Path::new(rp).file_name(),
            "toplevel is the repo dir"
        );

        // a plain directory that isn't a git repo must error, not return a path
        let plain = unique_dir("validate-plain");
        let _ = std::fs::remove_dir_all(&plain);
        std::fs::create_dir_all(&plain).unwrap();
        assert!(validate_repo(plain.to_str().unwrap()).await.is_err(), "a non-repo must be rejected");

        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&plain);
    }

    /// Data-loss guard: this report arms `worktree remove --force`, and a
    /// failed probe must be an ERROR the UI fails closed on — never `clean`.
    #[tokio::test]
    async fn dirty_report_fails_closed_on_a_broken_repo() {
        let missing = unique_dir("never-created");
        let _ = std::fs::remove_dir_all(&missing);
        assert!(
            dirty_report(missing.to_str().unwrap()).await.is_err(),
            "missing path must error, not report clean"
        );
    }
}
