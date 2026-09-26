// Embedded per-worktree terminals.
//
// Each session is a real PTY running the user's login shell in a worktree's
// directory — the foundation for the agent lane, where the configured coding
// agent CLI runs inside a shell just like anything else the user types.
//
// Model mirrors `services.rs`: a table of sessions keyed by an opaque id, with a
// capped scrollback ring buffer per session so a late-joining or re-mounting
// window can rehydrate. Where a service is spawned over pipes and read *by line*
// on the async runtime, a PTY is raw, bidirectional, byte-oriented I/O — so the
// read loop lives on a dedicated std thread and streams `terminal:data` events.
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
#[cfg(unix)]
use crate::settings::TermOrphan;
// read by the activity detector (agent profile lookup) and the embedded-shell
// config lookup on every platform, and by the Unix orphan persist/sweep
use crate::state::AppState;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use parking_lot::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use crate::runtime::RuntimeContext;

/// Per-session scrollback cap (bytes). Big enough for a screenful of history on
/// rehydrate, small enough to stay cheap across many idle worktrees.
const SCROLLBACK_CAP: usize = 256 * 1024;
/// Idle shell sessions past this are swept (bounds long-run memory/threads over,
/// e.g., an overnight run of visiting many worktrees). Agents are exempt.
const IDLE_LIMIT: Duration = Duration::from_secs(60 * 60);
// a read() returns whatever bytes are already available (up to this size), so a
// larger buffer coalesces bursts into fewer events — fewer base64/JSON emits
// under heavy output, with no added latency for small writes.
const READ_CHUNK: usize = 32 * 1024;

/// What an agent session is doing right now.
///
/// Deliberately only two values: a *live* PTY is either working or blocked on
/// a human. "idle" is the absence of a session, which the frontend already
/// derives from `running` — modelling it here would create a third state that
/// nothing can ever observe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Activity {
    Busy,
    Waiting,
}

/// Output must be silent for at least this long before the tail is even
/// considered. An agent mid-stream is working by definition, and testing the
/// tail while bytes are flowing would flap on any output that happens to end
/// in a question mark.
const QUIET_BEFORE_WAITING: Duration = Duration::from_millis(1200);

/// How much of the tail to inspect. A prompt lives in the last line or two;
/// reading further back only invites matching a question the agent asked
/// itself several screens ago.
const TAIL_BYTES: usize = 2048;

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    /// Behind its own Arc<Mutex> so a write blocked by a stalled child (full
    /// PTY buffer) doesn't hold the sessions table lock — the reader thread
    /// needs that lock to drain the master, which is what unblocks the write.
    writer: std::sync::Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
    /// raw byte scrollback, capped at SCROLLBACK_CAP
    scrollback: VecDeque<u8>,
    /// total bytes ever emitted for this session (monotonic). Lets a re-mounting
    /// window rehydrate without double-rendering: it replays the snapshot up to
    /// this cursor and applies only later `terminal:data` events.
    seq: u64,
    /// last output or input time, for idle sweeping
    last_activity: Instant,
    /// last *emitted* activity, so the poll only emits on a transition
    activity: Activity,
    /// extra literal snippets that mean "waiting", from the agent profile this
    /// session was launched from. Empty for shells and unconfigured profiles.
    waiting_patterns: Vec<String>,
    /// generation guard: a fast reopen under the same id bumps this so a stale
    /// reader thread doesn't remove/exit the replacement session.
    generation: u64,
    /// child pgid (session leader) + spawn time, persisted for the Unix
    /// crash-orphan sweep. On Windows there is no sweep (portable-pty's ConPTY
    /// child is killed directly), so these go unread there.
    #[allow(dead_code)]
    pgid: i32,
    #[allow(dead_code)]
    started_unix: u64,
}

/// The final scrollback of a session whose process has exited, kept so the UI
/// can still show what it printed. The PTY, child and reader are all gone by
/// then — this is just bytes.
struct ExitedBuffer {
    scrollback: Vec<u8>,
    seq: u64,
    at: Instant,
}

/// How many exited sessions keep their output. Past this the oldest is dropped,
/// so a long session of starting and stopping agents can't grow without bound.
const EXITED_CAP: usize = 24;

#[derive(Default)]
pub struct TermTable {
    pub sessions: Mutex<HashMap<String, PtySession>>,
    /// scrollback of exited sessions, by id (see `ExitedBuffer`)
    exited: Mutex<HashMap<String, ExitedBuffer>>,
    next_gen: AtomicU64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DataEvent<'a> {
    id: &'a str,
    /// base64 of the raw PTY bytes (raw bytes aren't guaranteed valid UTF-8)
    data: String,
    /// cumulative byte cursor *after* this chunk
    seq: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitEvent<'a> {
    id: &'a str,
}

/// Emitted only on a transition, so the attention queue re-renders when an
/// agent starts or stops needing a human — never on a timer.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StateEvent<'a> {
    id: &'a str,
    state: Activity,
}

/// Scrollback snapshot + the byte cursor it ends at (for race-free rehydrate).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BufferSnapshot {
    pub buffer: String,
    pub seq: u64,
}


/// The user's home directory, for "don't open in the worktree root".
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok()).filter(|h| !h.is_empty())
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The kind of a session id — `"agent"` or `"shell"`. A worktree holds any
/// number of each, so ids carry an instance suffix (`…::agent#3`); the wtKey is
/// a filesystem path and never contains `::`, so the last segment is the kind.
/// Ids from before multi-session (`…::agent`) parse the same way.
fn kind_of(id: &str) -> &str {
    let last = id.rsplit("::").next().unwrap_or("");
    last.split('#').next().unwrap_or("")
}

// ── agent activity detection ──────────────────────────────────────────
//
// "An agent is waiting on a human" is the second-highest priority state in the
// app, so it has to be inferred from the only thing Canopy can actually see:
// the PTY byte stream. The rule is deliberately conservative — a false
// "waiting" sends the user to a terminal that doesn't need them, which erodes
// trust in the whole attention queue faster than a missed prompt does.
//
// A session is `Waiting` only when BOTH hold:
//   1. output has been silent for `QUIET_BEFORE_WAITING`, and
//   2. the visible tail is prompt-shaped.
//
// Shell sessions are never evaluated: a shell sitting at `$` matches every
// prompt heuristic there is and means nothing — the user did not ask it a
// question. Only `agent` sessions can be `Waiting`.

/// Strip ANSI/CSI/OSC escape sequences so the tail can be matched as text.
/// Agent CLIs are full TUIs; without this, the "last line" is mostly cursor
/// positioning and colour codes.
fn strip_ansi(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            // carriage returns rewrite the current line in TUIs; treating one
            // as a newline keeps "the last line" meaningful
            out.push(if c == '\r' { '\n' } else { c });
            continue;
        }
        match chars.next() {
            // CSI — parameter bytes then a final byte in @..~
            Some('[') => {
                for c in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&c) {
                        break;
                    }
                }
            }
            // OSC — runs to BEL or ST (ESC \)
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // two-character escape — the second char is already consumed
            _ => {}
        }
    }
    out
}

/// Does this tail look like something waiting for a human?
///
/// Matching is on literal snippets, not regex: Canopy carries no regex engine,
/// and a user-supplied pattern that fails to compile would silently disable
/// detection for that profile — a worse failure than a missed match.
fn looks_like_prompt(tail: &str, extra: &[String]) -> bool {
    let clean = strip_ansi(tail);
    // Box-drawing frames and leading gutters are decoration, not content.
    let lines: Vec<&str> = clean
        .lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || "│┃|╎┆>·".contains(c)))
        .filter(|l| !l.is_empty() && !l.chars().all(|c| "─━═-_ ┌┐└┘├┤┬┴┼╭╮╰╯".contains(c)))
        .collect();
    let Some(last) = lines.last() else { return false };

    // A user-configured snippet wins outright — it was written for this CLI.
    let lower_tail = clean.to_lowercase();
    if extra.iter().any(|p| {
        let p = p.trim().to_lowercase();
        !p.is_empty() && lower_tail.contains(&p)
    }) {
        return true;
    }

    // The last few lines are where a question lives; a TUI often renders the
    // question above the input box, so look at more than just the final line.
    let recent = lines[lines.len().saturating_sub(3)..].join("\n").to_lowercase();
    const ASKS: [&str; 9] = [
        "(y/n)",
        "[y/n]",
        "(yes/no)",
        "do you want",
        "would you like",
        "press enter to",
        "continue?",
        "proceed?",
        "overwrite?",
    ];
    if ASKS.iter().any(|a| recent.contains(a)) {
        return true;
    }

    // A trailing question mark on the last visible line is the generic case.
    if last.ends_with('?') {
        return true;
    }

    // A bare agent input caret with nothing after it — the CLI has finished
    // its turn and is holding the line open. Only counts when the line is
    // *just* the caret, so prose ending in "›" doesn't trigger it.
    matches!(*last, "❯" | "›" | ">" | "▌" | "■")
}

/// Recompute every agent session's activity and emit `terminal:state` for the
/// ones that changed. Cheap by construction: it inspects at most `TAIL_BYTES`
/// of already-resident scrollback per agent session and allocates only for
/// sessions that are quiet.
pub fn poll_states(app: &RuntimeContext) {
    let Some(table) = app.try_state::<TermTable>() else { return };
    let mut changes: Vec<(String, Activity)> = Vec::new();
    {
        let mut sessions = table.sessions.lock();
        for (id, sess) in sessions.iter_mut() {
            if kind_of(id) != "agent" {
                continue;
            }
            let next = if sess.last_activity.elapsed() < QUIET_BEFORE_WAITING {
                Activity::Busy // bytes are still flowing
            } else {
                let start = sess.scrollback.len().saturating_sub(TAIL_BYTES);
                let tail: Vec<u8> = sess.scrollback.iter().skip(start).copied().collect();
                let text = String::from_utf8_lossy(&tail);
                if looks_like_prompt(&text, &sess.waiting_patterns) {
                    Activity::Waiting
                } else {
                    // Quiet but not prompt-shaped: the agent is thinking, or
                    // running a long tool call. Still busy — claiming it needs
                    // a human here is the false positive that matters.
                    Activity::Busy
                }
            };
            if next != sess.activity {
                sess.activity = next;
                changes.push((id.clone(), next));
            }
        }
    }
    let changed = !changes.is_empty();
    for (id, state) in changes {
        if state == Activity::Waiting {
            crate::notify::notify(app, crate::notify::Kind::AgentWaiting, &id, "An agent is waiting", "Open Canopy to respond to the agent.");
        }
        let _ = app.emit("terminal:state", &StateEvent { id: &id, state });
    }
    if changed { crate::notify::refresh_badge(app); }
}

pub fn waiting_count(table: &TermTable) -> usize {
    table.sessions.lock().values().filter(|session| session.activity == Activity::Waiting).count()
}

/// Resolve the agent profile a session was launched from, and return its
/// configured waiting snippets.
///
/// The session id doesn't name the profile, but the launched `command` does:
/// the agent lane runs `<profile.command>` optionally followed by a quoted
/// prompt, so the profile whose command the launch starts with is the one.
/// This keeps detection per-profile — as the issue asks — without threading a
/// new argument through the whole terminal-open call chain.
fn patterns_for(app: &RuntimeContext, cwd: &str, command: Option<&str>) -> Vec<String> {
    let Some(command) = command.map(str::trim).filter(|c| !c.is_empty()) else { return Vec::new() };
    let Some(state) = app.try_state::<AppState>() else { return Vec::new() };
    let Some(ctx) = state.wt_context(cwd) else { return Vec::new() };
    let settings = state.settings.read();
    let Some(repo) = settings.repos.iter().find(|r| r.id == ctx.repo_id) else { return Vec::new() };
    repo.agents
        .iter()
        .filter(|a| !a.command.trim().is_empty())
        .find(|a| command.starts_with(a.command.trim()))
        .map(|a| a.waiting_patterns.lines().map(str::to_string).filter(|l| !l.trim().is_empty()).collect())
        .unwrap_or_default()
}

/// Open (or no-op if already open) a terminal session `id` in `cwd`. With no
/// `command` it runs an interactive login shell; with one it runs that command
/// under a login shell (so the session ends — firing `terminal:exit` — when the
/// command exits, which is how the agent lane tracks agent lifecycle).
///
/// The whole check→spawn→insert runs under the sessions lock so two concurrent
/// attaches for one id (StrictMode remount, pop-out) can't both spawn.
pub fn open(
    app: &RuntimeContext,
    table: &TermTable,
    id: &str,
    cwd: &str,
    cols: u16,
    rows: u16,
    command: Option<String>,
) -> Result<(), String> {
    // Resolve everything that reads settings BEFORE taking the sessions lock:
    // keeping the two locks disjoint means no path can ever establish a
    // settings→sessions ordering to deadlock against.
    let waiting_patterns =
        if kind_of(id) == "agent" { patterns_for(app, cwd, command.as_deref()) } else { Vec::new() };
    let (term_cfg, provisioned_vars) = match app.try_state::<AppState>() {
        Some(state) => {
            let cfg = state.settings.read().embedded_terminal.clone();
            let vars = if cfg.inherit_env {
                state
                    .wt_context(cwd)
                    .map(|ctx| crate::state::worktree_vars(app, &ctx.repo_id, cwd, ctx.is_main))
                    .unwrap_or_default()
            } else {
                HashMap::new()
            };
            (cfg, vars)
        }
        None => (crate::settings::TermCfg::default(), HashMap::new()),
    };

    let mut sessions = table.sessions.lock();
    if sessions.contains_key(id) {
        return Ok(()); // already running — idempotent attach
    }
    // A restart reuses the id; the previous run's retained output would
    // otherwise be replayed as though the new process had printed it.
    table.exited.lock().remove(id);

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;

    // An explicit program is run as given, with the user's own arguments; an
    // unset one keeps the login-shell behaviour that makes nvm/asdf/volta and
    // rc-file PATH resolve.
    let shell = if term_cfg.program.trim().is_empty() {
        crate::toolchain::user_shell()
    } else {
        term_cfg.program.trim().to_string()
    };
    let custom_program = !term_cfg.program.trim().is_empty();
    let mut cmd = CommandBuilder::new(&shell);
    let name = std::path::Path::new(&shell).file_name().and_then(|s| s.to_str()).unwrap_or("");
    // on Windows the shell is `bash.exe`; normalize so the family checks below
    // (login flag, and the `-i` interactive flag) match as they do on Unix
    let name = name.strip_suffix(".exe").unwrap_or(name);
    if custom_program {
        // The user chose the program, so they own its arguments. Canopy's
        // -l/-i flags are for a shell IT picked and would be wrong (or fatal)
        // for an arbitrary binary.
        for a in term_cfg.args.split_whitespace() {
            cmd.arg(a);
        }
    } else if !matches!(name, "sh" | "dash") {
        cmd.arg("-l");
    }
    if let Some(c) = command.as_deref().filter(|c| !c.trim().is_empty()) {
        // A bare login shell on a PTY is interactive (so it sources .zshrc /
        // .bashrc), but `-c` is NOT — user aliases/functions and rc-only PATH
        // wouldn't resolve (e.g. an agent aliased in .zshrc). Force interactive
        // for bash/zsh so the agent command runs like it would when typed.
        if matches!(name, "zsh" | "bash") {
            cmd.arg("-i");
        }
        cmd.arg("-c");
        cmd.arg(c);
    }
    // A launched command always runs where it belongs; only a bare shell can
    // honour "open in my home directory instead".
    let start_dir = if term_cfg.cwd_worktree || command.is_some() {
        cwd.to_string()
    } else {
        home_dir().unwrap_or_else(|| cwd.to_string())
    };
    cmd.cwd(&start_dir);
    cmd.env("TERM", "xterm-256color");
    // The same WT_SLUG / WT_DB_NAME / WT_<SERVICE>_PORT the services and setup
    // commands see, so a command typed by hand behaves the same way.
    for (k, v) in provisioned_vars {
        cmd.env(k, v);
    }
    // Every agent profile can read the same durable handoff even when it opts
    // out of positional prompts because its CLI has a different interface.
    if kind_of(id) == "agent" {
        cmd.env("CANOPY_CONTEXT_FILE", std::path::Path::new(cwd).join(".canopy/context.md"));
        cmd.env("CANOPY_WORKTREE", cwd);
    }
    if let Some(bin) = crate::toolchain::pinned_node_bin(cwd) {
        // prepend to PATH using the OS separator (';' on Windows, ':' elsewhere)
        // and native path form — this is the process env bash.exe inherits, not a
        // bash-internal PATH string.
        let existing = std::env::var_os("PATH").unwrap_or_default();
        let mut dirs = vec![std::path::PathBuf::from(&bin)];
        dirs.extend(std::env::split_paths(&existing));
        if let Ok(joined) = std::env::join_paths(dirs) {
            cmd.env("PATH", joined);
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn failed: {e}"))?;
    // the parent doesn't need the slave handle; dropping it lets EOF propagate
    // when the shell/command exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("reader clone failed: {e}"))?;
    let writer = std::sync::Arc::new(Mutex::new(
        pair.master.take_writer().map_err(|e| format!("writer failed: {e}"))?,
    ));

    // the child is its own session leader (the pty setsid's it), so pid == pgid
    let pgid = child.process_id().unwrap_or(0) as i32;
    let started_unix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let generation = table.next_gen.fetch_add(1, Ordering::Relaxed) + 1;

    sessions.insert(
        id.to_string(),
        PtySession {
            master: pair.master,
            writer,
            child,
            scrollback: VecDeque::new(),
            seq: 0,
            last_activity: Instant::now(),
            // a session that just launched is working, not waiting
            activity: Activity::Busy,
            waiting_patterns,
            generation,
            pgid,
            started_unix,
        },
    );
    drop(sessions); // release before spawning the reader thread
    persist_orphans(app); // record for the crash-orphan sweep

    // reader loop on a dedicated thread: PTY reads are blocking byte I/O.
    let app = app.clone();
    let id = id.to_string();
    std::thread::spawn(move || {
        let mut buf = [0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — shell/command exited / pty closed
                Ok(n) => {
                    let chunk = &buf[..n];
                    // append to scrollback and advance the cursor atomically, so
                    // the emitted seq always matches a chunk boundary.
                    let mut seq = 0;
                    let mut ours = false;
                    if let Some(table) = app.try_state::<TermTable>() {
                        if let Some(sess) = table.sessions.lock().get_mut(&id) {
                            // Same generation guard the exit path uses: a restart
                            // reopens this id, and bytes this (now stale) reader
                            // drains afterwards must not be appended to — or
                            // emitted as — the replacement session's output.
                            if sess.generation == generation {
                                sess.scrollback.extend(chunk.iter().copied());
                                let overflow = sess.scrollback.len().saturating_sub(SCROLLBACK_CAP);
                                if overflow > 0 {
                                    sess.scrollback.drain(0..overflow);
                                }
                                sess.seq += n as u64;
                                sess.last_activity = Instant::now();
                                seq = sess.seq;
                                ours = true;
                            }
                        }
                    }
                    // Skip the emit while nothing is on screen: base64 + JSON +
                    // waking a hidden webview per chunk is pure waste. The
                    // scrollback + seq advanced above regardless, and the UI
                    // resyncs from the snapshot on show / on the next chunk's
                    // seq-gap check — the same race-free cursor rehydrate
                    // mechanism it already uses on mount.
                    if ours && app.interested(crate::runtime::Audience::Terminals) {
                        let _ = app.emit_to(crate::runtime::Audience::Terminals, "terminal:data", &DataEvent { id: &id, data: b64(chunk), seq });
                    }
                }
                Err(_) => break,
            }
        }
        // session ended: drop it and tell the UI — but only if a newer session
        // hasn't already replaced this id (fast reopen), else we'd delete the
        // replacement and emit a false exit.
        let removed = if let Some(table) = app.try_state::<TermTable>() {
            let mut sessions = table.sessions.lock();
            match sessions.get(&id) {
                Some(s) if s.generation == generation => {
                    // Keep what it printed: the UI shows an exited tab read-only
                    // until it's closed or restarted, and without this the output
                    // would die with the session the moment the process ended.
                    let sess = sessions.remove(&id).unwrap();
                    let mut exited = table.exited.lock();
                    if exited.len() >= EXITED_CAP {
                        if let Some(oldest) = exited.iter().min_by_key(|(_, b)| b.at).map(|(k, _)| k.clone()) {
                            exited.remove(&oldest);
                        }
                    }
                    exited.insert(
                        id.clone(),
                        ExitedBuffer { scrollback: sess.scrollback.into_iter().collect(), seq: sess.seq, at: Instant::now() },
                    );
                    true
                }
                _ => false,
            }
        } else {
            false
        };
        if removed {
            crate::notify::refresh_badge(&app);
            persist_orphans(&app);
            let _ = app.emit_to(crate::runtime::Audience::TerminalState, "terminal:exit", &ExitEvent { id: &id });
        }
    });

    Ok(())
}

/// Write user input (keystrokes, or a command the UI injects such as the agent
/// CLI) to a session.
pub fn write(app: &RuntimeContext, table: &TermTable, id: &str, data: &str) -> Result<(), String> {
    // clone the writer handle out, then release the table lock BEFORE the
    // (potentially blocking) write — see the field comment on `writer`.
    let (writer, answered) = {
        let mut sessions = table.sessions.lock();
        let sess = sessions.get_mut(id).ok_or("no such terminal")?;
        sess.last_activity = Instant::now();
        // The human typed: whatever the agent was blocked on, it isn't blocked
        // on them any more. Flipping here rather than waiting for the next poll
        // means the "Answer agent" action clears the instant it's acted on,
        // instead of lingering for up to a second after the keystroke.
        let answered = sess.activity == Activity::Waiting;
        if answered {
            sess.activity = Activity::Busy;
        }
        (sess.writer.clone(), answered)
    };
    if answered {
        let _ = app.emit("terminal:state", &StateEvent { id, state: Activity::Busy });
    }
    let mut w = writer.lock();
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

/// Resize a session's PTY (xterm's fit addon drives this).
pub fn resize(table: &TermTable, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = table.sessions.lock();
    let sess = sessions.get(id).ok_or("no such terminal")?;
    sess.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// Scrollback snapshot + its end cursor, for a re-mounting window to rehydrate.
/// Falls back to the retained buffer of an exited session, so a tab that ended
/// while its worktree wasn't selected can still be read. `None` only when the id
/// was never opened (or has since been closed).
pub fn get_buffer(table: &TermTable, id: &str) -> Option<BufferSnapshot> {
    if let Some(s) = table.sessions.lock().get(id) {
        let bytes: Vec<u8> = s.scrollback.iter().copied().collect();
        return Some(BufferSnapshot { buffer: b64(&bytes), seq: s.seq });
    }
    table
        .exited
        .lock()
        .get(id)
        .map(|b| BufferSnapshot { buffer: b64(&b.scrollback), seq: b.seq })
}

/// Kill and drop a session, including any retained output — closing a tab is the
/// point at which the user is done with it.
pub fn close(table: &TermTable, id: &str) {
    if let Some(mut sess) = table.sessions.lock().remove(id) {
        let _ = sess.child.kill();
    }
    table.exited.lock().remove(id);
}

/// Close a session and refresh the persisted orphan list (command path).
pub fn close_and_persist(app: &RuntimeContext, table: &TermTable, id: &str) {
    close(table, id);
    crate::notify::refresh_badge(app);
    persist_orphans(app);
}

/// Close every terminal belonging to a worktree (called before it's removed, so
/// no shell/agent lingers with no UI to stop it).
pub fn close_worktree(app: &RuntimeContext, table: &TermTable, wt_key: &str) {
    let prefix = format!("{wt_key}::");
    let ids: Vec<String> = table.sessions.lock().keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
    for id in &ids {
        close(table, id);
    }
    table.exited.lock().retain(|k, _| !k.starts_with(&prefix));
    if !ids.is_empty() {
        crate::notify::refresh_badge(app);
        persist_orphans(app);
    }
}

/// Kill every session (app quit).
pub fn close_all(table: &TermTable) {
    let mut sessions = table.sessions.lock();
    for (_, mut sess) in sessions.drain() {
        let _ = sess.child.kill();
    }
    table.exited.lock().clear();
}

/// Snapshot live sessions' pgids into persisted runtime state, so a crash can be
/// cleaned up on next launch (mirrors the service orphan sweep). Unix-only — see
/// `sweep_orphans`.
#[cfg(unix)]
fn persist_orphans(app: &RuntimeContext) {
    let table = app.state::<TermTable>();
    let orphans: Vec<TermOrphan> = table
        .sessions
        .lock()
        .iter()
        .map(|(id, s)| TermOrphan { id: id.clone(), pgid: s.pgid, spawn_time_secs: s.started_unix })
        .collect();
    let state = app.state::<AppState>();
    let runtime = {
        let mut rt = state.runtime.write();
        rt.terminal_orphans = orphans;
        rt.clone()
    };
    let _ = crate::settings::save_runtime(app, &runtime);
}

#[cfg(windows)]
fn persist_orphans(_app: &RuntimeContext) {}

/// Startup: kill terminal process groups left over from a crashed previous run
/// (only when the group leader still exists and its start time matches). Unix-only
/// — on Windows portable-pty's ConPTY child is killed directly and there is no
/// pgid to sweep (a documented limitation: PTY grandchildren may linger).
#[cfg(windows)]
pub fn sweep_orphans(_app: &RuntimeContext) {}

#[cfg(unix)]
pub fn sweep_orphans(app: &RuntimeContext) {
    let orphans = {
        let state = app.state::<AppState>();
        let rt = state.runtime.read();
        rt.terminal_orphans.clone()
    };
    for o in &orphans {
        if o.pgid <= 1 {
            continue;
        }
        let alive = unsafe { libc::killpg(o.pgid, 0) == 0 };
        if alive && crate::services::proc_start_time_matches(o.pgid as u32, o.spawn_time_secs) {
            log::warn!("sweeping terminal orphan pgid {} ({})", o.pgid, o.id);
            unsafe {
                libc::killpg(o.pgid, libc::SIGTERM);
            }
        }
    }
    let state = app.state::<AppState>();
    let runtime = {
        let mut rt = state.runtime.write();
        rt.terminal_orphans.clear();
        rt.clone()
    };
    let _ = crate::settings::save_runtime(app, &runtime);
}

/// Sweep idle SHELL sessions (bounds long-run resource growth). Killing the
/// child makes its reader hit EOF, which removes the session and emits
/// `terminal:exit`. Agent sessions are exempt — a quiet agent may just be
/// waiting for the user, and killing it would lose work.
pub fn sweep_idle(app: &RuntimeContext, table: &TermTable) {
    // Per-repo agent timeout, keyed by the repo's worktree paths. Resolved
    // once per sweep rather than per session — the sweep runs every 5 minutes
    // and this is two lock acquisitions instead of one per open terminal.
    let agent_limits: HashMap<String, Duration> = app
        .try_state::<AppState>()
        .map(|state| {
            let settings = state.settings.read();
            let tree = state.tree.read();
            tree.iter()
                .filter_map(|r| {
                    let mins = settings.repos.iter().find(|c| c.id == r.repo_id)?.agent_idle_timeout_min;
                    (mins > 0).then(|| {
                        r.worktrees
                            .iter()
                            .map(|w| (w.wt_key.clone(), Duration::from_secs(mins as u64 * 60)))
                            .collect::<Vec<_>>()
                    })
                })
                .flatten()
                .collect()
        })
        .unwrap_or_default();

    let mut sessions = table.sessions.lock();
    for (id, sess) in sessions.iter_mut() {
        let kind = kind_of(id);
        if kind == "shell" && sess.last_activity.elapsed() > IDLE_LIMIT {
            let _ = sess.child.kill();
            continue;
        }
        // Agents are exempt unless the repo opted in: a quiet agent may just
        // be waiting for the user, and killing it loses work. Only an explicit
        // per-repo timeout overrides that.
        if kind == "agent" {
            let wt = id.rsplit_once("::").map(|(w, _)| w).unwrap_or("");
            if let Some(limit) = agent_limits.get(wt) {
                if sess.last_activity.elapsed() > *limit {
                    log::info!("closing idle agent {id} after {}s", limit.as_secs());
                    let _ = sess.child.kill();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{b64, kind_of, looks_like_prompt, strip_ansi};

    #[test]
    fn strip_ansi_removes_csi_and_osc() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red", "SGR colour codes");
        assert_eq!(strip_ansi("\x1b[2J\x1b[1;1Hclear"), "clear", "erase + cursor move");
        assert_eq!(strip_ansi("\x1b]0;title\x07text"), "text", "OSC terminated by BEL");
        assert_eq!(strip_ansi("\x1b]0;title\x1b\\text"), "text", "OSC terminated by ST");
        // a CR rewrites the line in a TUI, so it must break "the last line"
        assert_eq!(strip_ansi("first\rsecond"), "first\nsecond");
    }

    #[test]
    fn waiting_is_detected_only_for_real_prompts() {
        let no_extra: [String; 0] = [];
        // explicit confirmations
        assert!(looks_like_prompt("Overwrite src/main.rs? (y/n)", &no_extra));
        assert!(looks_like_prompt("Do you want to run this command?", &no_extra));
        assert!(looks_like_prompt("\x1b[1mProceed?\x1b[0m", &no_extra), "through ANSI");
        // a bare input caret inside a TUI box
        assert!(looks_like_prompt("╭──────────╮\n│ ❯        │\n╰──────────╯", &no_extra));

        // NOT waiting: ordinary working output, including output that merely
        // mentions a question mark mid-sentence
        assert!(!looks_like_prompt("Running tests…\n  42 passed", &no_extra));
        assert!(!looks_like_prompt("Edited src/lib.rs (3 additions)", &no_extra));
        assert!(
            !looks_like_prompt("Checking whether the config? file exists\nnow reading it", &no_extra),
            "a '?' that isn't at the end of the last line is not a prompt"
        );
        assert!(!looks_like_prompt("", &no_extra), "empty tail is not a prompt");
        assert!(
            !looks_like_prompt("the answer is > 5 for all inputs", &no_extra),
            "a caret inside prose is not a bare input caret"
        );
    }

    #[test]
    fn configured_phrases_extend_the_builtin_shapes() {
        let extra = ["Approve this edit".to_string()];
        // the built-ins alone would not call this waiting
        assert!(!looks_like_prompt("Approve this edit to continue working", &[] as &[String]));
        // with the profile's phrase it does, case-insensitively
        assert!(looks_like_prompt("approve this edit to continue working", &extra));
        // blank lines in the setting are ignored rather than matching everything
        let blanks = ["".to_string(), "   ".to_string()];
        assert!(!looks_like_prompt("ordinary output", &blanks));
    }

    /// TerminalPane detects missed chunks (emits skipped while hidden) by
    /// computing each chunk's decoded length WITHOUT decoding it:
    /// `len/4*3 - padding`. That formula is only correct while this encoder
    /// emits standard, unwrapped base64 — pin the contract on the Rust side
    /// so a future encoder change can't silently break the frontend gap math.
    #[test]
    fn b64_length_formula_matches_frontend_gap_math() {
        for n in 0..=9usize {
            let s = b64(&vec![0xAB; n]);
            assert!(!s.contains('\n') && !s.contains('\r'), "must be unwrapped: {s:?}");
            let pad = if s.ends_with("==") {
                2
            } else if s.ends_with('=') {
                1
            } else {
                0
            };
            assert_eq!(s.len() / 4 * 3 - pad, n, "n={n} s={s}");
        }
    }

    #[test]
    fn kind_of_reads_multi_session_ids() {
        assert_eq!(kind_of("/Users/me/wt/feature#1::agent#3"), "agent");
        assert_eq!(kind_of("/Users/me/wt/feature#1::shell#12"), "shell");
        // ids carry a per-launch nonce so a webview reload can't reuse one
        assert_eq!(kind_of("/Users/me/wt/x::agent#mfz1a2b-4"), "agent");
        assert_eq!(kind_of("/Users/me/wt/x::shell#mfz1a2b-11"), "shell");
        // ids written before multi-session carried no instance suffix
        assert_eq!(kind_of("/Users/me/wt/feature::agent"), "agent");
        assert_eq!(kind_of("/Users/me/wt/feature::shell"), "shell");
        assert_eq!(kind_of("nonsense"), "nonsense");
    }
}
