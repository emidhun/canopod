//! One runtime owner per data directory, across desktop and headless hosts.
//!
//! Acquire before reading runtime state or sweeping children. The lock file is
//! deliberately never removed: unlinking a locked file would let another
//! process lock a different inode at the same path. Closing the file releases
//! the OS lock, including when the process crashes.
//!
//! Lock-file symlinks and Windows reparse points are refused.
use std::fs::{self, File, OpenOptions};
use std::path::Path;

pub struct RuntimeOwner {
    lock: File,
}

impl RuntimeOwner {
    pub fn acquire(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir)
            .map_err(|e| format!("create runtime directory {}: {e}", data_dir.display()))?;
        let path = data_dir.join("runtime.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
            options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0);
        }
        let file = options
            .open(&path)
            .map_err(|e| format!("open runtime lock {}: {e}", path.display()))?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
            let metadata = file
                .metadata()
                .map_err(|e| format!("stat runtime lock {}: {e}", path.display()))?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
                return Err(format!(
                    "runtime lock is a reparse point: {}",
                    path.display()
                ));
            }
        }
        if !file
            .metadata()
            .map_err(|e| format!("stat runtime lock {}: {e}", path.display()))?
            .is_file()
        {
            return Err(format!(
                "runtime lock is not a regular file: {}",
                path.display()
            ));
        }
        file.try_lock().map_err(|e| match e {
            std::fs::TryLockError::WouldBlock => format!(
                "another Canopy backend owns {}; stop that backend before starting this one",
                data_dir.display()
            ),
            std::fs::TryLockError::Error(e) => {
                format!("lock runtime directory {}: {e}", data_dir.display())
            }
        })?;
        Ok(Self { lock: file })
    }
}

impl Drop for RuntimeOwner {
    fn drop(&mut self) {
        // A concurrent fork can briefly inherit this open file description.
        // Explicit unlock releases ownership without waiting for its exec.
        let _ = self.lock.unlock();
    }
}

/// Legacy desktops predate runtime.lock. Refuse a second engine while one is
/// visible in the process table, even if it might use another data directory.
/// A false positive is recoverable; allowing it to mutate shared state is not.
pub fn refuse_legacy_desktop() -> Result<(), String> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let own = Pid::from_u32(std::process::id());
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    if system.process(own).is_none() {
        return Err("cannot inspect the process table; refusing backend takeover".into());
    }
    for (pid, process) in system.processes() {
        if *pid != own && legacy_name(&process.name().to_string_lossy()) {
            return Err(format!("a Canopy desktop may still own runtime state (pid {pid}); quit it before starting the backend"));
        }
    }
    Ok(())
}

fn legacy_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("canopy") || name.eq_ignore_ascii_case("canopy.exe")
}

/// Only init-parented Unix processes are demonstrably detached from their old
/// owner. Containers with a subreaper deliberately fail closed rather than
/// guessing whether the reaper is an old live desktop. Missing parent metadata
/// is not permission to signal a process group.
#[cfg(unix)]
pub(crate) fn orphan_parent_verified(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), false, ProcessRefreshKind::nothing());
    system.process(pid).and_then(|p| p.parent()).is_some_and(|p| p.as_u32() == 1)
}

/// Check all recorded candidates before either sweeper writes state.json.
/// PID identity checks alone cannot distinguish legacy live children.
pub fn verify_recovery(state: &crate::settings::RuntimeState) -> Result<(), String> {
    #[cfg(unix)]
    for (pid, started) in state.orphans.iter().map(|o| (o.pgid, o.spawn_time_secs))
        .chain(state.terminal_orphans.iter().map(|o| (o.pgid, o.spawn_time_secs))) {
        if pid <= 1 { continue }
        let live = unsafe { libc::killpg(pid, 0) == 0 };
        if live && (started == 0 || (crate::services::proc_start_time_matches(pid as u32, started)
            && !orphan_parent_verified(pid as u32))) {
            return Err(format!("cannot safely recover recorded process group {pid}: its previous owner may still be alive; stop the previous Canopy instance and its children first"));
        }
    }
    #[cfg(not(unix))]
    let _ = state;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn directory() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "canopy-owner-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn exclusive_until_owner_drops() {
        let dir = directory();
        fs::write(dir.join("runtime.lock"), "existing metadata").unwrap();
        let first = RuntimeOwner::acquire(&dir).unwrap();
        assert!(RuntimeOwner::acquire(&dir)
            .err()
            .unwrap()
            .contains("another Canopy backend"));
        drop(first);
        // Windows enforces byte-range locks on reads as well as writes.
        assert_eq!(
            fs::read_to_string(dir.join("runtime.lock")).unwrap(),
            "existing metadata"
        );
        let next = RuntimeOwner::acquire(&dir).unwrap();
        assert!(dir.join("runtime.lock").is_file());
        drop(next);
        fs::remove_dir_all(dir).unwrap();
    }

    // Run by the process test below with a private temp directory. A normal
    // test-suite invocation does nothing. The parent kills us to exercise OS
    // lock release without Rust destructors, as in a backend crash.
    #[test]
    fn child_owner() {
        let Some(dir) = std::env::var_os("CANOPY_TEST_OWNER_DIR") else {
            return;
        };
        let _owner = RuntimeOwner::acquire(Path::new(&dir)).unwrap();
        use std::io::Write;
        println!("OWNER_READY");
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::park();
        }
    }

    #[test]
    fn another_process_is_excluded_and_crash_releases_lock() {
        use std::io::BufRead;
        use std::process::{Command, Stdio};
        let dir = directory();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "ownership::tests::child_owner", "--nocapture"])
            .env("CANOPY_TEST_OWNER_DIR", &dir)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let reader = std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                if line.contains("OWNER_READY") {
                    let _ = tx.send(());
                    break;
                }
            }
        });
        let ready = rx.recv_timeout(std::time::Duration::from_secs(10));
        let excluded = ready.is_ok() && RuntimeOwner::acquire(&dir).is_err();
        let _ = child.kill();
        child.wait().unwrap();
        reader.join().unwrap();
        ready.expect("child did not acquire lock within 10 seconds");
        assert!(excluded, "a second process acquired the live owner's lock");
        let next = RuntimeOwner::acquire(&dir).unwrap();
        drop(next);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn independent_data_directories_have_independent_owners() {
        let a = directory();
        let b = directory();
        let first = RuntimeOwner::acquire(&a).unwrap();
        let second = RuntimeOwner::acquire(&b).unwrap();
        drop((first, second));
        fs::remove_dir_all(a).unwrap();
        fs::remove_dir_all(b).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn directory_alias_cannot_create_second_owner() {
        let root = directory();
        let real = root.join("real");
        let alias = root.join("alias");
        let owner = RuntimeOwner::acquire(&real).unwrap();
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        assert!(RuntimeOwner::acquire(&alias).is_err());
        drop(owner);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn lock_file_symlinks_are_refused() {
        let dir = directory();
        let target = dir.join("user-file");
        fs::write(&target, "preserve me").unwrap();
        std::os::unix::fs::symlink(&target, dir.join("runtime.lock")).unwrap();
        assert!(RuntimeOwner::acquire(&dir).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "preserve me");
        fs::remove_dir_all(dir).unwrap();
    }
}
