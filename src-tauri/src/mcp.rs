//! Opt-in MCP transport. Application credentials exclusively control policy;
//! MCP credentials can only use the explicitly allowed read surface.
use crate::{
    credentials::{Bearer, CredentialKind, CredentialStore},
    runtime::RuntimeContext,
    state::AppState,
};
use axum::{
    body::{to_bytes, Body},
    extract::Request,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use parking_lot::{Mutex, RwLock};
use rmcp::{
    model::*,
    service::RequestContext,
    transport::streamable_http_server::{
        session::never::NeverSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData, RoleServer, ServerHandler,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io::Write, path::Path, sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

const BODY_LIMIT: usize = 64 * 1024;
const MAX_REQUESTS: usize = 8;

#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct Policy {
    enabled: bool,
    repo_ids: Vec<String>,
    repo_bindings: BTreeMap<String, RepoBinding>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepoBinding {
    registered_path: String,
    canonical_path: String,
}

impl Policy {
    fn load(directory: &Path) -> Result<Self, String> {
        let policy: Self = crate::settings::load_checked(&directory.join("mcp.json"))?;
        policy.validate()?;
        Ok(policy)
    }
    fn validate(&self) -> Result<(), String> {
        if self.repo_ids.len() > 256
            || self
                .repo_ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 256)
            || (self.enabled && self.repo_ids.is_empty())
        {
            return Err(
                "MCP requires 1–256 explicit repository IDs, each at most 256 bytes".into(),
            );
        }
        if self.repo_bindings.len() > 256
            || self.repo_bindings.iter().any(|(id, path)| {
                !self.repo_ids.contains(id)
                    || path.registered_path.is_empty()
                    || path.registered_path.len() > 4096
                    || path.canonical_path.is_empty()
                    || path.canonical_path.len() > 4096
            })
        {
            return Err("invalid MCP repository path bindings".into());
        }
        if self.enabled
            && self
                .repo_ids
                .iter()
                .any(|id| !self.repo_bindings.contains_key(id))
        {
            return Err("MCP policy needs repository path bindings; back up mcp.json, set enabled=false, and explicitly enable the repositories again".into());
        }
        Ok(())
    }
    fn save(&self, directory: &Path, previous: &Self) -> Result<(), String> {
        // External edits are never silently overwritten by a stale controller.
        if &Self::load(directory)? != previous {
            return Err("MCP policy changed on disk; restart the backend before editing".into());
        }
        self.validate()?;
        std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
        let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let temporary = directory.join(format!(".mcp-{suffix}.tmp"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&temporary).map_err(|e| e.to_string())?;
        let result = (|| {
            let mut file = file;
            file.write_all(&serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            drop(file);
            std::fs::rename(&temporary, directory.join("mcp.json")).map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temporary);
        }
        // After rename the policy is committed: a durability warning must not
        // leave the live permission state behind the committed file.
        #[cfg(unix)]
        if result.is_ok() {
            if let Err(error) = std::fs::File::open(directory).and_then(|f| f.sync_all()) {
                log::warn!("MCP policy committed but directory flush failed: {error}");
            }
        }
        result
    }
}

struct Live {
    policy: Policy,
    bearer: Option<Bearer>,
    generation: CancellationToken,
    fault: Option<String>,
}
pub struct Controller {
    app: RuntimeContext,
    credentials: Arc<CredentialStore>,
    live: RwLock<Live>,
    admin: Mutex<()>,
    shutdown: CancellationToken,
    requests: Arc<Semaphore>,
    authority: String,
    origin: String,
}
impl Controller {
    pub fn open(
        app: RuntimeContext,
        credentials: Arc<CredentialStore>,
        port: u16,
    ) -> Result<Arc<Self>, String> {
        let (policy, mut fault) = match Policy::load(&app.path().config) {
            Ok(policy) => (policy, None),
            Err(error) => (
                Policy::default(),
                Some(format!(
                    "repair {}: {error}",
                    app.path().config.join("mcp.json").display()
                )),
            ),
        };
        let bearer = match credentials.load(CredentialKind::Mcp) {
            Ok(bearer) => bearer,
            Err(error) => {
                fault = Some(format!("repair MCP credential: {error}"));
                None
            }
        };
        if policy.enabled && bearer.is_none() && fault.is_none() {
            fault = Some(
                "MCP credential missing; rotate the MCP token using the application API".into(),
            );
        }
        Ok(Arc::new(Self {
            app,
            credentials,
            live: RwLock::new(Live {
                policy,
                bearer,
                fault,
                generation: CancellationToken::new(),
            }),
            admin: Mutex::new(()),
            shutdown: CancellationToken::new(),
            requests: Arc::new(Semaphore::new(MAX_REQUESTS)),
            authority: format!("127.0.0.1:{port}"),
            origin: format!("http://127.0.0.1:{port}"),
        }))
    }
    pub fn status(&self) -> serde_json::Value {
        let live = self.live.read();
        serde_json::json!({"enabled": live.policy.enabled && live.fault.is_none() && !self.shutdown.is_cancelled(), "error": live.fault,
            "repoIds": live.policy.repo_ids, "permissions": ["read"],
            "endpoint": format!("{}/mcp", self.origin), "transport": "streamable-http", "sessions": 0})
    }
    #[cfg(test)]
    pub(crate) fn available_requests(&self) -> usize {
        self.requests.available_permits()
    }
    pub fn enabled(&self) -> bool {
        let live = self.live.read();
        live.policy.enabled && live.fault.is_none() && !self.shutdown.is_cancelled()
    }

    pub async fn configure(
        self: &Arc<Self>,
        enabled: bool,
        repo_ids: Option<Vec<String>>,
    ) -> Result<(), String> {
        let controller = self.clone();
        // The owned blocking task completes disk commit AND publication even
        // when the HTTP caller disconnects or its request deadline expires.
        tokio::task::spawn_blocking(move || {
            let _transaction = if enabled {
                controller
                    .admin
                    .try_lock()
                    .ok_or("MCP administration busy")?
            } else {
                controller.admin.lock()
            };
            controller.configure_sync(enabled, repo_ids)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    fn configure_sync(&self, enabled: bool, repo_ids: Option<Vec<String>>) -> Result<(), String> {
        if self.shutdown.is_cancelled() {
            return Err("backend stopping".into());
        }
        if !enabled {
            return self.disable_sync();
        }
        let (previous_live, faulted) = {
            let live = self.live.read();
            (live.policy.clone(), live.fault.is_some())
        };
        let previous = Policy::load(&self.app.path().config)?;
        if !faulted && previous != previous_live {
            return Err("MCP policy changed on disk; restart or repair before editing".into());
        }
        let mut policy = previous.clone();
        policy.enabled = enabled;
        if let Some(ids) = repo_ids {
            policy.repo_ids = ids;
            policy.repo_ids.sort();
            policy.repo_ids.dedup();
        }
        let bearer = {
            let repos = self.app.state::<AppState>().settings.read().repos.clone();
            policy.repo_bindings.clear();
            for id in &policy.repo_ids {
                let repo = repos
                    .iter()
                    .find(|repo| &repo.id == id)
                    .ok_or("MCP allowlist contains an unregistered repository")?;
                let canonical = std::fs::canonicalize(&repo.path)
                    .map_err(|e| format!("resolve repository {id}: {e}"))?;
                policy.repo_bindings.insert(
                    id.clone(),
                    RepoBinding {
                        registered_path: repo.path.clone(),
                        canonical_path: canonical
                            .to_str()
                            .ok_or("repository canonical path is not UTF-8")?
                            .to_owned(),
                    },
                );
            }
            policy.validate()?;
            Some(
                match self
                    .credentials
                    .load(CredentialKind::Mcp)
                    .map_err(|e| e.to_string())?
                {
                    Some(bearer) => bearer,
                    None => self.rotate_credential()?,
                },
            )
        };
        policy.save(&self.app.path().config, &previous)?;
        let mut live = self.live.write();
        live.policy = policy;
        if let Some(bearer) = bearer {
            live.bearer = Some(bearer);
        }
        live.fault = None;
        live.generation.cancel();
        live.generation = CancellationToken::new();
        Ok(())
    }
    fn disable_sync(&self) -> Result<(), String> {
        let (previous_live, faulted) = {
            let live = self.live.read();
            (live.policy.clone(), live.fault.is_some())
        };
        let persisted = (|| {
            let previous = Policy::load(&self.app.path().config)?;
            if !faulted && previous != previous_live {
                return Err("policy changed on disk; external edits were preserved".to_owned());
            }
            let mut disabled = previous.clone();
            disabled.enabled = false;
            disabled.save(&self.app.path().config, &previous)?;
            Ok(disabled)
        })();
        // Revocation is unconditional, including read-only/full disks and
        // external edits. Serialization prevents an older enable publishing
        // after this kill switch; disk errors never restore live permission.
        let mut live = self.live.write();
        match persisted {
            Ok(policy) => {
                live.policy = policy;
                live.fault = None;
            }
            Err(error) => {
                live.fault = Some(format!(
                    "MCP disabled in memory; repair {} before enabling: {error}",
                    self.app.path().config.join("mcp.json").display()
                ));
            }
        }
        live.policy.enabled = false;
        live.generation.cancel();
        live.generation = CancellationToken::new();
        Ok(())
    }

    fn rotate_credential(&self) -> Result<Bearer, String> {
        let rotation = self
            .credentials
            .rotate(CredentialKind::Mcp, self.app.owner()?)
            .map_err(|e| e.to_string())?;
        if let Some(error) = rotation.durability_warning {
            log::warn!("MCP credential committed but directory flush failed: {error}");
        }
        Ok(rotation.bearer)
    }
    pub async fn rotate(self: &Arc<Self>) -> Result<(), String> {
        let controller = self.clone();
        tokio::task::spawn_blocking(move || {
            let _transaction = controller
                .admin
                .try_lock()
                .ok_or("MCP administration busy")?;
            if controller.shutdown.is_cancelled() {
                return Err("backend stopping".into());
            }
            let bearer = controller.rotate_credential()?;
            let policy = Policy::load(&controller.app.path().config);
            let mut live = controller.live.write();
            live.bearer = Some(bearer);
            // A repaired policy becomes effective only after explicit enable;
            // rotation never grants new repository permissions.
            if policy.as_ref().is_ok_and(|policy| policy == &live.policy) {
                live.fault = None;
            }
            live.generation.cancel();
            live.generation = CancellationToken::new();
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    pub fn shutdown(&self) {
        self.shutdown.cancel();
    }

    pub async fn handle(self: Arc<Self>, request: Request) -> Response {
        let mut response = self.dispatch(request).await;
        response
            .headers_mut()
            .insert("cache-control", "no-store".parse().unwrap());
        response.headers_mut().insert(
            "x-canopy-api-version",
            crate::app_api::API_VERSION.parse().unwrap(),
        );
        response
    }
    async fn dispatch(self: &Arc<Self>, request: Request) -> Response {
        if self.shutdown.is_cancelled() {
            return http_error(StatusCode::SERVICE_UNAVAILABLE, "stopping");
        }
        let generation = {
            let live = self.live.read();
            if live.fault.is_some() {
                return http_error(StatusCode::SERVICE_UNAVAILABLE, "mcp_faulted");
            }
            if !live.policy.enabled {
                return http_error(StatusCode::NOT_FOUND, "mcp_disabled");
            }
            if crate::app_api::single_header(request.headers(), "host") != Some(&self.authority)
                || (request.headers().contains_key("origin")
                    && crate::app_api::single_header(request.headers(), "origin")
                        != Some(&self.origin))
            {
                return http_error(StatusCode::FORBIDDEN, "invalid_host_or_origin");
            }
            let authorized = crate::app_api::single_header(request.headers(), "authorization")
                .and_then(|value| value.strip_prefix("Bearer "))
                .is_some_and(|value| {
                    live.bearer
                        .as_ref()
                        .is_some_and(|bearer| bearer.matches(value))
                });
            if !authorized {
                return http_error(StatusCode::UNAUTHORIZED, "unauthorized");
            }
            live.generation.clone()
        };
        let Ok(_permit) = self.requests.clone().try_acquire_owned() else {
            return http_error(StatusCode::SERVICE_UNAVAILABLE, "busy");
        };
        let request_cancel = generation.child_token();
        let _cleanup = request_cancel.clone().drop_guard();
        let (mut parts, body) = request.into_parts();
        // The SDK never receives a bearer, including in its request extensions
        // and diagnostics. Host/Origin checks are also enabled inside the SDK.
        parts.headers.remove("authorization");
        let work = async {
            let bytes = match tokio::time::timeout(
                Duration::from_secs(5),
                to_bytes(body, BODY_LIMIT),
            )
            .await
            {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(_)) => return http_error(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large"),
                Err(_) => return http_error(StatusCode::REQUEST_TIMEOUT, "body_timeout"),
            };
            // rmcp caches schemas (including unknown tool names) in a HashMap.
            // A fresh stateless service per bounded request makes that cache
            // request-local, so arbitrary names cannot accumulate across calls.
            let controller = self.clone();
            let request_generation = generation.clone();
            let config = StreamableHttpServerConfig::default()
                .with_legacy_session_mode(false)
                .with_json_response(true)
                .with_allowed_hosts([self.authority.clone()])
                .with_allowed_origins([self.origin.clone()])
                .with_max_request_body_bytes(BODY_LIMIT)
                .with_cancellation_token(request_cancel);
            let service = StreamableHttpService::new(
                move || {
                    Ok(Handler {
                        controller: controller.clone(),
                        generation: request_generation.clone(),
                    })
                },
                Arc::new(NeverSessionManager::default()),
                config,
            );
            service
                .handle(Request::from_parts(parts, Body::from(bytes)))
                .await
                .map(Body::new)
        };
        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => http_error(StatusCode::SERVICE_UNAVAILABLE, "stopping"),
            _ = generation.cancelled() => http_error(StatusCode::UNAUTHORIZED, "authorization_changed"),
            response = tokio::time::timeout(Duration::from_secs(10), work) => response.unwrap_or_else(|_| http_error(StatusCode::GATEWAY_TIMEOUT, "request_timeout")),
        }
    }
}

fn http_error(status: StatusCode, code: &'static str) -> Response {
    (status, Json(serde_json::json!({"code": code}))).into_response()
}

#[derive(Clone)]
struct Handler {
    controller: Arc<Controller>,
    generation: CancellationToken,
}
fn status_tool() -> Tool {
    Tool::new("canopy_status", "Read cached status for one explicitly allowed repository. No subprocesses or fresh filesystem reads. repoId is required until client roots inference is available.",
        serde_json::json!({"type":"object","properties":{"repoId":{"type":"string","minLength":1,"maxLength":256}},"required":["repoId"],"additionalProperties":false}).as_object().unwrap().clone())
        .with_annotations(ToolAnnotations::new().read_only(true).destructive(false).idempotent(true).open_world(false))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusArgs {
    repo_id: String,
}
impl ServerHandler for Handler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("canopy-mcp", env!("CARGO_PKG_VERSION")))
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        (name == "canopy_status").then(status_tool)
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        if self.generation.is_cancelled() {
            return Err(ErrorData::internal_error("authorization changed", None));
        }
        Ok(ListToolsResult::with_all_items(vec![status_tool()])
            .with_ttl_ms(0)
            .with_cache_scope(CacheScope::Private))
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if request.name != "canopy_status" {
            return Err(ErrorData::invalid_params("unknown tool", None));
        }
        let args = serde_json::from_value::<StatusArgs>(serde_json::Value::Object(
            request.arguments.unwrap_or_default(),
        ));
        let outcome = match args {
            Ok(args) if !args.repo_id.is_empty() && args.repo_id.len() <= 256 => {
                self.cached_status(&args.repo_id)
            }
            _ => Err("invalid_arguments"),
        };
        Ok(match outcome {
            Ok(value) => CallToolResult::success(vec![ContentBlock::text(value)]),
            Err(code) => CallToolResult::error(vec![ContentBlock::text(code)]),
        }
        .into())
    }
}
impl Handler {
    fn cached_status(&self, repo_id: &str) -> Result<String, &'static str> {
        // Hold policy through the cached read: rotation/disable linearizes
        // either before this call or after it, never halfway through it.
        let live = self.controller.live.read();
        if self.controller.shutdown.is_cancelled()
            || live.fault.is_some()
            || self.generation.is_cancelled()
            || !live.policy.enabled
        {
            return Err("authorization_changed");
        }
        if !live.policy.repo_ids.iter().any(|id| id == repo_id) {
            return Err("repo_not_allowed");
        }
        let app = self.controller.app.state::<AppState>();
        let settings = app.settings.read();
        let registered = settings
            .repos
            .iter()
            .find(|repo| repo.id == repo_id)
            .ok_or("repo_not_found")?;
        if live
            .policy
            .repo_bindings
            .get(repo_id)
            .map(|binding| &binding.registered_path)
            != Some(&registered.path)
        {
            return Err("repo_not_allowed");
        }
        let tree = app.tree.read();
        let repo = tree.iter().find(|repo| repo.repo_id == repo_id);
        // Aggregate-only bootstrap surface: no branch/path/env/command text.
        // Rich, paged worktree status and readiness are the next read-tools slice.
        let mut counts = [0usize; 5];
        if let Some(repo) = repo {
            for wt in &repo.worktrees {
                for svc in &wt.services {
                    use crate::state::SvcStatus::*;
                    counts[match svc.status {
                        Stopped => 0,
                        Starting => 1,
                        Running => 2,
                        Stopping => 3,
                        Error => 4,
                    }] += 1;
                }
            }
        }
        Ok(serde_json::json!({"repoId":repo_id,"source":"cache","cacheAvailable":repo.is_some(),
            "worktrees":repo.map(|r| r.worktrees.len()).unwrap_or(0),
            "services":{"stopped":counts[0],"starting":counts[1],"running":counts[2],"stopping":counts[3],"error":counts[4]}}).to_string())
    }
}
