//! Exercise the actual GUI-free executable, not a mock lifecycle.
use std::{io::{BufRead, BufReader}, path::PathBuf, process::{Child, Command, Stdio}, time::{Duration, Instant}};

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}
struct Directory(PathBuf);
impl Drop for Directory { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

fn backend_command(dir: &Directory, action: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_canopy-backend"));
    command.args(action.split_whitespace()).arg("--data-dir").arg(&dir.0).arg("--config-dir").arg(&dir.0).arg("--log-dir").arg(&dir.0);
    command
}

struct Started {
    child: ChildGuard,
    reader: std::thread::JoinHandle<()>,
    #[cfg(unix)]
    lines: Vec<String>,
    #[cfg(unix)]
    messages: std::sync::mpsc::Receiver<String>,
    attempts: usize,
}

// The child cannot portably inherit this listener. Retry once only when another
// process wins the gap between selecting a port and the child binding it.
fn start_backend(dir: &Directory, initial_port: Option<u16>) -> Started {
    for attempt in 0..2 {
        let port = match (attempt, initial_port) {
            (0, Some(port)) => port,
            _ => std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port(),
        };
        let mut child = ChildGuard(backend_command(dir, "serve").arg("--port").arg(port.to_string()).stderr(Stdio::piped()).spawn().unwrap());
        let stderr = child.0.stderr.take().unwrap();
        let (send, messages) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) { let _ = send.send(line); }
        });
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut lines = Vec::new();
        let mut bind_failed = false;
        while let Ok(line) = messages.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            bind_failed |= line.contains("bind backend at");
            let ready = line.contains("running in foreground");
            lines.push(line);
            if ready { return Started { child, reader, #[cfg(unix)] lines, #[cfg(unix)] messages, attempts: attempt + 1 }; }
        }
        drop(child);
        reader.join().unwrap();
        assert!(bind_failed && attempt == 0, "backend failed to start: {lines:?}");
    }
    unreachable!("second bind failure is reported above")
}

#[test]
fn a_contended_process_port_is_retried_once() {
    let dir = Directory(std::env::temp_dir().join(format!("canopy-backend-retry-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let started = start_backend(&dir, Some(occupied.local_addr().unwrap().port()));
    assert_eq!(started.attempts, 2);
    drop(started.child);
    started.reader.join().unwrap();
}

#[test]
fn foreground_duplicate_launch_status_and_stop_release_the_owner() {
    #[cfg(unix)]
    let methods = ["api", "signal"];
    #[cfg(not(unix))]
    let methods = ["api"];
    for method in methods { run_lifecycle(method); }
}

fn run_lifecycle(method: &str) {
    let dir = Directory(std::env::temp_dir().join(format!("canopy-backend-process-{}-{method}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    std::fs::write(dir.0.join("settings.json"), serde_json::to_vec(&serde_json::json!({"repos":[{"id":"fixture","path":dir.0,"name":"fixture"}]})).unwrap()).unwrap();
    let command = |action: &str| backend_command(&dir, action);
    let Started { mut child, reader, .. } = start_backend(&dir, None);
    let second = command("serve").output().unwrap();
    assert!(!second.status.success());
    assert!(String::from_utf8_lossy(&second.stderr).contains("another Canopy backend"));
    assert!(child.0.try_wait().unwrap().is_none());
    let status = command("status").output().unwrap();
    assert!(status.status.success(), "{}", String::from_utf8_lossy(&status.stderr));
    let snapshot: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(snapshot["pid"], child.0.id());
    assert_eq!(snapshot["apiVersion"], "1");
    for action in ["mcp status", "mcp enable --repo fixture", "mcp enable --allow-worktree-write", "mcp rotate-token", "mcp disable", "mcp enable", "mcp enable --read-only"] {
        let result = command(action).output().unwrap();
        assert!(result.status.success(), "{action}: {}", String::from_utf8_lossy(&result.stderr));
        let body: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert!(body["enabled"].is_boolean());
        assert!(body.get("token").is_none(), "control output must never include credentials");
        assert_eq!(body["allowWorktreeWrite"], matches!(action, "mcp enable --allow-worktree-write" | "mcp rotate-token" | "mcp disable" | "mcp enable"));
    }
    for (action, allowed) in [("mcp enable --allow-service-control", true), ("mcp enable", true), ("mcp enable --no-service-control", false), ("mcp enable --allow-service-control", true), ("mcp enable --read-only", false)] {
        let result = command(action).output().unwrap();
        assert!(result.status.success(), "{action}: {}", String::from_utf8_lossy(&result.stderr));
        let body: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(body["allowServiceControl"], allowed);
        assert_eq!(body["allowWorktreeWrite"], false);
    }
    for (action, allowed) in [("mcp enable --allow-configuration", true), ("mcp enable", true), ("mcp enable --no-configuration", false), ("mcp enable --allow-configuration", true), ("mcp enable --read-only", false)] {
        let result=command(action).output().unwrap();
        assert!(result.status.success(), "{action}: {}", String::from_utf8_lossy(&result.stderr));
        let body:serde_json::Value=serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(body["allowConfiguration"],allowed);
    }
    for action in ["mcp enable --allow-configuration --read-only", "mcp enable --read-only --allow-configuration", "mcp status --allow-configuration", "mcp enable --read-only --allow-service-control", "mcp enable --allow-service-control --read-only", "mcp status --allow-service-control", "mcp enable --read-only --allow-worktree-write", "mcp status --allow-worktree-write"] {
        let result = command(action).output().unwrap();
        assert!(!result.status.success(), "{action} should reject invalid permission flags");
    }
    if method == "api" {
        let stop = command("stop").output().unwrap();
        assert!(stop.status.success(), "{}", String::from_utf8_lossy(&stop.stderr));
        let response: serde_json::Value = serde_json::from_slice(&stop.stdout).unwrap();
        assert_eq!(response["status"], "stopping");
    } else {
        #[cfg(unix)]
        unsafe { assert_eq!(libc::kill(child.0.id() as i32, libc::SIGTERM), 0); }
    }
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() { assert!(status.success()); break }
        assert!(Instant::now() < deadline, "{method} shutdown timed out");
        std::thread::sleep(Duration::from_millis(20));
    }
    reader.join().unwrap();
    let owner = canopy_lib::ownership::RuntimeOwner::acquire(&dir.0).unwrap();
    drop(owner);
}

#[cfg(unix)]
#[test]
fn foreground_logger_exposes_stale_orphan_expiry() {
    use std::os::unix::process::CommandExt;
    let dir = Directory(std::env::temp_dir().join(format!("canopy-backend-warning-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let mut unrelated = ChildGuard(Command::new("sleep").arg("30").process_group(0).spawn().unwrap());
    std::fs::write(dir.0.join("state.json"), serde_json::to_vec(&serde_json::json!({"orphans":[{"svcKey":"stale", "pgid":unrelated.0.id(), "spawnTimeSecs":1}]})).unwrap()).unwrap();
    let Started { child: mut backend, reader, lines, messages, .. } = start_backend(&dir, None);
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut warned = lines.iter().any(|line| line.contains("forgetting stale process group record"));
    while !warned {
        match messages.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(line) => warned = line.contains("forgetting stale process group record"),
            Err(_) => break,
        }
    }
    unsafe { libc::kill(backend.0.id() as i32, libc::SIGTERM); }
    let deadline = Instant::now() + Duration::from_secs(10);
    while backend.0.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(20));
    }
    reader.join().unwrap(); assert!(warned, "sweep warning was not written to stderr");
    assert!(unrelated.0.try_wait().unwrap().is_none(), "unrelated process was signalled");
}
