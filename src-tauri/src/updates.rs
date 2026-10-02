// Update checking, signed installation, daily project reminders and crash reports.
//
// ── Why crash reports are written, not sent ──
//
// There is no crash-report endpoint to send to. Rather than a toggle that
// quietly does nothing, the preference controls whether a panic is *recorded*
// at all: with it on, a panic writes its message, backtrace, app version and
// OS to the log directory, which is the thing a bug report can attach. Nothing
// leaves the machine, and the UI says so.
use crate::runtime::RuntimeContext;
use serde::{Deserialize, Serialize};
use std::io::Write;

/// Where release metadata comes from. The repository is public, so this needs
/// no token; unauthenticated GitHub API requests are rate-limited to 60/hour
/// per IP, which a daily check cannot approach.
const RELEASES_URL: &str = "https://api.github.com/repos/emidhun/canopy/releases/latest";
#[cfg(feature = "desktop")]
const PROJECT_URL: &str = "https://github.com/emidhun/canopy";

/// The reminders and automatic release check run at most once per day, even
/// across restarts. The task wakes hourly so a newly enabled preference does
/// not wait until tomorrow.
#[cfg(any(feature = "desktop", test))]
const DAILY_SECS: i64 = 24 * 60 * 60;
#[cfg(feature = "desktop")]
const TASK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// the version this build is
    pub current: String,
    /// the newest published release, when the check succeeded
    pub latest: Option<String>,
    /// `latest` is newer than `current`
    pub available: bool,
    /// where to read about it / download it
    pub url: Option<String>,
    /// why the last check produced nothing, for the UI to show verbatim
    pub error: Option<String>,
    /// unix seconds of the last completed check
    pub checked_at: i64,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(any(feature = "desktop", test))]
fn daily_due(last: i64, now: i64) -> bool {
    last <= 0 || now.saturating_sub(last) >= DAILY_SECS
}

pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Compare two dotted version strings numerically, ignoring a leading `v` and
/// anything after a `-` (so `v0.5.0-beta.1` compares as `0.5.0`).
///
/// String comparison would order `0.10.0` before `0.9.0`, which is exactly the
/// case a naive check gets wrong and nobody notices until the tenth minor.
fn is_newer(candidate: &str, current: &str) -> bool {
    fn parts(v: &str) -> Vec<u64> {
        v.trim()
            .trim_start_matches(['v', 'V'])
            .split('-')
            .next()
            .unwrap_or("")
            .split('.')
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    }
    let (a, b) = (parts(candidate), parts(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

/// Ask GitHub for the newest published release. Drafts and prereleases are
/// skipped — someone running a stable build should not be told a beta is
/// "available".
async fn fetch_latest() -> Result<GhRelease, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        // GitHub rejects requests without one
        .user_agent(concat!("Canopy/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("could not reach GitHub: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub returned {}", resp.status()));
    }
    let rel: GhRelease = resp
        .json()
        .await
        .map_err(|e| format!("unreadable release data: {e}"))?;
    if rel.draft || rel.prerelease {
        return Err("the newest release is a draft or prerelease".into());
    }
    Ok(rel)
}

/// Run one check and emit `app:update` with the result.
pub async fn check_now(app: &RuntimeContext) -> UpdateStatus {
    let current = current_version().to_string();
    let status = match fetch_latest().await {
        Ok(rel) => UpdateStatus {
            available: is_newer(&rel.tag_name, &current),
            latest: Some(rel.tag_name),
            url: Some(rel.html_url),
            error: None,
            current,
            checked_at: now_secs(),
        },
        Err(e) => UpdateStatus {
            latest: None,
            available: false,
            url: None,
            error: Some(e),
            current,
            checked_at: now_secs(),
        },
    };
    let _ = app.emit("app:update", &status);
    status
}

#[cfg(feature = "desktop")]
fn save_runtime(app: &RuntimeContext) {
    let runtime = app.state::<crate::state::AppState>().runtime.read().clone();
    if let Err(error) = crate::settings::save_runtime(app, &runtime) {
        log::warn!("could not persist update reminder state: {error}");
    }
}

#[cfg(feature = "desktop")]
fn send_star_reminder(app: &RuntimeContext, now: i64) {
    let settings = app
        .state::<crate::state::AppState>()
        .settings
        .read()
        .updates
        .clone();
    if !settings.star_reminder {
        return;
    }
    let due = daily_due(
        app.state::<crate::state::AppState>()
            .runtime
            .read()
            .last_star_reminder_at,
        now,
    );
    if !due {
        return;
    }
    let _ = app.host().notify(
        "Enjoying Canopy?",
        &format!("Star Canopy on GitHub to support the project: {PROJECT_URL}"),
        false,
    );
    app.state::<crate::state::AppState>()
        .runtime
        .write()
        .last_star_reminder_at = now;
    save_runtime(app);
}

#[cfg(feature = "desktop")]
fn send_update_reminder(app: &RuntimeContext, status: &UpdateStatus, now: i64) {
    let Some(latest) = status.latest.as_deref().filter(|_| status.available) else {
        return;
    };
    let due = {
        let runtime = app.state::<crate::state::AppState>().runtime.read();
        runtime.last_update_reminder_version != latest
            || daily_due(runtime.last_update_reminder_at, now)
    };
    if !due {
        return;
    }
    let _ = app.host().notify(
        "Canopy update available",
        &format!("{latest} is ready. Open Canopy Settings to download and install it."),
        false,
    );
    {
        let mut runtime = app.state::<crate::state::AppState>().runtime.write();
        runtime.last_update_reminder_version = latest.to_string();
        runtime.last_update_reminder_at = now;
    }
    save_runtime(app);
}

#[cfg(feature = "desktop")]
async fn daily_check(app: &RuntimeContext) -> Option<UpdateStatus> {
    let now = now_secs();
    let enabled = app
        .state::<crate::state::AppState>()
        .settings
        .read()
        .updates
        .auto_check;
    let due = daily_due(
        app.state::<crate::state::AppState>()
            .runtime
            .read()
            .last_update_check_at,
        now,
    );
    if !enabled || !due {
        return None;
    }
    let status = check_now(app).await;
    app.state::<crate::state::AppState>()
        .runtime
        .write()
        .last_update_check_at = now;
    save_runtime(app);
    send_update_reminder(app, &status, now);
    Some(status)
}

#[cfg(feature = "desktop")]
pub async fn install_available_update(app: &tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_updater::UpdaterExt;

    let Some(update) = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(false);
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    app.restart();
}

/// Desktop loop: sends the two daily native reminders and optionally installs
/// a cryptographically signed update. Automatic installation is always opt-in.
#[cfg(feature = "desktop")]
pub fn spawn_desktop_check_task(
    app: RuntimeContext,
    desktop: tauri::AppHandle,
) -> tokio::task::JoinHandle<()> {
    app.executor().spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        loop {
            let now = now_secs();
            send_star_reminder(&app, now);
            if let Some(status) = daily_check(&app).await {
                let auto_install = app
                    .state::<crate::state::AppState>()
                    .settings
                    .read()
                    .updates
                    .auto_install;
                if status.available && auto_install {
                    if let Err(error) = install_available_update(&desktop).await {
                        log::warn!("automatic update failed: {error}");
                        let _ = app.host().notify(
                            "Canopy could not update",
                            "Automatic installation failed. Open Settings to try again.",
                            false,
                        );
                    }
                }
            }
            tokio::time::sleep(TASK_INTERVAL).await;
        }
    })
}

// ── crash reports ─────────────────────────────────────────────────────

/// `<app-log-dir>/crashes`.
pub fn crash_dir(app: &RuntimeContext) -> Option<std::path::PathBuf> {
    let dir = app.path().app_log_dir().ok()?.join("crashes");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Install the panic hook. It always chains to the previous hook (so the
/// existing stderr/log output is untouched) and only writes a report when the
/// preference is on — read at panic time, so toggling it needs no restart.
pub fn install_panic_hook(app: RuntimeContext) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let enabled = app
            .state::<crate::state::AppState>()
            .settings
            .read()
            .crash_reports
            .enabled;
        if enabled {
            if let Err(e) = write_report(&app, info) {
                // a failure here must never mask the panic itself
                log::error!("could not write crash report: {e}");
            }
        }
        previous(info);
    }));
}

fn write_report(app: &RuntimeContext, info: &std::panic::PanicHookInfo<'_>) -> Result<(), String> {
    let dir = crash_dir(app).ok_or("no log directory")?;
    let path = dir.join(format!("crash-{}.txt", now_secs()));
    let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    // Stack traces and environment only — never settings, repo paths or
    // anything the user typed. "Stack traces only" is the promise the
    // preference makes, so the writer is what keeps it.
    writeln!(
        f,
        "Canopy {} ({} {})",
        current_version(),
        std::env::consts::OS,
        std::env::consts::ARCH
    )
    .map_err(|e| e.to_string())?;
    writeln!(f, "when: {}", now_secs()).map_err(|e| e.to_string())?;
    if let Some(loc) = info.location() {
        writeln!(f, "where: {}:{}:{}", loc.file(), loc.line(), loc.column())
            .map_err(|e| e.to_string())?;
    }
    writeln!(f, "what: {info}").map_err(|e| e.to_string())?;
    writeln!(f, "\n{}", std::backtrace::Backtrace::force_capture()).map_err(|e| e.to_string())?;
    Ok(())
}

/// How many reports are on disk, so the UI can offer to open the folder only
/// when there is something in it.
pub fn crash_report_count(app: &RuntimeContext) -> usize {
    crash_dir(app)
        .and_then(|d| std::fs::read_dir(d).ok())
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "txt"))
                .count()
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{daily_due, is_newer, DAILY_SECS};

    #[cfg(feature = "desktop")]
    #[tokio::test]
    async fn native_reminders_are_daily_and_new_versions_notify_immediately() {
        use crate::{
            runtime::{Audience, Host, RuntimeContext, RuntimePaths},
            settings::{RuntimeState as PersistedState, Settings},
            state::AppState,
        };
        use parking_lot::Mutex;
        use std::sync::Arc;

        #[derive(Default)]
        struct RecordingHost(Mutex<Vec<String>>);
        impl Host for RecordingHost {
            fn interested(&self, _: Audience) -> bool {
                false
            }
            fn publish(&self, _: Audience, _: &str, _: serde_json::Value) -> Result<(), String> {
                Ok(())
            }
            fn notify(&self, title: &str, _: &str, _: bool) -> Result<(), String> {
                self.0.lock().push(title.to_string());
                Ok(())
            }
            fn badge(&self, _: &str, _: i64) {}
        }

        let directory = tempfile::tempdir().unwrap();
        let host = Arc::new(RecordingHost::default());
        let app = RuntimeContext::new(
            AppState::new(Settings::default(), PersistedState::default()),
            RuntimePaths {
                config: directory.path().into(),
                data: directory.path().into(),
                logs: directory.path().into(),
            },
            tokio::runtime::Handle::current(),
            host.clone(),
        );
        let available = super::UpdateStatus {
            current: "0.5.0".into(),
            latest: Some("v0.6.0".into()),
            available: true,
            url: Some("https://example.invalid/release".into()),
            error: None,
            checked_at: 1_000,
        };

        super::send_star_reminder(&app, 1_000);
        super::send_star_reminder(&app, 1_001);
        super::send_update_reminder(&app, &available, 1_000);
        super::send_update_reminder(&app, &available, 1_001);
        assert_eq!(
            host.0.lock().as_slice(),
            ["Enjoying Canopy?", "Canopy update available"]
        );

        let next = super::UpdateStatus {
            latest: Some("v0.7.0".into()),
            ..available
        };
        super::send_update_reminder(&app, &next, 1_002);
        super::send_star_reminder(&app, 1_000 + DAILY_SECS);
        assert_eq!(host.0.lock().len(), 4);
        assert!(directory.path().join("state.json").exists());
    }

    #[test]
    fn daily_work_is_due_once_per_twenty_four_hours() {
        assert!(daily_due(0, 1));
        assert!(!daily_due(1_000, 1_000 + DAILY_SECS - 1));
        assert!(daily_due(1_000, 1_000 + DAILY_SECS));
        assert!(
            !daily_due(2_000, 1_000),
            "a backwards clock must not create a reminder storm"
        );
    }

    #[test]
    fn version_comparison_is_numeric_not_lexical() {
        assert!(is_newer("0.5.0", "0.4.0"));
        assert!(is_newer("v0.5.0", "0.4.0"), "leading v ignored");
        assert!(!is_newer("0.4.0", "0.4.0"), "same version is not newer");
        assert!(!is_newer("0.3.9", "0.4.0"));
        // the case a string compare gets wrong, and nobody notices until the
        // tenth minor release
        assert!(is_newer("0.10.0", "0.9.0"), "10 > 9 numerically");
        assert!(!is_newer("0.9.0", "0.10.0"));
        // differing component counts
        assert!(is_newer("1.0", "0.9.9"));
        assert!(!is_newer("1.0", "1.0.0"), "1.0 == 1.0.0");
        assert!(is_newer("1.0.1", "1.0"));
        // a prerelease of the SAME version is not an upgrade
        assert!(!is_newer("0.4.0-beta.1", "0.4.0"));
        // garbage never claims to be newer
        assert!(!is_newer("nightly", "0.4.0"));
    }
}
