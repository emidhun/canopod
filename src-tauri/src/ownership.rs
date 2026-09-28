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
    data: std::path::PathBuf,
    credential_serial: parking_lot::Mutex<u64>,
}

impl RuntimeOwner {
    pub(crate) fn credential_mutation(&self, data: &Path) -> std::io::Result<parking_lot::MutexGuard<'_, u64>> {
        if data != self.data { return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "credential writer requires ownership of its data directory")) }
        Ok(self.credential_serial.lock())
    }

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
        Ok(Self { lock: file, data: fs::canonicalize(data_dir).map_err(|e| e.to_string())?, credential_serial: parking_lot::Mutex::new(0) })
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
/// visible in the process table for the default-directory CLI host. Library
/// hosts and explicitly isolated directories do not run this global check.
pub fn refuse_legacy_desktop() -> Result<(), String> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let own = Pid::from_u32(std::process::id());
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
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

/// Raw kernel creation identity, stable when the system clock is stepped.
#[cfg(target_os = "linux")]
fn process_start_token(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(')')?.1.split_whitespace().nth(19)?.parse().ok()
}
#[cfg(target_os = "macos")]
fn process_start_token(pid: u32) -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    if unsafe { libc::proc_pidinfo(pid as i32, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) } != size { return None }
    let info = unsafe { info.assume_init() };
    info.pbi_start_tvsec.checked_mul(1_000_000)?.checked_add(info.pbi_start_tvusec)
}
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn process_start_token(_: u32) -> Option<u64> { None }

#[cfg(unix)]
pub(crate) fn current_process_owner() -> Option<crate::settings::ProcessOwner> {
    let pid = std::process::id(); let started = process_start_token(pid)?;
    (started > 0).then_some(crate::settings::ProcessOwner { pid, started })
}

#[cfg(unix)]
pub(crate) fn group_may_be_alive(pgid: i32) -> bool {
    pgid > 1 && (unsafe { libc::killpg(pgid, 0) } == 0
        || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH))
}

#[cfg(unix)]
pub(crate) fn orphan_owner_gone(pid: u32, owner: Option<&crate::settings::ProcessOwner>) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    if let Some(owner) = owner {
        if owner.pid <= 1 || owner.pid > i32::MAX as u32 || owner.started == 0 {
            return false;
        }
        // ESRCH proves absence; access denied or incomplete metadata does not.
        if unsafe { libc::kill(owner.pid as i32, 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            return true;
        }
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[Pid::from_u32(owner.pid)]),
            false,
            ProcessRefreshKind::nothing(),
        );
        return system.process(Pid::from_u32(owner.pid)).is_some_and(|p| p.status() == sysinfo::ProcessStatus::Zombie)
            || process_start_token(owner.pid).is_some_and(|started| started > 0 && started != owner.started);
    }
    orphan_parent_verified(pid)
}

/// Old records have no owner identity. Only known init/reaper processes qualify;
/// new records recover under arbitrary subreapers by proving their owner died.
#[cfg(unix)]
pub(crate) fn orphan_parent_verified(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        false,
        ProcessRefreshKind::nothing(),
    );
    let Some(parent) = system.process(pid).and_then(|p| p.parent()) else {
        return false;
    };
    if parent.as_u32() == 1 {
        return true;
    }
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[parent]),
        false,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    system
        .process(parent)
        .and_then(|p| p.exe())
        .is_some_and(|path| {
            matches!(
                path.to_str(),
                Some(
                    "/usr/lib/systemd/systemd"
                        | "/lib/systemd/systemd"
                        | "/sbin/init"
                        | "/sbin/tini"
                        | "/usr/bin/tini"
                        | "/usr/bin/dumb-init"
                )
            )
        })
}

/// Check all recorded candidates before either sweeper writes state.json.
/// PID identity checks alone cannot distinguish legacy live children.
pub fn verify_recovery(state: &crate::settings::RuntimeState) -> Result<(), String> {
    #[cfg(unix)]
    for (kind, pid, started, owner) in state
        .orphans
        .iter()
        .map(|o| ("orphans", o.pgid, o.spawn_time_secs, o.owner.as_ref()))
        .chain(state.terminal_orphans.iter().map(|o| {
            (
                "terminalOrphans",
                o.pgid,
                o.spawn_time_secs,
                o.owner.as_ref(),
            )
        }))
    {
        if pid <= 1 {
            continue;
        }
        let live = group_may_be_alive(pid);
        if live
            && (started == 0
                || (crate::services::proc_start_time_matches(pid as u32, started)
                    && !orphan_owner_gone(pid as u32, owner)))
        {
            return Err(format!("cannot verify state.json {kind} record for process group {pid}; no process was signalled. Inspect the saved record and running process identity. If the record is stale, preserve a backup and remove only that record before restarting; do not kill an unrelated process"));
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

    #[test]
    fn dropping_owner_unlocks_even_with_a_cloned_file() {
        let dir = directory();
        let owner = RuntimeOwner::acquire(&dir).unwrap();
        let duplicate = owner.lock.try_clone().unwrap();
        drop(owner);
        let next = RuntimeOwner::acquire(&dir).unwrap();
        drop(next);
        drop(duplicate);
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
