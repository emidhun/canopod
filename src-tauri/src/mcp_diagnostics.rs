//! Public-field diagnostics with bounded pages and explicit snapshot consistency.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ServicesArgs {
    repo_id: String,
    worktree_key: String,
    #[serde(default)]
    cursor: usize,
    #[serde(default = "default_limit")]
    limit: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LogsArgs {
    repo_id: String,
    service_key: String,
    snapshot: Option<String>,
    #[serde(default)]
    cursor: usize,
    #[serde(default = "default_limit")]
    limit: usize,
}
pub(super) fn services(
    controller: &Controller,
    generation: &CancellationToken,
    args: ServicesArgs,
) -> Result<serde_json::Value, String> {
    controller.authorized_repo(generation, &args.repo_id, false)?;
    if !(1..=100).contains(&args.limit) || args.worktree_key.len() > 4096 {
        return Err("invalid_arguments".into());
    }
    let tree = controller.app.state::<AppState>().tree.read();
    let wt = tree
        .iter()
        .find(|r| r.repo_id == args.repo_id)
        .and_then(|r| r.worktrees.iter().find(|w| w.wt_key == args.worktree_key))
        .ok_or("worktree_not_found")?;
    let mut entries = Vec::new();
    let mut bytes = 0;
    let mut next = None;
    for (index, svc) in wt.services.iter().enumerate().skip(args.cursor) {
        let entry = serde_json::json!({"serviceKey":svc.svc_key,"serviceId":svc.service_id,"name":svc.name,"kind":svc.kind,"status":svc.status,"port":svc.port});
        let size = serde_json::to_vec(&entry)
            .map_err(|_| "encoding_failed")?
            .len();
        if size > 12 * 1024 {
            return Err("service_metadata_too_large".into());
        }
        if entries.len() >= args.limit || bytes + size > 12 * 1024 {
            next = Some(index);
            break;
        }
        bytes += size + 1;
        entries.push(entry);
    }
    Ok(serde_json::json!({"source":"cache","services":entries,"nextCursor":next}))
}
pub(super) async fn logs(
    controller: Arc<Controller>,
    generation: CancellationToken,
    args: LogsArgs,
) -> Result<serde_json::Value, String> {
    if !(1..=100).contains(&args.limit)
        || args.service_key.len() > 4096
        || args
            .snapshot
            .as_ref()
            .is_some_and(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("invalid_arguments".into());
    }
    let repo = controller.authorized_repo(&generation, &args.repo_id, false)?;
    let (wt, cfg) = {
        let tree = controller.app.state::<AppState>().tree.read();
        let wt = tree
            .iter()
            .find(|r| r.repo_id == args.repo_id)
            .and_then(|r| {
                r.worktrees
                    .iter()
                    .find(|w| w.services.iter().any(|s| s.svc_key == args.service_key))
            })
            .ok_or("service_not_found")?;
        let id = &wt
            .services
            .iter()
            .find(|s| s.svc_key == args.service_key)
            .unwrap()
            .service_id;
        let cfg = repo
            .services
            .iter()
            .find(|s| &s.id == id)
            .cloned()
            .ok_or("service_not_found")?;
        (wt.path.clone(), cfg)
    };
    let owned = controller.clone();
    let filter = tokio::task::spawn_blocking(move || {
        let cwd = Path::new(&wt).join(&cfg.cwd);
        crate::jobs::capture::secret_filter(
            &owned.app,
            &repo.path,
            &wt,
            &cwd.to_string_lossy(),
            &cfg.env,
        )
    })
    .await
    .map_err(|_| "secret_filter_unavailable")??;
    // Revocation while gathering secret sources cannot publish a page.
    controller.authorized_repo(&generation, &args.repo_id, false)?;
    let lines = controller
        .app
        .state::<crate::services::ProcTable>()
        .logs
        .lock()
        .get(&args.service_key)
        .cloned()
        .unwrap_or_default();
    let lines: Vec<_> = lines.iter().map(|line| {
        let oversized = line.text.ends_with(" [line truncated]");
        let (text, truncated) = filter.text(if oversized { "[oversized output omitted]" } else { &line.text });
        serde_json::json!({"time":line.t,"level":line.lv,"text":text,"truncated":truncated || line.text.ends_with(" [line truncated]")})
    }).collect();
    let snapshot = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&lines).map_err(|_| "encoding_failed")?)
    );
    if args.snapshot.as_ref().is_some_and(|s| *s != snapshot) {
        return Err("snapshot_changed".into());
    }
    if args.cursor > lines.len() || (args.cursor > 0 && args.snapshot.is_none()) {
        return Err("invalid_cursor".into());
    }
    let mut bytes = 0;
    let page: Vec<_> = lines
        .iter()
        .skip(args.cursor)
        .take(args.limit)
        .take_while(|line| {
            bytes += line.to_string().len() + 1;
            bytes <= 12 * 1024
        })
        .cloned()
        .collect();
    let next = args.cursor + page.len();
    Ok(
        serde_json::json!({"source":"memory","snapshot":snapshot,"lines":page,"nextCursor":next,"hasMore":next<lines.len(),
        "retainedLines":lines.len(),"historyComplete":false}),
    )
}
