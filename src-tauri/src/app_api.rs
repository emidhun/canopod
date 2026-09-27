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
        file.write_all(&serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&temporary, &path).map_err(|e| format!("save {}: {e}", path.display()))
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
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct McpEnable {
    repo_ids: Option<Vec<String>>,
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
    mcp_control_result(&state, state.mcp.configure(true, input.repo_ids))
}
async fn mcp_disable(State(state): State<ApiState>) -> Response {
    mcp_control_result(&state, state.mcp.configure(false, None))
}
async fn mcp_rotate(State(state): State<ApiState>) -> Response {
    mcp_control_result(&state, state.mcp.rotate())
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

pub struct Server {
    listener: TcpListener,
    state: ApiState,
    connections: Arc<Semaphore>,
    connection_lifetime: Duration,
}
impl Server {
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

    async fn run(self) -> Result<(), String> {
        let router = Router::new()
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
            // MCP has its own credential/admission layer, independent of app auth.
            .route("/mcp", any(mcp_request))
            .with_state(self.state.clone());
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
                            log::warn!("accept backend connection: {error}; retrying after {accept_backoff:?}");
                            tokio::select! {
                                _ = stopped(shutdown.clone()) => break Ok(()),
                                _ = tokio::time::sleep(accept_backoff) => {},
                            }
                            accept_backoff = (accept_backoff * 2).min(Duration::from_secs(1));
                            continue;
                        }
                    };
                    let Ok(permit) = slots.clone().try_acquire_owned() else { drop(stream); continue };
                    let router = router.clone();
                    let shutdown = shutdown.clone();
                    let lifetime = self.connection_lifetime;
                    connections.spawn(async move {
                        let _slot = permit;
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
                                    _ = tokio::time::timeout(Duration::from_secs(10), &mut connection) => {},
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
        // Join every accepted connection before releasing the runtime clone.
        // Each gets at most two seconds to flush its shutdown response.
        self.state.stop.send_replace(true);
        self.state.mcp.shutdown();
        while connections.join_next().await.is_some() {}
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
    let runtime_stop = shutdown.subscribe();
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
            let directory = Directory::new();
            let reservation = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = reservation.local_addr().unwrap().port();
            drop(reservation);
            let (shutdown, _) = watch::channel(false);
            let app = directory.context();
            let mut server = Server::bind(app.clone(), port, shutdown.clone())
                .await
                .unwrap();
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
        let response = running
            .request(reqwest::Method::GET, "status")
            .header("x-canopy-api-version", "2")
            .send()
            .await
            .unwrap();
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
            1,
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
            StatusCode::CONFLICT
        );
        assert_eq!(
            std::fs::read_to_string(running.directory.0.join("mcp.json")).unwrap(),
            "{broken"
        );
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
