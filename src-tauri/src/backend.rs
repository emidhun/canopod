//! Foreground, GUI-free runtime host. Transports attach in subsequent slices.
use crate::{
    ownership,
    runtime::{Audience, Host, RuntimeContext, RuntimePaths},
    settings,
    state::AppState,
};
use std::{future::Future, sync::Arc, time::Duration};

const APP_ID: &str = "com.midhunkumare.canopy";

/// Keep these identical to Tauri's desktop PathResolver defaults.
pub fn default_paths() -> Result<RuntimePaths, String> {
    let config = dirs::config_dir()
        .ok_or("cannot resolve configuration directory")?
        .join(APP_ID);
    let data = dirs::data_dir()
        .ok_or("cannot resolve data directory")?
        .join(APP_ID);
    #[cfg(target_os = "macos")]
    let logs = dirs::home_dir()
        .ok_or("cannot resolve home directory")?
        .join("Library/Logs")
        .join(APP_ID);
    #[cfg(not(target_os = "macos"))]
    let logs = dirs::data_local_dir()
        .ok_or("cannot resolve local data directory")?
        .join(APP_ID)
        .join("logs");
    Ok(RuntimePaths { config, data, logs })
}

struct HeadlessHost;
impl Host for HeadlessHost {
    fn interested(&self, _: Audience) -> bool {
        false
    }
    fn publish(&self, _: Audience, _: &str, _: serde_json::Value) -> Result<(), String> {
        Ok(())
    }
    fn notify(&self, _: &str, _: &str, _: bool) -> Result<(), String> {
        Ok(())
    }
    fn badge(&self, _: &str, _: i64) {}
}

/// No state is read, quarantined, or swept until runtime ownership is acquired.
/// Every task's context clone retains the OS lock, including during shutdown.
pub fn open(paths: RuntimePaths) -> Result<RuntimeContext, String> {
    let owner = ownership::RuntimeOwner::acquire(&paths.data)?;
    let loaded: settings::Settings = settings::load_checked(&paths.config.join("settings.json"))?;
    let persisted = settings::load_checked(&paths.data.join("state.json"))?;
    ownership::verify_recovery(&persisted)
        .map_err(|e| format!("{}: {e}", paths.data.join("state.json").display()))?;
    crate::git::apply_credentials(&loaded.security.ssh_key, &loaded.security.credential_helper);
    Ok(RuntimeContext::with_owner(
        AppState::new(loaded, persisted),
        paths,
        tokio::runtime::Handle::current(),
        Arc::new(HeadlessHost),
        owner,
    ))
}

/// A foreground supervisor: any unexpected periodic-task exit is fatal and
/// takes the same cleanup path as an explicit stop. Never silently lose a loop.
/// There is no UI lifecycle hook here; closing a client cannot stop this host.
pub async fn serve(
    app: RuntimeContext,
    stop: impl Future<Output = Result<(), String>>,
) -> Result<(), String> {
    crate::services::sweep_orphans(&app);
    crate::terminal::sweep_orphans(&app);
    let mut stats = crate::stats::spawn_stats_task(app.clone());
    let mut refresh = {
        let app = app.clone();
        tokio::spawn(async move {
            loop {
                crate::state::refresh_all(&app).await;
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        })
    };
    let mut terminals = {
        let app = app.clone();
        tokio::spawn(async move {
            let mut ticks = 0u16;
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                crate::terminal::poll_states(&app);
                ticks += 1;
                if ticks == 300 {
                    crate::terminal::sweep_idle(&app, app.state());
                    ticks = 0;
                }
            }
        })
    };
    let outcome = tokio::select! {
        result = stop => result,
        result = &mut stats => Err(format!("stats task stopped unexpectedly: {result:?}")),
        result = &mut refresh => Err(format!("refresh task stopped unexpectedly: {result:?}")),
        result = &mut terminals => Err(format!("terminal monitor stopped unexpectedly: {result:?}")),
    };
    // Abort before stopping children so periodic state refresh cannot race
    // cleanup. Join only unfinished handles: select may have consumed one.
    for task in [&mut stats, &mut refresh, &mut terminals] {
        if !task.is_finished() {
            task.abort();
            let _ = task.await;
        }
    }
    crate::terminal::close_all(&app);
    crate::services::stop_all(&app).await;
    if !app
        .state::<crate::services::ProcTable>()
        .procs
        .lock()
        .is_empty()
    {
        return Err(match outcome {
            Err(error) => format!(
                "{error}; additionally backend shutdown timed out waiting for services to exit"
            ),
            Ok(()) => "backend shutdown timed out waiting for services to exit".into(),
        });
    }
    outcome
}

/// Register before runtime startup so a signal cannot bypass graceful cleanup.
pub fn shutdown_signal() -> Result<impl Future<Output = Result<(), String>>, String> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut interrupt = signal(SignalKind::interrupt()).map_err(|e| e.to_string())?;
        let mut terminate = signal(SignalKind::terminate()).map_err(|e| e.to_string())?;
        Ok(async move {
            tokio::select! { _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
            Ok(())
        })
    }
    #[cfg(windows)]
    {
        let mut interrupt = tokio::signal::windows::ctrl_c().map_err(|e| e.to_string())?;
        let mut close = tokio::signal::windows::ctrl_close().map_err(|e| e.to_string())?;
        let mut shutdown = tokio::signal::windows::ctrl_shutdown().map_err(|e| e.to_string())?;
        Ok(async move {
            tokio::select! { _ = interrupt.recv() => {}, _ = close.recv() => {}, _ = shutdown.recv() => {} }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "canopy-host-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn paths(&self) -> RuntimePaths {
            RuntimePaths {
                config: self.0.clone(),
                data: self.0.clone(),
                logs: self.0.clone(),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn default_identifier_matches_desktop_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], APP_ID);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn crash_owner_helper() {
        if std::env::var_os("CANOPY_REAPER_OWNER").is_none() {
            return;
        }
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};
        // This helper exits to orphan its child; the isolated subreaper test
        // owns waitpid and asserts that the child is reaped.
        #[allow(clippy::zombie_processes)]
        let child = Command::new("sleep")
            .arg("30")
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let owner = ownership::current_process_owner().unwrap();
        let started = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        println!(
            "ORPHAN {}",
            serde_json::to_string(&(child.id(), started, owner)).unwrap()
        );
        // Child has no kill-on-drop: this process exits while its group lives.
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_subreaper_recovers_child_of_dead_recorded_owner() {
        use std::process::Command;
        if std::env::var_os("CANOPY_REAPER_TEST").is_none() {
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "backend::tests::linux_subreaper_recovers_child_of_dead_recorded_owner",
                    "--nocapture",
                ])
                .env("CANOPY_REAPER_TEST", "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        assert_eq!(
            unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) },
            0
        );
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "backend::tests::crash_owner_helper",
                "--nocapture",
            ])
            .env("CANOPY_REAPER_OWNER", "1")
            .output()
            .unwrap();
        assert!(output.status.success());
        let text = String::from_utf8(output.stdout).unwrap();
        let line = text
            .lines()
            .find_map(|line| line.strip_prefix("ORPHAN "))
            .unwrap();
        let (pid, started, owner): (u32, u64, settings::ProcessOwner) =
            serde_json::from_str(line).unwrap();
        struct Cleanup(i32);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if self.0 > 1 {
                    unsafe {
                        libc::killpg(self.0, libc::SIGKILL);
                        libc::waitpid(self.0, std::ptr::null_mut(), 0);
                    }
                }
            }
        }
        let mut cleanup = Cleanup(pid as i32);
        assert!(ownership::orphan_owner_gone(pid, Some(&owner)));
        assert!(!ownership::orphan_parent_verified(pid)); // adopter is this test, not PID 1
        let executor = tokio::runtime::Runtime::new().unwrap();
        executor.block_on(async {
            let fixture = Fixture::new();
            let persisted = settings::RuntimeState {
                orphans: vec![settings::OrphanProc {
                    pgid: pid as i32,
                    spawn_time_secs: started,
                    owner: Some(owner),
                    ..Default::default()
                }],
                ..Default::default()
            };
            ownership::verify_recovery(&persisted).unwrap();
            let app = RuntimeContext::new(
                AppState::new(Default::default(), persisted),
                fixture.paths(),
                tokio::runtime::Handle::current(),
                Arc::new(HeadlessHost),
            );
            crate::services::sweep_orphans(&app);
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            loop {
                let mut status = 0;
                if unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) } == pid as i32 {
                    cleanup.0 = 0;
                    assert!(libc::WIFSIGNALED(status));
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "adopted child was not swept"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        });
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_shutdown_stops_background_job_control_groups_and_persists() {
        for shell_exits in [false, true] {
            let fixture = Fixture::new();
            let app = open(fixture.paths()).unwrap();
            app.state::<AppState>()
                .settings
                .write()
                .embedded_terminal
                .program = "/bin/bash".into();
            app.state::<AppState>()
                .settings
                .write()
                .embedded_terminal
                .args = "--noprofile --norc".into();
            let pid_file = fixture.0.join("background-pid");
            let exit_gate = fixture.0.join("allow-shell-exit");
            let ending = if shell_exits {
                format!(
                    "while [ ! -f '{}' ]; do sleep 0.01; done; disown; exit",
                    exit_gate.display()
                )
            } else {
                "wait".into()
            };
            let command = format!(
                "trap '' HUP; set -m; sleep 30 & echo $! > '{}'; {ending}",
                pid_file.display()
            );
            crate::terminal::open(
                &app,
                app.state(),
                "fixture::shell::test",
                fixture.0.to_str().unwrap(),
                80,
                24,
                Some(command),
            )
            .unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let pid: u32 = loop {
                if let Ok(text) = std::fs::read_to_string(&pid_file) {
                    if let Ok(pid) = text.trim().parse() {
                        break pid;
                    }
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "PTY background command did not start"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            };
            let group = unsafe { libc::getpgid(pid as i32) };
            let leader = unsafe { libc::getsid(pid as i32) };
            assert!(
                group > 1 && leader > 1,
                "background job must be live before releasing its shell"
            );
            assert_ne!(group, leader);
            if shell_exits {
                // Observe the separate job group before allowing shell exit;
                // EOF cleanup can otherwise finish before the assertion.
                std::fs::write(&exit_gate, b"exit").unwrap();
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                loop {
                    use sysinfo::{
                        Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System,
                    };
                    let mut system = System::new();
                    system.refresh_processes_specifics(
                        ProcessesToUpdate::Some(&[Pid::from_u32(leader as u32)]),
                        true,
                        ProcessRefreshKind::nothing(),
                    );
                    if system
                        .process(Pid::from_u32(leader as u32))
                        .is_none_or(|p| p.status() == ProcessStatus::Zombie)
                    {
                        break;
                    }
                    assert!(std::time::Instant::now() < deadline, "shell did not exit");
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
            crate::terminal::close_all(&app);
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let persisted: settings::RuntimeState =
                settings::load_checked(&fixture.0.join("state.json")).unwrap();
            assert!(persisted.terminal_orphans.is_empty());
            loop {
                use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System};
                let mut system = System::new();
                system.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
                    true,
                    ProcessRefreshKind::nothing(),
                );
                if system
                    .process(Pid::from_u32(pid))
                    .is_none_or(|p| p.status() == ProcessStatus::Zombie)
                {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "background PTY process survived shutdown"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }

    #[tokio::test]
    async fn lock_is_checked_before_reading_or_rewriting_corrupt_state() {
        let fixture = Fixture::new();
        let bytes = b"not valid JSON";
        std::fs::write(fixture.0.join("state.json"), bytes).unwrap();
        let owner = ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        assert!(open(fixture.paths())
            .err()
            .unwrap()
            .contains("another Canopy backend"));
        drop(owner);
        assert!(open(fixture.paths()).err().unwrap().contains("parse"));
        assert_eq!(std::fs::read(fixture.0.join("state.json")).unwrap(), bytes);
        assert!(!fixture.0.join("state.json.corrupt").exists());
    }

    #[tokio::test]
    async fn context_clones_retain_ownership_until_the_last_task_finishes() {
        let fixture = Fixture::new();
        let app = open(fixture.paths()).unwrap();
        let client = app.clone();
        serve(app, async { Ok(()) }).await.unwrap();
        assert!(ownership::RuntimeOwner::acquire(&fixture.0).is_err());
        drop(client);
        let owner = ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        drop(owner);
    }

    #[tokio::test]
    async fn client_detach_preserves_service_and_explicit_stop_reaps_it() {
        let fixture = Fixture::new();
        for args in [
            vec!["init", "-b", "main"],
            vec![
                "-c",
                "user.name=Canopy Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        ] {
            let result = std::process::Command::new("git")
                .args(args)
                .current_dir(&fixture.0)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        let mut config = settings::Settings::default();
        config.updates.auto_check = false;
        config.repos.push(settings::RepoCfg {
            id: "fixture".into(),
            path: fixture.0.to_string_lossy().into_owned(),
            services: vec![settings::ServiceCfg {
                id: "worker".into(),
                name: "Worker".into(),
                command: "sleep 120".into(),
                ..Default::default()
            }],
            ..Default::default()
        });
        std::fs::write(
            fixture.0.join("settings.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        let app = open(fixture.paths()).unwrap();
        crate::state::refresh_tree(&app).await.unwrap();
        let key = app.state::<AppState>().tree.read()[0].worktrees[0].services[0]
            .svc_key
            .clone();
        crate::services::start_service(&app, &key).await.unwrap();
        let client = app
            .events()
            .subscribe(crate::events::SubscriptionKind::Application)
            .unwrap();
        let (send, receive) = tokio::sync::oneshot::channel();
        let (ready, started) = tokio::sync::oneshot::channel();
        let host = tokio::spawn(serve(app.clone(), async {
            ready.send(()).unwrap();
            receive.await.map_err(|e| e.to_string())
        }));
        drop(client);
        tokio::time::timeout(Duration::from_secs(3), started).await.unwrap().unwrap();
        let survived = app
            .state::<crate::services::ProcTable>()
            .procs
            .lock()
            .contains_key(&key);
        send.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(10), host).await;
        assert!(survived, "client disconnect stopped the service");
        result.unwrap().unwrap().unwrap();
        assert!(app
            .state::<crate::services::ProcTable>()
            .procs
            .lock()
            .is_empty());
        assert!(app.state::<AppState>().runtime.read().orphans.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn legacy_records_are_retained_but_reused_pid_records_expire() {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id();
        let state = settings::RuntimeState {
            orphans: vec![settings::OrphanProc {
                pgid: pid as i32,
                spawn_time_secs: 0, // legacy records may lack identity data
                ..Default::default()
            }],
            ..Default::default()
        };
        let rejected = ownership::verify_recovery(&state).is_err();
        let parent_rejected = !ownership::orphan_parent_verified(pid);
        let fixture = Fixture::new();
        let mut persisted = state.clone();
        persisted.orphans.push(settings::OrphanProc {
            pgid: pid as i32,
            spawn_time_secs: 1,
            ..Default::default()
        });
        persisted.terminal_orphans = persisted
            .orphans
            .iter()
            .map(|o| settings::TermOrphan {
                id: "legacy".into(),
                pgid: o.pgid,
                spawn_time_secs: o.spawn_time_secs,
                owner: None,
            })
            .collect();
        let app = RuntimeContext::new(
            AppState::new(settings::Settings::default(), persisted),
            fixture.paths(),
            tokio::runtime::Handle::current(),
            Arc::new(HeadlessHost),
        );
        crate::services::sweep_orphans(&app);
        crate::terminal::sweep_orphans(&app);
        crate::services::persist_orphans(&app);
        crate::terminal::persist_orphans(&app);
        let saved: settings::RuntimeState =
            settings::load_checked(&fixture.0.join("state.json")).unwrap();
        let retained = app.state::<AppState>().runtime.read().orphans.len() == 1
            && app
                .state::<AppState>()
                .runtime
                .read()
                .terminal_orphans
                .len()
                == 1;
        let still_alive = child.try_wait().unwrap().is_none();
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(saved.orphans.len(), 1);
        assert_eq!(saved.orphans[0].spawn_time_secs, 0);
        assert_eq!(saved.terminal_orphans.len(), 1);
        assert_eq!(saved.terminal_orphans[0].spawn_time_secs, 0);
        assert!(rejected && parent_rejected && still_alive && retained);
    }
}
