use canopod_lib::{
    app_api, backend,
    credentials::{CredentialKind, CredentialStore},
};
use std::path::PathBuf;

const USAGE: &str = "canopod-backend <serve|status|stop|repo|mcp> [--config-dir PATH] [--data-dir PATH] [--log-dir PATH]\ncanopod-backend serve [--port PORT]\ncanopod-backend repo add PATH\n\nServe runs in the foreground; use a supervisor for persistence. Status/stop attach\nto the authenticated loopback backend hosted by Canopod or canopod-backend, without launching a GUI. `repo add` registers an existing Git repository with that backend. MCP defaults to disabled and read-only; worktree creation/setup require --allow-worktree-write. Stop acknowledges asynchronous process cleanup.\ncanopod-backend mcp <status|enable|disable|rotate-token|smoke> [--repo ID]... [--allow-worktree-write | --read-only] [--allow-service-control | --no-service-control] [--allow-configuration | --no-configuration]\nEnable requires explicit registered repository IDs on first use. Re-enable without\n--repo preserves the allowlist. `mcp smoke --repo ID` verifies initialize, prompt/tool discovery, cached status, and the warm latency budget without printing credentials. Credentials remain in private files; commands never print them.\n--port accepts 1024..65535 and persists for subsequent serve/status/stop commands.";

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
        eprintln!("canopod-backend: {error}");
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
            println!("canopod-backend {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Some("serve") => "serve",
        Some("status") => "status",
        Some("stop") => "stop",
        Some("repo") => match args.next().as_deref().and_then(|arg| arg.to_str()) {
            Some("add") => "repositories",
            _ => return Err(USAGE.into()),
        },
        Some("mcp") => match args.next().as_deref().and_then(|arg| arg.to_str()) {
            Some("status") => "mcp/status",
            Some("enable") => "mcp/enable",
            Some("disable") => "mcp/disable",
            Some("rotate-token") => "mcp/rotate-token",
            Some("smoke") => "mcp/smoke",
            _ => return Err(USAGE.into()),
        },
        _ => return Err(USAGE.into()),
    };
    let mut paths = backend::default_paths()?;
    let mut port = None;
    let mut repository_path = None;
    let mut repo_ids = Vec::new();
    let mut allow_worktree_write = None;
    let mut allow_service_control = None;
    let mut allow_configuration = None;
    let mut seen = std::collections::HashSet::new();
    while let Some(flag) = args.next() {
        let name = flag.to_str().ok_or("directory option must be UTF-8")?;
        if matches!(name, "--help" | "-h") {
            println!("{USAGE}");
            return Ok(());
        }
        if matches!(name, "--allow-configuration" | "--no-configuration") {
            if action != "mcp/enable" || allow_configuration.is_some() { return Err("Choose one configuration permission flag, only with mcp enable".into()); }
            allow_configuration = Some(name == "--allow-configuration");
            continue;
        }
        if matches!(name, "--allow-service-control" | "--no-service-control") {
            if action != "mcp/enable" || allow_service_control.is_some() { return Err("Choose one service permission flag, only with mcp enable".into()); }
            allow_service_control = Some(name == "--allow-service-control");
            continue;
        }
        if matches!(name, "--allow-worktree-write" | "--read-only") {
            if action != "mcp/enable" || allow_worktree_write.is_some() { return Err("Choose one permission flag, only with mcp enable".into()); }
            if name == "--read-only" {
                if allow_service_control.is_some() || allow_configuration.is_some() { return Err("--read-only cannot be combined with other permission flags".into()); }
                allow_configuration = Some(false);
                allow_service_control = Some(false);
            }
            allow_worktree_write = Some(name == "--allow-worktree-write");
            continue;
        }
        if name == "--repo" {
            if !matches!(action, "mcp/enable" | "mcp/smoke") {
                return Err("--repo is accepted only with mcp enable or mcp smoke".into());
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
            _ if action == "repositories" && repository_path.is_none() => {
                let path = PathBuf::from(flag);
                if !path.is_dir() {
                    return Err(format!(
                        "repository path must be an existing directory: {}",
                        path.display()
                    ));
                }
                repository_path = Some(
                    std::fs::canonicalize(&path)
                        .map_err(|e| format!("resolve {}: {e}", path.display()))?,
                );
                continue;
            }
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
    if action == "mcp/smoke" && repo_ids.len() != 1 {
        return Err("mcp smoke requires exactly one --repo ID".into());
    }
    if action == "repositories" && repository_path.is_none() {
        return Err("repo add requires a repository path".into());
    }
    // Either shared directory permits legacy state races. Isolated hosts must
    // override both config and data; binary install locations are not evidence.
    let defaults = backend::default_paths()?;
    let canonical =
        |path: &std::path::Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    // Carry pre-rename directories over only for the real install, never for
    // an isolated host (tests, smoke runs) pointed at its own directories.
    if paths.data == defaults.data || paths.config == defaults.config {
        canopod_lib::legacy::migrate_app_dirs(backend::APP_ID);
    }
    if action == "serve"
        && (canonical(&paths.data) == canonical(&defaults.data)
            || canonical(&paths.config) == canonical(&defaults.config))
    {
        canopod_lib::ownership::refuse_legacy_desktop()?;
    }
    let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("start executor: {e}"))?;
    let result = runtime.block_on(async {
        if action != "serve" {
            return attach(&paths, action, repo_ids, allow_worktree_write, allow_service_control, allow_configuration, repository_path).await;
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
            "canopod-backend {} running in foreground (pid {}) at http://127.0.0.1:{}",
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
    paths: &canopod_lib::runtime::RuntimePaths,
    action: &str,
    repo_ids: Vec<String>,
    allow_worktree_write: Option<bool>,
    allow_service_control: Option<bool>,
    allow_configuration: Option<bool>,
    repository_path: Option<PathBuf>,
) -> Result<(), String> {
    let config = app_api::Config::load(&paths.config)?;
    let store = CredentialStore::open_existing(&paths.data)
        .map_err(|e| format!("read backend credentials: {e}; launch Canopod or start canopod-backend serve first"))?;
    let bearer = store
        .load(CredentialKind::Application)
        .map_err(|e| e.to_string())?
        .ok_or("application credential is absent; launch Canopod or start canopod-backend serve first")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    if action == "mcp/smoke" {
        let mcp_bearer = store
            .load(CredentialKind::Mcp)
            .map_err(|e| e.to_string())?
            .ok_or("MCP credential is absent; enable MCP first")?;
        return mcp_smoke(&client, config.port, &mcp_bearer, &repo_ids[0]).await;
    }
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
        request.json(&serde_json::json!({"repoIds": if repo_ids.is_empty() { None } else { Some(repo_ids) }, "allowWorktreeWrite": allow_worktree_write, "allowServiceControl": allow_service_control, "allowConfiguration": allow_configuration}))
    } else if action == "repositories" {
        request.json(&serde_json::json!({"path": repository_path.ok_or("missing repository path")?}))
    } else {
        request
    };
    let mut response = request
        .header("authorization", authorization)
        .header("x-canopod-api-version", app_api::API_VERSION)
        .send()
        .await
        .map_err(|e| format!("backend unavailable: {e}; launch Canopod or run canopod-backend serve"))?;
    if response
        .headers()
        .get("x-canopod-api-version")
        .and_then(|h| h.to_str().ok())
        != Some(app_api::API_VERSION)
    {
        return Err("incompatible backend API version".into());
    }
    if !response.status().is_success() {
        return Err(format!(
            "backend rejected {action}: HTTP {}",
            response.status()
        ));
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

async fn mcp_rpc(
    client: &reqwest::Client,
    port: u16,
    bearer: &canopod_lib::credentials::Bearer,
    id: u64,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut authorization =
        reqwest::header::HeaderValue::from_str(&format!("Bearer {}", bearer.expose()))
            .map_err(|_| "invalid MCP credential")?;
    authorization.set_sensitive(true);
    let mut response = client
        .post(format!("http://127.0.0.1:{port}/mcp"))
        .header("authorization", authorization)
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-03-26")
        .json(&serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
        .send()
        .await
        .map_err(|e| format!("MCP request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("MCP {method} failed: HTTP {}", response.status()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 32 * 1024 {
            return Err("MCP response exceeds 32 KiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| format!("MCP {method} returned invalid JSON"))?;
    if value.get("error").is_some() {
        return Err(format!("MCP {method} returned {}", value["error"]));
    }
    Ok(value["result"].clone())
}

async fn mcp_smoke(
    client: &reqwest::Client,
    port: u16,
    bearer: &canopod_lib::credentials::Bearer,
    repo_id: &str,
) -> Result<(), String> {
    let initialized = mcp_rpc(
        client,
        port,
        bearer,
        1,
        "initialize",
        serde_json::json!({
            "protocolVersion":"2025-03-26",
            "capabilities":{},
            "clientInfo":{"name":"canopod-release-smoke","version":env!("CARGO_PKG_VERSION")}
        }),
    )
    .await?;
    if initialized["serverInfo"]["name"] != "canopod-mcp"
        || initialized["capabilities"]["tools"].is_null()
        || initialized["capabilities"]["prompts"].is_null()
    {
        return Err("MCP initialize omitted Canopod tools or prompts".into());
    }

    let prompts = mcp_rpc(client, port, bearer, 2, "prompts/list", serde_json::json!({})).await?;
    if !prompts["prompts"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["name"] == "canopod_worktree_delivery"))
    {
        return Err("MCP workflow prompt is missing".into());
    }
    let prompt = mcp_rpc(
        client,
        port,
        bearer,
        3,
        "prompts/get",
        serde_json::json!({
            "name":"canopod_worktree_delivery",
            "arguments":{"repoId":repo_id,"task":"Validate the packaged MCP workflow","branch":"smoke/mcp"}
        }),
    )
    .await?;
    if !prompt["messages"][0]["content"]["text"]
        .as_str()
        .is_some_and(|text| text.contains(repo_id) && text.contains("Use branch `smoke/mcp`"))
    {
        return Err("MCP workflow prompt did not preserve explicit scope".into());
    }
    let tools = mcp_rpc(client, port, bearer, 4, "tools/list", serde_json::json!({})).await?;
    let tool_count = tools["tools"].as_array().map_or(0, Vec::len);
    let Some(advertised_tools) = tools["tools"].as_array() else {
        return Err("MCP tool discovery returned an invalid tool list".into());
    };
    if !advertised_tools.iter().any(|item| item["name"] == "canopod_status") {
        return Err("MCP cached status tool is missing".into());
    }
    if advertised_tools
        .iter()
        .any(|item| !item["outputSchema"].is_object())
    {
        return Err("MCP tool discovery omitted a stable output schema".into());
    }
    for required in ["canopod_repositories", "canopod_worktrees", "canopod_worktree"] {
        if !advertised_tools.iter().any(|item| item["name"] == required) {
            return Err(format!("MCP discovery tool is missing: {required}"));
        }
    }

    let repositories = mcp_rpc(
        client,
        port,
        bearer,
        5,
        "tools/call",
        serde_json::json!({"name":"canopod_repositories","arguments":{}}),
    )
    .await?;
    if repositories["structuredContent"]["repositories"]
        .as_array()
        .is_none_or(|items| !items.iter().any(|repo| repo["repoId"] == repo_id))
    {
        return Err("canopod_repositories omitted the allowed repository".into());
    }
    if repositories["structuredContent"]["repositories"][0]
        .get("path")
        .is_some()
    {
        return Err("canopod_repositories exposed a filesystem path".into());
    }
    let worktrees = mcp_rpc(
        client,
        port,
        bearer,
        6,
        "tools/call",
        serde_json::json!({"name":"canopod_worktrees","arguments":{"repoId":repo_id}}),
    )
    .await?;
    let worktree_key = worktrees["structuredContent"]["worktrees"][0]["worktreeKey"]
        .as_str()
        .ok_or("canopod_worktrees omitted the main worktree")?;
    let worktree = mcp_rpc(
        client,
        port,
        bearer,
        7,
        "tools/call",
        serde_json::json!({"name":"canopod_worktree","arguments":{"repoId":repo_id,"worktreeKey":worktree_key}}),
    )
    .await?;
    if worktree["structuredContent"]["worktreeKey"] != worktree_key {
        return Err("canopod_worktree returned the wrong worktree".into());
    }
    if worktree["structuredContent"].get("path").is_some()
        || worktree["structuredContent"].get("dbName").is_some()
        || worktree["structuredContent"]["git"]
            .get("lastCommitMsg")
            .is_some()
    {
        return Err("canopod_worktree exposed a private field".into());
    }

    let mut samples = Vec::with_capacity(25);
    for id in 10..35 {
        let started = std::time::Instant::now();
        let result = mcp_rpc(
            client,
            port,
            bearer,
            id,
            "tools/call",
            serde_json::json!({"name":"canopod_status","arguments":{"repoId":repo_id}}),
        )
        .await?;
        if result["isError"] == true {
            return Err(format!("canopod_status failed: {}", result["content"]));
        }
        if result["structuredContent"]["repoId"] != repo_id {
            return Err("canopod_status omitted typed structuredContent".into());
        }
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(f64::total_cmp);
    let p50 = samples[samples.len() / 2];
    let p95 = samples[((samples.len() as f64 * 0.95).ceil() as usize).saturating_sub(1)];
    let p99 = samples[((samples.len() as f64 * 0.99).ceil() as usize).saturating_sub(1)];
    if p95 > 50.0 {
        return Err(format!("cached status p95 {p95:.2} ms exceeds the 50 ms release budget"));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "status":"ok",
            "protocol":"2025-03-26",
            "server":"canopod-mcp",
            "workflowPrompt":"canopod_worktree_delivery",
            "tools":tool_count,
            "outputSchemas":tool_count,
            "samples":samples.len(),
            "cachedStatusMs":{"p50":p50,"p95":p95,"p99":p99}
        }))
        .map_err(|e| e.to_string())?
    );
    Ok(())
}
