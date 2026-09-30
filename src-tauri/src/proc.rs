// Cross-platform process-group control.
//
// Canopy spawns each dev service (and each PTY shell) as a *tree* of processes
// and must be able to tear the whole tree down — a dev server forks watchers,
// bundler workers, nodemon supervisors, etc. On POSIX this is a process group
// (`process_group(0)` + `killpg`). Windows has no process groups, so the tree is
// wrapped in a Job Object with `KILL_ON_JOB_CLOSE`; `TerminateJobObject` kills
// it, and the OS auto-reaps the job when Canopy exits/crashes (which is why the
// persisted-pgid crash sweep in services.rs/terminal.rs is Unix-only).
//
// Everything OS-specific lives behind this module's small API so services.rs and
// terminal.rs never mention libc or the windows crate.

/// Opaque handle to a spawned process group / job.
/// Unix: the child's process-group id. Windows: a Job Object HANDLE.
pub use imp::ProcGroup;

/// Configure a Command for group isolation *before* spawn.
/// Unix: `.process_group(0)`. Windows: `CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP`.
pub use imp::prepare_group_command;

/// Establish the group for a freshly-spawned child and return its handle.
/// Unix: pgid == child pid (already running). Windows: create the Job, assign the
/// (suspended) child, then resume it so every descendant is captured race-free.
pub use imp::attach_group;

/// Graceful stop (maps to SIGTERM). Windows: `TerminateJobObject` (whole tree).
pub use imp::terminate_group;

/// Hard kill (maps to SIGKILL). Windows: `TerminateJobObject` (idempotent).
pub use imp::kill_group;

/// A stable identity for the group (Unix: pgid; Windows: child pid). Only used by
/// the Unix-gated selftest/logging — the stop-race guard uses `generation`.
#[allow(unused_imports)]
pub use imp::group_key;

/// Local UTC offset in seconds, for log timestamps (no chrono dependency).
pub use imp::local_utc_offset_secs;

/// Kills an isolated command tree when its future is cancelled or times out.
/// Disarm after an ordinary wait so a reaped PID can never be killed later.
pub(crate) struct CommandGroup {
    group: Option<ProcGroup>,
    #[cfg(unix)]
    record: Option<crate::jobs::CommandRecord>,
}
impl CommandGroup {
    pub fn attach(pid: u32) -> Result<Self, String> {
        let group = attach_group(pid)?;
        #[cfg(unix)]
        let record = crate::jobs::track_group(&group);
        Ok(Self { group: Some(group), #[cfg(unix)] record })
    }
    pub fn disarm(&mut self) {
        self.group.take();
        #[cfg(unix)]
        self.record.take();
    }
    pub fn kill(&mut self) {
        if let Some(group) = self.group.take() { kill_group(&group); }
        #[cfg(unix)]
        self.record.take();
    }
}
impl Drop for CommandGroup { fn drop(&mut self) { self.kill(); } }

// ───────────────────────────── Unix ─────────────────────────────
#[cfg(unix)]
mod imp {
    use tokio::process::Command;

    pub struct ProcGroup {
        pgid: i32,
    }

    pub fn prepare_group_command(cmd: &mut Command) {
        cmd.process_group(0);
    }

    pub fn attach_group(pid: u32) -> Result<ProcGroup, String> {
        // `process_group(0)` made the child its own group leader: pgid == pid.
        Ok(ProcGroup { pgid: pid as i32 })
    }

    pub fn terminate_group(g: &ProcGroup) {
        unsafe {
            libc::killpg(g.pgid, libc::SIGTERM);
        }
    }

    pub fn kill_group(g: &ProcGroup) {
        unsafe {
            libc::killpg(g.pgid, libc::SIGKILL);
        }
    }

    pub fn group_key(g: &ProcGroup) -> i64 {
        g.pgid as i64
    }

    pub fn local_utc_offset_secs() -> i64 {
        // localtime_r-based offset; cheap and correct for display purposes
        unsafe {
            let t = libc::time(std::ptr::null_mut());
            let mut tm: libc::tm = std::mem::zeroed();
            libc::localtime_r(&t, &mut tm);
            tm.tm_gmtoff as i64
        }
    }
}

// ──────────────────────────── Windows ────────────────────────────
#[cfg(windows)]
mod imp {
    use tokio::process::Command;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, OpenThread, ResumeThread, CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED, PROCESS_SET_QUOTA,
        PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
    };
    use windows::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};

    /// GetTimeZoneInformation returns this (2) when daylight-saving is in effect.
    const TIME_ZONE_ID_DAYLIGHT: u32 = 2;

    /// Owns a Job Object HANDLE. Closing the last handle triggers
    /// KILL_ON_JOB_CLOSE, tearing down the whole tree — which is exactly what we
    /// want when the entry is dropped on stop / exit / crash.
    struct OwnedJobHandle(HANDLE);

    // A Windows kernel HANDLE is a process-wide table index with no thread
    // affinity; passing it between threads is sound, and all access is serialized
    // behind the ProcTable mutex.
    unsafe impl Send for OwnedJobHandle {}
    unsafe impl Sync for OwnedJobHandle {}

    impl Drop for OwnedJobHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    pub struct ProcGroup {
        job: OwnedJobHandle,
        /// kept for parity with the Unix pgid and for diagnostics; only
        /// `group_key` reads it, which nothing on Windows calls (see below)
        #[allow(dead_code)]
        pid: u32,
    }

    pub fn prepare_group_command(cmd: &mut Command) {
        // Spawn suspended so we can assign the child to its Job *before* it runs
        // (and thus before it can fork workers that would escape the job).
        // NEW_PROCESS_GROUP leaves room for a future CTRL_BREAK graceful stop.
        cmd.creation_flags(CREATE_SUSPENDED.0 | CREATE_NEW_PROCESS_GROUP.0);
    }

    pub fn attach_group(pid: u32) -> Result<ProcGroup, String> {
        unsafe {
            let job = CreateJobObjectW(None, PCWSTR::null()).map_err(|e| format!("CreateJobObject: {e}"))?;
            let job = OwnedJobHandle(job);

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|e| format!("SetInformationJobObject: {e}"))?;

            let hproc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
                .map_err(|e| format!("OpenProcess: {e}"))?;
            let assign = AssignProcessToJobObject(job.0, hproc);
            let _ = CloseHandle(hproc);
            assign.map_err(|e| format!("AssignProcessToJobObject: {e}"))?;

            resume_primary_thread(pid)?;
            Ok(ProcGroup { job, pid })
        }
    }

    /// Resume the child's primary thread (the process was created suspended).
    /// tokio's Command doesn't surface the child's thread handle, so find it via a
    /// toolhelp snapshot filtered on the child pid.
    unsafe fn resume_primary_thread(pid: u32) -> Result<(), String> {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0).map_err(|e| format!("snapshot: {e}"))?;
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut resumed = false;
        if Thread32First(snap, &mut entry).is_ok() {
            loop {
                if entry.th32OwnerProcessID == pid {
                    // a CREATE_SUSPENDED process has exactly one thread (the
                    // primary) at this point — resume it, and only count success
                    // if ResumeThread didn't report failure (u32::MAX). Otherwise
                    // the process would stay frozen while marked "running".
                    if let Ok(hthread) = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) {
                        let prev = ResumeThread(hthread);
                        let _ = CloseHandle(hthread);
                        resumed = prev != u32::MAX;
                    }
                    break;
                }
                if Thread32Next(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        if resumed {
            Ok(())
        } else {
            Err("could not resume child's primary thread".into())
        }
    }

    // Exit the job with code 0 so the service waiter treats a user-requested stop
    // as `Stopped`, not `Error` (a non-zero code routes to SvcStatus::Error in
    // services.rs — mirroring how a SIGTERM'd Unix process reports no exit code).
    pub fn terminate_group(g: &ProcGroup) {
        unsafe {
            let _ = TerminateJobObject(g.job.0, 0);
        }
    }

    pub fn kill_group(g: &ProcGroup) {
        unsafe {
            let _ = TerminateJobObject(g.job.0, 0);
        }
    }

    /// Part of the cross-platform API surface, but unused on Windows: its only
    /// callers are the Unix crash-orphan persist and the Unix-gated selftest.
    /// Windows needs neither — KILL_ON_JOB_CLOSE reaps the tree when Canopy
    /// dies, so there are no orphans to record or sweep.
    #[allow(dead_code)]
    pub fn group_key(g: &ProcGroup) -> i64 {
        g.pid as i64
    }

    pub fn local_utc_offset_secs() -> i64 {
        // Windows `Bias` is the negative of the POSIX offset: UTC = local + Bias
        // (minutes). Effective bias includes the seasonal component.
        unsafe {
            let mut tzi = TIME_ZONE_INFORMATION::default();
            let id = GetTimeZoneInformation(&mut tzi);
            let seasonal = if id == TIME_ZONE_ID_DAYLIGHT {
                tzi.DaylightBias
            } else {
                tzi.StandardBias
            };
            -((tzi.Bias + seasonal) as i64) * 60
        }
    }
}

#[cfg(test)]
mod tests {
    /// Cross-platform sanity check — exercises the per-OS offset code (including
    /// the Windows GetTimeZoneInformation path in CI) and guards the sign bug.
    #[test]
    fn utc_offset_is_within_range() {
        let off = super::local_utc_offset_secs();
        assert!(off.abs() <= 14 * 3600, "utc offset out of range: {off}s");
    }
}
