use canopy_lib::{
    app_api, backend,
    credentials::{CredentialKind, CredentialStore},
};
use std::path::PathBuf;

const USAGE: &str = "canopy-backend <serve|status|stop|mcp> [--config-dir PATH] [--data-dir PATH] [--log-dir PATH]\ncanopy-backend serve [--port PORT]\n\nServe runs in the foreground; use a supervisor for persistence. Status/stop attach\nto the authenticated loopback backend without launching a GUI. MCP defaults to disabled.\ncanopy-backend mcp <status|enable|disable|rotate-token> [--repo ID]...\nEnable requires explicit registered repository IDs on first use. Re-enable without\n--repo preserves the allowlist. Credentials remain in private files; commands never print them.\n--port accepts 1024..65535 and persists for subsequent serve/status/stop commands.";

struct StderrLogger;
impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::max_level()
    }
    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("{} {}: {}", record.level(), record.target(), record.args());
        }
    }
    fn flush(&self) {}
}
static LOGGER: StderrLogger = StderrLogger;
fn main() {
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(
        std::env::var("RUST_LOG")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(log::LevelFilter::Info),
    );
    if let Err(error) = run() {
        eprintln!("canopy-backend: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = std::env::args_os().skip(1);
    let action = match args.next().as_deref().and_then(|arg| arg.to_str()) {
        Some("--help" | "-h") => {
            println!("{USAGE}");
            return Ok(());
        }
        Some("--version") => {
            println!("canopy-backend {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Some("serve") => "serve",
        Some("status") => "status",
        Some("stop") => "stop",
        Some("mcp") => match args.next().as_deref().and_then(|arg| arg.to_str()) {
            Some("status") => "mcp/status",
            Some("enable") => "mcp/enable",
            Some("disable") => "mcp/disable",
            Some("rotate-token") => "mcp/rotate-token",
            _ => return Err(USAGE.into()),
        },
        _ => return Err(USAGE.into()),
    };
    let mut paths = backend::default_paths()?;
    let mut port = None;
    let mut repo_ids = Vec::new();
    let mut seen = std::collections::HashSet::new();
    while let Some(flag) = args.next() {
        let name = flag.to_str().ok_or("directory option must be UTF-8")?;
        if matches!(name, "--help" | "-h") {
            println!("{USAGE}");
            return Ok(());
        }
        if name == "--repo" {
            if action != "mcp/enable" {
                return Err("--repo is accepted only with mcp enable".into());
            }
            let value = args
                .next()
                .ok_or("missing repository ID")?
                .into_string()
                .map_err(|_| "repository ID must be UTF-8")?;
            if value.is_empty() || value.len() > 256 || repo_ids.len() >= 256 {
                return Err("invalid repository allowlist".into());
            }
            repo_ids.push(value);
            continue;
        }
        if name == "--port" {
            if action != "serve" || port.is_some() {
                return Err("--port is accepted once, only with serve".into());
            }
            let value = args.next().ok_or("missing port")?;
            port = Some(
                value
                    .to_str()
                    .ok_or("invalid port")?
                    .parse::<u16>()
                    .map_err(|_| "invalid port")?,
            );
            if port.is_some_and(|port| port < 1024) {
                return Err("port must be between 1024 and 65535".into());
            }
            continue;
        }
        let target = match name {
            "--config-dir" => &mut paths.config,
            "--data-dir" => &mut paths.data,
            "--log-dir" => &mut paths.logs,
            _ => return Err(format!("unknown option {name}\n{USAGE}")),
        };
        if !seen.insert(name.to_owned()) {
            return Err(format!("duplicate option {name}"));
        }
        let path = PathBuf::from(
            args.next()
                .ok_or_else(|| format!("missing path for {name}"))?,
        );
        if !path.is_dir() {
            return Err(format!(
                "{name} must name an existing directory: {}",
                path.display()
            ));
        }
        *target =
            std::fs::canonicalize(&path).map_err(|e| format!("resolve {}: {e}", path.display()))?;
    }
    // Either shared directory permits legacy state races. Isolated hosts must
    // override both config and data; binary install locations are not evidence.
    let defaults = backend::default_paths()?;
    let canonical =
        |path: &std::path::Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    if action == "serve"
        && (canonical(&paths.data) == canonical(&defaults.data)
            || canonical(&paths.config) == canonical(&defaults.config))
    {
        canopy_lib::ownership::refuse_legacy_desktop()?;
    }
    let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("start executor: {e}"))?;
    let result = runtime.block_on(async {
        if action != "serve" {
            return attach(&paths, action, repo_ids).await;
        }
        let signal = backend::shutdown_signal()?;
        let app = backend::open(paths)?;
        let mut config = app_api::Config::load(&app.path().config)?;
        if let Some(port) = port {
            config.port = port;
        }
        let (shutdown, _) = tokio::sync::watch::channel(false);
        let server = app_api::Server::bind(app.clone(), config.port, shutdown).await?;
        config.save(&app.path().config)?;
        eprintln!(
            "canopy-backend {} running in foreground (pid {}) at http://127.0.0.1:{}",
            env!("CARGO_PKG_VERSION"),
            std::process::id(),
            config.port
        );
        app_api::serve(app, server, signal).await
    });
    // Detached process waiters may briefly retain the context/owner lock. Give
    // them time to finish; OS process exit is the final ownership boundary.
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
    result
}

async fn attach(
    paths: &canopy_lib::runtime::RuntimePaths,
    action: &str,
    repo_ids: Vec<String>,
) -> Result<(), String> {
    let config = app_api::Config::load(&paths.config)?;
    let store = CredentialStore::open_existing(&paths.data)
        .map_err(|e| format!("read backend credentials: {e}; start canopy-backend serve first"))?;
    let bearer = store
        .load(CredentialKind::Application)
        .map_err(|e| e.to_string())?
        .ok_or("application credential is absent; start canopy-backend serve first")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{}/api/v1/{action}", config.port);
    let mut authorization =
        reqwest::header::HeaderValue::from_str(&format!("Bearer {}", bearer.expose()))
            .map_err(|_| "invalid credential")?;
    authorization.set_sensitive(true);
    let request = if action == "status" || action == "mcp/status" {
        client.get(url)
    } else {
        client.post(url)
    };
    let request = if action == "mcp/enable" {
        request.json(&serde_json::json!({"repoIds": if repo_ids.is_empty() { None } else { Some(repo_ids) }}))
    } else {
        request
    };
    let mut response = request
        .header("authorization", authorization)
        .header("x-canopy-api-version", app_api::API_VERSION)
        .send()
        .await
        .map_err(|e| format!("backend unavailable: {e}; run canopy-backend serve"))?;
    if !response.status().is_success() {
        return Err(format!(
            "backend rejected {action}: HTTP {}",
            response.status()
        ));
    }
    if response
        .headers()
        .get("x-canopy-api-version")
        .and_then(|h| h.to_str().ok())
        != Some(app_api::API_VERSION)
    {
        return Err("incompatible backend API version".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 32 * 1024 {
            return Err("backend response exceeds control API limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "invalid backend response")?;
    println!(
        "{}",
        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
    );
    Ok(())
}
