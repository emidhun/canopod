//! Host-independent state and capabilities shared by backend operations.
//!
//! A context clone references the same tables; it never creates a new process
//! manager. Native window APIs live in the desktop host adapter. The injected
//! Tokio handle also lets synchronous adapters schedule work off the UI thread.
use crate::{
    disk::DiskCache, notify::NotifyState, services::ProcTable, state::AppState, terminal::TermTable,
};
use serde::Serialize;
use std::{path::PathBuf, sync::Arc};

#[derive(Clone, Copy)]
pub enum Audience {
    All,
    Main,
    Terminals,
    TerminalState,
}

pub trait Host: Send + Sync {
    /// A human can see the native UI; independent of event subscribers.
    fn user_present(&self) -> bool { false }
    fn interested(&self, audience: Audience) -> bool;
    fn publish(
        &self,
        audience: Audience,
        event: &str,
        payload: serde_json::Value,
    ) -> Result<(), String>;
    fn notify(&self, title: &str, body: &str, sound: bool) -> Result<(), String>;
    fn badge(&self, mode: &str, count: i64);
}

#[derive(Clone)]
pub struct RuntimePaths {
    pub config: PathBuf,
    pub data: PathBuf,
    pub logs: PathBuf,
}

impl RuntimePaths {
    pub fn app_config_dir(&self) -> Result<PathBuf, String> {
        Ok(self.config.clone())
    }
    pub fn app_data_dir(&self) -> Result<PathBuf, String> {
        Ok(self.data.clone())
    }
    pub fn app_log_dir(&self) -> Result<PathBuf, String> {
        Ok(self.logs.clone())
    }
}

struct Inner {
    state: AppState,
    processes: ProcTable,
    terminals: TermTable,
    disk: DiskCache,
    notifications: NotifyState,
    paths: RuntimePaths,
    executor: tokio::runtime::Handle,
    host: Arc<dyn Host>,
    service_logs: std::sync::OnceLock<Option<PathBuf>>,
    events: crate::events::EventHub,
    _owner: Option<crate::ownership::RuntimeOwner>,
}

#[derive(Clone)]
pub struct RuntimeContext(Arc<Inner>);

impl RuntimeContext {
    pub fn new(state: AppState, paths: RuntimePaths, executor: tokio::runtime::Handle, host: Arc<dyn Host>) -> Self {
        Self::construct(state, paths, executor, host, None)
    }

    pub fn with_owner(state: AppState, paths: RuntimePaths, executor: tokio::runtime::Handle, host: Arc<dyn Host>, owner: crate::ownership::RuntimeOwner) -> Self {
        Self::construct(state, paths, executor, host, Some(owner))
    }

    fn construct(state: AppState, paths: RuntimePaths, executor: tokio::runtime::Handle, host: Arc<dyn Host>, owner: Option<crate::ownership::RuntimeOwner>) -> Self {
        Self(Arc::new(Inner {
            state, paths, executor, host, _owner: owner,
            processes: ProcTable::default(), terminals: TermTable::default(),
            disk: DiskCache::default(), notifications: NotifyState::default(),
            service_logs: std::sync::OnceLock::new(),
            events: crate::events::EventHub::default(),
        }))
    }

    pub fn state<T: RuntimeState>(&self) -> &T {
        T::get(self)
    }
    pub fn path(&self) -> &RuntimePaths {
        &self.0.paths
    }
    pub fn executor(&self) -> tokio::runtime::Handle {
        self.0.executor.clone()
    }
    pub fn interested(&self, audience: Audience) -> bool {
        self.0.host.interested(audience)
            || match audience {
                Audience::Main => self.0.events.has_application_subscribers(),
                Audience::Terminals => self.0.events.has_terminal_subscribers(),
                Audience::All => self.0.events.has_application_subscribers(),
                Audience::TerminalState => {
                    self.0.events.has_application_subscribers()
                        || self.0.events.has_terminal_subscribers()
                }
            }
    }
    pub fn host(&self) -> &dyn Host {
        self.0.host.as_ref()
    }
    pub fn events(&self) -> &crate::events::EventHub {
        &self.0.events
    }

    pub fn emit<T: Serialize>(&self, event: &str, value: &T) -> Result<(), String> {
        self.emit_to(Audience::All, event, value)
    }

    pub fn emit_to<T: Serialize>(
        &self,
        audience: Audience,
        event: &str,
        value: &T,
    ) -> Result<(), String> {
        let native = self.0.host.interested(audience);
        if !native && !self.0.events.interested(audience, event) {
            return Ok(());
        }
        let value = serde_json::to_value(value).map_err(|e| e.to_string())?;
        let _ = self.0.events.publish(audience, event, &value);
        // Subscribers observe gaps through recv(ResnapshotRequired), never
        // through an operation's result, even when there is no native host.
        // A lagging remote consumer must not suppress desktop delivery.
        if native {
            self.0.host.publish(audience, event, value)?;
        }
        Ok(())
    }

    pub fn service_log_dir(&self) -> Option<&PathBuf> {
        self.0
            .service_logs
            .get_or_init(|| {
                let dir = self.0.paths.logs.join("services");
                std::fs::create_dir_all(&dir).ok()?;
                Some(dir)
            })
            .as_ref()
    }
}

/// Closed set of state tables; the host cannot replace one after startup.
pub trait RuntimeState: private::Sealed {
    fn get(runtime: &RuntimeContext) -> &Self;
}
mod private {
    pub trait Sealed {}
}
macro_rules! runtime_state {
    ($ty:ty, $field:ident) => {
        impl private::Sealed for $ty {}
        impl RuntimeState for $ty {
            fn get(runtime: &RuntimeContext) -> &Self {
                &runtime.0.$field
            }
        }
    };
}
runtime_state!(AppState, state);
runtime_state!(ProcTable, processes);
runtime_state!(TermTable, terminals);
runtime_state!(DiskCache, disk);
runtime_state!(NotifyState, notifications);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{RuntimeState as PersistedState, Settings};
    use parking_lot::Mutex;

    #[derive(Default)]
    struct RecordingHost {
        interested: bool,
        present: bool,
        notifications: Mutex<Vec<String>>,
        events: Mutex<Vec<(String, serde_json::Value)>>,
    }
    impl Host for RecordingHost {
        fn user_present(&self) -> bool { self.present }
        fn interested(&self, _: Audience) -> bool {
            self.interested
        }
        fn publish(
            &self,
            _: Audience,
            event: &str,
            payload: serde_json::Value,
        ) -> Result<(), String> {
            self.events.lock().push((event.into(), payload));
            Ok(())
        }
        fn notify(&self, title: &str, _: &str, _: bool) -> Result<(), String> {
            self.notifications.lock().push(title.into());
            Ok(())
        }
        fn badge(&self, _: &str, _: i64) {}
    }

    fn context(host: Arc<dyn Host>) -> RuntimeContext {
        RuntimeContext::new(
            AppState::new(Settings::default(), PersistedState::default()),
            RuntimePaths {
                config: PathBuf::new(),
                data: PathBuf::new(),
                logs: PathBuf::new(),
            },
            tokio::runtime::Handle::current(),
            host,
        )
    }

    #[tokio::test]
    async fn presence_is_independent_of_event_interest() {
        for (present, interested) in [(false, true), (true, false)] {
            let host = Arc::new(RecordingHost { present, interested, ..Default::default() });
            let app = context(host.clone());
            app.state::<AppState>().settings.write().notifications.service_crash = true;
            crate::notify::notify(&app, crate::notify::Kind::ServiceCrash, "subject", "crashed", "details");
            assert_eq!(host.notifications.lock().len(), usize::from(!present));
            assert_eq!(crate::stats::should_poll(&app), present);
        }
    }

    #[tokio::test]
    async fn clones_share_state_tables_and_operation_leases_without_a_desktop() {
        let app = context(Arc::new(RecordingHost::default()));
        let client = app.clone();
        assert!(std::ptr::eq(
            app.state::<ProcTable>(),
            client.state::<ProcTable>()
        ));
        assert!(std::ptr::eq(
            app.state::<TermTable>(),
            client.state::<TermTable>()
        ));
        app.state::<AppState>().settings.write().terminal = "shared".into();
        assert_eq!(
            crate::operations::get_settings(client.state::<AppState>()).terminal,
            "shared"
        );
        let lease = crate::state::try_lease(&app, "worktree", "setup").unwrap();
        assert!(crate::state::try_lease(&client, "worktree", "remove").is_err());
        drop(lease);
        assert!(crate::state::try_lease(&client, "worktree", "remove").is_ok());
    }

    #[tokio::test]
    async fn an_unobserved_event_does_not_even_serialize() {
        struct CannotSerialize;
        impl Serialize for CannotSerialize {
            fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
                panic!("unobserved payload must not be serialized")
            }
        }
        let app = context(Arc::new(RecordingHost::default()));
        app.emit("service:log", &CannotSerialize).unwrap();
    }

    #[tokio::test]
    async fn event_payloads_are_unchanged_by_the_adapter() {
        let host = Arc::new(RecordingHost {
            interested: true,
            ..Default::default()
        });
        let app = context(host.clone());
        let payload = serde_json::json!({"svcKey": "worktree::web", "status": "running"});
        app.emit_to(Audience::Main, "service:status", &payload)
            .unwrap();
        assert_eq!(&*host.events.lock(), &[("service:status".into(), payload)]);
    }

    #[tokio::test]
    async fn subscribers_receive_events_without_a_native_host() {
        let host = Arc::new(RecordingHost::default());
        let app = context(host.clone());
        assert!(!app.interested(Audience::Main));
        let mut client = app
            .events()
            .subscribe(crate::events::SubscriptionKind::Application)
            .unwrap();
        assert!(app.interested(Audience::Main));
        app.emit("tree:changed", &serde_json::json!({"repos": []}))
            .unwrap();
        let frame = client.recv().await.unwrap();
        let payload: serde_json::Value = serde_json::from_str(&frame.json).unwrap();
        assert_eq!(payload["event"], "tree:changed");
        assert_eq!(payload["payload"], serde_json::json!({"repos": []}));
        assert!(host.events.lock().is_empty());
        drop(client);
        assert!(!app.interested(Audience::Main));
    }

    #[tokio::test]
    async fn all_interest_requires_application_subscribers() {
        let app = context(Arc::new(RecordingHost::default()));
        assert!(!app.interested(Audience::All));
        let terminal = app.events().subscribe(crate::events::SubscriptionKind::Terminal).unwrap();
        assert!(!app.interested(Audience::All));
        let application = app.events().subscribe(crate::events::SubscriptionKind::Application).unwrap();
        assert!(app.interested(Audience::All));
        drop(application);
        assert!(!app.interested(Audience::All));
        drop(terminal);
    }

    #[tokio::test]
    async fn remote_resnapshot_never_fails_native_emit() {
        for native in [false, true] {
            let host = Arc::new(RecordingHost {
                interested: native,
                ..Default::default()
            });
            let app = context(host.clone());
            let mut subscriber = app
                .events()
                .subscribe(crate::events::SubscriptionKind::Application)
                .unwrap();
            app.emit("tree:changed", &"x".repeat(crate::events::MAX_EVENT_BYTES))
                .unwrap();
            assert_eq!(host.events.lock().len(), usize::from(native));
            assert_eq!(
                subscriber.recv().await.unwrap_err(),
                crate::events::EventError::ResnapshotRequired
            );
        }
    }

    #[test]
    fn injected_executor_works_outside_tokio_thread_context() {
        let executor = tokio::runtime::Runtime::new().unwrap();
        let app = {
            let _entered = executor.enter();
            context(Arc::new(RecordingHost::default()))
        };
        // This is how a synchronous native command schedules backend work.
        let task = app.executor().spawn(async { 42 });
        assert_eq!(executor.block_on(task).unwrap(), 42);
    }

    #[tokio::test]
    async fn real_service_execution_and_logs_work_without_tauri() {
        use crate::settings::{RepoCfg, ServiceCfg};
        use crate::state::{RepoNode, ServiceNode, SvcStatus, WorktreeNode};
        let dir = std::env::temp_dir().join(format!("canopy-core-service-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().into_owned();
        let key = format!("{path}::smoke");
        let state = AppState::new(
            Settings {
                repos: vec![RepoCfg {
                    id: "fixture".into(),
                    path: path.clone(),
                    services: vec![ServiceCfg {
                        id: "smoke".into(),
                        name: "Smoke".into(),
                        command: "printf canopy-core-smoke".into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            },
            PersistedState::default(),
        );
        *state.tree.write() = vec![RepoNode {
            repo_id: "fixture".into(),
            name: "Fixture".into(),
            path: path.clone(),
            worktrees: vec![WorktreeNode {
                wt_key: path.clone(),
                branch: "main".into(),
                path,
                is_main: true,
                git: None,
                db_name: None,
                setup: None,
                setup_configured: false,
                pinned: false,
                services: vec![ServiceNode {
                    svc_key: key.clone(),
                    service_id: "smoke".into(),
                    name: "Smoke".into(),
                    kind: "worker".into(),
                    port: None,
                    derived_port: None,
                    status: SvcStatus::Stopped,
                }],
            }],
        }];
        let app = RuntimeContext::new(
            state,
            RuntimePaths {
                config: dir.clone(),
                data: dir.clone(),
                logs: dir.clone(),
            },
            tokio::runtime::Handle::current(),
            Arc::new(RecordingHost::default()),
        );
        let started = crate::operations::service_start(app.clone(), key.clone()).await;
        let observed = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let output = crate::operations::get_logs(app.state::<ProcTable>(), key.clone());
                if output
                    .iter()
                    .any(|line| line.text.contains("canopy-core-smoke"))
                    && app.state::<ProcTable>().procs.lock().is_empty()
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await;
        crate::services::stop_all(&app).await;
        drop(app);
        let _ = std::fs::remove_dir_all(dir);
        started.unwrap();
        observed.expect("service output/reaping did not reach the shared tables");
    }
}
