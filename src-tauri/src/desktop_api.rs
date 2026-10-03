//! Network lifecycle for the embedded desktop runtime.
use crate::{app_api, runtime::RuntimeContext};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::{sync::watch, task::JoinHandle};

pub(crate) struct DesktopApi {
    pub(crate) mcp: Arc<crate::mcp::Controller>,
    stop: watch::Sender<bool>,
    closing: Arc<AtomicBool>,
    task: parking_lot::Mutex<Option<JoinHandle<()>>>,
}

impl DesktopApi {
    pub(crate) async fn start(
        app: RuntimeContext,
        on_stopped: impl FnOnce(Result<(), String>) + Send + 'static,
    ) -> Result<Self, String> {
        let config = app_api::Config::load(&app.path().config)?;
        let (stop, _) = watch::channel(false);
        let server = app_api::Server::bind(app, config.port, stop.clone()).await?;
        log::info!("desktop API listening at http://127.0.0.1:{}", config.port);
        Ok(Self::spawn(server, stop, on_stopped))
    }

    fn spawn(
        server: app_api::Server,
        stop: watch::Sender<bool>,
        on_stopped: impl FnOnce(Result<(), String>) + Send + 'static,
    ) -> Self {
        let mcp = server.mcp();
        let closing = Arc::new(AtomicBool::new(false));
        let task_closing = closing.clone();
        let task = tokio::spawn(async move {
            let result = server.run().await;
            // An authenticated API stop also quits the GUI and triggers its
            // normal child cleanup. A native quit is already doing that.
            if !task_closing.load(Ordering::Acquire) {
                on_stopped(result);
            }
        });
        Self {
            mcp,
            stop,
            closing,
            task: parking_lot::Mutex::new(Some(task)),
        }
    }

    pub(crate) async fn shutdown(&self) {
        self.closing.store(true, Ordering::Release);
        self.stop.send_replace(true);
        let task = self.task.lock().take();
        if let Some(task) = task {
            if let Err(error) = task.await {
                log::error!("desktop API task failed: {error}");
            }
        }
    }
}

impl Drop for DesktopApi {
    fn drop(&mut self) {
        self.closing.store(true, Ordering::Release);
        self.stop.send_replace(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        credentials::{CredentialKind, CredentialStore},
        state::AppState,
    };
    use std::time::Duration;

    async fn fixture() -> (
        tempfile::TempDir,
        RuntimeContext,
        String,
        reqwest::Client,
        app_api::Server,
        watch::Sender<bool>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let paths = crate::runtime::RuntimePaths {
            config: directory.path().into(),
            data: directory.path().into(),
            logs: directory.path().into(),
        };
        let app = crate::backend::open(paths).unwrap();
        let reservation = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = reservation.local_addr().unwrap().port();
        app_api::Config { port }.save(directory.path()).unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let (stop, _) = watch::channel(false);
        let server =
            app_api::Server::from_listener(app.clone(), reservation, stop.clone()).unwrap();
        (
            directory,
            app,
            format!("http://127.0.0.1:{port}"),
            client,
            server,
            stop,
        )
    }

    fn credential(app: &RuntimeContext, kind: CredentialKind) -> crate::credentials::Bearer {
        CredentialStore::open_existing(&app.path().data)
            .unwrap()
            .load(kind)
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn desktop_mcp_shares_live_state_and_survives_restart() {
        let (_directory, app, origin, client, network, stop) = fixture().await;
        let exited = Arc::new(AtomicBool::new(false));
        let callback_exited = exited.clone();
        let server = DesktopApi::spawn(network, stop, move |_| {
            callback_exited.store(true, Ordering::Release);
        });
        let application = credential(&app, CredentialKind::Application);
        let status = client
            .get(format!("{origin}/api/v1/mcp/status"))
            .bearer_auth(application.expose())
            .header("x-canopy-api-version", "1")
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(status["enabled"], false);
        assert!(server.mcp.connection().is_err());
        // Model a repository added in the GUI after the server started.
        app.state::<AppState>()
            .settings
            .write()
            .repos
            .push(crate::settings::RepoCfg {
                id: "desktop-repo".into(),
                path: app.path().data.to_string_lossy().into_owned(),
                ..Default::default()
            });
        let response = client
            .post(format!("{origin}/api/v1/mcp/enable"))
            .bearer_auth(application.expose())
            .header("x-canopy-api-version", "1")
            .json(&serde_json::json!({"repoIds": ["desktop-repo"]}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let mcp = credential(&app, CredentialKind::Mcp);
        let exported = server.mcp.connection().unwrap();
        assert_eq!(exported["token"], mcp.expose());
        assert_eq!(exported["endpoint"], format!("{origin}/mcp"));
        assert!(!server.mcp.status().to_string().contains(mcp.expose()));
        {
            let response = client
                .post(format!("{origin}/mcp"))
                .bearer_auth(mcp.expose())
                .header("accept", "application/json, text/event-stream")
                .header("mcp-protocol-version", "2025-03-26")
                .json(
                    &serde_json::json!({"jsonrpc":"2.0", "id":1, "method":"tools/call",
                    "params":{"name":"canopy_status", "arguments":{"repoId":"desktop-repo"}}}),
                )
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::OK);
            let body: serde_json::Value = response.json().await.unwrap();
            assert_eq!(body["result"]["isError"], false);
            let result: serde_json::Value =
                serde_json::from_str(body["result"]["content"][0]["text"].as_str().unwrap())
                    .unwrap();
            assert_eq!(result["repoId"], "desktop-repo");
            assert_eq!(server.mcp.status()["allowWorktreeWrite"], false);
            server.mcp.configure_capabilities(true, None, Some(true), Some(true), Some(true)).await.unwrap();
            server.shutdown().await;
            assert!(!exited.load(Ordering::Acquire));
        }
        let callback_exited = exited.clone();
        // Other parallel tests can claim the old ephemeral port after shutdown.
        // Keep the restarted listener reserved instead of probing and rebinding.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let (stop, _) = watch::channel(false);
        let network = app_api::Server::from_listener(app.clone(), listener, stop.clone()).unwrap();
        let restarted = DesktopApi::spawn(network, stop, move |_| {
            callback_exited.store(true, Ordering::Release);
        });
        assert!(credential(&app, CredentialKind::Mcp).matches(mcp.expose()));
        assert_eq!(restarted.mcp.status()["allowWorktreeWrite"], true);
        assert_eq!(restarted.mcp.status()["allowServiceControl"], true);
        assert_eq!(restarted.mcp.status()["allowConfiguration"], true);
        let response = client
            .post(format!("{origin}/mcp"))
            .bearer_auth(mcp.expose())
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-03-26")
            .json(&serde_json::json!({"jsonrpc":"2.0", "id":2, "method":"tools/list", "params":{}}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        restarted.mcp.rotate().await.unwrap();
        let rotated = credential(&app, CredentialKind::Mcp);
        assert!(!rotated.matches(mcp.expose()));
        assert_eq!(
            restarted.mcp.connection().unwrap()["token"],
            rotated.expose()
        );
        restarted.mcp.configure(false, None).await.unwrap();
        assert!(restarted.mcp.connection().is_err());
        restarted.shutdown().await;
        assert!(!exited.load(Ordering::Acquire));
        assert!(client.get(format!("{origin}/mcp")).send().await.is_err());
    }

    #[tokio::test]
    async fn authenticated_stop_requests_desktop_exit() {
        let (_directory, app, origin, client, network, stop) = fixture().await;
        let (send, receive) = tokio::sync::oneshot::channel();
        let server = DesktopApi::spawn(network, stop, move |result| {
            let _ = send.send(result);
        });
        let response = client
            .post(format!("{origin}/api/v1/stop"))
            .bearer_auth(credential(&app, CredentialKind::Application).expose())
            .header("x-canopy-api-version", "1")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
        tokio::time::timeout(Duration::from_secs(5), receive)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        server.shutdown().await;
    }
}
