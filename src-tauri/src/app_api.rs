//! Versioned application control API, separate from MCP permissions/tokens.
use crate::{
    credentials::{Bearer, CredentialKind, CredentialStore},
    runtime::RuntimeContext,
    state::AppState,
};
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    io::Write,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    net::TcpListener,
    sync::{watch, Semaphore},
    task::JoinSet,
};

pub const API_VERSION: &str = "1";
pub const DEFAULT_PORT: u16 = 47831;
const BODY_LIMIT: usize = 64 * 1024;
const MAX_REQUESTS: usize = 8;
const MAX_CONNECTIONS: usize = 32;

#[derive(Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub port: u16,
}
impl Default for Config {
    fn default() -> Self {
        Self { port: DEFAULT_PORT }
    }
}
impl Config {
    pub fn load(directory: &Path) -> Result<Self, String> {
        let config: Self = crate::settings::load_checked(&directory.join("backend.json"))?;
        if config.port < 1024 {
            return Err("backend port must be between 1024 and 65535".into());
        }
        Ok(config)
    }
    /// Caller holds runtime ownership. Only this backend CLI writes this file;
    /// it is separate from legacy whole-object desktop settings saves.
    pub fn save(&self, directory: &Path) -> Result<(), String> {
        if self.port < 1024 {
            return Err("backend port must be between 1024 and 65535".into());
        }
        std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let path = directory.join("backend.json");
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
        let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let temporary = directory.join(format!(".backend-{suffix}.tmp"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        let result = (|| {
            file.write_all(&serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            drop(file);
            std::fs::rename(&temporary, &path).map_err(|e| format!("save {}: {e}", path.display()))
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        #[cfg(unix)]
        if result.is_ok() {
            if let Err(error) = std::fs::File::open(directory).and_then(|f| f.sync_all()) {
                log::warn!("backend port committed but directory flush failed: {error}");
            }
        }
        result
    }
}

#[derive(Clone)]
struct ApiState {
    app: RuntimeContext,
    bearer: Arc<Bearer>,
    _credentials: Arc<CredentialStore>,
    mcp: Arc<crate::mcp::Controller>,
    authority: String,
    origin: String,
    requests: Arc<Semaphore>,
    stop: watch::Sender<bool>,
    started: Instant,
}

fn error(status: StatusCode, code: &'static str) -> Response {
    (
        status,
        [
            ("cache-control", "no-store"),
            ("x-canopy-api-version", API_VERSION),
        ],
        Json(serde_json::json!({"code": code})),
    )
        .into_response()
}

pub(crate) fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let first = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    Some(first)
}

async fn authorize(State(state): State<ApiState>, request: Request, next: Next) -> Response {
    if *state.stop.borrow() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "stopping");
    }
    if single_header(request.headers(), "host") != Some(&state.authority) {
        return error(StatusCode::FORBIDDEN, "invalid_host");
    }
    if request.headers().contains_key("origin")
        && single_header(request.headers(), "origin") != Some(&state.origin)
    {
        return error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let authorized = single_header(request.headers(), "authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| state.bearer.matches(value));
    if !authorized {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    if single_header(request.headers(), "x-canopy-api-version") != Some(API_VERSION) {
        return error(StatusCode::CONFLICT, "unsupported_api_version");
    }
    if *state.stop.borrow() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "stopping");
    }
    let Ok(_permit) = state.requests.clone().try_acquire_owned() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "busy");
    };
    // Bound both announced and streamed bodies, after authentication and before
    // dispatch. A slow authenticated body cannot monopolize admission forever.
    let (parts, body) = request.into_parts();
    let bytes = match tokio::time::timeout(Duration::from_secs(5), to_bytes(body, BODY_LIMIT)).await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => return error(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large"),
        Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "body_timeout"),
    };
    if *state.stop.borrow() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "stopping");
    }
    match tokio::time::timeout(
        Duration::from_secs(10),
        next.run(Request::from_parts(parts, Body::from(bytes))),
    )
    .await
    {
        Ok(mut response) => {
            response
                .headers_mut()
                .insert("cache-control", "no-store".parse().unwrap());
            response
                .headers_mut()
                .insert("x-canopy-api-version", API_VERSION.parse().unwrap());
            response
        }
        Err(_) => error(StatusCode::GATEWAY_TIMEOUT, "request_timeout"),
    }
}

async fn status(State(state): State<ApiState>) -> Json<serde_json::Value> {
    let app = state.app.state::<AppState>();
    let repositories = app.settings.read().repos.len();
    let worktrees = app
        .tree
        .read()
        .iter()
        .map(|repo| repo.worktrees.len())
        .sum::<usize>();
    let services = state
        .app
        .state::<crate::services::ProcTable>()
        .procs
        .lock()
        .len();
    Json(serde_json::json!({
        "apiVersion": API_VERSION,
        "backendVersion": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "uptimeMs": state.started.elapsed().as_millis() as u64,
        "repositories": repositories,
        "cachedWorktrees": worktrees,
        "trackedServices": services,
        "mcpEnabled": state.mcp.enabled(),
        "mcpError": state.mcp.status()["error"],
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct McpEnable {
    repo_ids: Option<Vec<String>>,
    allow_worktree_write: Option<bool>,
    allow_service_control: Option<bool>,
}
async fn mcp_status(State(state): State<ApiState>) -> Json<serde_json::Value> {
    Json(state.mcp.status())
}
fn mcp_control_result(state: &ApiState, result: Result<(), String>) -> Response {
    match result {
        Ok(()) => Json(state.mcp.status()).into_response(),
        Err(message) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"code":"mcp_configuration_failed","message":message})),
        )
            .into_response(),
    }
}
async fn mcp_enable(State(state): State<ApiState>, Json(input): Json<McpEnable>) -> Response {
    mcp_control_result(&state, state.mcp.configure_access(true, input.repo_ids, input.allow_worktree_write, input.allow_service_control).await)
}
async fn mcp_disable(State(state): State<ApiState>) -> Response {
    mcp_control_result(&state, state.mcp.configure(false, None).await)
}
async fn mcp_rotate(State(state): State<ApiState>) -> Response {
    mcp_control_result(&state, state.mcp.rotate().await)
}
async fn mcp_request(State(state): State<ApiState>, request: Request) -> Response {
    if *state.stop.borrow() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "stopping");
    }
    state.mcp.handle(request).await
}

async fn stop(State(state): State<ApiState>) -> impl IntoResponse {
    state.stop.send_replace(true);
    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({"status": "stopping"})),
    )
}

async fn stopped(mut receiver: watch::Receiver<bool>) {
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            break;
        }
    }
}

fn accept_retry(kind: std::io::ErrorKind, backoff: Duration) -> (Option<Duration>, Duration) {
    use std::io::ErrorKind::{ConnectionAborted, ConnectionReset, Interrupted};
    if matches!(kind, ConnectionAborted | ConnectionReset | Interrupted) {
        (None, backoff)
    } else {
        (Some(backoff), (backoff * 2).min(Duration::from_secs(1)))
    }
}

pub struct Server {
    listener: TcpListener,
    state: ApiState,
    connections: Arc<Semaphore>,
    connection_lifetime: Duration,
}
impl Server {
    #[cfg(feature = "desktop")]
    pub(crate) fn mcp(&self) -> Arc<crate::mcp::Controller> {
        self.state.mcp.clone()
    }

    pub async fn bind(
        app: RuntimeContext,
        port: u16,
        stop: watch::Sender<bool>,
    ) -> Result<Self, String> {
        if port < 1024 {
            return Err("backend port must be between 1024 and 65535".into());
        }
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .map_err(|e| {
                format!("bind backend at 127.0.0.1:{port}: {e}; choose a free --port explicitly")
            })?;
        Self::from_listener(app, listener, stop)
    }

    pub(crate) fn from_listener(app: RuntimeContext, listener: TcpListener, stop: watch::Sender<bool>) -> Result<Self, String> {
        let address = listener.local_addr().map_err(|e| format!("read backend listener address: {e}"))?;
        if address.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST) || address.port() < 1024 {
            return Err("backend listener must use 127.0.0.1 and a port between 1024 and 65535".into());
        }
        let port = address.port();
        let credentials = CredentialStore::open(&app.path().data)
            .map_err(|e| format!("open application credentials: {e}"))?;
        let bearer = match credentials
            .load(CredentialKind::Application)
            .map_err(|e| e.to_string())?
        {
            Some(bearer) => bearer,
            None => {
                let created = credentials
                    .rotate(CredentialKind::Application, app.owner()?)
                    .map_err(|e| e.to_string())?;
                if let Some(error) = created.durability_warning {
                    eprintln!("canopy-backend: application credential committed, but directory flush failed: {error}");
                }
                created.bearer
            }
        };
        let credentials = Arc::new(credentials);
        let mcp = crate::mcp::Controller::open(app.clone(), credentials.clone(), port)?;
        Ok(Self {
            listener,
            connection_lifetime: Duration::from_secs(60),
            connections: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            state: ApiState {
                app,
                bearer: Arc::new(bearer),
                _credentials: credentials,
                mcp,
                authority: format!("127.0.0.1:{port}"),
                origin: format!("http://127.0.0.1:{port}"),
                requests: Arc::new(Semaphore::new(MAX_REQUESTS)),
                stop,
                started: Instant::now(),
            },
        })
    }

    pub(crate) async fn run(self) -> Result<(), String> {
        let application = Router::new()
            .fallback(|| async { error(StatusCode::NOT_FOUND, "not_found") })
            .route("/api/v1/status", get(status))
            .route("/api/v1/stop", post(stop))
            .route("/api/v1/mcp/status", get(mcp_status))
            .route("/api/v1/mcp/enable", post(mcp_enable))
            .route("/api/v1/mcp/disable", post(mcp_disable))
            .route("/api/v1/mcp/rotate-token", post(mcp_rotate))
            .layer(middleware::from_fn_with_state(
                self.state.clone(),
                authorize,
            ))
            .with_state(self.state.clone());
        // App authentication is attached before merging the independently
        // authenticated MCP router; route insertion order cannot bypass it.
        let router = application.merge(
            Router::new()
                .route("/mcp", any(mcp_request))
                .with_state(self.state.clone()),
        );
        let slots = self.connections;
        let shutdown = self.state.stop.subscribe();
        let mut connections = JoinSet::new();
        let mut accept_backoff = Duration::from_millis(100);
        let outcome = loop {
            tokio::select! {
                biased;
                _ = stopped(shutdown.clone()) => break Ok(()),
                Some(_) = connections.join_next(), if !connections.is_empty() => {},
                accepted = self.listener.accept() => {
                    let (stream, _) = match accepted {
                        Ok(value) => { accept_backoff = Duration::from_millis(100); value },
                        Err(error) => {
                            // Accept errors never stop the runtime or its supervised children.
                            let (delay, next) = accept_retry(error.kind(), accept_backoff);
                            accept_backoff = next;
                            let Some(delay) = delay else { continue };
                            log::warn!("accept backend connection: {error}; retrying after {delay:?}");
                            tokio::select! {
                                _ = stopped(shutdown.clone()) => break Ok(()),
                                _ = tokio::time::sleep(delay) => {},
                            }
                            continue;
                        }
                    };
                    let Ok(permit) = slots.clone().try_acquire_owned() else { drop(stream); continue };
                    let router = router.clone();
                    let shutdown = shutdown.clone();
                    let lifetime = self.connection_lifetime;
                    connections.spawn(async move {
                        let _slot = permit;
                        // Hyper's idle timer behavior must not decide whether
                        // silent unauthenticated sockets retain admission.
                        let mut first = [0u8; 1];
                        tokio::select! {
                            _ = stopped(shutdown.clone()) => return,
                            ready = tokio::time::timeout(Duration::from_secs(5), stream.peek(&mut first)) => {
                                if !matches!(ready, Ok(Ok(1))) { return; }
                            },
                        }
                        let mut builder = hyper::server::conn::http1::Builder::new();
                        builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(5)).max_buf_size(16 * 1024);
                        let connection = builder.serve_connection(TokioIo::new(stream), TowerToHyperService::new(router));
                        tokio::pin!(connection);
                        tokio::select! {
                            _ = &mut connection => {},
                            _ = stopped(shutdown.clone()) => {
                                connection.as_mut().graceful_shutdown();
                                let _ = tokio::time::timeout(Duration::from_secs(2), &mut connection).await;
                            },
                            // Retire keep-alive admission, then allow an active request
                            // to finish under the existing request deadline.
                            _ = tokio::time::sleep(lifetime) => {
                                connection.as_mut().graceful_shutdown();
                                tokio::select! {
                                    _ = tokio::time::timeout(Duration::from_secs(20), &mut connection) => {},
                                    _ = stopped(shutdown) => {
                                        let _ = tokio::time::timeout(Duration::from_secs(2), &mut connection).await;
                                    },
                                }
                            },
                        }
                    });
                }
            }
        };
        drop(self.listener);
        // Join every accepted connection before releasing the runtime clone.
        // Each gets at most two seconds to flush its shutdown response.
        self.state.stop.send_replace(true);
        self.state.mcp.shutdown();
        while connections.join_next().await.is_some() {}
        self.state.mcp.drain_writes().await;
        outcome
    }
}

/// Stop admission and drain network connections alongside runtime child
/// cleanup. Neither a request cancellation nor connection drop sends stop.
pub async fn serve(
    app: RuntimeContext,
    server: Server,
    signal: impl Future<Output = Result<(), String>>,
) -> Result<(), String> {
    let shutdown = server.state.stop.clone();
    let (runtime_shutdown, runtime_stop) = watch::channel(false);
    let cleanup = app.clone();
    let mut network = tokio::spawn(server.run());
    let mut runtime = tokio::spawn(crate::backend::serve(app, async {
        stopped(runtime_stop).await;
        Ok(())
    }));
    let mut runtime_done = false;
    let mut network_done = false;
    let outcome = tokio::select! {
        result = signal => result,
        result = &mut runtime => { runtime_done = true; result.map_err(|e| e.to_string()).and_then(|r| r) },
        result = &mut network => { network_done = true; result.map_err(|e| e.to_string()).and_then(|r| r) },
    };
    shutdown.send_replace(true);
    let network_result = if network_done {
        Ok(())
    } else {
        network.await.map_err(|e| e.to_string()).and_then(|r| r)
    };
    // Finish accepted writes before child cleanup, so no job can spawn a
    // service after the process supervisor has already swept it.
    runtime_shutdown.send_replace(true);
    let runtime_result = if runtime_done {
        Ok(())
    } else {
        runtime.await.map_err(|e| e.to_string()).and_then(|r| r)
    };
    let result = outcome.and(network_result).and(runtime_result);
    if result.is_err() {
        // A panic in the supervisor itself skips its normal cleanup path.
        // Keep a separate context clone for best-effort process cleanup.
        crate::terminal::close_all(&cleanup);
        crate::services::stop_all(&cleanup).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimePaths;
    use std::path::PathBuf;

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "canopy-api-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn context(&self) -> RuntimeContext {
            crate::backend::open(RuntimePaths {
                data: self.0.clone(),
                config: self.0.clone(),
                logs: self.0.clone(),
            })
            .unwrap()
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct Running {
        directory: Directory,
        app: RuntimeContext,
        mcp: Arc<crate::mcp::Controller>,
        shutdown: watch::Sender<bool>,
        task: tokio::task::JoinHandle<Result<(), String>>,
        port: u16,
        bearer: Bearer,
        client: reqwest::Client,
        connections: Arc<Semaphore>,
    }
    impl Running {
        async fn start() -> Self {
            Self::with_lifetime(Duration::from_secs(60)).await
        }
        async fn with_lifetime(lifetime: Duration) -> Self {
            Self::with_directory(Directory::new(), lifetime).await
        }
        async fn with_directory(directory: Directory, lifetime: Duration) -> Self {
            let reservation = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = reservation.local_addr().unwrap().port();
            let (shutdown, _) = watch::channel(false);
            let app = directory.context();
            let mut server = Server::from_listener(app.clone(), reservation, shutdown.clone()).unwrap();
            server.connection_lifetime = lifetime;
            let bearer = CredentialStore::open_existing(&directory.0)
                .unwrap()
                .load(CredentialKind::Application)
                .unwrap()
                .unwrap();
            let connections = server.connections.clone();
            let app = server.state.app.clone();
            let mcp = server.state.mcp.clone();
            let task = tokio::spawn(server.run());
            Self {
                directory,
                app,
                mcp,
                shutdown,
                task,
                port,
                bearer,
                connections,
                client: reqwest::Client::builder()
                    .no_proxy()
                    .timeout(Duration::from_secs(10))
                    .build()
                    .unwrap(),
            }
        }
        fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
            self.client
                .request(
                    method,
                    format!("http://127.0.0.1:{}/api/v1/{path}", self.port),
                )
                .bearer_auth(self.bearer.expose())
                .header("x-canopy-api-version", API_VERSION)
        }
        async fn finish(self) {
            self.shutdown.send_replace(true);
            tokio::time::timeout(Duration::from_secs(4), self.task)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        }
    }

    #[test]
    fn accept_errors_retry_with_bounded_backoff() {
        use std::io::ErrorKind::*;
        for kind in [ConnectionAborted, ConnectionReset, Interrupted] {
            assert_eq!(accept_retry(kind, Duration::from_millis(100)), (None, Duration::from_millis(100)));
        }
        let mut backoff = Duration::from_millis(100);
        for expected in [100, 200, 400, 800, 1000, 1000] {
            let (delay, next) = accept_retry(Other, backoff);
            assert_eq!(delay, Some(Duration::from_millis(expected)));
            backoff = next;
        }
    }

    #[tokio::test]
    async fn adopts_an_already_bound_listener() {
        let directory = Directory::new();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, _) = watch::channel(false);
        let server = Server::from_listener(directory.context(), listener, stop).unwrap();
        assert_eq!(server.listener.local_addr().unwrap(), address);
        assert!(TcpListener::bind(address).await.is_err());
        drop(server);
        assert!(TcpListener::bind(address).await.is_ok());
    }

    #[tokio::test]
    async fn unauthorized_cross_origin_and_incompatible_requests_never_stop_backend() {
        let running = Running::start().await;
        let store = CredentialStore::open_existing(&running.directory.0).unwrap();
        let mcp = store
            .rotate(CredentialKind::Mcp, running.app.owner().unwrap())
            .unwrap()
            .bearer;
        for (header, value, expected) in [
            ("authorization", "Bearer invalid", StatusCode::UNAUTHORIZED),
            ("host", "evil.example", StatusCode::FORBIDDEN),
            ("origin", "http://evil.example", StatusCode::FORBIDDEN),
            ("origin", "null", StatusCode::FORBIDDEN),
            ("x-canopy-api-version", "2", StatusCode::CONFLICT),
        ] {
            let mut request = running
                .request(reqwest::Method::POST, "stop")
                .build()
                .unwrap();
            request.headers_mut().insert(header, value.parse().unwrap());
            assert_eq!(
                running.client.execute(request).await.unwrap().status(),
                expected
            );
            assert!(!*running.shutdown.borrow());
        }
        let mut request = running
            .request(reqwest::Method::POST, "stop")
            .build()
            .unwrap();
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {}", mcp.expose()).parse().unwrap(),
        );
        assert_eq!(
            running.client.execute(request).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert!(!*running.shutdown.borrow());
        drop(store);
        running.finish().await;
    }

    #[tokio::test]
    async fn missing_credentials_are_rejected_even_for_unknown_routes_and_methods() {
        let running = Running::start().await;
        for (method, path) in [
            (reqwest::Method::GET, "status"),
            (reqwest::Method::DELETE, "status"),
            (reqwest::Method::GET, "missing"),
        ] {
            let mut request = running.request(method, path).build().unwrap();
            request.headers_mut().remove("authorization");
            let response = running.client.execute(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(response.headers()["x-canopy-api-version"], API_VERSION);
        }
        let mut request = running.request(reqwest::Method::GET, "status").build().unwrap();
        request.headers_mut().insert("x-canopy-api-version", "2".parse().unwrap());
        assert_eq!(request.headers().get_all("x-canopy-api-version").iter().count(), 1);
        let response = running.client.execute(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(response.headers()["x-canopy-api-version"], API_VERSION);
        running.finish().await;
    }

    #[tokio::test]
    async fn connection_retirement_drains_an_active_request() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let running = Running::with_lifetime(Duration::from_millis(200)).await;
        let mut stream =
            tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, running.port))
                .await
                .unwrap();
        stream.write_all(format!("GET /api/v1/status HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nX-Canopy-Api-Version: 1\r\nContent-Length: 2\r\n\r\n", running.port, running.bearer.expose()).as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
        stream.write_all(b"{}").await.unwrap();
        let mut response = String::new();
        tokio::time::timeout(Duration::from_secs(2), stream.read_to_string(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("backendVersion"));
        running.finish().await;
    }

    #[tokio::test]
    async fn bounded_bodies_fail_before_mutation_and_status_reports_the_same_runtime() {
        let running = Running::start().await;
        let response = running
            .request(reqwest::Method::POST, "stop")
            .body(vec![0; BODY_LIMIT + 1])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(!*running.shutdown.borrow());
        let response = running
            .request(reqwest::Method::GET, "status")
            .send()
            .await
            .unwrap();
        assert_eq!(response.headers()["cache-control"], "no-store");
        let status: serde_json::Value = response.json().await.unwrap();
        assert_eq!(status["pid"], std::process::id());
        assert_eq!(status["apiVersion"], API_VERSION);
        assert_eq!(status["mcpEnabled"], false);
        // Dropping a client response/connection never requests shutdown.
        assert!(!*running.shutdown.borrow());
        running.finish().await;
    }

    #[tokio::test]
    async fn authenticated_stop_flushes_its_response_and_closes_listener() {
        let running = Running::start().await;
        let response = running
            .request(reqwest::Method::POST, "stop")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["status"], "stopping");
        let port = running.port;
        running.finish().await;
        assert!(
            tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn occupied_port_fails_without_creating_credentials_or_falling_back() {
        let directory = Directory::new();
        let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = occupied.local_addr().unwrap().port();
        let (stop, _) = watch::channel(false);
        let result = Server::bind(directory.context(), port, stop).await;
        assert!(result.err().unwrap().contains(&format!("127.0.0.1:{port}")));
        assert!(!directory.0.join("credentials").exists());
    }

    #[tokio::test]
    async fn incomplete_authenticated_requests_cannot_exhaust_unbounded_admission() {
        use tokio::io::AsyncWriteExt;
        let running = Running::start().await;
        let mut stalled = Vec::new();
        for _ in 0..MAX_REQUESTS {
            let mut stream =
                tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, running.port))
                    .await
                    .unwrap();
            stream.write_all(format!("POST /api/v1/stop HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nX-Canopy-Api-Version: 1\r\nContent-Length: 1\r\n\r\n", running.port, running.bearer.expose()).as_bytes()).await.unwrap();
            stalled.push(stream);
        }
        // Wait for headers to reach middleware; stay well below body timeout.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let response = running
                .request(reqwest::Method::GET, "status")
                .send()
                .await
                .unwrap();
            if response.status() == StatusCode::SERVICE_UNAVAILABLE {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "request admission did not reach its bound"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!*running.shutdown.borrow());
        drop(stalled);
        running.finish().await;
    }

    #[tokio::test]
    async fn idle_connections_are_bounded_and_do_not_hold_shutdown_open() {
        use tokio::io::AsyncReadExt;
        let running = Running::start().await;
        let mut idle = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            idle.push(
                tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, running.port))
                    .await
                    .unwrap(),
            );
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while running.connections.available_permits() != 0 {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut excess =
            tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, running.port))
                .await
                .unwrap();
        let mut byte = [0];
        let closed = tokio::time::timeout(Duration::from_secs(1), excess.read(&mut byte))
            .await
            .unwrap();
        assert!(matches!(closed, Ok(0) | Err(_)));
        assert!(!*running.shutdown.borrow());
        running.finish().await;
        drop(idle);
    }

    #[tokio::test]
    async fn silent_connection_releases_admission_after_first_byte_deadline() {
        use tokio::io::AsyncReadExt;
        let running = Running::start().await;
        let mut stream =
            tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, running.port))
                .await
                .unwrap();
        let mut byte = [0];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(7), stream.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert_eq!(
            running
                .request(reqwest::Method::GET, "status")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        running.finish().await;
    }

    #[test]
    fn configured_port_is_stable_and_malformed_config_is_preserved() {
        let directory = Directory::new();
        assert_eq!(Config::load(&directory.0).unwrap().port, DEFAULT_PORT);
        Config { port: 49991 }.save(&directory.0).unwrap();
        assert_eq!(Config::load(&directory.0).unwrap().port, 49991);
        let path = directory.0.join("backend.json");
        std::fs::write(&path, "{invalid").unwrap();
        assert!(Config::load(&directory.0).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "{invalid");
        for port in [0, 80, 1023] {
            assert!(Config { port }.save(&directory.0).is_err());
            std::fs::write(
                directory.0.join("backend.json"),
                format!("{{\"port\":{port}}}"),
            )
            .unwrap();
            assert!(Config::load(&directory.0).is_err());
        }
    }
    impl Running {
        async fn enable_mcp(&self) -> Bearer {
            self.app
                .state::<AppState>()
                .settings
                .write()
                .repos
                .push(crate::settings::RepoCfg {
                    id: "allowed".into(),
                    path: std::fs::canonicalize(&self.directory.0)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    ..Default::default()
                });
            let response = self
                .request(reqwest::Method::POST, "mcp/enable")
                .json(&serde_json::json!({"repoIds":["allowed"]}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            self.mcp_bearer()
        }
        fn mcp_bearer(&self) -> Bearer {
            CredentialStore::open_existing(&self.directory.0)
                .unwrap()
                .load(CredentialKind::Mcp)
                .unwrap()
                .unwrap()
        }
        fn rpc(
            &self,
            bearer: &Bearer,
            method: &str,
            params: serde_json::Value,
        ) -> reqwest::RequestBuilder {
            self.client
                .post(format!("http://127.0.0.1:{}/mcp", self.port))
                .bearer_auth(bearer.expose())
                .header("accept", "application/json, text/event-stream")
                .header("mcp-protocol-version", "2025-03-26")
                .json(&serde_json::json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
        }
    }
    impl Running {
        async fn write_fixture(&self, setup: &str) -> (Bearer, String) {
            let bearer = self.enable_mcp().await;
            let path = self.app.state::<AppState>().settings.read().repos[0].path.clone();
            for args in [
                vec!["init", "-b", "main"],
                vec!["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"],
            ] {
                crate::git::run_git(&path, &args).await.unwrap();
            }
            std::fs::write(Path::new(&path).join(".worktreemanager.json"),
                serde_json::json!({"setup":[setup]}).to_string()).unwrap();
            (bearer, path)
        }
        async fn grant_writes(&self, enabled: bool) {
            let response = self.request(reqwest::Method::POST, "mcp/enable")
                .json(&serde_json::json!({"repoIds":["allowed"],"allowWorktreeWrite":enabled}))
                .send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
        async fn tool(&self, bearer: &Bearer, name: &str, args: serde_json::Value) -> serde_json::Value {
            self.rpc(bearer, "tools/call", serde_json::json!({"name":name,"arguments":args}))
                .send().await.unwrap().json::<serde_json::Value>().await.unwrap()["result"].clone()
        }
        async fn job_done(&self, bearer: &Bearer, id: &str) -> serde_json::Value {
            tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    let result = self.tool(bearer, "canopy_job", serde_json::json!({"repoId":"allowed","jobId":id})).await;
                    assert_ne!(result["isError"], true, "{result}");
                    let job: serde_json::Value = serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
                    if !matches!(job["status"].as_str().unwrap(), "queued" | "running") && job["persistencePending"] == false { break job; }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }).await.unwrap()
        }
    }
    fn tool_data(result: &serde_json::Value) -> serde_json::Value {
        assert_ne!(result["isError"], true, "{result}");
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn mcp_worktree_create_setup_permissions_retries_and_scope() {
        let running = Running::start().await;
        let (bearer, path) = running.write_fixture("echo configured > setup-ran").await;
        let args = serde_json::json!({"repoId":"allowed","branch":"agent-test","base":"main","requestKey":"create-one"});
        let denied = running.tool(&bearer, "canopy_create_worktree", args.clone()).await;
        assert_eq!(denied["isError"], true, "{denied}");
        assert!(!Path::new(&path).join(".worktrees/agent-test").exists());
        running.grant_writes(true).await;
        let listing: serde_json::Value = running.rpc(&bearer, "tools/list", serde_json::json!({})).send().await.unwrap().json().await.unwrap();
        assert_eq!(listing["result"]["tools"].as_array().unwrap().len(), 8);
        let accepted = tool_data(&running.tool(&bearer, "canopy_create_worktree", args.clone()).await);
        let id = accepted["job"]["jobId"].as_str().unwrap();
        let job = running.job_done(&bearer, id).await;
        assert_eq!(job["status"], "succeeded", "{job}");
        let created = job["createdPath"].as_str().unwrap();
        assert_eq!(std::fs::read_to_string(Path::new(created).join("setup-ran")).unwrap().trim(), "configured");
        let retry = tool_data(&running.tool(&bearer, "canopy_create_worktree", args.clone()).await);
        assert_eq!(retry["reused"], true);
        assert_eq!(retry["job"]["jobId"], id);
        let mut changed = args.clone();
        changed["base"] = "HEAD".into();
        let conflict = running.tool(&bearer, "canopy_create_worktree", changed).await;
        assert_eq!(conflict["isError"], true, "{conflict}");
        let denied = running.tool(&bearer, "canopy_job", serde_json::json!({"repoId":"other","jobId":id})).await;
        assert_eq!(denied["isError"], true);
        let worktrees = tool_data(&running.tool(&bearer, "canopy_worktrees", serde_json::json!({"repoId":"allowed"})).await);
        assert!(worktrees["worktrees"].as_array().unwrap().iter().any(|w| w["worktreeKey"] == created));
        std::fs::remove_file(Path::new(created).join("setup-ran")).unwrap();
        for dry_run in [true, false] {
            let result = tool_data(&running.tool(&bearer, "canopy_run_setup", serde_json::json!({
                "repoId":"allowed","worktreeKey":created,"dryRun":dry_run,"requestKey":format!("setup-{dry_run}")
            })).await);
            let job = running.job_done(&bearer, result["job"]["jobId"].as_str().unwrap()).await;
            assert_eq!(job["status"], "succeeded", "{job}");
            assert_eq!(Path::new(created).join("setup-ran").exists(), !dry_run);
        }
        let result = tool_data(&running.tool(&bearer, "canopy_run_setup", serde_json::json!({
            "repoId":"allowed","worktreeKey":path,"requestKey":"main-denied"
        })).await);
        assert_eq!(running.job_done(&bearer, result["job"]["jobId"].as_str().unwrap()).await["status"], "failed");
        let denied = running.tool(&bearer, "canopy_run_setup", serde_json::json!({
            "repoId":"allowed","worktreeKey":created,"requestKey":"arbitrary","command":"echo unsafe"
        })).await;
        assert_eq!(denied["isError"], true);
        running.grant_writes(false).await;
        assert_eq!(running.tool(&bearer, "canopy_create_worktree", args).await["isError"], true);
        running.finish().await;
    }

    #[tokio::test]
    async fn mcp_failed_setup_preserves_created_worktree_and_job_checkpoint() {
        let running = Running::start().await;
        let (bearer, _) = running.write_fixture("exit 23").await;
        running.grant_writes(true).await;
        let accepted = tool_data(&running.tool(&bearer, "canopy_create_worktree", serde_json::json!({
            "repoId":"allowed","branch":"failed-setup","base":"main","requestKey":"partial"
        })).await);
        let job = running.job_done(&bearer, accepted["job"]["jobId"].as_str().unwrap()).await;
        assert_eq!(job["status"], "failed", "{job}");
        assert_eq!(job["error"], "setup_failed");
        assert!(Path::new(job["createdPath"].as_str().unwrap()).join(".git").exists());
        assert_eq!(job["persistencePending"], false);
        running.finish().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mcp_shutdown_interrupts_setup_and_flushes_job() {
        let running = Running::start().await;
        let (bearer, path) = running.write_fixture("sleep 60 & echo $! > setup-child; echo started > setup-started; wait; echo escaped > setup-escaped").await;
        running.grant_writes(true).await;
        let accepted = tool_data(&running.tool(&bearer, "canopy_create_worktree", serde_json::json!({
            "repoId":"allowed","branch":"shutdown","base":"main","requestKey":"shutdown"
        })).await);
        let id = accepted["job"]["jobId"].as_str().unwrap();
        let created = Path::new(&path).join(".worktrees/shutdown");
        tokio::time::timeout(Duration::from_secs(20), async {
            while !created.join("setup-started").exists() { tokio::time::sleep(Duration::from_millis(20)).await; }
        }).await.unwrap();
        let child: i32 = std::fs::read_to_string(created.join("setup-child")).unwrap().trim().parse().unwrap();
        running.shutdown.send_replace(true);
        tokio::time::timeout(Duration::from_secs(5), running.task).await.unwrap().unwrap().unwrap();
        let journal = crate::jobs::Registry::open(&running.directory.0).unwrap();
        let job = journal.get(id).unwrap();
        assert_eq!(job.record.status, crate::jobs::Status::Interrupted);
        assert_eq!(job.record.outcome.created_path.as_deref(), created.to_str());
        assert!(!created.join("setup-escaped").exists());
        tokio::time::timeout(Duration::from_secs(3), async {
            while unsafe { libc::kill(child, 0) } == 0 { tokio::time::sleep(Duration::from_millis(20)).await; }
        }).await.expect("setup descendant survived shutdown");
        assert!(running.app.state::<AppState>().retained_orphans.lock().is_empty());
        journal.close().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mcp_service_jobs_permissions_leases_retries_and_real_process_lifecycle() {
        let running = Running::start().await;
        let (bearer,path) = running.write_fixture("echo hello").await;
        running.app.state::<AppState>().settings.write().repos[0].services.push(crate::settings::ServiceCfg {
            id:"worker".into(),name:"Worker".into(),command:"while :; do sleep 1; done".into(),..Default::default()
        });
        crate::state::refresh_tree(&running.app).await.unwrap();
        let key = crate::state::svc_key(&path,"worker");
        let args = serde_json::json!({"repoId":"allowed","serviceKey":key,"requestKey":"start"});
        running.grant_writes(true).await;
        assert_eq!(running.tool(&bearer,"canopy_start_service",args.clone()).await["isError"],true);
        running.mcp.configure_access(true,None,Some(false),Some(true)).await.unwrap();
        let lease = crate::state::try_lease(&running.app,&path,"test").unwrap();
        let busy = tool_data(&running.tool(&bearer,"canopy_start_service",serde_json::json!({"repoId":"allowed","serviceKey":key,"requestKey":"busy"})).await);
        assert_eq!(running.job_done(&bearer,busy["job"]["jobId"].as_str().unwrap()).await["status"],"failed");
        assert!(running.app.state::<crate::services::ProcTable>().procs.lock().is_empty());
        drop(lease);
        let started = tool_data(&running.tool(&bearer,"canopy_start_service",args.clone()).await);
        assert_eq!(running.job_done(&bearer,started["job"]["jobId"].as_str().unwrap()).await["status"],"succeeded");
        let pid = running.app.state::<crate::services::ProcTable>().procs.lock()[&key].pid;
        let retry = tool_data(&running.tool(&bearer,"canopy_start_service",args).await);
        assert_eq!(retry["job"]["jobId"],started["job"]["jobId"]);
        assert_eq!(retry["reused"],true);
        assert_eq!(running.app.state::<crate::services::ProcTable>().procs.lock()[&key].pid,pid);
        let restarted = tool_data(&running.tool(&bearer,"canopy_restart_service",serde_json::json!({"repoId":"allowed","serviceKey":key,"requestKey":"restart"})).await);
        assert_eq!(running.job_done(&bearer,restarted["job"]["jobId"].as_str().unwrap()).await["status"],"succeeded");
        assert_ne!(running.app.state::<crate::services::ProcTable>().procs.lock()[&key].pid,pid);
        assert_eq!(running.tool(&bearer,"canopy_stop_service",serde_json::json!({"repoId":"other","serviceKey":key,"requestKey":"bad"})).await["isError"],true);
        let stopped = tool_data(&running.tool(&bearer,"canopy_stop_service",serde_json::json!({"repoId":"allowed","serviceKey":key,"requestKey":"stop"})).await);
        assert_eq!(running.job_done(&bearer,stopped["job"]["jobId"].as_str().unwrap()).await["status"],"succeeded");
        assert!(!running.app.state::<crate::services::ProcTable>().procs.lock().contains_key(&key));
        running.mcp.configure_access(true,None,None,Some(false)).await.unwrap();
        assert_eq!(running.tool(&bearer,"canopy_start_service",serde_json::json!({"repoId":"allowed","serviceKey":key,"requestKey":"revoked"})).await["isError"],true);
        running.finish().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mcp_diagnostics_capture_bursts_filter_secrets_and_recover_output() {
        let running = Running::start().await;
        let (bearer, path) = running.write_fixture("i=0; while [ $i -lt 100 ]; do echo burst-$i; i=$((i + 1)); done; echo private-fixture-value; echo 'Bearer private-bearer'; echo 'password=hidden-value' >&2; exit 7").await;
        std::fs::write(Path::new(&path).join(".env"), "API_TOKEN=private-fixture-value
").unwrap();
        running.grant_writes(true).await;
        let admitted = tool_data(&running.tool(&bearer, "canopy_create_worktree", serde_json::json!({
            "repoId":"allowed","branch":"output","base":"main","requestKey":"output"
        })).await);
        let id = admitted["job"]["jobId"].as_str().unwrap();
        assert_eq!(running.job_done(&bearer,id).await["status"], "failed");
        let mut cursor = None;
        let mut all = String::new();
        loop {
            let result = running.tool(&bearer,"canopy_job_output",serde_json::json!({"repoId":"allowed","jobId":id,"cursor":cursor,"limit":17})).await;
            assert!(result.to_string().len() < 32*1024);
            let page = tool_data(&result);
            all.push_str(&page["output"]["lines"].to_string());
            assert_eq!(page["persistencePending"],false);
            if page["output"]["hasMore"] == false { break; }
            cursor = page["output"]["nextCursor"].as_u64();
        }
        for i in 0..100 { assert!(all.contains(&format!("burst-{i}"))); }
        for secret in ["private-fixture-value","private-bearer","hidden-value"] { assert!(!all.contains(secret),"{all}"); }
        assert!(all.contains("[REDACTED]"));
        let denied = running.tool(&bearer,"canopy_job_output",serde_json::json!({"repoId":"other","jobId":id})).await;
        assert_eq!(denied["isError"],true);
        let invalid = running.tool(&bearer,"canopy_job_output",serde_json::json!({"repoId":"allowed","jobId":id,"limit":501})).await;
        assert_eq!(invalid["isError"],true);
        running.shutdown.send_replace(true);
        running.task.await.unwrap().unwrap();
        let journal = crate::jobs::Registry::open(&running.directory.0).unwrap();
        let recovered = journal.output(id,journal.earliest_cursor(id).unwrap(),500).unwrap();
        let text = serde_json::to_string(&recovered).unwrap();
        assert!(text.contains("burst-99")); assert!(!text.contains("private-fixture-value"));
        journal.close().await;
    }

    #[tokio::test]
    async fn mcp_service_log_pages_are_scoped_redacted_and_detect_changes() {
        let running = Running::start().await;
        let (bearer,path) = running.write_fixture("echo hello").await;
        running.app.state::<AppState>().settings.write().repos[0].services.push(crate::settings::ServiceCfg {
            id:"api".into(),name:"API".into(),env:std::collections::HashMap::from([("API_TOKEN".into(),"fixture-private-service-token".into())]),..Default::default()
        });
        crate::state::refresh_tree(&running.app).await.unwrap();
        let service_key = crate::state::svc_key(&path,"api");
        let listed = tool_data(&running.tool(&bearer,"canopy_services",serde_json::json!({"repoId":"allowed","worktreeKey":path})).await);
        assert_eq!(listed["services"][0]["serviceKey"],service_key);
        assert!(!listed.to_string().contains("fixture-private-service-token"));
        for i in 0..3 { crate::services::push_log(&running.app,&service_key,crate::services::LogLine::now("info",format!("line-{i} fixture-private-service-token"))); }
        let first = tool_data(&running.tool(&bearer,"canopy_service_logs",serde_json::json!({"repoId":"allowed","serviceKey":service_key,"limit":1})).await);
        assert_eq!(first["hasMore"],true);
        assert!(!first.to_string().contains("fixture-private-service-token"));
        let next = tool_data(&running.tool(&bearer,"canopy_service_logs",serde_json::json!({"repoId":"allowed","serviceKey":service_key,"snapshot":first["snapshot"],"cursor":first["nextCursor"],"limit":1})).await);
        assert!(next["lines"][0]["text"].as_str().unwrap().contains("line-1"));
        crate::services::push_log(&running.app,&service_key,crate::services::LogLine::now("info","new"));
        let changed = running.tool(&bearer,"canopy_service_logs",serde_json::json!({"repoId":"allowed","serviceKey":service_key,"snapshot":first["snapshot"],"cursor":first["nextCursor"]})).await;
        assert_eq!(changed["isError"],true);
        assert!(changed.to_string().contains("snapshot_changed"));
        let denied = running.tool(&bearer,"canopy_service_logs",serde_json::json!({"repoId":"other","serviceKey":service_key})).await;
        assert_eq!(denied["isError"],true);
        running.finish().await;
    }

    #[tokio::test]
    async fn mcp_corrupt_journal_preserves_reads_and_refuses_write_grant() {
        let directory = Directory::new();
        let journal = crate::jobs::Registry::open(&directory.0).unwrap();
        journal.close().await;
        drop(journal);
        let file = directory.0.join("jobs/job-000.json");
        std::fs::write(&file, "{invalid").unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let running = Running::with_directory(directory, Duration::from_secs(60)).await;
        let bearer = running.enable_mcp().await;
        assert!(running.mcp.status()["executionError"].is_string());
        assert_ne!(running.tool(&bearer, "canopy_status", serde_json::json!({"repoId":"allowed"})).await["isError"], true);
        assert!(running.mcp.configure_permissions(true, None, Some(true)).await.is_err());
        assert_eq!(running.mcp.status()["allowWorktreeWrite"], false);
        assert_eq!(std::fs::read_to_string(file).unwrap(), "{invalid");
        running.finish().await;
    }

    #[tokio::test]
    async fn mcp_off_by_default_and_app_credentials_cannot_access_tools() {
        let running = Running::start().await;
        assert_eq!(
            running
                .rpc(&running.bearer, "tools/list", serde_json::json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert!(!running.directory.0.join("credentials/mcp.token").exists());
        let bearer = running.enable_mcp().await;
        assert_eq!(
            running
                .rpc(&running.bearer, "tools/list", serde_json::json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        for (header, value) in [
            ("host", "evil.example"),
            ("origin", "https://evil.example"),
            ("origin", "null"),
        ] {
            assert_eq!(
                running
                    .rpc(&bearer, "tools/list", serde_json::json!({}))
                    .header(header, value)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
        let mut request = running
            .request(reqwest::Method::POST, "mcp/disable")
            .build()
            .unwrap();
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {}", bearer.expose()).parse().unwrap(),
        );
        assert_eq!(
            running.client.execute(request).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert!(running.mcp.enabled());
        running.finish().await;
    }
    #[tokio::test]
    async fn mcp_official_stateless_protocol_lists_and_calls_only_allowed_cached_status() {
        let running = Running::start().await;
        let bearer = running.enable_mcp().await;
        let response = running.rpc(&bearer, "initialize", serde_json::json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"canopy-test","version":"1"}})).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get("mcp-session-id").is_none());
        let body: serde_json::Value = response.json().await.unwrap();
        assert!(
            body["result"]["capabilities"]["tools"].is_object(),
            "{body}"
        );
        let response = running
            .rpc(&bearer, "tools/list", serde_json::json!({}))
            .send()
            .await
            .unwrap();
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(
            body["result"]["tools"].as_array().unwrap().len(),
            6,
            "{body}"
        );
        assert_eq!(body["result"]["tools"][0]["name"], "canopy_status");
        assert_eq!(body["result"]["ttlMs"], 0);
        assert_eq!(body["result"]["cacheScope"], "private");
        for repo in ["allowed", "forbidden"] {
            let response = running
                .rpc(
                    &bearer,
                    "tools/call",
                    serde_json::json!({"name":"canopy_status","arguments":{"repoId":repo}}),
                )
                .send()
                .await
                .unwrap();
            let bytes = response.bytes().await.unwrap();
            assert!(bytes.len() <= 32 * 1024);
            let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            if repo == "allowed" {
                assert_ne!(body["result"]["isError"], true, "{body}");
                let result: serde_json::Value =
                    serde_json::from_str(body["result"]["content"][0]["text"].as_str().unwrap())
                        .unwrap();
                assert_eq!(result["repoId"], "allowed");
                assert_eq!(result["cacheAvailable"], false);
                assert_eq!(result["source"], "cache");
            } else {
                assert_eq!(body["result"]["isError"], true, "{body}");
            }
        }
        // A distinct connection has no session to recover and gets the same tool.
        let response = running
            .rpc(&bearer, "tools/list", serde_json::json!({}))
            .header("connection", "close")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get("mcp-session-id").is_none());
        running.finish().await;
    }
    #[tokio::test]
    async fn mcp_rotation_disable_and_allowlist_changes_revoke_without_stopping_app() {
        let running = Running::start().await;
        let bearer = running.enable_mcp().await;
        assert_eq!(
            running
                .request(reqwest::Method::POST, "mcp/rotate-token")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            running
                .rpc(&bearer, "tools/list", serde_json::json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let rotated = running.mcp_bearer();
        assert!(!rotated.matches(bearer.expose()));
        assert_eq!(
            running
                .rpc(&rotated, "tools/list", serde_json::json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            running
                .request(reqwest::Method::POST, "mcp/disable")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            running
                .rpc(&rotated, "tools/list", serde_json::json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            running
                .request(reqwest::Method::GET, "status")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert!(!*running.shutdown.borrow());
        assert_eq!(
            running
                .request(reqwest::Method::POST, "mcp/enable")
                .json(&serde_json::json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert!(running.mcp_bearer().matches(rotated.expose()));
        let original = std::fs::read(running.directory.0.join("mcp.json")).unwrap();
        assert_eq!(
            running
                .request(reqwest::Method::POST, "mcp/enable")
                .json(&serde_json::json!({"repoIds":["unregistered"]}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            std::fs::read(running.directory.0.join("mcp.json")).unwrap(),
            original
        );
        std::fs::write(running.directory.0.join("mcp.json"), "{broken").unwrap();
        assert_eq!(
            running
                .request(reqwest::Method::POST, "mcp/disable")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            std::fs::read_to_string(running.directory.0.join("mcp.json")).unwrap(),
            "{broken"
        );
        assert!(!running.mcp.enabled());
        running.finish().await;
    }

    #[tokio::test]
    async fn mcp_current_protocol_validates_metadata_and_bounded_bodies() {
        let running = Running::start().await;
        let bearer = running.enable_mcp().await;
        let mut request = running
            .rpc(
                &bearer,
                "tools/call",
                serde_json::json!({
                    "name":"canopy_status","arguments":{"repoId":"allowed"},
                    "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
                        "io.modelcontextprotocol/clientInfo":{"name":"canopy-test","version":"1"},
                        "io.modelcontextprotocol/clientCapabilities":{}}
                }),
            )
            .build()
            .unwrap();
        request
            .headers_mut()
            .insert("mcp-protocol-version", "2026-07-28".parse().unwrap());
        request
            .headers_mut()
            .insert("mcp-method", "tools/call".parse().unwrap());
        request
            .headers_mut()
            .insert("mcp-name", "canopy_status".parse().unwrap());
        let response = running.client.execute(request).await.unwrap();
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["result"]["resultType"], "complete", "{body}");
        assert_ne!(body["result"]["isError"], true, "{body}");
        let response = running
            .rpc(&bearer, "tools/list", serde_json::json!({}))
            .body(vec![0; BODY_LIMIT + 1])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        for _ in 0..3 {
            let body: serde_json::Value = running
                .rpc(
                    &bearer,
                    "tools/call",
                    serde_json::json!({"name":"unknown","arguments":{}}),
                )
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert!(body["error"].is_object(), "{body}");
        }
        // A fresh controller sees the committed policy and credential on restart.
        let reloaded = crate::mcp::Controller::open(
            running.app.clone(),
            Arc::new(CredentialStore::open_existing(&running.directory.0).unwrap()),
            running.port,
        )
        .unwrap();
        assert_eq!(reloaded.status(), running.mcp.status());
        drop(reloaded);
        running.finish().await;
    }
    #[tokio::test]
    async fn old_enabled_policy_faults_without_disabling_app_control() {
        let directory = Directory::new();
        let old = r#"{"enabled":true,"repoIds":["allowed"]}"#;
        std::fs::write(directory.0.join("mcp.json"), old).unwrap();
        let running = Running::with_directory(directory, Duration::from_secs(60)).await;
        let status: serde_json::Value = running.request(reqwest::Method::GET, "status").send().await.unwrap().json().await.unwrap();
        assert_eq!(status["mcpEnabled"], false);
        assert!(status["mcpError"].as_str().unwrap().contains("path bindings"));
        assert_eq!(std::fs::read_to_string(running.directory.0.join("mcp.json")).unwrap(), old);
        running.finish().await;
    }

    #[tokio::test]
    async fn concurrent_admin_changes_return_conflict() {
        let running = Running::start().await;
        running.enable_mcp().await;
        let controller = running.mcp.clone();
        let (ready, started) = tokio::sync::oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let holder = tokio::task::spawn_blocking(move || {
            let _transaction = controller.admin_guard_for_test();
            ready.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        tokio::time::timeout(Duration::from_secs(2), started).await.unwrap().unwrap();
        for action in ["mcp/enable", "mcp/rotate-token"] {
            let response = running.request(reqwest::Method::POST, action).json(&serde_json::json!({"repoIds":["allowed"]})).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT);
            let body: serde_json::Value = response.json().await.unwrap();
            assert!(body["message"].as_str().unwrap().contains("busy"));
        }
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), holder).await.unwrap().unwrap();
        running.finish().await;
    }

    #[tokio::test]
    async fn malformed_mcp_policy_keeps_app_control_available_and_repair_is_explicit() {
        let directory = Directory::new();
        std::fs::write(directory.0.join("mcp.json"), "{broken").unwrap();
        let running = Running::with_directory(directory, Duration::from_secs(60)).await;
        assert_eq!(
            running
                .request(reqwest::Method::GET, "status")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert!(running.mcp.status()["error"].is_string());
        let fault = running.mcp.status()["error"].clone();
        assert_eq!(running.request(reqwest::Method::POST, "mcp/rotate-token").send().await.unwrap().status(), StatusCode::OK);
        assert_eq!(running.mcp.status()["error"], fault, "rotation must not repair policy faults");

        assert_eq!(
            running
                .rpc(&running.bearer, "tools/list", serde_json::json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            running
                .request(reqwest::Method::POST, "mcp/disable")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            std::fs::read_to_string(running.directory.0.join("mcp.json")).unwrap(),
            "{broken"
        );
        std::fs::write(running.directory.0.join("mcp.json"), "{}").unwrap();
        let bearer = running.enable_mcp().await;
        assert_eq!(
            running
                .rpc(&bearer, "tools/list", serde_json::json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        running.finish().await;
    }

    #[tokio::test]
    async fn disable_revokes_after_valid_external_edits_or_deleted_policy() {
        for deleted in [false, true] {
            let running = Running::start().await;
            let bearer = running.enable_mcp().await;
            let path = running.directory.0.join("mcp.json");
            if deleted {
                std::fs::remove_file(&path).unwrap();
            } else {
                std::fs::write(&path, "{}").unwrap();
            }
            assert_eq!(
                running
                    .request(reqwest::Method::POST, "mcp/disable")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK
            );
            assert!(!running.mcp.enabled());
            assert!(running.mcp.status()["error"].is_string());
            assert_ne!(
                running
                    .rpc(&bearer, "tools/list", serde_json::json!({}))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK
            );
            if deleted {
                assert!(!path.exists());
            } else {
                assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
            }
            running.finish().await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn disable_revokes_even_when_policy_cannot_be_written() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let running = Running::start().await;
        let bearer = running.enable_mcp().await;
        let path = running.directory.0.join("mcp.json");
        let before = std::fs::read(&path).unwrap();
        std::fs::set_permissions(&running.directory.0, std::fs::Permissions::from_mode(0o500))
            .unwrap();
        let response = running
            .request(reqwest::Method::POST, "mcp/disable")
            .send()
            .await;
        std::fs::set_permissions(&running.directory.0, std::fs::Permissions::from_mode(0o700))
            .unwrap();
        assert_eq!(response.unwrap().status(), StatusCode::OK);
        assert!(!running.mcp.enabled());
        assert!(running.mcp.status()["error"].is_string());
        assert_eq!(std::fs::read(path).unwrap(), before);
        assert_eq!(
            running
                .rpc(&bearer, "tools/list", serde_json::json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        running.finish().await;
    }

    #[tokio::test]
    async fn malformed_mcp_credential_keeps_app_alive_and_can_be_repaired() {
        let directory = Directory::new();
        let app = directory.context();
        let store = CredentialStore::open(&directory.0).unwrap();
        store
            .rotate(CredentialKind::Mcp, app.owner().unwrap())
            .unwrap();
        std::fs::write(directory.0.join("credentials/mcp.token"), "invalid").unwrap();
        drop(store);
        drop(app);
        let running = Running::with_directory(directory, Duration::from_secs(60)).await;
        assert_eq!(
            running
                .request(reqwest::Method::GET, "status")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert!(running.mcp.status()["error"].is_string());
        let fault = running.mcp.status()["error"].clone();
        assert_eq!(running.request(reqwest::Method::POST, "mcp/disable").send().await.unwrap().status(), StatusCode::OK);
        assert_eq!(running.mcp.status()["error"], fault, "disable must retain credential faults");
        let status: serde_json::Value = running.request(reqwest::Method::GET, "status").send().await.unwrap().json().await.unwrap();
        assert_eq!(status["mcpError"], fault);

        assert_eq!(
            std::fs::read_to_string(running.directory.0.join("credentials/mcp.token")).unwrap(),
            "invalid"
        );
        assert_eq!(
            running
                .request(reqwest::Method::POST, "mcp/rotate-token")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let bearer = running.enable_mcp().await;
        assert_eq!(
            running
                .rpc(&bearer, "tools/list", serde_json::json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        running.finish().await;
    }

    #[tokio::test]
    async fn repository_removal_and_id_reuse_do_not_inherit_permission() {
        let running = Running::start().await;
        let bearer = running.enable_mcp().await;
        running
            .app
            .state::<AppState>()
            .settings
            .write()
            .repos
            .clear();
        let params = serde_json::json!({"name":"canopy_status","arguments":{"repoId":"allowed"}});
        let body: serde_json::Value = running
            .rpc(&bearer, "tools/call", params.clone())
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(body["result"]["content"][0]["text"], "repo_not_found");
        running
            .app
            .state::<AppState>()
            .settings
            .write()
            .repos
            .push(crate::settings::RepoCfg {
                id: "allowed".into(),
                path: "/different/repository".into(),
                ..Default::default()
            });
        let body: serde_json::Value = running
            .rpc(&bearer, "tools/call", params)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(body["result"]["content"][0]["text"], "repo_not_allowed");
        running.finish().await;
    }

    #[tokio::test]
    async fn policy_narrowing_revokes_inflight_requests_and_shutdown_has_distinct_status() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let running = Running::start().await;
        let bearer = running.enable_mcp().await;
        running
            .app
            .state::<AppState>()
            .settings
            .write()
            .repos
            .push(crate::settings::RepoCfg {
                id: "second".into(),
                path: std::fs::canonicalize(&running.directory.0)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                ..Default::default()
            });
        running
            .mcp
            .configure(true, Some(vec!["allowed".into(), "second".into()]))
            .await
            .unwrap();
        for stopping in [false, true] {
            let mut stream =
                tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, running.port))
                    .await
                    .unwrap();
            stream.write_all(format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: 1\r\nConnection: close\r\n\r\n", running.port, bearer.expose()).as_bytes()).await.unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while running.mcp.available_requests() == MAX_REQUESTS {
                assert!(Instant::now() < deadline);
                tokio::task::yield_now().await;
            }
            if stopping {
                let response = running.request(reqwest::Method::POST, "stop").send().await.unwrap();
                assert_eq!(response.status(), StatusCode::ACCEPTED);
            } else {
                running
                    .mcp
                    .configure(true, Some(vec!["second".into()]))
                    .await
                    .unwrap();
            }
            let mut response = String::new();
            tokio::time::timeout(Duration::from_secs(2), stream.read_to_string(&mut response))
                .await
                .unwrap()
                .unwrap();
            assert!(
                response.contains(if stopping {
                    "503 Service Unavailable"
                } else {
                    "401 Unauthorized"
                }),
                "{response}"
            );
            assert!(
                response.contains(if stopping {
                    "stopping"
                } else {
                    "authorization_changed"
                }),
                "{response}"
            );
            if !stopping {
                let body: serde_json::Value = running.rpc(&bearer, "tools/call", serde_json::json!({"name":"canopy_status","arguments":{"repoId":"allowed"}})).send().await.unwrap().json().await.unwrap();
                assert_eq!(body["result"]["content"][0]["text"], "repo_not_allowed");
            }
        }
        running.finish().await;
    }

    #[tokio::test]
    async fn mcp_stalled_requests_are_bounded_and_rotation_cancels_them() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let running = Running::start().await;
        let bearer = running.enable_mcp().await;
        let mut stalled = Vec::new();
        for _ in 0..8 {
            let mut stream =
                tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, running.port))
                    .await
                    .unwrap();
            stream.write_all(format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: 1\r\n\r\n", running.port, bearer.expose()).as_bytes()).await.unwrap();
            stalled.push(stream);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while running.mcp.available_requests() != 0 {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            running
                .rpc(&bearer, "tools/list", serde_json::json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        // The independent application control plane can still revoke a full
        // MCP admission queue, and all old requests must release their slots.
        assert_eq!(
            running
                .request(reqwest::Method::POST, "mcp/rotate-token")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        for mut stream in stalled {
            let mut bytes = [0u8; 4096];
            let count = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut bytes))
                .await
                .unwrap()
                .unwrap();
            assert!(String::from_utf8_lossy(&bytes[..count]).contains("401 Unauthorized"));
        }
        let rotated = running.mcp_bearer();
        assert_eq!(
            running
                .rpc(&rotated, "tools/list", serde_json::json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        running.finish().await;
    }
}
