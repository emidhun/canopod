//! Exercise the actual GUI-free executable, not a mock lifecycle.
use std::{io::{BufRead, BufReader}, path::PathBuf, process::{Child, Command, Stdio}, time::{Duration, Instant}};

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}
struct Directory(PathBuf);
impl Drop for Directory { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

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
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reservation.local_addr().unwrap().port().to_string();
    drop(reservation);
    let command = |action: &str| {
        let mut c = Command::new(env!("CARGO_BIN_EXE_canopy-backend"));
        c.args(action.split_whitespace()).arg("--data-dir").arg(&dir.0).arg("--config-dir").arg(&dir.0).arg("--log-dir").arg(&dir.0);
        if action == "serve" { c.arg("--port").arg(&port); }
        c
    };
    let mut child = ChildGuard(command("serve").stderr(Stdio::piped()).spawn().unwrap());
    let stderr = child.0.stderr.take().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if line.contains("running in foreground") { let _ = send.send(()); }
        }
    });
    receive.recv_timeout(Duration::from_secs(15)).expect("backend did not become ready");
    let second = command("serve").output().unwrap();
    assert!(!second.status.success());
    assert!(String::from_utf8_lossy(&second.stderr).contains("another Canopy backend"));
    assert!(child.0.try_wait().unwrap().is_none());
    let status = command("status").output().unwrap();
    assert!(status.status.success(), "{}", String::from_utf8_lossy(&status.stderr));
    let snapshot: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(snapshot["pid"], child.0.id());
    assert_eq!(snapshot["apiVersion"], "1");
    for action in ["mcp status", "mcp enable --repo fixture", "mcp rotate-token", "mcp disable", "mcp enable"] {
        let result = command(action).output().unwrap();
        assert!(result.status.success(), "{action}: {}", String::from_utf8_lossy(&result.stderr));
        let body: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert!(body["enabled"].is_boolean());
        assert!(body.get("token").is_none(), "control output must never include credentials");
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

#[test]
fn foreground_logger_exposes_preserved_orphan_warning() {
    use std::os::unix::process::CommandExt;
    let dir = Directory(std::env::temp_dir().join(format!("canopy-backend-warning-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let mut unrelated = ChildGuard(Command::new("sleep").arg("30").process_group(0).spawn().unwrap());
    std::fs::write(dir.0.join("state.json"), serde_json::to_vec(&serde_json::json!({"orphans":[{"svcKey":"stale", "pgid":unrelated.0.id(), "spawnTimeSecs":1}]})).unwrap()).unwrap();
    let mut backend = ChildGuard(Command::new(env!("CARGO_BIN_EXE_canopy-backend"))
        .arg("serve").arg("--data-dir").arg(&dir.0).arg("--config-dir").arg(&dir.0).arg("--log-dir").arg(&dir.0).stderr(Stdio::piped()).spawn().unwrap());
    let stderr = backend.0.stderr.take().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if line.contains("leaving process group") { let _ = send.send(()); }
        }
    });
    let warning = receive.recv_timeout(Duration::from_secs(10));
    unsafe { libc::kill(backend.0.id() as i32, libc::SIGTERM); }
    let deadline = Instant::now() + Duration::from_secs(10);
    while backend.0.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(20));
    }
    reader.join().unwrap(); warning.expect("sweep warning was not written to stderr");
    assert!(unrelated.0.try_wait().unwrap().is_none(), "unrelated process was signalled");
}
