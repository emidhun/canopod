// Per-worktree on-disk footprint, for the overview's Size column.
//
// The column answers one question: "what would I reclaim by removing this?"
// That framing settles the two design decisions this module has to make.
//
// 1. WHAT IS COUNTED — everything under the worktree root, `node_modules` and
//    build output included. Those are the bulk of the footprint and they *are*
//    freed by removal, so excluding them would answer a question nobody asked.
//    Ignored-by-git is irrelevant here; git has no opinion about disk.
//
// 2. WHEN IT RUNS — never on the UI path. A recursive walk of a few
//    `node_modules` trees is hundreds of thousands of `stat` calls; making the
//    overview await that would freeze it on open. So scans run on the blocking
//    pool, one at a time, and publish `worktree:disk` when each finishes. The
//    overview renders "—" until a result arrives and never blocks on one.
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use parking_lot::Mutex;
use crate::runtime::RuntimeContext;

/// A completed measurement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub bytes: u64,
    /// unix seconds — the UI shows how stale a figure is rather than implying
    /// it is live
    pub scanned_at: i64,
    /// the walk hit a budget and stopped early, so `bytes` is a floor. Surfaced
    /// rather than hidden: a number that silently under-reports is worse than
    /// one labelled approximate.
    pub partial: bool,
}

/// Re-scan anything older than this when a scan is requested. A worktree's size
/// moves on the scale of installs and builds, not seconds — and each scan is
/// genuinely expensive, so the default is deliberately lazy.
const STALE_AFTER: Duration = Duration::from_secs(10 * 60);

/// Ceilings for a single walk. A worktree containing a runaway directory (or a
/// mount point that shouldn't have been there) must not pin a blocking thread
/// indefinitely — the result is reported `partial` instead.
const MAX_ENTRIES: u64 = 4_000_000;
const MAX_WALL: Duration = Duration::from_secs(90);

#[derive(Default)]
pub struct DiskCache {
    /// wt_key -> last completed measurement
    usage: Mutex<HashMap<String, DiskUsage>>,
    /// worktrees waiting to be walked, in request order
    queue: Mutex<VecDeque<String>>,
    /// is the single drain task alive? Scans are serialized: two concurrent
    /// recursive walks on one disk are slower than the same two in sequence,
    /// and they'd compete with whatever the user is actually running.
    draining: AtomicBool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DiskEvent<'a> {
    wt_key: &'a str,
    #[serde(flatten)]
    usage: DiskUsage,
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Every measurement Canopy currently holds. Read by `get_disk_usage` so a
/// window that opens the overview late gets what earlier scans already found
/// instead of waiting for a re-scan.
pub fn snapshot(app: &RuntimeContext) -> HashMap<String, DiskUsage> {
    app.state::<DiskCache>().usage.lock().clone()
}

/// Drop a worktree's measurement (it was removed, or something invalidated it).
pub fn forget(app: &RuntimeContext, wt_key: &str) {
    {
        let cache = app.state::<DiskCache>();
        cache.usage.lock().remove(wt_key);
        cache.queue.lock().retain(|k| k != wt_key);
    }
}

/// Queue `wt_keys` for measurement, skipping any whose cached figure is still
/// fresh unless `force`. Returns immediately — results arrive as `worktree:disk`.
pub fn request(app: &RuntimeContext, wt_keys: Vec<String>, force: bool) {
    let cache = app.state::<DiskCache>();
    let now = now_secs();
    {
        let usage = cache.usage.lock();
        let mut queue = cache.queue.lock();
        for key in wt_keys {
            if queue.contains(&key) {
                continue; // already waiting — don't walk the same tree twice
            }
            let fresh = !force
                && usage
                    .get(&key)
                    .is_some_and(|u| now.saturating_sub(u.scanned_at) < STALE_AFTER.as_secs() as i64);
            if !fresh {
                queue.push_back(key);
            }
        }
        if queue.is_empty() {
            return;
        }
    }
    // one drain task at a time; a second request just adds to its queue
    if cache.draining.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    app.executor().spawn(async move {
        loop {
            let next = {
                let cache = app.state::<DiskCache>();
                let next = cache.queue.lock().pop_front();
                match next {
                    Some(k) => k,
                    None => {
                        // Clear the flag while still holding no queue lock, then
                        // re-check: a request that landed between the pop and the
                        // clear would otherwise see `draining` true and never be
                        // drained by anyone.
                        cache.draining.store(false, Ordering::Release);
                        if cache.queue.lock().is_empty() {
                            break;
                        }
                        if cache.draining.swap(true, Ordering::AcqRel) {
                            break; // someone else took over
                        }
                        continue;
                    }
                }
            };
            let path = next.clone();
            let measured = app.executor().spawn_blocking(move || measure(&path)).await;
            let Ok(usage) = measured else { continue };
            {
        let cache = app.state::<DiskCache>();
                cache.usage.lock().insert(next.clone(), usage);
            }
            let _ = app.emit("worktree:disk", &DiskEvent { wt_key: &next, usage });
        }
    });
}

/// Walk `root` and total the size of every regular file beneath it.
///
/// Symlinks are stat'd, never followed: following them would double-count a
/// linked package cache and could walk out of the worktree entirely (or in a
/// cycle). The link itself contributes its own tiny size, which is what
/// removing the worktree actually frees.
fn measure(root: &str) -> DiskUsage {
    let started = Instant::now();
    let mut total: u64 = 0;
    let mut entries: u64 = 0;
    let mut partial = false;
    let mut stack: Vec<PathBuf> = vec![PathBuf::from(root)];

    while let Some(dir) = stack.pop() {
        if entries >= MAX_ENTRIES || started.elapsed() > MAX_WALL {
            partial = true;
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            // unreadable directory (permissions, a race with a delete) — skip
            // it rather than abandoning the whole measurement
            continue;
        };
        for entry in rd.flatten() {
            entries += 1;
            let Ok(meta) = entry.metadata_no_follow() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }

    DiskUsage { bytes: total, scanned_at: now_secs(), partial }
}

/// `DirEntry::metadata` already does not follow symlinks on the platforms we
/// ship, but that is a documented behaviour of the *entry*, not of the path —
/// spelling it out here keeps the guarantee explicit and testable.
trait NoFollow {
    fn metadata_no_follow(&self) -> std::io::Result<std::fs::Metadata>;
}

impl NoFollow for std::fs::DirEntry {
    fn metadata_no_follow(&self) -> std::io::Result<std::fs::Metadata> {
        std::fs::symlink_metadata(self.path())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measure_totals_files_recursively() {
        let dir = std::env::temp_dir().join("canopy_disk_test_xyz");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::write(dir.join("a.txt"), vec![0u8; 1000]).unwrap();
        std::fs::write(dir.join("node_modules/pkg/index.js"), vec![0u8; 2500]).unwrap();

        let u = measure(dir.to_str().unwrap());
        assert_eq!(u.bytes, 3500, "counts nested files, node_modules included");
        assert!(!u.partial, "a small tree completes");
        assert!(u.scanned_at > 0, "carries a timestamp");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn measure_does_not_follow_symlinks_out_of_the_tree() {
        let base = std::env::temp_dir().join("canopy_disk_link_test_xyz");
        let _ = std::fs::remove_dir_all(&base);
        let inside = base.join("wt");
        let outside = base.join("elsewhere");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(inside.join("small.txt"), vec![0u8; 100]).unwrap();
        std::fs::write(outside.join("huge.bin"), vec![0u8; 50_000]).unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, inside.join("link")).unwrap();

        let u = measure(inside.to_str().unwrap());
        #[cfg(unix)]
        assert!(u.bytes < 1000, "the 50KB outside the worktree is not counted: {}", u.bytes);
        assert!(u.bytes >= 100, "the real file inside still counts");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn measure_survives_a_missing_root() {
        // a worktree deleted between the request and the walk must not panic
        let u = measure("/canopy/definitely/not/a/real/path");
        assert_eq!(u.bytes, 0);
        assert!(!u.partial, "nothing to walk is complete, not truncated");
    }
}
