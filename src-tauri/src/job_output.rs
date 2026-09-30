//! Capture subprocess output before renderer throttling with best-effort redaction.
use super::{Registry, SecretFilter, Tracking};
use crate::{runtime::RuntimeContext, state::AppState};
use parking_lot::Mutex;
use std::{collections::HashMap, io::Read, path::Path, sync::Arc};

struct Capture {
    tracking: Tracking,
    filter: Mutex<Option<SecretFilter>>,
}
tokio::task_local! { static CAPTURE: Capture; }

pub(crate) async fn scope<T>(tracking: Tracking, work: impl std::future::Future<Output = T>) -> T {
    CAPTURE
        .scope(
            Capture {
                tracking,
                filter: Mutex::new(None),
            },
            work,
        )
        .await
}

/// Rebuild immediately before a setup command, after provisioning has written
/// its files. If any secret source exceeds bounds, suppress output, fail closed.
pub(crate) fn prepare(
    app: &RuntimeContext,
    repo: &str,
    wt: &str,
    cwd: &str,
    vars: &HashMap<String, String>,
) {
    let _ = CAPTURE.try_with(|capture| {
        *capture.filter.lock() = secret_filter(app, repo, wt, cwd, vars).ok();
    });
}
pub(crate) fn incomplete() {
    let _ = CAPTURE.try_with(|capture| {
        capture
            .tracking
            .registry
            .mark_output_incomplete(&capture.tracking.id)
    });
}
pub(crate) fn line(text: &str) {
    let _ = CAPTURE.try_with(|capture| {
        let filter = capture.filter.lock();
        let fallback = SecretFilter::default();
        if filter.is_none() || text.ends_with(" [line truncated]") {
            capture
                .tracking
                .registry
                .mark_output_incomplete(&capture.tracking.id);
        }
        let text = if filter.is_none() {
            "[output omitted: secret filter unavailable]"
        } else if text.ends_with(" [line truncated]") {
            "[oversized output omitted]"
        } else {
            text
        };
        let _ = capture.tracking.registry.append(
            &capture.tracking.id,
            text,
            filter.as_ref().unwrap_or(&fallback),
        );
    });
}
pub(crate) async fn flush_until(
    registry: Arc<Registry>,
    id: String,
    done: tokio_util::sync::CancellationToken,
) {
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(250));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = done.cancelled() => break,
            _ = interval.tick() => {
                if let Err(error) = registry.flush(&id).await { log::warn!("Job output persistence failed: {}", error.code); }
            }
        }
    }
}
fn bounded_file(path: &Path) -> Result<Option<String>, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("secret_source_unavailable".into()),
    };
    if !file
        .metadata()
        .map_err(|_| "secret_source_unavailable")?
        .is_file()
    {
        return Err("secret_source_unavailable".into());
    }
    let mut text = String::new();
    file.by_ref()
        .take(64 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|_| "secret_source_unavailable")?;
    if text.len() > 64 * 1024 {
        return Err("secret_source_too_large".into());
    }
    Ok(Some(text))
}
pub(crate) fn secret_filter(
    app: &RuntimeContext,
    repo: &str,
    wt: &str,
    cwd: &str,
    vars: &HashMap<String, String>,
) -> Result<SecretFilter, String> {
    let mut values = Vec::new();
    // Environment and explicit spawn values: only secret-shaped names. Dotenv
    // values are all treated as private, even when names do not suggest secrets.
    for (key, value) in std::env::vars().chain(vars.iter().map(|(k, v)| (k.clone(), v.clone()))) {
        if crate::services::looks_secret(&key) {
            values.push(value);
        }
    }
    {
        let settings = app.state::<AppState>().settings.read();
        for service in settings
            .repos
            .iter()
            .filter(|r| r.path == repo)
            .flat_map(|r| &r.services)
        {
            values.extend(service.env.values().cloned());
        }
    }
    let mut paths = vec![
        Path::new(repo).join(".env"),
        Path::new(wt).join(".env"),
        Path::new(cwd).join(".env"),
    ];
    paths.sort();
    paths.dedup();
    for path in paths {
        if let Some(text) = bounded_file(&path)? {
            values.extend(
                crate::setup::parse_dotenv(&text)
                    .into_iter()
                    .map(|(_, value)| value),
            );
        }
    }
    // Include provision templates, including JSON/YAML keys and arbitrary file
    // locations, without following extra paths supplied by an MCP caller.
    for root in [repo, wt] {
        if let Some(text) = bounded_file(&Path::new(root).join(".worktreemanager.json"))? {
            let config: serde_json::Value =
                serde_json::from_str(&text).map_err(|_| "secret_source_invalid")?;
            for section in ["env", "provision"] {
                collect_values(&config[section], &mut values)?;
            }
        }
    }
    let store = crate::credentials::CredentialStore::open_existing(&app.path().data)
        .map_err(|_| "secret_source_unavailable")?;
    for kind in [
        crate::credentials::CredentialKind::Application,
        crate::credentials::CredentialKind::Mcp,
    ] {
        if let Some(token) = store.load(kind).map_err(|_| "secret_source_unavailable")? {
            values.push(token.expose().into());
        }
    }
    values.retain(|v| !v.is_empty());
    values.sort();
    values.dedup();
    SecretFilter::new(values).map_err(|_| "secret_filter_limit".into())
}
fn collect_values(value: &serde_json::Value, values: &mut Vec<String>) -> Result<(), String> {
    if values.len() > 256 {
        return Err("secret_filter_limit".into());
    }
    match value {
        serde_json::Value::String(s) => values.push(s.clone()),
        serde_json::Value::Array(a) => {
            for v in a {
                collect_values(v, values)?;
            }
        }
        serde_json::Value::Object(o) => {
            for v in o.values() {
                collect_values(v, values)?;
            }
        }
        _ => {}
    }
    Ok(())
}
