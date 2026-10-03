//! One-time carry-over from the app's previous name. Canopod shipped as
//! "Canopy" through 0.4.x under the bundle identifier below, so an upgraded
//! install finds its settings, runtime state, credentials and webview storage
//! under the old identifier. Each directory moves the first time the renamed
//! app starts, before any plugin, webview or runtime owner touches it.
use std::path::{Path, PathBuf};

pub const LEGACY_APP_ID: &str = "com.midhunkumare.canopy";
/// Per-worktree directory name before the rename (now `.canopod/`).
pub const LEGACY_WORKTREE_DIR: &str = ".canopy";

/// Every per-app directory the OS or the webview keys on the identifier:
/// config, data, local data (WebView2 on Windows), logs and, on macOS, the
/// WKWebView store that holds localStorage.
fn app_dirs(app_id: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for base in [dirs::config_dir(), dirs::data_dir(), dirs::data_local_dir()].into_iter().flatten() {
        let dir = base.join(app_id);
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join("Library/Logs").join(app_id));
        dirs.push(home.join("Library/WebKit").join(app_id));
    }
    dirs
}

fn is_empty_dir(path: &Path) -> bool {
    std::fs::read_dir(path).map(|mut d| d.next().is_none()).unwrap_or(false)
}

/// Move `from` to `to` unless `to` already holds something. An empty `to` is
/// what a plugin leaves when it creates its directory first; it is replaced.
fn carry_over(from: &Path, to: &Path) {
    if !from.is_dir() || (to.exists() && !is_empty_dir(to)) {
        return;
    }
    if to.exists() {
        let _ = std::fs::remove_dir(to);
    }
    if let Some(parent) = to.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::rename(from, to) {
        Ok(()) => log::info!("moved {} to {}", from.display(), to.display()),
        Err(e) => log::warn!("could not move {} to {}: {e}", from.display(), to.display()),
    }
}

/// Move the pre-rename app directories to their new names. Idempotent and
/// best-effort: a failure leaves the old directory in place and the app starts
/// fresh rather than refusing to start.
pub fn migrate_app_dirs(app_id: &str) {
    for (from, to) in app_dirs(LEGACY_APP_ID).into_iter().zip(app_dirs(app_id)) {
        carry_over(&from, &to);
    }
}

/// A worktree's app-owned directory (`.canopod/`), renaming a pre-rename
/// `.canopy/` in place so setup markers and agent context survive.
pub fn worktree_dir(wt_path: &Path) -> PathBuf {
    let dir = wt_path.join(".canopod");
    carry_over(&wt_path.join(LEGACY_WORKTREE_DIR), &dir);
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_dir_renames_the_legacy_directory() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".canopy")).unwrap();
        std::fs::write(tmp.path().join(".canopy/setup.json"), "{}").unwrap();
        let dir = worktree_dir(tmp.path());
        assert_eq!(dir, tmp.path().join(".canopod"));
        assert_eq!(std::fs::read_to_string(dir.join("setup.json")).unwrap(), "{}");
        assert!(!tmp.path().join(".canopy").exists());
    }

    #[test]
    fn carry_over_never_overwrites_existing_contents() {
        let tmp = tempfile::tempdir().unwrap();
        let (old, new) = (tmp.path().join("old"), tmp.path().join("new"));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("settings.json"), "new").unwrap();
        carry_over(&old, &new);
        assert!(old.exists(), "a populated destination leaves the legacy dir alone");
        assert_eq!(std::fs::read_to_string(new.join("settings.json")).unwrap(), "new");
    }

    #[test]
    fn carry_over_replaces_an_empty_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let (old, new) = (tmp.path().join("old"), tmp.path().join("new"));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("state.json"), "old").unwrap();
        std::fs::create_dir_all(&new).unwrap();
        carry_over(&old, &new);
        assert_eq!(std::fs::read_to_string(new.join("state.json")).unwrap(), "old");
        assert!(!old.exists());
    }
}
