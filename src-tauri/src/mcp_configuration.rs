//! Revision-checked, stable-ID configuration patches. No whole-settings MCP save.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReadArgs {
    repo_id: String,
    #[serde(default)]
    cursor: usize,
    #[serde(default = "default_limit")]
    limit: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PatchArgs {
    repo_id: String,
    revision: String,
    #[serde(default)]
    repository: serde_json::Map<String, serde_json::Value>,
    service_id: Option<String>,
    #[serde(default)]
    service: serde_json::Map<String, serde_json::Value>,
}
pub(super) async fn read(
    controller: Arc<Controller>,
    generation: CancellationToken,
    args: ReadArgs,
) -> Result<serde_json::Value, String> {
    if !(1..=100).contains(&args.limit) {
        return Err("invalid_arguments".into());
    }
    controller.authorized_repo(&generation, &args.repo_id, false)?;
    let owned = controller.clone();
    tokio::task::spawn_blocking(move || crate::settings_store::ensure_current(&owned.app))
        .await
        .map_err(|_| "configuration_unavailable")?
        .map_err(|_| "external_settings_changed")?;
    controller.authorized_repo(&generation, &args.repo_id, false)?;
    let settings = controller.app.state::<AppState>().settings.read();
    let repo = settings
        .repos
        .iter()
        .find(|r| r.id == args.repo_id)
        .ok_or("repo_not_found")?;
    let mut response = serde_json::json!({"revision":settings.revision,"repository":{"id":repo.id,"name":repo.name,"path":repo.path,
        "worktreeDir":repo.worktree_dir,"defaultBase":repo.default_base,"worktreeDefaults":repo.worktree_defaults},"services":[],"nextCursor":null});
    let mut bytes = response.to_string().len();
    if bytes > 12 * 1024 {
        return Err("configuration_metadata_too_large".into());
    }
    let mut services = Vec::new();
    for (index, service) in repo.services.iter().enumerate().skip(args.cursor) {
        let mut keys: Vec<_> = service.env.keys().collect();
        keys.sort();
        let entry = serde_json::json!({"id":service.id,"name":service.name,"kind":service.kind,"cwd":service.cwd,"basePort":service.base_port,
            "health":service.health,"commandConfigured":!service.command.is_empty(),"environmentKeys":keys});
        let size = entry.to_string().len();
        if size > 10 * 1024 {
            return Err("configuration_metadata_too_large".into());
        }
        if services.is_empty() && bytes + size > 12 * 1024 {
            return Err("configuration_metadata_too_large".into());
        }
        if services.len() >= args.limit || bytes + size > 12 * 1024 {
            response["nextCursor"] = index.into();
            break;
        }
        bytes += size + 1;
        services.push(entry);
    }
    response["services"] = services.into();
    Ok(response)
}
fn validate(
    fields: &serde_json::Map<String, serde_json::Value>,
    service: bool,
) -> Result<(), String> {
    for (key, value) in fields {
        match key.as_str() {
            "name" | "kind" | "command" | "cwd" | "health" if service => {
                let value = value.as_str().ok_or("invalid_arguments")?;
                if value.len() > 8192 || value.contains('\0') {
                    return Err("invalid_arguments".into());
                }
            }
            "name" | "defaultBase" | "worktreeDir" if !service => {
                let value = value.as_str().ok_or("invalid_arguments")?;
                if value.len() > 4096 || value.chars().any(char::is_control) {
                    return Err("invalid_arguments".into());
                }
            }
            "basePort" if service => {
                if !value.is_null() && !value.as_u64().is_some_and(|p| (1..=65535).contains(&p)) {
                    return Err("invalid_arguments".into());
                }
            }
            "worktreeDefaults" if !service => {
                let object = value.as_object().ok_or("invalid_arguments")?;
                if object.keys().any(|key| {
                    !matches!(
                        key.as_str(),
                        "runSetup" | "startServices" | "isolatedDatabase"
                    )
                }) || object.values().any(|v| !v.is_boolean())
                {
                    return Err("invalid_arguments".into());
                }
            }
            _ => return Err("unsupported_configuration_field".into()),
        }
    }
    Ok(())
}
fn patch<T: Serialize + serde::de::DeserializeOwned>(
    value: &T,
    fields: &serde_json::Map<String, serde_json::Value>,
) -> Result<T, String> {
    let mut next = serde_json::to_value(value).map_err(|_| "invalid_arguments")?;
    for (key, value) in fields {
        if key == "worktreeDefaults" {
            for (name, setting) in value.as_object().ok_or("invalid_arguments")? {
                next[key][name] = setting.clone();
            }
        } else {
            next[key] = value.clone();
        }
    }
    serde_json::from_value(next).map_err(|_| "invalid_arguments".into())
}
pub(super) async fn update(
    controller: Arc<Controller>,
    generation: CancellationToken,
    args: PatchArgs,
) -> Result<serde_json::Value, String> {
    if args.revision.len() != 64
        || args.repository.is_empty() && args.service.is_empty()
        || args.service.is_empty() != args.service_id.is_none()
    {
        return Err("invalid_arguments".into());
    }
    validate(&args.repository, false)?;
    validate(&args.service, true)?;
    controller.authorized_repo(&generation, &args.repo_id, false)?;
    let result=tokio::task::spawn_blocking(move || {
        let repo=controller.authorized_repo(&generation,&args.repo_id,false)?;
        let live=controller.live.read();
        if generation.is_cancelled() || controller.shutdown.is_cancelled() { return Err("authorization_changed".into()); }
        if !live.policy.allow_configuration { return Err("configuration_not_allowed".into()); }
        let binding=live.policy.repo_bindings.get(&args.repo_id).ok_or("repo_not_allowed")?;
        if std::fs::canonicalize(&repo.path).ok().as_deref()!=Some(Path::new(&binding.canonical_path)) { return Err("repo_path_changed".into()); }
        let keys:Vec<_>=controller.app.state::<AppState>().tree.read().iter().filter(|r|r.repo_id==args.repo_id)
            .flat_map(|r|r.worktrees.iter().map(|w|w.wt_key.clone())).collect();
        let _leases=keys.iter().map(|key|crate::state::try_lease(&controller.app,key,"configuration")).collect::<Result<Vec<_>,_>>().map_err(|_|"worktree_busy")?;
        let (saved,())=crate::settings_store::mutate(&controller.app,Some(&args.revision),|settings| {
            let current=settings.repos.iter_mut().find(|r|r.id==args.repo_id && r.path==repo.path).ok_or("repo_not_found")?;
            *current=patch(current,&args.repository)?;
            if let Some(id)=&args.service_id {
                let service=current.services.iter_mut().find(|s|&s.id==id).ok_or("service_not_found")?;
                *service=patch(service,&args.service)?;
            }
            Ok(())
        }).map_err(|message| if message.contains("changed on disk") {"external_settings_changed"} else if message.contains("Settings changed") {"revision_conflict"} else {"configuration_save_failed"}.to_owned())?;
        // The committed configuration is authoritative. Refresh asynchronously;
        // a disconnect cannot cancel disk publication or this scheduling.
        let app=controller.app.clone();
        controller.app.executor().spawn(async move { let _=crate::state::refresh_tree(&app).await; });
        Ok(serde_json::json!({"repoId":args.repo_id,"revision":saved.revision,"applied":true,"runningServicesRestarted":false}))
    }).await.map_err(|_|"configuration_save_failed")?;
    result
}
