use crate::services::ProcTable;
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use crate::runtime::RuntimeContext;

const POLL: Duration = Duration::from_secs(2);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatEntry {
    svc_key: String,
    cpu: f32,
    mem_mb: u64,
    uptime_sec: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatsEvent {
    entries: Vec<StatEntry>,
}

/// 2s poll: aggregate CPU/MEM over each service's descendant process tree
/// (the spawned zsh wrapper's children are the real node processes).
pub fn spawn_stats_task(app: RuntimeContext) {
    app.executor().spawn(async move {
        let mut sys = System::new();
        loop {
            tokio::time::sleep(POLL).await;

            // enumerating every process on the machine 30×/min is the app's
            // steady-state CPU cost — skip it while nothing is on screen
            // (the stats card can't be seen from the tray)
            if !should_poll(&app) {
                continue;
            }

            let tracked: Vec<(String, u32, u64)> = {
                let table = app.state::<ProcTable>();
                let procs = table.procs.lock();
                procs
                    .iter()
                    .map(|(k, p)| (k.clone(), p.pid, p.started_at.elapsed().as_secs()))
                    .collect()
            };
            if tracked.is_empty() {
                continue;
            }

            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_cpu().with_memory(),
            );

            // parent -> children map, built once per tick
            let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
            for (pid, proc_) in sys.processes() {
                if let Some(parent) = proc_.parent() {
                    children.entry(parent).or_default().push(*pid);
                }
            }

            let mut entries = Vec::new();
            for (key, root_pid, uptime) in tracked {
                let root = Pid::from_u32(root_pid);
                let mut cpu = 0.0f32;
                let mut mem = 0u64;
                let mut stack = vec![root];
                while let Some(pid) = stack.pop() {
                    if let Some(p) = sys.process(pid) {
                        cpu += p.cpu_usage();
                        mem += p.memory();
                    }
                    if let Some(kids) = children.get(&pid) {
                        stack.extend(kids.iter().copied());
                    }
                }
                entries.push(StatEntry {
                    svc_key: key,
                    cpu: (cpu * 10.0).round() / 10.0,
                    mem_mb: mem / (1024 * 1024),
                    uptime_sec: uptime,
                });
            }
            let _ = app.emit_to(crate::runtime::Audience::Main, "service:stats", &StatsEvent { entries });
        }
    });
}

// Event interest can come from a machine client; only a visible UI needs
// continuous system-wide sampling for its stats card.
pub(crate) fn should_poll(app: &RuntimeContext) -> bool {
    app.host().user_present()
}
