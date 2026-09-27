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
    routing::{get, post},
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

fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
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
        "mcpEnabled": false,
    }))
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
        Ok(Self {
            listener,
            connection_lifetime: Duration::from_secs(60),
            connections: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            state: ApiState {
                app,
                bearer: Arc::new(bearer),
                _credentials: Arc::new(credentials),
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
            .layer(middleware::from_fn_with_state(
                self.state.clone(),
                authorize,
            ))
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
                            if matches!(error.kind(), std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::Interrupted) { continue; }
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
            let task = tokio::spawn(server.run());
            Self {
                directory,
                app,
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
}
