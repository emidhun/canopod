// OS notifications and the app-icon badge.
//
// Every event routed through here already appears in the in-app attention
// queue. A notification exists for the case the queue cannot cover: Canopy is
// in the tray and you are looking at something else.
//
// That framing sets the defaults. Notify when a human is BLOCKING something —
// a crashed service, an agent waiting on an answer — and stay quiet for
// progress you asked for and can watch. `setup_done` and `branch_moved` are
// off by default for exactly that reason.
//
// Two guards keep this from becoming noise:
//   - nothing fires while a Canopy window is on screen; the pip, the queue and
//     the toast have already told you
//   - the same subject can't re-notify inside a cooldown, so a service that
//     crash-loops produces one notification, not forty
use std::collections::HashMap;
use std::time::{Duration, Instant};
use parking_lot::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

/// Minimum gap between notifications about the same subject.
const COOLDOWN: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct NotifyState {
    /// subject key -> when it last notified
    last: Mutex<HashMap<String, Instant>>,
}

/// The kinds of thing Canopy notifies about, matching the preference fields.
#[derive(Clone, Copy)]
pub enum Kind {
    ServiceCrash,
    AgentWaiting,
    SetupDone,
    BranchMoved,
}

fn enabled(app: &AppHandle, kind: Kind) -> (bool, bool) {
    let Some(state) = app.try_state::<crate::state::AppState>() else { return (false, false) };
    let cfg = state.settings.read().notifications.clone();
    let on = match kind {
        Kind::ServiceCrash => cfg.service_crash,
        Kind::AgentWaiting => cfg.agent_waiting,
        Kind::SetupDone => cfg.setup_done,
        Kind::BranchMoved => cfg.branch_moved,
    };
    (on, cfg.sound)
}

/// Raise an OS notification, subject to the preference, the visibility guard
/// and the per-subject cooldown.
///
/// `subject` is the dedupe key — a service key, a session id — NOT the title,
/// so a crash-looping service is one notification however its message varies.
pub fn notify(app: &AppHandle, kind: Kind, subject: &str, title: &str, body: &str) {
    let (on, sound) = enabled(app, kind);
    if !on {
        return;
    }
    // Someone looking at Canopy has already been told, twice.
    if crate::windows_visible() {
        return;
    }
    if let Some(state) = app.try_state::<NotifyState>() {
        let mut last = state.last.lock();
        if last.get(subject).is_some_and(|t| t.elapsed() < COOLDOWN) {
            return;
        }
        last.insert(subject.to_string(), Instant::now());
        // bound the map: without this, a long session of churning worktrees
        // grows one entry per subject forever
        if last.len() > 256 {
            let cutoff = Instant::now();
            last.retain(|_, t| cutoff.duration_since(*t) < COOLDOWN);
        }
    }

    let mut builder = app.notification().builder().title(title).body(body);
    if sound {
        builder = builder.sound("default");
    }
    if let Err(e) = builder.show() {
        // A refused notification (permission denied on macOS, no daemon on
        // Linux) is not an app failure — the in-app queue still has it.
        log::debug!("notification not shown: {e}");
    }
}

/// Set the app-icon badge from the current attention count, honouring the
/// `badge` preference ("count" | "dot" | "off").
///
/// The count is computed here rather than sent from the frontend so it stays
/// correct while no window is open — which is precisely when a badge is the
/// only thing communicating it.
pub fn refresh_badge(app: &AppHandle) {
    let Some(state) = app.try_state::<crate::state::AppState>() else { return };
    let mode = state.settings.read().notifications.badge.clone();

    let crashed = {
        let tree = state.tree.read();
        tree.iter()
            .flat_map(|r| r.worktrees.iter())
            .flat_map(|w| w.services.iter())
            .filter(|s| s.status == crate::state::SvcStatus::Error)
            .count()
    };
    let waiting = app.try_state::<crate::terminal::TermTable>()
        .map(|table| crate::terminal::waiting_count(&table)).unwrap_or(0);
    let total = (crashed + waiting) as i64;

    let Some(win) = app.get_webview_window("main") else { return };
    match mode.as_str() {
        "off" => {
            let _ = win.set_badge_count(None);
        }
        "dot" => {
            // A dot is "something needs you" without the number. Not every
            // platform has one, so fall back to a count of 1 — which carries
            // the same meaning — rather than showing nothing.
            #[cfg(target_os = "macos")]
            let _ = win.set_badge_label(if total > 0 { Some("●".to_string()) } else { None });
            #[cfg(not(target_os = "macos"))]
            let _ = win.set_badge_count(if total > 0 { Some(1) } else { None });
        }
        _ => {
            let _ = win.set_badge_count(if total > 0 { Some(total) } else { None });
        }
    }
}
