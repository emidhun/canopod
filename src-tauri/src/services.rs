use crate::settings::ServiceCfg;
use crate::state::{AppState, SvcStatus};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use parking_lot::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use crate::runtime::RuntimeContext;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

pub const LOG_CAP: usize = 160;
// Flush cadence for log batches. 200ms caps store-update/render pressure at
// 5/sec per noisy service (was 12.5/sec at 80ms) — meaningful on low-spec
// machines during a webpack burst, imperceptible as log-tail latency.
const LOG_FLUSH_MS: u64 = 200;
const STOP_GRACE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub t: String,
    pub lv: String, // info | ok | warn | err
    pub text: String,
}

impl LogLine {
    pub fn now(lv: &str, text: impl Into<String>) -> Self {
        let t = chrono_time();
        Self { t, lv: lv.into(), text: text.into() }
    }
}

fn chrono_time() -> String {
    // HH:MM:SS local time without pulling in chrono
    let now = std::time::SystemTime::now();
    let secs = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let offset = cached_utc_offset(secs);
    let local = (secs as i64 + offset).rem_euclid(86_400);
    format!("{:02}:{:02}:{:02}", local / 3600, (local % 3600) / 60, local % 60)
}

/// Local UTC offset with a 60s cache — the exact value only shifts on a DST
/// boundary, and computing it per log line meant a localtime_r call for every
/// line of a webpack burst. Timestamp and offset are packed into ONE atomic
/// (see `pack_offset`) so a racing reader can never pair a fresh timestamp
/// with a stale offset.
fn cached_utc_offset(now_secs: u64) -> i64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static PACKED: AtomicU64 = AtomicU64::new(0);
    let p = PACKED.load(Ordering::Relaxed);
    if p != 0 {
        let (ts, off) = unpack_offset(p);
        if now_secs.saturating_sub(ts) <= 60 {
            return off;
        }
    }
    let fresh = crate::proc::local_utc_offset_secs().clamp(-OFFSET_BIAS, OFFSET_BIAS);
    PACKED.store(pack_offset(now_secs, fresh), Ordering::Relaxed);
    fresh
}

/// UTC offsets span ±14h (= ±50400s) < 2^17, so `offset + BIAS` fits the low
/// 20 bits and the fetch timestamp takes the rest: `ts << 20 | offset + BIAS`.
const OFFSET_BIAS: i64 = 50_400;

fn pack_offset(ts_secs: u64, offset: i64) -> u64 {
    (ts_secs << 20) | ((offset + OFFSET_BIAS) as u64)
}

fn unpack_offset(p: u64) -> (u64, i64) {
    (p >> 20, ((p & 0xF_FFFF) as i64) - OFFSET_BIAS)
}

pub struct ProcEntry {
    pub pid: u32,
    /// process-group / job handle used to tear down the whole child tree
    pub group: crate::proc::ProcGroup,
    pub started_at: Instant,
    /// read only by the Unix crash-orphan persist (Windows has none — the Job
    /// Object's KILL_ON_JOB_CLOSE makes the OS reap the tree)
    #[cfg_attr(windows, allow(dead_code))]
    pub started_unix: u64,
    /// generation guard: stop() bumps this so a stale waiter doesn't clobber state
    pub generation: u64,
}

#[derive(Default)]
pub struct ProcTable {
    pub procs: Mutex<HashMap<String, ProcEntry>>,
    pub logs: Mutex<HashMap<String, VecDeque<LogLine>>>,
    /// open append handles for the on-disk service logs (see `persist_log_lines`)
    pub log_files: Mutex<HashMap<String, LogSink>>,
    generation: Mutex<u64>,
}

impl ProcTable {
    fn next_gen(&self) -> u64 {
        let mut g = self.generation.lock();
        *g += 1;
        *g
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatusEvent<'a> {
    svc_key: &'a str,
    status: SvcStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
}

pub fn set_status(app: &RuntimeContext, key: &str, status: SvcStatus, started_at: Option<u64>, exit_code: Option<i32>) {
    let state = app.state::<AppState>();
    let previous = state.statuses.write().insert(key.to_string(), status);
    // patch cached tree so late get_tree calls see fresh statuses
    {
        let mut tree = state.tree.write();
        for r in tree.iter_mut() {
            for w in r.worktrees.iter_mut() {
                for s in w.services.iter_mut() {
                    if s.svc_key == key {
                        s.status = status;
                    }
                }
            }
        }
    }
    let _ = app.emit("service:status", &StatusEvent { svc_key: key, status, started_at, exit_code });

    // Notify on the TRANSITION into error, not on the state: a status
    // re-broadcast (a tree rebuild, a refresh) would otherwise re-notify about
    // a crash the user already knows about.
    if status == SvcStatus::Error && previous != Some(SvcStatus::Error) {
        let name = {
            let tree = state.tree.read();
            tree.iter()
                .flat_map(|r| r.worktrees.iter())
                .flat_map(|w| w.services.iter().map(move |s| (w, s)))
                .find(|(_, s)| s.svc_key == key)
                .map(|(w, s)| format!("{} · {}", s.name, w.branch))
                .unwrap_or_else(|| key.to_string())
        };
        crate::notify::notify(
            app,
            crate::notify::Kind::ServiceCrash,
            key,
            "A service crashed",
            &match exit_code {
                Some(c) => format!("{name} exited with code {c}"),
                None => format!("{name} exited"),
            },
        );
    }
    crate::notify::refresh_badge(app);
}


pub fn push_log(app: &RuntimeContext, key: &str, line: LogLine) {
    let table = app.state::<ProcTable>();
    {
        let mut logs = table.logs.lock();
        let buf = logs.entry(key.to_string()).or_default();
        buf.push_back(line.clone());
        while buf.len() > LOG_CAP {
            buf.pop_front();
        }
    }
    persist_log_lines(app, key, std::slice::from_ref(&line));
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct LogEvent<'a> {
        svc_key: &'a str,
        lines: Vec<LogLine>,
    }
    // ring + disk always record; the emit is skipped while nothing is on
    // screen (the UI re-snapshots the ring via get_logs on tab select,
    // primeLogs, and window focus)
    if app.interested(crate::runtime::Audience::Main) {
        let _ = app.emit_to(crate::runtime::Audience::Main, "service:log", &LogEvent { svc_key: key, lines: vec![line] });
    }
}

/// Cap for one on-disk service log before it rolls to `<name>.1.log`.
const SVC_LOG_ROTATE_BYTES: u64 = 2 * 1024 * 1024;
/// Longest generated log filename stem; beyond this the flattened svc_key is
/// truncated and hashed, since 255 bytes is the per-component limit on APFS,
/// ext4 and NTFS alike and deep worktree paths flatten into long names.
const LOG_NAME_MAX: usize = 120;

/// Open sink for one service's on-disk log. Holding the handle (and counting
/// bytes in-process) keeps the steady-state cost of a flush to a single
/// `write` — the log pump fires every 80ms per running service, so resolving
/// the directory and reopening the file each time was pure syscall overhead.
pub struct LogSink {
    file: std::fs::File,
    written: u64,
}

/// `<app-log-dir>/services`, resolved and created once per run.
fn service_log_dir(app: &RuntimeContext) -> Option<&std::path::PathBuf> {
    app.service_log_dir()
}

/// svc_key (`<wt path>::<service id>`) flattened to a filesystem-safe stem,
/// length-bounded so a deep worktree path can't overflow the 255-byte
/// filename limit.
fn log_file_stem(key: &str) -> String {
    let flat: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' })
        .collect();
    if flat.len() <= LOG_NAME_MAX {
        return flat;
    }
    // keep the tail (worktree + service, the part a human recognizes) and
    // prefix a cheap hash of the whole key so distinct services never collide
    let mut h: u64 = 0xcbf29ce484222325;
    for b in key.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let tail: String = flat.chars().skip(flat.chars().count() - (LOG_NAME_MAX - 17)).collect();
    format!("{h:016x}_{tail}")
}

/// Append log lines to a per-service file under `<app-log-dir>/services/`.
/// The in-memory ring keeps only LOG_CAP lines — a crash 500 lines in would
/// otherwise lose its own cause. Best-effort: log I/O never fails a service op.
fn persist_log_lines(app: &RuntimeContext, key: &str, lines: &[LogLine]) {
    use std::io::Write;
    if lines.is_empty() {
        return;
    }
    let Some(dir) = service_log_dir(app) else { return };
    let mut body = String::new();
    for l in lines {
        use std::fmt::Write as _;
        let _ = writeln!(body, "{} [{}] {}", l.t, l.lv, l.text);
    }

    let table = app.state::<ProcTable>();
    let mut sinks = table.log_files.lock();
    let stem = log_file_stem(key);
    let path = dir.join(format!("{stem}.log"));

    // rotate on the byte count we already track — no metadata() syscall
    if let Some(s) = sinks.get(key) {
        if s.written + body.len() as u64 > SVC_LOG_ROTATE_BYTES {
            sinks.remove(key); // drop the handle before renaming (Windows)
            let _ = std::fs::rename(&path, dir.join(format!("{stem}.1.log")));
        }
    }
    let sink = match sinks.entry(key.to_string()) {
        std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
        std::collections::hash_map::Entry::Vacant(e) => {
            let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else { return };
            let written = file.metadata().map(|m| m.len()).unwrap_or(0);
            e.insert(LogSink { file, written })
        }
    };
    if sink.file.write_all(body.as_bytes()).is_ok() {
        sink.written += body.len() as u64;
    }
}

/// Persist live service pgids so a crash can be swept on next launch. Unix-only:
/// on Windows the Job Object's KILL_ON_JOB_CLOSE makes the OS reap the tree when
/// Canopy dies, so there is nothing to persist or sweep.
#[cfg(unix)]
fn persist_orphans(app: &RuntimeContext) {
    use crate::settings::OrphanProc;
    let table = app.state::<ProcTable>();
    let orphans: Vec<OrphanProc> = table
        .procs
        .lock()
        .iter()
        .map(|(k, p)| OrphanProc {
            svc_key: k.clone(),
            pgid: crate::proc::group_key(&p.group) as i32,
            spawn_time_secs: p.started_unix,
        })
        .collect();
    let state = app.state::<AppState>();
    let runtime = {
        let mut rt = state.runtime.write();
        rt.orphans = orphans;
        rt.clone()
    };
    let _ = crate::settings::save_runtime(app, &runtime);
}

#[cfg(windows)]
fn persist_orphans(_app: &RuntimeContext) {}

/// Resolve a service's config + worktree env (PORT etc.) from settings.
fn resolve_service(app: &RuntimeContext, key: &str) -> Result<(ServiceCfg, String, HashMap<String, String>), String> {
    let state = app.state::<AppState>();
    let tree = state.tree.read();
    for r in tree.iter() {
        for w in r.worktrees.iter() {
            for s in w.services.iter() {
                if s.svc_key == key {
                    let settings = state.settings.read();
                    let repo = settings.repos.iter().find(|rc| rc.id == r.repo_id).ok_or("repo gone")?;
                    let cfg = repo
                        .services
                        .iter()
                        .find(|sc| sc.id == s.service_id)
                        .ok_or("service gone")?
                        .clone();
                    let mut env = cfg.env.clone();
                    // A service command must see exactly the variables setup saw
                    // — same builder, no second implementation to drift from it
                    // (see state::build_wt_vars).
                    let siblings: Vec<(String, String, u32)> = w
                        .services
                        .iter()
                        .filter_map(|sib| Some((sib.service_id.clone(), sib.name.clone(), sib.port?)))
                        .collect();
                    let idx = crate::state::existing_port_index(app, &r.repo_id, &w.path);
                    let db = crate::state::resolve_db_name(app, &r.repo_id, &w.path);
                    env.extend(crate::state::build_wt_vars(&w.path, idx, db, &siblings));
                    if let Some(port) = s.port {
                        env.insert("PORT".into(), port.to_string());
                    }
                    return Ok((cfg, w.path.clone(), env));
                }
            }
        }
    }
    Err(format!("unknown service: {key}"))
}

// ── resolved environment (the Service detail modal) ───────────────────
//
// "Why is this service talking to the wrong database?" is the most common
// worktree-isolation bug, and it is unanswerable without seeing the values the
// process actually runs with. Two things contribute, and telling them apart is
// most of the answer:
//
//   spawn  — what Canopy puts in the child's environment (`resolve_service`)
//   dotenv — what setup provisioned into the worktree's .env files, which the
//            process loads itself
//
// Spawn wins on a collision, because a dotenv loader does not overwrite an
// already-set process variable by default.

/// One resolved environment variable, with where it came from.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvEntry {
    pub key: String,
    /// masked when the key looks secret, or when a URL carries credentials
    pub value: String,
    /// "spawn" | "dotenv"
    pub source: &'static str,
    /// the real value was withheld — the UI says so rather than implying the
    /// process runs with literal bullets
    pub masked: bool,
}

/// Key fragments that mean "this is a credential". Matched case-insensitively
/// as substrings, so `GITHUB_TOKEN`, `jwtSecret` and `DB_PASSWORD` all hit.
const SECRET_HINTS: [&str; 9] =
    ["secret", "token", "password", "passwd", "apikey", "api_key", "private", "credential", "signing"];

fn looks_secret(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    SECRET_HINTS.iter().any(|h| k.contains(h))
}

/// Redact `scheme://user:password@host` in place, leaving everything else
/// readable. A repo `.env` routinely holds a DATABASE_URL whose password is the
/// only secret in it — masking the whole value would hide the database name,
/// which is the single thing this panel exists to show.
fn redact_url_credentials(value: &str) -> Option<String> {
    let (scheme, rest) = value.split_once("://")?;
    let (authority, tail) = match rest.split_once('/') {
        Some((a, t)) => (a, Some(t)),
        None => (rest, None),
    };
    let (userinfo, host) = authority.split_once('@')?;
    let (user, _pass) = userinfo.split_once(':')?;
    let mut out = format!("{scheme}://{user}:••••@{host}");
    if let Some(t) = tail {
        out.push('/');
        out.push_str(t);
    }
    Some(out)
}

fn mask(key: &str, value: &str) -> (String, bool) {
    if value.is_empty() {
        return (value.to_string(), false);
    }
    if looks_secret(key) {
        return ("••••••••".to_string(), true);
    }
    match redact_url_credentials(value) {
        Some(v) => (v, true),
        None => (value.to_string(), false),
    }
}

/// Every variable a service runs (or would run) with, ordered spawn-first and
/// masked. Works whether or not the service is running: this is the resolved
/// configuration, not a snapshot of a live process.
pub fn resolved_env(app: &RuntimeContext, key: &str) -> Result<Vec<EnvEntry>, String> {
    let (cfg, wt_path, spawn_env) = resolve_service(app, key)?;

    let mut out: Vec<EnvEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    // spawn env first — it is what actually wins
    let mut spawn: Vec<(String, String)> = spawn_env.into_iter().collect();
    spawn.sort_by(|a, b| a.0.cmp(&b.0));
    for (k, v) in spawn {
        let (value, masked) = mask(&k, &v);
        seen.insert(k.clone());
        out.push(EnvEntry { key: k, value, source: "spawn", masked });
    }

    // then the dotenvs the process loads itself: the worktree root, and the
    // service's own working directory when it has one (e.g. `server/.env`)
    let mut dotenv_paths = vec![std::path::Path::new(&wt_path).join(".env")];
    if !cfg.cwd.trim().is_empty() {
        dotenv_paths.push(std::path::Path::new(&wt_path).join(&cfg.cwd).join(".env"));
    }
    for path in dotenv_paths {
        let Ok(txt) = std::fs::read_to_string(&path) else { continue };
        for (k, v) in crate::setup::parse_dotenv(&txt) {
            if !seen.insert(k.clone()) {
                continue; // already set in the spawn env, which takes precedence
            }
            let (value, masked) = mask(&k, &v);
            out.push(EnvEntry { key: k, value, source: "dotenv", masked });
        }
    }
    Ok(out)
}

pub async fn start_service(app: &RuntimeContext, key: &str) -> Result<(), String> {
    {
        let table = app.state::<ProcTable>();
        if table.procs.lock().contains_key(key) {
            return Ok(()); // already running
        }
    }
    let (cfg, wt_path, env) = resolve_service(app, key)?;
    let cwd = if cfg.cwd.is_empty() {
        wt_path.clone()
    } else {
        format!("{wt_path}/{}", cfg.cwd)
    };

    set_status(app, key, SvcStatus::Starting, None, None);
    push_log(app, key, LogLine::now("info", format!("starting {}…", cfg.name.to_lowercase())));

    // expand ${PORT} in the command, run via the user's login shell so
    // nvm/volta/asdf resolve
    let mut command_str = cfg.command.clone();
    if let Some(port) = env.get("PORT") {
        command_str = command_str.replace("${PORT}", port).replace("$PORT", port);
    }
    // honor the worktree's pinned Node version (see toolchain.rs)
    command_str = crate::toolchain::with_pinned_node(&cwd, &command_str);

    let (shell, shargs) = crate::toolchain::shell_argv(&command_str);
    let mut cmd = Command::new(shell);
    cmd.args(&shargs)
        .current_dir(&cwd)
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    // isolate the child (+ its whole tree) in its own process group / job so we
    // can tear it all down on stop (see proc.rs)
    crate::proc::prepare_group_command(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        set_status(app, key, SvcStatus::Error, None, None);
        push_log(app, key, LogLine::now("err", format!("spawn failed: {e}")));
        format!("spawn failed: {e}")
    })?;

    let pid = child.id().unwrap_or(0);
    // establish the group (Windows: assigns the suspended child to a Job and
    // resumes it). On failure the child would linger — kill it and bail.
    let group = match crate::proc::attach_group(pid) {
        Ok(g) => g,
        Err(e) => {
            let _ = child.kill().await;
            set_status(app, key, SvcStatus::Error, None, None);
            push_log(app, key, LogLine::now("err", format!("group setup failed: {e}")));
            return Err(format!("group setup failed: {e}"));
        }
    };
    let started_unix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();

    let generation = {
        let table = app.state::<ProcTable>();
        let generation = table.next_gen();
        table.procs.lock().insert(
            key.to_string(),
            ProcEntry { pid, group, started_at: Instant::now(), started_unix, generation },
        );
        generation
    };
    persist_orphans(app);

    let port = env.get("PORT").and_then(|p| p.parse::<u32>().ok());
    let health = cfg.health.trim().to_string();
    match (port, health.is_empty()) {
        (Some(p), false) => {
            // Stay in Starting and let the probe decide. The dot going green
            // then means "it answered", not "the shell forked".
            push_log(app, key, LogLine::now("info", format!("spawned — probing http://localhost:{p}{health}")));
            let app2 = app.clone();
            let key2 = key.to_string();
            let h = health.clone();
            app.executor().spawn(async move {
                if await_ready(&app2, &key2, p, &h, generation).await {
                    set_status(&app2, &key2, SvcStatus::Running, Some(started_unix), None);
                    push_log(&app2, &key2, LogLine::now("ok", format!("ready — http://localhost:{p}{h}")));
                } else {
                    // Only report a failure if this generation is still the
                    // live one: a stop or restart while probing is not an error.
                    let still_ours = {
                        let table = app2.state::<ProcTable>();
                        let procs = table.procs.lock();
                        procs.get(&key2).is_some_and(|e| e.generation == generation)
                    };
                    if still_ours {
                        push_log(&app2, &key2, LogLine::now("err", format!("never became ready — {h} did not answer on :{p}")));
                        set_status(&app2, &key2, SvcStatus::Error, None, None);
                    }
                }
            });
        }
        // No probe (or no port): Running as soon as the process exists — the
        // behaviour before health checks, and the only honest answer when
        // there is nothing to ask.
        _ => {
            set_status(app, key, SvcStatus::Running, Some(started_unix), None);
            if let Some(p) = port {
                push_log(app, key, LogLine::now("ok", format!("spawned — expecting http://localhost:{p}")));
            }
        }
    }

    // ── log pumps (batched) ──
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    for (stream, is_err) in [(stdout.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), false)]
        .into_iter()
        .chain([(stderr.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), true)])
    {
        let Some(stream) = stream else { continue };
        let app = app.clone();
        let key = key.to_string();
        app.executor().spawn(async move {
            let mut lines = BufReader::new(stream).lines();
            let mut batch: Vec<LogLine> = Vec::new();
            let mut last_flush = Instant::now();
            loop {
                let line = tokio::select! {
                    l = lines.next_line() => l,
                    _ = tokio::time::sleep(Duration::from_millis(LOG_FLUSH_MS)) => {
                        if !batch.is_empty() { flush_batch(&app, &key, &mut batch); }
                        last_flush = Instant::now();
                        continue;
                    }
                };
                match line {
                    Ok(Some(text)) => {
                        let lv = classify_line(&text, is_err);
                        batch.push(LogLine::now(lv, text));
                        if last_flush.elapsed().as_millis() as u64 >= LOG_FLUSH_MS {
                            flush_batch(&app, &key, &mut batch);
                            last_flush = Instant::now();
                        }
                    }
                    _ => {
                        if !batch.is_empty() {
                            flush_batch(&app, &key, &mut batch);
                        }
                        break;
                    }
                }
            }
        });
    }

    // ── waiter: authoritative exit handling ──
    {
        let app = app.clone();
        let key = key.to_string();
        app.executor().spawn(async move {
            let status = child.wait().await;
            let table = app.state::<ProcTable>();
            {
                let mut procs = table.procs.lock();
                match procs.get(&key) {
                    Some(p) if p.generation == generation => {
                        procs.remove(&key);
                    }
                    // a newer process replaced us (restart) — don't touch state
                    _ => return,
                }
            }
            persist_orphans(&app);
            let code = status.ok().and_then(|s| s.code());
            match code {
                Some(0) => {
                    push_log(&app, &key, LogLine::now("warn", "process exited (code 0)"));
                    set_status(&app, &key, SvcStatus::Stopped, None, Some(0));
                }
                Some(c) => {
                    push_log(&app, &key, LogLine::now("err", format!("process exited (code {c})")));
                    set_status(&app, &key, SvcStatus::Error, None, Some(c));
                }
                None => {
                    // killed by signal (our stop path or external)
                    push_log(&app, &key, LogLine::now("warn", "process exited (SIGTERM)"));
                    set_status(&app, &key, SvcStatus::Stopped, None, None);
                }
            }
        });
    }

    Ok(())
}

fn flush_batch(app: &RuntimeContext, key: &str, batch: &mut Vec<LogLine>) {
    let table = app.state::<ProcTable>();
    {
        let mut logs = table.logs.lock();
        let buf = logs.entry(key.to_string()).or_default();
        for l in batch.iter() {
            buf.push_back(l.clone());
        }
        while buf.len() > LOG_CAP {
            buf.pop_front();
        }
    }
    persist_log_lines(app, key, batch);
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct LogEvent<'a> {
        svc_key: &'a str,
        lines: Vec<LogLine>,
    }
    // see push_log: recorded always, emitted only when someone can see it
    if app.interested(crate::runtime::Audience::Main) {
        let _ = app.emit_to(crate::runtime::Audience::Main, "service:log", &LogEvent { svc_key: key, lines: std::mem::take(batch) });
    } else {
        batch.clear();
    }
}

/// Case-insensitive substring search without allocating (the old
/// `to_lowercase()` copied every log line — thousands per webpack burst).
fn contains_ci(hay: &str, needle: &str) -> bool {
    let (h, n) = (hay.as_bytes(), needle.as_bytes());
    !n.is_empty() && h.len() >= n.len() && h.windows(n.len()).any(|w| w.eq_ignore_ascii_case(n))
}

fn classify_line(text: &str, _from_stderr: bool) -> &'static str {
    if contains_ci(text, "error") || contains_ci(text, "fatal") || contains_ci(text, "err!") {
        "err"
    } else if contains_ci(text, "warn") {
        "warn"
    } else if contains_ci(text, "listening") || contains_ci(text, "compiled successfully") || contains_ci(text, "ready") {
        "ok"
    } else {
        // stderr alone isn't an error — many dev tools log normal output there
        "info"
    }
}

pub async fn stop_service(app: &RuntimeContext, key: &str) -> Result<(), String> {
    // graceful terminate under the lock (we need the group handle); capture the
    // generation so a restart during the grace window isn't hard-killed by us.
    let generation = {
        let table = app.state::<ProcTable>();
        let procs = table.procs.lock();
        match procs.get(key) {
            Some(p) => {
                crate::proc::terminate_group(&p.group);
                p.generation
            }
            None => return Ok(()), // not running
        }
    };

    set_status(app, key, SvcStatus::Stopping, None, None);

    // grace period, then hard kill if the *same* process is still tracked
    let app2 = app.clone();
    let key2 = key.to_string();
    app.executor().spawn(async move {
        tokio::time::sleep(STOP_GRACE).await;
        let table = app2.state::<ProcTable>();
        let procs = table.procs.lock();
        if let Some(p) = procs.get(&key2) {
            if p.generation == generation {
                crate::proc::kill_group(&p.group);
            }
        }
    });
    Ok(())
}

/// Wait up to `ticks * 150ms` for the waiter task to reap `key`.
async fn wait_reaped(app: &RuntimeContext, key: &str, ticks: u32) -> bool {
    for _ in 0..ticks {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let table = app.state::<ProcTable>();
        if !table.procs.lock().contains_key(key) {
            return true;
        }
    }
    false
}

pub async fn restart_service(app: &RuntimeContext, key: &str) -> Result<(), String> {
    let was_running = {
        let table = app.state::<ProcTable>();
        let procs = table.procs.lock();
        procs.contains_key(key)
    };
    if was_running {
        push_log(app, key, LogLine::now("warn", "restarting…"));
        stop_service(app, key).await?;
        // stop() SIGTERMs now and SIGKILLs at the 3s grace mark; give the
        // waiter up to 6s to reap before escalating ourselves.
        if !wait_reaped(app, key, 40).await {
            {
                let table = app.state::<ProcTable>();
                let procs = table.procs.lock();
                if let Some(p) = procs.get(key) {
                    crate::proc::kill_group(&p.group);
                }
            }
            if !wait_reaped(app, key, 20).await {
                // start_service would see the stale entry and return Ok(())
                // doing nothing — the restart MUST fail loudly instead, or a
                // port/database change reports applied while the old process
                // keeps serving the old config.
                let msg = "restart failed: previous process did not exit (SIGKILL sent) — try again";
                push_log(app, key, LogLine::now("err", msg));
                return Err(msg.into());
            }
        }
    }
    start_service(app, key).await
}

/// Stop everything; returns once all process groups are reaped or grace expires.
pub async fn stop_all(app: &RuntimeContext) {
    let keys: Vec<String> = {
        let table = app.state::<ProcTable>();
        let procs = table.procs.lock();
        procs.keys().cloned().collect()
    };
    for k in &keys {
        let _ = stop_service(app, k).await;
    }
    for _ in 0..40 {
        let table = app.state::<ProcTable>();
        let empty = table.procs.lock().is_empty();
        if empty {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// Worktree-level: collect svc keys of one worktree.
pub fn worktree_svc_keys(app: &RuntimeContext, wt_key: &str) -> Vec<String> {
    app.state::<AppState>().wt_service_keys(wt_key)
}

/// Reset DB: runs the repo's resetDb command in the worktree root; output goes
/// to the first server-kind service's log buffer.
pub async fn reset_db(app: &RuntimeContext, wt_key: &str) -> Result<(), String> {
    let (cmd_str, log_key) = {
        let state = app.state::<AppState>();
        let tree = state.tree.read();
        let settings = state.settings.read();
        let mut found = None;
        for r in tree.iter() {
            for w in r.worktrees.iter() {
                if w.wt_key == wt_key {
                    let repo = settings.repos.iter().find(|rc| rc.id == r.repo_id).ok_or("repo gone")?;
                    if repo.reset_db.trim().is_empty() {
                        return Err("No Reset DB command configured for this repo (Settings)".into());
                    }
                    let log_svc = w
                        .services
                        .iter()
                        .find(|s| s.kind == "server")
                        .or(w.services.first())
                        .map(|s| s.svc_key.clone());
                    found = Some((repo.reset_db.clone(), log_svc));
                }
            }
        }
        found.ok_or("unknown worktree")?
    };

    // concurrency guard: the command layer holds the per-worktree OpLease
    // (state::try_lease) for the whole reset — no separate flag needed.

    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct ResetEvent<'a> {
        wt_key: &'a str,
        state: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    }
    let _ = app.emit("reset:status", &ResetEvent { wt_key, state: "started", message: None });
    if let Some(k) = &log_key {
        push_log(app, k, LogLine::now("warn", "db: reset started…"));
    }

    // honor the worktree's pinned Node version (ToolJet's reset scripts need it)
    let wrapped = crate::toolchain::with_pinned_node(wt_key, &cmd_str);
    let (shell, shargs) = crate::toolchain::shell_argv(&wrapped);
    let out = Command::new(shell)
        .args(&shargs)
        .current_dir(wt_key)
        .output()
        .await;

    match out {
        Ok(o) if o.status.success() => {
            if let Some(k) = &log_key {
                for line in String::from_utf8_lossy(&o.stdout).lines().rev().take(5).collect::<Vec<_>>().into_iter().rev() {
                    push_log(app, k, LogLine::now("info", line.to_string()));
                }
                push_log(app, k, LogLine::now("ok", "db: reset complete"));
            }
            let _ = app.emit("reset:status", &ResetEvent { wt_key, state: "done", message: None });
            Ok(())
        }
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            if let Some(k) = &log_key {
                push_log(app, k, LogLine::now("err", format!("db: reset failed — {err}")));
            }
            let _ = app.emit("reset:status", &ResetEvent { wt_key, state: "error", message: Some(err.clone()) });
            Err(err)
        }
        Err(e) => {
            let _ = app.emit("reset:status", &ResetEvent { wt_key, state: "error", message: Some(e.to_string()) });
            Err(e.to_string())
        }
    }
}

/// Startup sweep: kill process groups left over from a crash. Only kills when
/// the group leader still exists and its start time matches what we recorded
/// (avoids killing a recycled PID). Unix-only — on Windows KILL_ON_JOB_CLOSE
/// makes the OS reap the tree when Canopy dies, so there are no orphans to sweep.
#[cfg(unix)]
pub fn sweep_orphans(app: &RuntimeContext) {
    let orphans = {
        let state = app.state::<AppState>();
        let rt = state.runtime.read();
        rt.orphans.clone()
    };
    for o in &orphans {
        if o.pgid <= 1 {
            continue;
        }
        let alive = unsafe { libc::killpg(o.pgid, 0) == 0 };
        if alive && proc_start_time_matches(o.pgid as u32, o.spawn_time_secs) {
            log::warn!("sweeping orphan pgid {} ({})", o.pgid, o.svc_key);
            unsafe {
                libc::killpg(o.pgid, libc::SIGTERM);
            }
        }
    }
    let state = app.state::<AppState>();
    let runtime = {
        let mut rt = state.runtime.write();
        rt.orphans.clear();
        rt.clone()
    };
    let _ = crate::settings::save_runtime(app, &runtime);
}

#[cfg(windows)]
pub fn sweep_orphans(_app: &RuntimeContext) {}

/// Compare recorded spawn time against the process's actual start time (±5s).
/// This is the guard against PID recycling: after a reboot (or enough process
/// churn) the persisted pgid can belong to an unrelated process — the sweep
/// must never SIGTERM that. Unix-only; only the Unix crash sweep calls it.
#[cfg(unix)]
pub(crate) fn proc_start_time_matches(pid: u32, recorded_secs: u64) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        false,
        ProcessRefreshKind::nothing(),
    );
    let Some(p) = sys.process(Pid::from_u32(pid)) else { return false };
    let actual = p.start_time(); // seconds since the epoch
    // an unreadable start time (0) fails the match — skipping a sweep is safe,
    // killing an innocent process group is not
    actual != 0 && actual.abs_diff(recorded_secs) <= 5
}

// ── readiness probes ──────────────────────────────────────────────────
//
// A spawned process is not a working service. `pnpm dev` returns instantly
// and then spends thirty seconds compiling; marking it "running" the moment
// the shell forks is why the dot goes green before anything answers the port.
//
// When a service declares a health path, Canopy holds it in `Starting` until
// that path answers, and only then calls it Running.
//
// The probe is a hand-rolled HTTP/1.1 GET over TcpStream rather than an HTTP
// client dependency: the target is always `127.0.0.1:<own port>`, so there is
// no TLS, no redirects, no proxies and no DNS. A crate for this would be a
// large dependency to answer "did localhost return a 2xx".

/// How long to keep probing before calling the start a failure. Generous: a
/// cold TypeScript build legitimately takes this long.
const READY_TIMEOUT: Duration = Duration::from_secs(120);
/// Gap between attempts. Short enough to feel immediate, long enough not to
/// spin while a compiler is using the CPU.
const PROBE_INTERVAL: Duration = Duration::from_millis(400);
/// A single attempt's budget — a server accepting the connection but never
/// replying must not stall the whole probe loop.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// One GET against `127.0.0.1:port`. `Ok(true)` only for a 2xx or 3xx status.
async fn probe_once(port: u32, path: &str) -> Result<bool, String> {
    use tokio::io::AsyncWriteExt;
    let path = if path.starts_with('/') { path.to_string() } else { format!("/{path}") };
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port as u16))
        .await
        .map_err(|e| e.to_string())?;
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: Canopy\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;

    // Only the status line is needed, and reading it alone means a health
    // endpoint returning a large body costs nothing.
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await.map_err(|e| e.to_string())?;
    let code: u16 = line.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    Ok((200..400).contains(&code))
}

/// Poll a service's health path until it answers, the deadline passes, or the
/// process dies. Returns whether the service became ready.
///
/// The process check matters: without it, a service that crashes two seconds
/// after spawning would sit in `Starting` for the full two minutes instead of
/// reporting the failure immediately.
pub async fn await_ready(app: &RuntimeContext, key: &str, port: u32, path: &str, generation: u64) -> bool {
    let started = Instant::now();
    let mut announced = false;
    while started.elapsed() < READY_TIMEOUT {
        // stopped, restarted, or exited — nothing left to wait for
        let alive = {
            let table = app.state::<ProcTable>();
            let procs = table.procs.lock();
            procs.get(key).is_some_and(|p| p.generation == generation)
        };
        if !alive {
            return false;
        }
        match tokio::time::timeout(PROBE_TIMEOUT, probe_once(port, path)).await {
            Ok(Ok(true)) => return true,
            _ => {
                if !announced {
                    push_log(app, key, LogLine::now("info", format!("waiting for {path} on :{port}…")));
                    announced = true;
                }
            }
        }
        tokio::time::sleep(PROBE_INTERVAL).await;
    }
    false
}

#[cfg(test)]
mod env_tests {
    use super::{looks_secret, mask, redact_url_credentials};

    #[test]
    fn secret_looking_keys_are_masked_whole() {
        assert!(looks_secret("GITHUB_TOKEN"));
        assert!(looks_secret("jwtSecret"), "case-insensitive substring");
        assert!(looks_secret("DB_PASSWORD"));
        assert!(looks_secret("STRIPE_API_KEY"));
        assert!(!looks_secret("PORT"));
        assert!(!looks_secret("PG_DB"));
        assert!(!looks_secret("TOOLJET_HOST"));

        let (v, masked) = mask("GITHUB_TOKEN", "ghp_realvalue");
        assert_eq!(v, "••••••••");
        assert!(masked);
        assert!(!v.contains("ghp_"), "the real value never leaves the backend");
    }

    #[test]
    fn urls_keep_everything_but_the_password() {
        // the database NAME is the one thing this panel exists to show, so a
        // whole-value mask here would defeat the feature
        let redacted = redact_url_credentials("postgres://admin:hunter2@localhost:5432/tj_history").unwrap();
        assert!(redacted.contains("tj_history"), "database name survives: {redacted}");
        assert!(redacted.contains("admin"), "user survives: {redacted}");
        assert!(redacted.contains("localhost:5432"), "host survives: {redacted}");
        assert!(!redacted.contains("hunter2"), "password does not: {redacted}");

        // a credential-free URL is left completely alone
        assert!(redact_url_credentials("postgres://localhost/tj_history").is_none());
        let (v, masked) = mask("DATABASE_URL", "postgres://localhost/tj_history");
        assert_eq!(v, "postgres://localhost/tj_history");
        assert!(!masked, "nothing was withheld, so nothing is claimed to be");
    }

    #[test]
    fn ordinary_values_pass_through() {
        assert_eq!(mask("PORT", "3160"), ("3160".to_string(), false));
        assert_eq!(mask("TOOLJET_HOST", "http://localhost:8242"), ("http://localhost:8242".to_string(), false));
        // an empty value is not a secret worth bulleting — it's just empty
        assert_eq!(mask("SECRET_KEY", ""), (String::new(), false));
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_line, log_file_stem, LOG_NAME_MAX};

    #[test]
    fn log_file_stem_is_safe_and_length_bounded() {
        let short = log_file_stem("/Users/me/wt/feat::frontend");
        assert_eq!(short, "_Users_me_wt_feat__frontend", "separators flattened");

        // a deep path must not overflow the 255-byte filename limit
        let deep = format!("/Users/me/{}/wt::server", "nested-dir/".repeat(40));
        let stem = log_file_stem(&deep);
        assert!(stem.len() <= LOG_NAME_MAX, "bounded: {}", stem.len());
        assert!(stem.ends_with("wt__server"), "keeps the recognizable tail: {stem}");

        // two long keys differing only at the head still get distinct names
        let a = log_file_stem(&format!("/a/{}/wt::server", "x/".repeat(80)));
        let b = log_file_stem(&format!("/b/{}/wt::server", "x/".repeat(80)));
        assert_ne!(a, b, "hash prefix disambiguates truncated names");
    }

    /// The PID-recycling guard must recognize a live process's real start time
    /// (this also proves sysinfo delivers a non-zero start_time on this OS —
    /// the guard fails closed to "no match" when it can't read one).
    #[test]
    #[cfg(unix)]
    fn own_process_start_time_matches_itself() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let pid = std::process::id();
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
            false,
            ProcessRefreshKind::nothing(),
        );
        let start = sys.process(Pid::from_u32(pid)).map(|p| p.start_time()).unwrap_or(0);
        assert!(start > 0, "sysinfo must expose a start time");
        assert!(super::proc_start_time_matches(pid, start), "exact start time matches");
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        assert!(!super::proc_start_time_matches(pid, now + 3600), "wrong time must not match");
    }

    #[test]
    fn classifies_log_levels() {
        assert_eq!(classify_line("Error: boom", false), "err");
        assert_eq!(classify_line("npm WARN deprecated", false), "warn");
        assert_eq!(classify_line("webpack compiled successfully", false), "ok");
        assert_eq!(classify_line("Listening on :3000", true), "ok");
        assert_eq!(classify_line("plain build output", true), "info", "stderr alone isn't an error");
    }

    #[test]
    fn contains_ci_edge_cases() {
        assert!(super::contains_ci("XxErRoRxX", "error"), "mid-word, mixed case");
        assert!(!super::contains_ci("err", "error"), "needle longer than hay");
        assert!(!super::contains_ci("", "e"), "empty hay");
        assert!(!super::contains_ci("anything", ""), "empty needle matches nothing (never classifies)");
    }

    /// The packed-atomic cache must round-trip both extremes of the legal
    /// UTC-offset range without the timestamp and offset bleeding into each
    /// other's bits.
    #[test]
    fn offset_packing_round_trips() {
        use super::{pack_offset, unpack_offset, OFFSET_BIAS};
        for &off in &[-OFFSET_BIAS, -3600, 0, 19800 /* +05:30 */, OFFSET_BIAS] {
            for &ts in &[0u64, 1_722_500_000, u64::MAX >> 21] {
                assert_eq!(unpack_offset(pack_offset(ts, off)), (ts, off), "ts={ts} off={off}");
            }
        }
    }
}

#[cfg(test)]
mod health_probe_tests {
    use super::probe_once;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Serve one connection with `status_line`, and hand back the request's
    /// first line so a test can assert what was actually asked for.
    async fn stub(status_line: &'static str) -> (u32, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port() as u32;
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 512];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let _ = sock.write_all(status_line.as_bytes()).await;
            req.lines().next().unwrap_or("").to_string()
        });
        (port, handle)
    }

    #[tokio::test]
    async fn a_2xx_status_is_healthy() {
        let (port, _h) = stub("HTTP/1.1 200 OK\r\n\r\n").await;
        assert_eq!(probe_once(port, "/api/health").await, Ok(true));
    }

    #[tokio::test]
    async fn a_4xx_status_is_not_healthy() {
        let (port, _h) = stub("HTTP/1.1 404 Not Found\r\n\r\n").await;
        assert_eq!(probe_once(port, "/api/health").await, Ok(false));
    }

    /// 3xx counts as healthy — a dev server that redirects is answering.
    #[tokio::test]
    async fn a_redirect_is_healthy() {
        let (port, _h) = stub("HTTP/1.1 301 Moved Permanently\r\n\r\n").await;
        assert_eq!(probe_once(port, "/").await, Ok(true));
    }

    /// Fail closed: an unparseable status line must read as unhealthy rather
    /// than marking a service green because the probe got confused.
    #[tokio::test]
    async fn a_malformed_status_line_is_not_healthy() {
        let (port, _h) = stub("garbage\r\n\r\n").await;
        assert_eq!(probe_once(port, "/api/health").await, Ok(false));
    }

    /// Nothing listening is an error, not a false "healthy".
    #[tokio::test]
    async fn a_closed_port_is_an_error() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port() as u32;
        drop(listener);
        assert!(probe_once(port, "/api/health").await.is_err());
    }

    /// The config field is a path, and a user will write it either way.
    #[tokio::test]
    async fn a_path_without_a_leading_slash_still_requests_an_absolute_one() {
        let (port, h) = stub("HTTP/1.1 200 OK\r\n\r\n").await;
        assert_eq!(probe_once(port, "api/health").await, Ok(true));
        assert_eq!(h.await.unwrap(), "GET /api/health HTTP/1.1");
    }
}
