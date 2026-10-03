//! One ordered settings writer, shared by native UI and MCP.
use crate::{runtime::RuntimeContext, settings::Settings, state::AppState};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::Path,
};

const MAX_SETTINGS_BYTES: usize = 4 * 1024 * 1024;
fn read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Read settings: {e}")),
    };
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Settings must be a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_SETTINGS_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        return Err("Settings exceed 4 MiB".into());
    }
    Ok(Some(bytes))
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn disk_revision(path: &Path) -> Result<Option<String>, String> {
    Ok(read(path)?.map(|b| hash(&b)))
}
pub(crate) fn initial_disk_revision(path: &Path, settings: &Settings) -> Result<Option<String>, String> {
    let Some(bytes)=read(path)? else { return Ok(None); };
    let disk:Settings=serde_json::from_slice(&bytes).map_err(|e|format!("Read settings: {e}"))?;
    let mut loaded=serde_json::to_value(&disk).map_err(|e|e.to_string())?;
    let mut memory=serde_json::to_value(settings).map_err(|e|e.to_string())?;
    loaded.as_object_mut().unwrap().remove("revision");
    memory.as_object_mut().unwrap().remove("revision");
    if loaded!=memory { return Err("Settings changed during startup; restart Canopod".into()); }
    Ok(Some(hash(&bytes)))
}
pub(crate) fn revision(_settings: &Settings) -> String {
    let mut nonce = [0u8; 32];
    getrandom::fill(&mut nonce).expect("OS randomness required for settings revisions");
    hash(&nonce)
}
pub(crate) fn ensure_current(app: &RuntimeContext) -> Result<(), String> {
    let expected = app.state::<AppState>().settings_disk.lock();
    let actual = disk_revision(&app.path().config.join("settings.json"))?;
    if actual != *expected.as_ref().map_err(Clone::clone)? {
        return Err("Settings changed on disk; restart Canopod to load the external edit".into());
    }
    Ok(())
}
pub(crate) fn mutate<R>(
    app: &RuntimeContext,
    expected_revision: Option<&str>,
    change: impl FnOnce(&mut Settings) -> Result<R, String>,
) -> Result<(Settings, R), String> {
    let state = app.state::<AppState>();
    let mut disk = state.settings_disk.lock();
    let path = app.path().config.join("settings.json");
    let expected_disk = disk.as_ref().map_err(Clone::clone)?.clone();
    if disk_revision(&path)? != expected_disk {
        return Err("Settings changed on disk; restart Canopod to load the external edit".into());
    }
    let mut current = state.settings.write();
    if expected_revision.is_some_and(|r| r.is_empty() || r != current.revision) {
        return Err("Settings changed; reload settings before saving".into());
    }
    let mut next = current.clone();
    let result = change(&mut next)?;
    next.revision = revision(&next);
    let bytes = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        return Err("Settings exceed 4 MiB".into());
    }
    std::fs::create_dir_all(&app.path().config).map_err(|e| e.to_string())?;
    let mut temp =
        tempfile::NamedTempFile::new_in(&app.path().config).map_err(|e| e.to_string())?;
    temp.write_all(&bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    // Detect a non-cooperating editor immediately before atomic replacement.
    if disk_revision(&path)? != expected_disk {
        return Err("Settings changed on disk while saving; external edit preserved".into());
    }
    temp.persist(&path).map_err(|e| e.to_string())?;
    *disk = Ok(Some(hash(&bytes)));
    *current = next.clone();
    drop(current);
    drop(disk);
    let _ = app.emit(
        "settings:changed",
        &serde_json::json!({"revision":next.revision}),
    );
    Ok((next, result))
}
