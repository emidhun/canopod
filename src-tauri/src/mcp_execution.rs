//! Owned MCP worktree jobs. HTTP cancellation never abandons accepted work.
//! Graceful host shutdown interrupts subprocesses, checkpoints partial creation,
//! then drains the journal before runtime ownership and child cleanup end.
use super::*;
use crate::jobs::{self, Outcome, Registry, SecretFilter, Status, Submission};
use tokio::sync::oneshot;
use tokio_util::task::TaskTracker;

fn yes() -> bool {
    true
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CreateArgs {
    pub repo_id: String,
    pub branch: String,
    pub base: Option<String>,
    #[serde(default = "yes")]
    pub create_branch: bool,
    #[serde(skip_serializing)]
    pub request_key: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SetupArgs {
    pub repo_id: String,
    pub worktree_key: String,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(skip_serializing)]
    pub request_key: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ServiceArgs {
    pub repo_id: String,
    pub service_key: String,
    #[serde(skip_serializing)]
    pub request_key: String,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ServiceAction {
    Start,
    Stop,
    Restart,
}
#[derive(Clone, Serialize)]
#[serde(tag = "operation", content = "arguments", rename_all = "snake_case")]
pub(super) enum Request {
    Create(CreateArgs),
    Setup(SetupArgs),
    Service(ServiceArgs, ServiceAction),
}
impl Request {
    fn repo_id(&self) -> &str {
        match self {
            Self::Create(a) => &a.repo_id,
            Self::Setup(a) => &a.repo_id,
            Self::Service(a, _) => &a.repo_id,
        }
    }
    fn request_key(&self) -> &str {
        match self {
            Self::Create(a) => &a.request_key,
            Self::Setup(a) => &a.request_key,
            Self::Service(a, _) => &a.request_key,
        }
    }
    fn operation(&self) -> jobs::Operation {
        match self {
            Self::Create(_) => jobs::Operation::Create,
            Self::Setup(_) => jobs::Operation::Setup,
            Self::Service(_, ServiceAction::Start) => jobs::Operation::ServiceStart,
            Self::Service(_, ServiceAction::Stop) => jobs::Operation::ServiceStop,
            Self::Service(_, ServiceAction::Restart) => jobs::Operation::ServiceRestart,
        }
    }
    fn target(&self, repo: &crate::settings::RepoCfg) -> String {
        match self {
            Self::Create(a) => crate::operations::derive_worktree_path(repo, &a.branch),
            Self::Setup(a) => a.worktree_key.clone(),
            Self::Service(a, _) => a.service_key.clone(),
        }
    }
    fn authorize(
        &self,
        controller: &Controller,
        generation: &CancellationToken,
    ) -> Result<crate::settings::RepoCfg, String> {
        let repo = controller.authorized_repo(
            generation,
            self.repo_id(),
            !matches!(self, Self::Service(..)),
        )?;
        if matches!(self, Self::Service(..)) {
            if generation.is_cancelled() {
                return Err("authorization_changed".into());
            }
            if !controller.live.read().policy.allow_service_control {
                return Err("service_control_not_allowed".into());
            }
            let binding = controller
                .live
                .read()
                .policy
                .repo_bindings
                .get(self.repo_id())
                .cloned()
                .ok_or("repo_not_allowed")?;
            if std::fs::canonicalize(&repo.path).ok().as_deref()
                != Some(Path::new(&binding.canonical_path))
            {
                return Err("repo_path_changed".into());
            }
        }
        Ok(repo)
    }
    fn validate(&self) -> bool {
        let bounded = |s: &str, max: usize| {
            !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)
        };
        let git_ref = |s: &str| bounded(s, 256) && !s.starts_with('-');
        bounded(self.repo_id(), 256)
            && bounded(self.request_key(), 256)
            && match self {
                Self::Create(a) => git_ref(&a.branch) && a.base.as_deref().is_none_or(git_ref),
                Self::Setup(a) => bounded(&a.worktree_key, 4096),
                Self::Service(a, _) => bounded(&a.service_key, 4096),
            }
    }
}

pub(super) struct Executor {
    registry: Option<Arc<Registry>>,
    pub error: Option<String>,
    closed: Mutex<bool>,
    slots: Arc<Semaphore>,
    tasks: TaskTracker,
}
impl Executor {
    pub fn open(data: &Path) -> Self {
        let (registry, error) = match Registry::open(data) {
            Ok(registry) => (Some(registry), None),
            Err(error) => (None, Some(error.to_string())),
        };
        Self {
            registry,
            error,
            closed: Mutex::new(false),
            slots: Arc::new(Semaphore::new(8)),
            tasks: TaskTracker::new(),
        }
    }
    pub async fn drain(&self) {
        {
            *self.closed.lock() = true;
            self.tasks.close();
        }
        self.tasks.wait().await;
        if let Some(registry) = &self.registry {
            registry.close().await;
        }
    }
    pub async fn submit(
        controller: Arc<Controller>,
        generation: CancellationToken,
        request: Request,
    ) -> Result<serde_json::Value, String> {
        if !request.validate() {
            return Err("invalid_arguments".into());
        }
        request.authorize(&controller, &generation)?;
        let registry = controller
            .execution
            .registry
            .clone()
            .ok_or("job_journal_unavailable")?;
        let permit = controller
            .execution
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "busy")?;
        let (send, receive) = oneshot::channel();
        {
            let closed = controller.execution.closed.lock();
            if *closed || controller.shutdown.is_cancelled() {
                return Err("stopping".into());
            }
            let owned = controller.clone();
            controller.execution.tasks.spawn(async move {
                let _permit = permit;
                run(owned, generation, request, registry, send).await;
            });
        }
        receive
            .await
            .map_err(|_| "job_admission_failed".to_owned())?
    }
    pub fn output(
        &self,
        repo_id: &str,
        id: &str,
        cursor: Option<u64>,
        limit: usize,
    ) -> Result<serde_json::Value, String> {
        self.get(repo_id, id)?;
        let registry = self.registry.as_ref().ok_or("job_journal_unavailable")?;
        let view = registry.get(id).map_err(|_| "job_not_found")?;
        let cursor = match cursor {
            Some(cursor) => cursor,
            None => registry.earliest_cursor(id).map_err(|e| e.code)?,
        };
        let mut page = registry
            .output(id, cursor, limit)
            .map_err(|e| e.code.to_owned())?;
        let mut bytes = 0;
        let original_next = page.next_cursor;
        let mut lines = Vec::new();
        for mut line in page.lines {
            let mut size = serde_json::to_vec(&line)
                .map_err(|_| "encoding_failed")?
                .len();
            if size > 12 * 1024 {
                line.text = "[line omitted: encoded output exceeds page budget]".into();
                page.output_complete = false;
                size = serde_json::to_vec(&line)
                    .map_err(|_| "encoding_failed")?
                    .len();
            }
            if bytes + size > 12 * 1024 {
                break;
            }
            bytes += size + 1;
            lines.push(line);
        }
        page.next_cursor = lines.last().map(|line| line.sequence + 1).unwrap_or(cursor);
        page.has_more |= page.next_cursor < original_next;
        page.lines = lines;
        Ok(
            serde_json::json!({"jobId":id,"output":page,"persistedSequence":view.persisted_sequence,
            "persistencePending":view.persistence_pending,"durabilityError":view.durability_error.as_ref().map(|_|"journal_write_failed")}),
        )
    }
    pub fn get(&self, repo_id: &str, id: &str) -> Result<serde_json::Value, String> {
        if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid_arguments".into());
        }
        let view = self
            .registry
            .as_ref()
            .ok_or("job_journal_unavailable")?
            .get(id)
            .map_err(|_| "job_not_found")?;
        if view.record.repo_id != repo_id
            || !matches!(
                view.record.operation,
                jobs::Operation::Create
                    | jobs::Operation::Setup
                    | jobs::Operation::ServiceStart
                    | jobs::Operation::ServiceStop
                    | jobs::Operation::ServiceRestart
            )
        {
            return Err("job_not_found".into());
        }
        Ok(project(&view))
    }
}
fn project(view: &jobs::View) -> serde_json::Value {
    // No commands, environment, raw output or arbitrary outcome details cross
    // this boundary. Paths are restricted to the caller's allowlisted repo.
    serde_json::json!({"jobId":view.record.id,"repoId":view.record.repo_id,"operation":view.record.operation,
        "status":view.record.status,"target":view.record.target,"worktreeKey": if matches!(view.record.operation,jobs::Operation::Create|jobs::Operation::Setup) {Some(&view.record.target)} else {None},"serviceKey": if matches!(view.record.operation,jobs::Operation::ServiceStart|jobs::Operation::ServiceStop|jobs::Operation::ServiceRestart) {Some(&view.record.target)} else {None},"createdPath":view.record.outcome.created_path,
        "createdAtMs":view.record.created_at_ms,"startedAtMs":view.record.started_at_ms,"finishedAtMs":view.record.finished_at_ms,
        "persistencePending":view.persistence_pending,"durabilityError":view.durability_error.as_ref().map(|_| "journal_write_failed"),
        "error":view.record.outcome.error.as_ref().map(|error| &error.code)})
}
async fn run(
    controller: Arc<Controller>,
    generation: CancellationToken,
    request: Request,
    registry: Arc<Registry>,
    send: oneshot::Sender<Result<serde_json::Value, String>>,
) {
    let repo = match request.authorize(&controller, &generation) {
        Ok(repo) => repo,
        Err(error) => {
            let _ = send.send(Err(error));
            return;
        }
    };
    let target = request.target(&repo);
    let admission = registry
        .admit(Submission {
            operation: request.operation(),
            repo_id: request.repo_id().into(),
            target: target.clone(),
            request_key: request.request_key().into(),
            payload: serde_json::to_value(&request).expect("bounded MCP request"),
        })
        .await;
    let admission = match admission {
        Ok(admission) => admission,
        Err(error) => {
            let _ = send.send(Err(error.code.into()));
            return;
        }
    };
    let id = admission.job.record.id.clone();
    let _ = send.send(Ok(
        serde_json::json!({"job":project(&admission.job),"reused":admission.reused}),
    ));
    if admission.reused {
        return;
    }
    let result = if registry.start(&id).await.is_err() {
        Err("journal_write_failed".to_owned())
    } else {
        let owned = controller.clone();
        let tracking = jobs::Tracking {
            registry: registry.clone(),
            id: id.clone(),
        };
        // Catch panics at the operation boundary; its process guards clean up
        // before the parent commits a failed outcome. A client cannot abort it.
        let flush_done = CancellationToken::new();
        let flusher = tokio::spawn(jobs::capture::flush_until(
            registry.clone(),
            id.clone(),
            flush_done.clone(),
        ));
        let result = tokio::spawn(jobs::capture::scope(
            tracking.clone(),
            jobs::with_cancellation(
                controller.app.clone(),
                controller.shutdown.clone(),
                async move {
                    let repo = request.authorize(&owned, &generation)?;
                    if request.target(&repo) != target {
                        return Err("repository_changed".into());
                    }
                    match request {
                        Request::Service(args, action) => {
                            let (wt, repo_id, repo_path) = owned
                                .app
                                .state::<AppState>()
                                .service_context(&args.service_key)
                                .ok_or("service_not_found")?;
                            if repo_id != args.repo_id || repo_path != repo.path {
                                return Err("service_not_allowed".into());
                            }
                            let worktrees = crate::git::list_worktrees(&repo.path)
                                .await
                                .map_err(|_| "worktree_lookup_failed")?;
                            if !worktrees.iter().any(|w| !w.prunable && w.path == wt) {
                                return Err("worktree_not_allowed".into());
                            }
                            Request::Service(args.clone(), action)
                                .authorize(&owned, &generation)?;
                            match action {
                                ServiceAction::Start => {
                                    crate::operations::service_start(
                                        owned.app.clone(),
                                        args.service_key,
                                    )
                                    .await
                                }
                                ServiceAction::Stop => {
                                    crate::operations::service_stop(
                                        owned.app.clone(),
                                        args.service_key,
                                    )
                                    .await
                                }
                                ServiceAction::Restart => {
                                    crate::operations::service_restart(
                                        owned.app.clone(),
                                        args.service_key,
                                    )
                                    .await
                                }
                            }
                        }
                        Request::Create(args) => {
                            crate::git::run_git(
                                &repo.path,
                                &["check-ref-format", "--branch", &args.branch],
                            )
                            .await
                            .map_err(|_| "invalid_branch")?;
                            owned.authorized_repo(&generation, &args.repo_id, true)?;
                            crate::operations::create_worktree_for_repo(
                                owned.app.clone(),
                                repo,
                                args.branch,
                                args.base,
                                args.create_branch,
                                Some(tracking),
                            )
                            .await
                            .map(|_| ())
                        }
                        Request::Setup(args) => {
                            let worktrees = crate::git::list_worktrees(&repo.path)
                                .await
                                .map_err(|_| "worktree_lookup_failed")?;
                            let canonical = std::fs::canonicalize(&args.worktree_key)
                                .map_err(|_| "worktree_not_found")?;
                            if !worktrees.iter().any(|w| {
                                !w.is_main
                                    && !w.prunable
                                    && std::fs::canonicalize(&w.path).ok().as_deref()
                                        == Some(canonical.as_path())
                            }) {
                                return Err("worktree_not_allowed".into());
                            }
                            let context = owned
                                .app
                                .state::<AppState>()
                                .wt_context(&args.worktree_key)
                                .ok_or("worktree_not_found")?;
                            if context.is_main
                                || context.repo_id != args.repo_id
                                || context.repo_path != repo.path
                            {
                                return Err("worktree_not_allowed".into());
                            }
                            owned.authorized_repo(&generation, &args.repo_id, true)?;
                            crate::operations::run_worktree_setup(
                                owned.app.clone(),
                                args.worktree_key,
                                args.dry_run,
                            )
                            .await
                        }
                    }
                    .map_err(|error| match error.code {
                        crate::error::ErrorCode::Conflict => "worktree_busy_or_exists".to_owned(),
                        crate::error::ErrorCode::Setup => "setup_failed".to_owned(),
                        crate::error::ErrorCode::Git => "git_failed".to_owned(),
                        crate::error::ErrorCode::InvalidInput => "invalid_input".to_owned(),
                        _ => "operation_failed".to_owned(),
                    })
                },
            ),
        ))
        .await
        .unwrap_or_else(|_| Err("worktree_operation_panicked".into()));
        flush_done.cancel();
        let _ = flusher.await;
        result
    };
    let (status, outcome) = match result {
        Ok(()) => (Status::Succeeded, Outcome::default()),
        Err(code) => {
            let interrupted = controller.shutdown.is_cancelled();
            (
                if interrupted {
                    Status::Interrupted
                } else {
                    Status::Failed
                },
                Outcome {
                    error: Some(jobs::Failure {
                        code: if interrupted {
                            "interrupted".into()
                        } else {
                            code
                        },
                        message: "Worktree operation did not complete; check Canopy for details"
                            .into(),
                    }),
                    ..Default::default()
                },
            )
        }
    };
    if let Err(error) = registry
        .finish(&id, status, outcome, &SecretFilter::default())
        .await
    {
        log::error!("MCP job {id} completion persistence failed: {error}");
    }
}

impl Controller {
    pub(super) fn authorized_repo(
        &self,
        generation: &CancellationToken,
        repo_id: &str,
        execute: bool,
    ) -> Result<crate::settings::RepoCfg, String> {
        if repo_id.is_empty() || repo_id.len() > 256 {
            return Err("invalid_arguments".into());
        }
        let live = self.live.read();
        if self.shutdown.is_cancelled() {
            return Err("stopping".into());
        }
        if generation.is_cancelled() || !live.policy.enabled || live.fault.is_some() {
            return Err("authorization_changed".into());
        }
        if execute && !live.policy.allow_worktree_write {
            return Err("worktree_write_not_allowed".into());
        }
        if !live.policy.repo_ids.iter().any(|id| id == repo_id) {
            return Err("repo_not_allowed".into());
        }
        let repo = self
            .app
            .state::<AppState>()
            .settings
            .read()
            .repos
            .iter()
            .find(|r| r.id == repo_id)
            .cloned()
            .ok_or("repo_not_found")?;
        let binding = live
            .policy
            .repo_bindings
            .get(repo_id)
            .ok_or("repo_not_allowed")?;
        if binding.registered_path != repo.path {
            return Err("repo_not_allowed".into());
        }
        if execute
            && std::fs::canonicalize(&repo.path).ok().as_deref()
                != Some(Path::new(&binding.canonical_path))
        {
            return Err("repo_path_changed".into());
        }
        Ok(repo)
    }
}

pub(super) fn worktrees(
    controller: &Controller,
    generation: &CancellationToken,
    repo_id: &str,
    cursor: usize,
    limit: usize,
) -> Result<serde_json::Value, String> {
    if !(1..=100).contains(&limit) {
        return Err("invalid_arguments".into());
    }
    controller.authorized_repo(generation, repo_id, false)?;
    let tree = controller.app.state::<AppState>().tree.read();
    let repo = tree.iter().find(|r| r.repo_id == repo_id);
    let mut entries = Vec::new();
    let mut bytes = 0;
    let mut next = None;
    if let Some(repo) = repo {
        for (index, wt) in repo.worktrees.iter().enumerate().skip(cursor) {
            let entry = serde_json::json!({"worktreeKey":wt.wt_key,"branch":wt.branch,"isMain":wt.is_main,"setupConfigured":wt.setup_configured});
            let size = entry.to_string().len();
            if size > 12 * 1024 {
                return Err("worktree_metadata_too_large".into());
            }
            if entries.len() >= limit || bytes + size > 12 * 1024 {
                next = Some(index);
                break;
            }
            bytes += size + 1;
            entries.push(entry);
        }
    }
    Ok(
        serde_json::json!({"repoId":repo_id,"source":"cache","cacheAvailable":repo.is_some(),"worktrees":entries,"nextCursor":next}),
    )
}
