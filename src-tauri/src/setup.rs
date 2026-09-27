// Per-worktree provisioning declared in the repo ("from code"), via a JSON file
// (.worktreemanager.json or wtm.json). Two parts:
//
//   {
//     "env": {                          // declarative .env overrides (add-or-replace)
//       "PG_DB": "${WT_DB_NAME}",
//       "PORT": "${WT_SERVER_PORT}",
//       "TOOLJET_SERVER_PORT": "${WT_SERVER_PORT}"
//     },
//     "setup": [ "npm --prefix server install", "npm run db:create" ]
//   }
//
// On create/setup Canopy seeds `.env` from the main checkout, applies the `env`
// overrides (interpolating ${VAR}), then runs the `setup` commands. Available
// vars: WT_SLUG, WT_DB_NAME, WT_INDEX, WT_<SERVICE>_PORT, WT_PATH, REPO_PATH.
//
// Config lookup order: the worktree's own copy first (committed → travels with
// the branch), then the main checkout (configure once without committing).
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const CONFIG_NAMES: [&str; 2] = [".worktreemanager.json", "wtm.json"];

/// One file Canopy seeds + templates into every new worktree. `dotenv`/`json`/
/// `yaml` seed the file (copy `from`, or the same path in the main checkout, if
/// missing) then upsert `keys` — every other line is preserved. `text` copies
/// the whole file and, when `interpolate` is set, replaces every `${VAR}`.
#[derive(Default, Clone)]
pub struct ProvisionFile {
    /// destination path, relative to the worktree root (e.g. "server/.env")
    pub path: String,
    /// dotenv | json | yaml | text
    pub format: String,
    /// source path to copy from (relative to the repo); empty = same as `path`
    pub from: String,
    /// text mode only: interpolate ${VAR} after copying
    pub interpolate: bool,
    /// ordered (key, value-template) pairs upserted into the file (not for text)
    pub keys: Vec<(String, String)>,
}

/// One setup task.
///
/// The config accepts a bare string *or* an object, and a bare string parses
/// to an enabled task in the worktree root. That is what makes this change
/// invisible to every existing `.worktreemanager.json`: the old array of
/// strings still means exactly what it always did.
#[derive(Debug, Clone, PartialEq)]
pub struct SetupTask {
    pub cmd: String,
    /// working directory relative to the worktree root; empty = the root
    pub cwd: String,
    /// a disabled task is skipped, but stays in the file — the point is to
    /// turn one off without losing how it was written
    pub enabled: bool,
}

impl SetupTask {
    pub fn plain(cmd: impl Into<String>) -> Self {
        Self { cmd: cmd.into(), cwd: String::new(), enabled: true }
    }
}

/// What to do when a setup task fails, and how long any one may run.
///
/// The defaults are the existing behaviour: stop at the first failure (a task
/// list normally encodes an order, so continuing past a failed install just
/// produces a second, more confusing failure) and use the built-in one-hour
/// per-step ceiling.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SetupPolicy {
    /// keep going after a failed task instead of stopping at the first one
    pub continue_on_failure: bool,
    /// per-task ceiling in seconds; 0 = the built-in one hour
    pub timeout_secs: u64,
}

#[derive(Default, Clone)]
pub struct WtmConfig {
    /// files seeded + templated into the worktree (the ".env" root file is just
    /// one entry — legacy top-level `env` is migrated into this list on read)
    pub provision: Vec<ProvisionFile>,
    pub setup: Vec<SetupTask>,
    pub setup_policy: SetupPolicy,
    /// commands run before a worktree is deleted (e.g. drop its database)
    pub teardown: Vec<String>,
    /// commands run by the "Run migration" action
    pub migrate: Vec<String>,
}

/// Parse a JSON `provision` array into ordered `ProvisionFile`s.
fn parse_provision(v: &serde_json::Value) -> Vec<ProvisionFile> {
    v.get("provision")
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|o| {
                    let path = o.get("path").and_then(|x| x.as_str())?.to_string();
                    let format = o
                        .get("format")
                        .and_then(|x| x.as_str())
                        .filter(|f| matches!(*f, "dotenv" | "json" | "yaml" | "text"))
                        .unwrap_or("dotenv")
                        .to_string();
                    let from = o.get("from").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let interpolate = o.get("interpolate").and_then(|x| x.as_bool()).unwrap_or(false);
                    let keys = o
                        .get("keys")
                        .and_then(|k| k.as_object())
                        .map(|m| {
                            m.iter()
                                .map(|(k, val)| {
                                    let s = match val {
                                        serde_json::Value::String(s) => s.clone(),
                                        other => other.to_string(),
                                    };
                                    (k.clone(), s)
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    Some(ProvisionFile { path, format, from, interpolate, keys })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Parse the `setup` array: a bare string is a plain enabled task, an object
/// may carry `cwd` and `enabled`. Anything else is skipped rather than
/// silently becoming an empty command.
fn parse_setup(v: &serde_json::Value) -> Vec<SetupTask> {
    v.get("setup")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| match item {
                    serde_json::Value::String(s) => Some(SetupTask::plain(s.clone())),
                    serde_json::Value::Object(o) => {
                        let cmd = o.get("cmd").and_then(|c| c.as_str())?.to_string();
                        Some(SetupTask {
                            cmd,
                            cwd: o.get("cwd").and_then(|c| c.as_str()).unwrap_or("").to_string(),
                            enabled: o.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true),
                        })
                    }
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_policy(v: &serde_json::Value) -> SetupPolicy {
    let p = v.get("setupPolicy");
    SetupPolicy {
        continue_on_failure: p
            .and_then(|p| p.get("onFailure"))
            .and_then(|x| x.as_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("continue")),
        timeout_secs: p.and_then(|p| p.get("timeoutSecs")).and_then(|x| x.as_u64()).unwrap_or(0),
    }
}

pub fn read_config(wt_path: &str, repo_path: &str) -> WtmConfig {
    for dir in [wt_path, repo_path] {
        for name in CONFIG_NAMES {
            let p = Path::new(dir).join(name);
            let Ok(txt) = std::fs::read_to_string(&p) else { continue };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else { continue };
            let arr = |key: &str| {
                v.get(key)
                    .and_then(|s| s.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>())
                    .unwrap_or_default()
            };
            let setup = parse_setup(&v);
            let setup_policy = parse_policy(&v);
            let teardown = arr("teardown");
            let migrate = arr("migrate");
            let mut provision = parse_provision(&v);
            // back-compat: fold a legacy top-level `env` object into a leading
            // ".env" dotenv entry so old configs keep working (and migrate on save).
            let legacy_env: Vec<(String, String)> = v
                .get("env")
                .and_then(|e| e.as_object())
                .map(|o| {
                    o.iter()
                        .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
                .unwrap_or_default();
            if !legacy_env.is_empty() && !provision.iter().any(|p| p.path == ".env") {
                provision.insert(
                    0,
                    ProvisionFile {
                        path: ".env".into(),
                        format: "dotenv".into(),
                        from: String::new(),
                        interpolate: false,
                        keys: legacy_env,
                    },
                );
            }
            if !setup.is_empty() || !provision.is_empty() || !teardown.is_empty() || !migrate.is_empty() {
                return WtmConfig { provision, setup, setup_policy, teardown, migrate };
            }
        }
    }
    WtmConfig::default()
}

pub fn read_repo_config(repo_path: &str) -> WtmConfig {
    read_config(repo_path, repo_path)
}

pub fn has_config(wt_path: &str, repo_path: &str) -> bool {
    let c = read_config(wt_path, repo_path);
    !c.provision.is_empty() || !c.setup.is_empty()
}

/// Serialize a `ProvisionFile` list to a JSON `provision` array.
fn provision_to_json(provision: &[ProvisionFile]) -> serde_json::Value {
    serde_json::Value::Array(
        provision
            .iter()
            .filter(|p| !p.path.trim().is_empty())
            .map(|p| {
                let mut o = serde_json::Map::new();
                o.insert("path".into(), serde_json::Value::String(p.path.clone()));
                o.insert("format".into(), serde_json::Value::String(p.format.clone()));
                if !p.from.trim().is_empty() {
                    o.insert("from".into(), serde_json::Value::String(p.from.clone()));
                }
                if p.format == "text" {
                    o.insert("interpolate".into(), serde_json::Value::Bool(p.interpolate));
                } else {
                    o.insert("mode".into(), serde_json::Value::String("upsert".into()));
                    let mut keys = serde_json::Map::new();
                    for (k, v) in p.keys.iter().filter(|(k, _)| !k.trim().is_empty()) {
                        keys.insert(k.clone(), serde_json::Value::String(v.clone()));
                    }
                    o.insert("keys".into(), serde_json::Value::Object(keys));
                }
                serde_json::Value::Object(o)
            })
            .collect(),
    )
}

/// Write `.worktreemanager.json` at the repo root with the given provision list +
/// setup commands. Preserves other top-level keys (teardown/migrate) and drops
/// the legacy `env` block, which is now folded into `provision`. An existing but
/// malformed file is an ERROR — rewriting it would silently drop those keys.
#[cfg(test)]
pub fn write_repo_config(
    repo_path: &str,
    provision: &[ProvisionFile],
    setup: &[SetupTask],
    policy: Option<&SetupPolicy>,
) -> Result<(), String> {
    write_repo_config_sections(repo_path, provision, setup, policy, None, None)
}

pub fn write_repo_config_sections(
    repo_path: &str,
    provision: &[ProvisionFile],
    setup: &[SetupTask],
    policy: Option<&SetupPolicy>,
    teardown: Option<&[String]>,
    migrate: Option<&[String]>,
) -> Result<(), String> {
    let path = Path::new(repo_path).join(".worktreemanager.json");
    let mut root: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(txt) if !txt.trim().is_empty() => serde_json::from_str(&txt).map_err(|e| {
            format!(".worktreemanager.json is malformed ({e}) — fix it by hand before saving from Settings")
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Ok(_) => return Err(format!("{} is empty — fix it before saving", path.display())),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    if !root.is_object() {
        return Err(".worktreemanager.json is not a JSON object — fix it by hand before saving from Settings".into());
    }
    if let Some(obj) = root.as_object_mut() {
        obj.remove("env"); // migrated into `provision`
    }
    root["$schema"] = serde_json::Value::String("canopy://worktree-manager/v1".into());
    root["provision"] = provision_to_json(provision);
    for (key, commands) in [("teardown", teardown), ("migrate", migrate)] {
        if let Some(commands) = commands {
            root[key] = serde_json::json!(commands.iter().filter(|s| !s.trim().is_empty()).collect::<Vec<_>>());
        }
    }
    // A plain task round-trips as a bare string, so turning one option on for
    // one task doesn't rewrite the whole list into objects and produce a diff
    // that touches every line.
    root["setup"] = serde_json::Value::Array(
        setup
            .iter()
            .filter(|t| !t.cmd.trim().is_empty())
            .map(|t| {
                if t.cwd.trim().is_empty() && t.enabled {
                    serde_json::Value::String(t.cmd.clone())
                } else {
                    let mut o = serde_json::Map::new();
                    o.insert("cmd".into(), serde_json::Value::String(t.cmd.clone()));
                    if !t.cwd.trim().is_empty() {
                        o.insert("cwd".into(), serde_json::Value::String(t.cwd.trim().to_string()));
                    }
                    if !t.enabled {
                        o.insert("enabled".into(), serde_json::Value::Bool(false));
                    }
                    serde_json::Value::Object(o)
                }
            })
            .collect(),
    );
    match policy {
        // Only written when it differs from the built-in behaviour, so a repo
        // that never touched it keeps a config file without the key.
        Some(p) if *p != SetupPolicy::default() => {
            let mut o = serde_json::Map::new();
            o.insert(
                "onFailure".into(),
                serde_json::Value::String(if p.continue_on_failure { "continue" } else { "stop" }.into()),
            );
            if p.timeout_secs > 0 {
                o.insert("timeoutSecs".into(), serde_json::Value::from(p.timeout_secs));
            }
            root["setupPolicy"] = serde_json::Value::Object(o);
        }
        Some(_) => {
            if let Some(obj) = root.as_object_mut() {
                obj.remove("setupPolicy");
            }
        }
        None => {}
    }
    let body = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, body + "\n").map_err(|e| e.to_string())
}

// ── the setup marker ──────────────────────────────────────────────────
//
// Whether a worktree has ever been provisioned is a *durable* fact about the
// worktree, not about this run of Canopy — so it lives next to the worktree
// (`.canopy/setup.json`) rather than in app state. That survives a restart, a
// `get_tree` rescan, and a Canopy reinstall, and it is greppable when
// debugging a repo by hand.
//
// `.canopy/` is already the worktree-local Canopy directory (see
// `write_worktree_context`) and self-ignores via its own `.gitignore`, so the
// marker never shows up in `git status`.

/// The marker's on-disk shape. `ok` records whether the run that wrote it
/// succeeded — a failed setup still leaves a marker, so the UI can say "last
/// run failed" instead of the much weaker "never provisioned".
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupMarker {
    /// schema version, so a future field can be added without a silent misread
    version: u32,
    /// unix seconds when the run finished
    ran_at: i64,
    ok: bool,
}

/// How we know a worktree was provisioned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SetupSource {
    /// read from `.canopy/setup.json` — authoritative
    Marker,
    /// no marker, but every declared provisioned file is already present.
    /// Worktrees created before the marker existed land here; without this
    /// they would all claim "never provisioned" and invite a pointless
    /// re-install of every dependency tree on the machine.
    Inferred,
}

/// What Canopy knows about a worktree's provisioning.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupState {
    /// unix seconds of the recorded run; absent when inferred
    pub ran_at: Option<i64>,
    /// did the recorded run succeed (inferred state is always `true` —
    /// the files exist, so *something* provisioned them)
    pub ok: bool,
    pub source: SetupSource,
}

fn marker_path(wt_path: &str) -> std::path::PathBuf {
    Path::new(wt_path).join(".canopy").join("setup.json")
}

/// Record that setup finished for a worktree. Best-effort: setup itself
/// already succeeded (or failed) by the time this runs, and a marker we
/// couldn't write must never turn a good run into a reported failure — the
/// worst case is the worktree reads as unprovisioned and offers a re-run.
pub fn write_setup_marker(wt_path: &str, ok: bool) {
    let dir = Path::new(wt_path).join(".canopy");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("setup marker: mkdir {} failed: {e}", dir.display());
        return;
    }
    // keep `.canopy/` out of git the same way write_worktree_context does,
    // without ever truncating an existing ignore file
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        let _ = std::fs::write(&ignore, "*\n");
    }
    let ran_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let marker = SetupMarker { version: 1, ran_at, ok };
    match serde_json::to_string_pretty(&marker) {
        Ok(body) => {
            if let Err(e) = std::fs::write(marker_path(wt_path), body + "\n") {
                log::warn!("setup marker: write failed for {wt_path}: {e}");
            }
        }
        Err(e) => log::warn!("setup marker: serialize failed: {e}"),
    }
}

/// A worktree's provisioning state plus whether its repo declares any
/// provisioning at all — the pair the tree needs, from a single config read.
///
/// Called once per worktree per tree rebuild, so it stays cheap: one small
/// read for the marker, one for the config, and — only when the marker misses
/// — an `exists()` per declared provisioned file. No directory walks.
///
/// Returns `(state, configured)`. `state == None` means "never provisioned as
/// far as Canopy can tell"; that is only actionable when `configured` is true.
pub fn setup_status(wt_path: &str, repo_path: &str) -> (Option<SetupState>, bool) {
    let cfg = read_config(wt_path, repo_path);
    let configured = !cfg.provision.is_empty() || !cfg.setup.is_empty();

    if let Ok(txt) = std::fs::read_to_string(marker_path(wt_path)) {
        if let Ok(m) = serde_json::from_str::<SetupMarker>(&txt) {
            let state = SetupState { ran_at: Some(m.ran_at), ok: m.ok, source: SetupSource::Marker };
            return (Some(state), configured);
        }
        // a corrupt marker is not evidence of anything — fall through to the
        // file-presence inference rather than trusting a half-written file
        log::warn!("setup marker at {wt_path} is unreadable — falling back to file inference");
    }

    // No usable marker. If the repo declares provisioned files and every one
    // of them already exists here, provisioning demonstrably happened.
    let declared: Vec<&ProvisionFile> = cfg.provision.iter().filter(|p| !p.path.trim().is_empty()).collect();
    if declared.is_empty() {
        // Nothing to infer from: a setup-commands-only repo leaves no
        // inspectable trace, so absence of a marker is all we have.
        return (None, configured);
    }
    let all_present = declared.iter().all(|p| Path::new(wt_path).join(&p.path).exists());
    let state = all_present.then_some(SetupState { ran_at: None, ok: true, source: SetupSource::Inferred });
    (state, configured)
}

/// Stable, db-safe per-worktree identifier from the worktree folder name:
/// lowercased, non-alphanumerics → '_'.
pub fn wt_slug(wt_path: &str) -> String {
    Path::new(wt_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Replace `${VAR}` tokens in a template using the vars map (unknown left as-is).
fn interpolate(tpl: &str, vars: &HashMap<String, String>) -> String {
    let mut out = tpl.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("${{{k}}}"), v);
    }
    out
}

/// Add-or-replace literal KEY=VALUE pairs in the worktree's `.env`, preserving
/// every other line. Seeds `.env` from the main checkout if missing.
pub fn set_env_keys(wt_path: &str, repo_path: &str, pairs: &[(String, String)]) -> Result<(), String> {
    if pairs.is_empty() {
        return Ok(());
    }
    let env_path = Path::new(wt_path).join(".env");
    if !env_path.exists() {
        let main_env = Path::new(repo_path).join(".env");
        if main_env.exists() {
            std::fs::copy(&main_env, &env_path).map_err(|e| format!("seed .env failed: {e}"))?;
        }
    }
    let existing = std::fs::read_to_string(&env_path).unwrap_or_default();
    let body = upsert_dotenv_str(&existing, pairs);
    std::fs::write(&env_path, body).map_err(|e| format!("write .env failed: {e}"))
}

/// Upsert literal KEY=VALUE pairs into every *provisioned dotenv file* that
/// declares any of the keys — so e.g. switching database repoints `PG_DB` in
/// `server/.env` too, not just the root `.env`.
pub fn set_env_keys_in_provisioned(wt_path: &str, repo_path: &str, pairs: &[(String, String)]) -> Result<(), String> {
    let cfg = read_config(wt_path, repo_path);
    for pf in cfg.provision.iter().filter(|p| p.format == "dotenv" && p.path != ".env") {
        let relevant: Vec<(String, String)> = pairs
            .iter()
            .filter(|(k, _)| pf.keys.iter().any(|(pk, _)| pk == k))
            .cloned()
            .collect();
        if relevant.is_empty() {
            continue;
        }
        let target = Path::new(wt_path).join(&pf.path);
        if !target.exists() {
            continue; // never materialize a file just to repoint a key
        }
        let existing = std::fs::read_to_string(&target).unwrap_or_default();
        let body = upsert_dotenv_str(&existing, &relevant);
        std::fs::write(&target, body).map_err(|e| format!("write {}: {e}", target.display()))?;
    }
    Ok(())
}

/// Upsert `KEY=VALUE` pairs into dotenv `existing` text, preserving every other
/// line and replacing keys already present (including `export KEY=` variants).
/// Updated keys move to the end of the file.
fn upsert_dotenv_str(existing: &str, pairs: &[(String, String)]) -> String {
    let keys: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).collect();
    let mut lines: Vec<String> = existing
        .lines()
        .filter(|l| {
            let head = l.split('=').next().unwrap_or("").trim();
            let key = head.strip_prefix("export ").map(str::trim).unwrap_or(head);
            !keys.contains(&key)
        })
        .map(String::from)
        .collect();
    for (k, v) in pairs {
        lines.push(format!("{k}={v}"));
    }
    let mut body = lines.join("\n");
    body.push('\n');
    body
}

/// Read a dotenv file into ordered `(key, value)` pairs, preserving file order
/// and skipping comments/blanks. Handles the `export KEY=` form and strips one
/// layer of matching quotes — the same shapes `upsert_dotenv_str` writes and
/// tolerates. Deliberately not a full shell parser: no `$VAR` expansion, since
/// the point is to show what is literally on disk.
pub fn parse_dotenv(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((head, value)) = line.split_once('=') else { continue };
        let key = head.trim().strip_prefix("export ").map(str::trim).unwrap_or_else(|| head.trim());
        if key.is_empty() {
            continue;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        out.push((key.to_string(), value.to_string()));
    }
    out
}

/// Set a dotted key (`development.database`) to a string value inside a JSON
/// object, creating intermediate objects as needed.
fn set_dotted_json(root: &mut serde_json::Value, dotted: &str, value: &str) {
    if !root.is_object() {
        *root = serde_json::json!({});
    }
    let segs: Vec<&str> = dotted.split('.').collect();
    let mut cur = root;
    for seg in &segs[..segs.len() - 1] {
        let obj = cur.as_object_mut().unwrap();
        let entry = obj.entry(seg.to_string()).or_insert_with(|| serde_json::json!({}));
        if !entry.is_object() {
            *entry = serde_json::json!({});
        }
        cur = entry;
    }
    if let Some(obj) = cur.as_object_mut() {
        obj.insert(segs[segs.len() - 1].to_string(), serde_json::Value::String(value.to_string()));
    }
}

/// Upsert dotted keys into `existing` JSON text (or `{}` when empty), returning
/// pretty-printed JSON. Malformed input is an ERROR, never silently replaced —
/// defaulting to `{}` would wipe the user's file down to just the upserted keys.
fn upsert_json_str(existing: &str, pairs: &[(String, String)]) -> Result<String, String> {
    let mut root: serde_json::Value = if existing.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(existing)
            .map_err(|e| format!("refusing to rewrite malformed JSON ({e}) — fix the file or remove it so it can be re-seeded"))?
    };
    for (k, v) in pairs {
        set_dotted_json(&mut root, k, v);
    }
    let mut body = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    body.push('\n');
    Ok(body)
}

/// Upsert dotted keys into `existing` YAML text with a line-based, comment- and
/// layout-preserving rewrite. An existing dotted path has just its scalar value
/// replaced; a missing path is appended as an indented block. Indent width is
/// detected from the file (first indented mapping line; 2 for new files) so
/// 4-space and tab-free wide-indent files descend correctly. Not a full YAML
/// parser — targets the seed-an-example-then-set-values workflow.
fn upsert_yaml_str(existing: &str, pairs: &[(String, String)]) -> String {
    let mut lines: Vec<String> = existing.lines().map(String::from).collect();
    let indent_of = |l: &str| l.len() - l.trim_start().len();
    let key_of = |l: &str| -> Option<String> {
        let t = l.trim_start();
        if t.is_empty() || t.starts_with('#') || t.starts_with('-') {
            return None;
        }
        t.split_once(':').map(|(k, _)| k.trim().to_string())
    };
    // indent unit = the first indented, non-comment mapping line's indent
    let step = lines
        .iter()
        .filter(|l| key_of(l).is_some())
        .map(|l| indent_of(l))
        .find(|&i| i > 0)
        .unwrap_or(2) as i32;

    for (dotted, value) in pairs {
        let segs: Vec<&str> = dotted.split('.').collect();
        // walk the segments, tracking the line range + indent of the current block
        let (mut lo, mut hi, mut depth_indent) = (0usize, lines.len(), 0i32);
        let mut found_upto = 0usize; // how many leading segments matched
        let mut target_line: Option<usize> = None;
        'seg: for (si, seg) in segs.iter().enumerate() {
            let want_indent = depth_indent;
            let mut i = lo;
            while i < hi {
                let l = &lines[i];
                if l.trim().is_empty() || (indent_of(l) as i32) != want_indent {
                    i += 1;
                    continue;
                }
                if key_of(l).as_deref() == Some(*seg) {
                    found_upto = si + 1;
                    if si == segs.len() - 1 {
                        target_line = Some(i);
                        break 'seg;
                    }
                    // descend into this key's block. The child indent is whatever
                    // the block actually uses (first keyed line inside it).
                    lo = i + 1;
                    // block ends where indentation drops back to <= want_indent
                    let mut j = lo;
                    while j < hi {
                        let lj = &lines[j];
                        if !lj.trim().is_empty() && (indent_of(lj) as i32) <= want_indent {
                            break;
                        }
                        j += 1;
                    }
                    hi = j;
                    depth_indent = lines[lo..hi]
                        .iter()
                        .find(|l| key_of(l).is_some())
                        .map(|l| indent_of(l) as i32)
                        .unwrap_or(want_indent + step);
                    continue 'seg;
                }
                i += 1;
            }
            break; // segment not found at this level
        }

        if let Some(li) = target_line {
            let indent = " ".repeat(indent_of(&lines[li]));
            lines[li] = format!("{indent}{}: {value}", segs.last().unwrap());
        } else {
            // append the missing tail as an indented nested block at the deepest
            // matched position (end of file for a wholly-new top-level key).
            let base = found_upto as i32 * step;
            let mut block = Vec::new();
            for (k, seg) in segs[found_upto..].iter().enumerate() {
                let indent = " ".repeat((base + k as i32 * step) as usize);
                if found_upto + k == segs.len() - 1 {
                    block.push(format!("{indent}{seg}: {value}"));
                } else {
                    block.push(format!("{indent}{seg}:"));
                }
            }
            let at = hi.min(lines.len());
            for (k, b) in block.into_iter().enumerate() {
                lines.insert(at + k, b);
            }
        }
    }
    let mut body = lines.join("\n");
    if !body.ends_with('\n') {
        body.push('\n');
    }
    body
}

/// A provision path must stay inside its root: relative, no `..` components.
fn check_contained(p: &str, what: &str) -> Result<(), String> {
    use std::path::Component;
    let path = Path::new(p);
    // On Windows a leading-`/` path (`/etc/hosts`) is *rooted* but not *absolute*
    // (no drive), yet `join` still resolves it onto the current drive and escapes
    // the root — so reject `has_root()` and drive prefixes (`C:\`, `C:foo`) too.
    let escapes = path.is_absolute()
        || path.has_root()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)));
    if escapes {
        return Err(format!("provision {what} '{p}' must be a relative path without '..'"));
    }
    Ok(())
}

/// Seed + template one provisioned file into the worktree. `dotenv`/`json`/`yaml`
/// seed the file (copy `from`/same-path from the main checkout when missing) then
/// upsert `keys`; `text` copies the whole file and optionally interpolates.
fn provision_file(wt_path: &str, repo_path: &str, pf: &ProvisionFile, vars: &HashMap<String, String>) -> Result<(), String> {
    if pf.path.trim().is_empty() {
        return Ok(());
    }
    check_contained(&pf.path, "path")?;
    if !pf.from.trim().is_empty() {
        check_contained(&pf.from, "from")?;
    }
    let target = Path::new(wt_path).join(&pf.path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let src_rel = if pf.from.trim().is_empty() { pf.path.as_str() } else { pf.from.as_str() };
    let src = Path::new(repo_path).join(src_rel);

    if pf.format == "text" {
        let content = if target.exists() {
            std::fs::read_to_string(&target).unwrap_or_default()
        } else if src.exists() {
            std::fs::read_to_string(&src).map_err(|e| format!("read {}: {e}", src.display()))?
        } else {
            String::new()
        };
        let out = if pf.interpolate { interpolate(&content, vars) } else { content };
        return std::fs::write(&target, out).map_err(|e| format!("write {}: {e}", target.display()));
    }

    // key formats: seed from source if the target doesn't exist yet
    if !target.exists() && src.exists() {
        std::fs::copy(&src, &target).map_err(|e| format!("seed {}: {e}", target.display()))?;
    }
    let resolved: Vec<(String, String)> = pf
        .keys
        .iter()
        .filter(|(k, _)| !k.trim().is_empty())
        .map(|(k, tpl)| (k.clone(), interpolate(tpl, vars)))
        .collect();
    if resolved.is_empty() {
        return Ok(());
    }
    let existing = std::fs::read_to_string(&target).unwrap_or_default();
    let body = match pf.format.as_str() {
        "json" => upsert_json_str(&existing, &resolved)?,
        "yaml" => upsert_yaml_str(&existing, &resolved),
        _ => upsert_dotenv_str(&existing, &resolved),
    };
    std::fs::write(&target, body).map_err(|e| format!("write {}: {e}", target.display()))
}

/// Re-apply every key-based provisioned file's keys with fresh `vars` (e.g. after
/// a port override, so dependent values like TOOLJET_SERVER_PORT follow). Skips
/// `text` files so their contents aren't re-copied.
pub fn reapply_provision(wt_path: &str, repo_path: &str, vars: &HashMap<String, String>) -> Result<(), String> {
    let cfg = read_config(wt_path, repo_path);
    for pf in cfg.provision.iter().filter(|p| p.format != "text") {
        provision_file(wt_path, repo_path, pf, vars)?;
    }
    Ok(())
}

/// Provision a worktree: apply declarative env overrides, then run setup
/// commands (sequentially, via login shell on the pinned Node, with `vars`
/// exposed as env so commands can reference $WT_SERVER_PORT etc.).
/// Streams progress; stops at the first failure.
pub async fn run_setup(
    wt_path: &str,
    repo_path: &str,
    vars: &HashMap<String, String>,
    dry_run: bool,
    parallel: bool,
    mut progress: impl FnMut(Progress),
) -> Result<(), String> {
    let cfg = read_config(wt_path, repo_path);

    if !cfg.provision.is_empty() {
        let n = cfg.provision.len();
        progress(Progress::Line(format!("provisioning {n} file(s){}", if dry_run { " — dry run" } else { "" })));
        for pf in &cfg.provision {
            progress(Progress::Line(format!("  → {} ({})", pf.path, pf.format)));
            if !dry_run {
                provision_file(wt_path, repo_path, pf, vars)?;
            }
        }
        // Provisioning is the one step whose count Canopy knows exactly rather
        // than having to parse out of someone else's output.
        progress(Progress::StepResult { index: 0, text: format!("{n} file{}", if n == 1 { "" } else { "s" }) });
    }
    run_tasks(wt_path, repo_path, &cfg.setup, &cfg.setup_policy, vars, dry_run, parallel, &mut progress).await
}

/// Run the setup task list, honouring per-task cwd/enable and the failure and
/// timeout policy. With `dry_run`, it reports exactly what WOULD run — same
/// order, same working directories, same skips — and executes nothing.
#[allow(clippy::too_many_arguments)]
async fn run_tasks(
    wt_path: &str,
    repo_path: &str,
    tasks: &[SetupTask],
    policy: &SetupPolicy,
    vars: &HashMap<String, String>,
    dry_run: bool,
    parallel: bool,
    progress: &mut impl FnMut(Progress),
) -> Result<(), String> {
    let live: Vec<&SetupTask> = tasks.iter().filter(|t| !t.cmd.trim().is_empty()).collect();
    let total = live.iter().filter(|t| t.enabled).count();

    // The parallel-setup experiment runs the ENABLED tasks at once. It has to
    // go through the same task list rather than the raw command array it was
    // written against: running a task the user disabled, or running one
    // outside its configured working directory, would be a bug the experiment
    // flag doesn't excuse. A dry run still reports sequentially — the plan is
    // what is being previewed, not the scheduling.
    if parallel && !dry_run && total > 1 {
        let enabled: Vec<&SetupTask> = live.iter().copied().filter(|t| t.enabled).collect();
        return run_tasks_parallel(wt_path, repo_path, &enabled, policy, vars, progress).await;
    }
    let mut failures: Vec<String> = Vec::new();
    let mut n = 0usize;

    for task in live {
        // A disabled task is reported, not omitted: "why didn't my migration
        // run?" is answered by seeing it listed as skipped.
        if !task.enabled {
            progress(Progress::Line(format!("setup — skipped (disabled): {}", task.cmd)));
            continue;
        }
        n += 1;
        let where_ = if task.cwd.trim().is_empty() { String::new() } else { format!(" (in {})", task.cwd.trim()) };
        if dry_run {
            progress(Progress::Line(format!("setup [{n}/{total}]: {}{where_} — dry run, not executed", task.cmd)));
            continue;
        }
        progress(Progress::Line(format!("setup [{n}/{total}]: {}{where_}", task.cmd)));

        // A per-task cwd must stay inside the worktree, for the same reason a
        // provision path must: this string comes from a repo config file.
        let cwd = if task.cwd.trim().is_empty() {
            wt_path.to_string()
        } else {
            check_contained(task.cwd.trim(), "task cwd")?;
            Path::new(wt_path).join(task.cwd.trim()).to_string_lossy().into_owned()
        };

        let one = [task.cmd.clone()];
        let result =
            run_commands_in(&cwd, wt_path, repo_path, &one, vars, "setup", policy.timeout_secs, Numbering::Caller(n), progress).await;
        if let Err(e) = result {
            if !policy.continue_on_failure {
                return Err(e);
            }
            progress(Progress::Line(format!("setup — continuing after failure: {e}")));
            failures.push(e);
        }
    }

    match failures.len() {
        0 => Ok(()),
        // With continue-on-failure the run finished, but it did NOT succeed —
        // reporting Ok here would mark the worktree provisioned when it isn't.
        1 => Err(failures.remove(0)),
        k => Err(format!("{k} setup tasks failed:\n{}", failures.join("\n"))),
    }
}

/// Run every setup command at once (the `parallel-setup` experiment).
///
/// Correct only when the tasks are independent; the experiment's own copy says
/// so, and that is exactly why it is an experiment rather than the default.
/// Ordinary setup lists routinely encode a dependency ("install, then
/// migrate") that no static analysis here could detect.
///
/// Output is funnelled through one channel rather than shared `&mut` progress,
/// so interleaved lines stay whole and each is prefixed with its task number —
/// without that, parallel output is unreadable.
async fn run_tasks_parallel(
    wt_path: &str,
    repo_path: &str,
    tasks: &[&SetupTask],
    policy: &SetupPolicy,
    vars: &HashMap<String, String>,
    progress: &mut impl FnMut(Progress),
) -> Result<(), String> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Progress>();
    let n = tasks.len();
    progress(Progress::Line(format!("setup [parallel]: running {n} tasks at once")));

    // Resolve every working directory BEFORE spawning: a task whose cwd
    // escapes the worktree must fail the run, not one spawned branch.
    let mut prepared = Vec::with_capacity(n);
    for task in tasks {
        let cwd = if task.cwd.trim().is_empty() {
            wt_path.to_string()
        } else {
            check_contained(task.cwd.trim(), "task cwd")?;
            Path::new(wt_path).join(task.cwd.trim()).to_string_lossy().into_owned()
        };
        prepared.push((task.cmd.clone(), cwd));
    }

    let mut handles = Vec::with_capacity(n);
    for (i, (cmd, cwd)) in prepared.into_iter().enumerate() {
        let (wt, repo, vars, tx) = (wt_path.to_string(), repo_path.to_string(), vars.clone(), tx.clone());
        let timeout = policy.timeout_secs;
        // The engine has no host context; its async caller already runs on Tokio.
        handles.push(tokio::spawn(async move {
            let step = i + 1;
            let prefix = format!("setup [{step}/{n}]");
            // Announced by the task itself, as it starts — which in parallel
            // is all of them at once, and that is the honest picture.
            let _ = tx.send(Progress::Line(format!("{prefix}: {cmd}")));
            let one = [cmd];
            let tx2 = tx.clone();
            let mut fwd = move |p: Progress| {
                let _ = tx2.send(match p {
                    // interleaved output is unreadable without saying whose it is
                    Progress::Line(line) => Progress::Line(format!("{prefix} {line}")),
                    // a result already carries this task's number; forwarding it
                    // is how parallel steps get their metadata at all
                    other => other,
                });
            };
            run_commands_in(&cwd, &wt, &repo, &one, &vars, "setup", timeout, Numbering::Caller(step), &mut fwd).await
        }));
    }
    drop(tx); // the loop below ends when every task's sender is gone

    while let Some(p) = rx.recv().await {
        progress(p);
    }

    // Every task is awaited even after one fails: leaving the others running
    // detached would let a half-finished install keep writing into a worktree
    // the caller has already been told is broken.
    let mut first_error: Option<String> = None;
    for h in handles {
        match h.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                first_error.get_or_insert(e);
            }
            Err(e) => {
                first_error.get_or_insert(format!("setup task panicked: {e}"));
            }
        }
    }
    match first_error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Run a worktree's teardown commands (e.g. drop its database) before deletion.
pub async fn run_teardown(
    wt_path: &str,
    repo_path: &str,
    vars: &HashMap<String, String>,
    mut progress: impl FnMut(Progress),
) -> Result<(), String> {
    let cfg = read_config(wt_path, repo_path);
    run_commands(wt_path, repo_path, &cfg.teardown, vars, "teardown", &mut progress).await
}

pub fn has_teardown(wt_path: &str, repo_path: &str) -> bool {
    !read_config(wt_path, repo_path).teardown.is_empty()
}

/// Run the worktree's configured migration commands (`migrate` in the config).
pub async fn run_migration(
    wt_path: &str,
    repo_path: &str,
    vars: &HashMap<String, String>,
    mut progress: impl FnMut(Progress),
) -> Result<(), String> {
    let cfg = read_config(wt_path, repo_path);
    if cfg.migrate.is_empty() {
        return Err("No migrate command configured (\"migrate\" in .worktreemanager.json)".into());
    }
    run_commands(wt_path, repo_path, &cfg.migrate, vars, "migrate", &mut progress).await
}

/// Run a single ad-hoc command (a repo "custom command") in the worktree root on
/// the pinned Node, streaming progress — same execution model as setup/migrate.
pub async fn run_custom_command(
    wt_path: &str,
    repo_path: &str,
    command: &str,
    vars: &HashMap<String, String>,
    mut progress: impl FnMut(Progress),
) -> Result<(), String> {
    let cmds = [command.to_string()];
    run_commands(wt_path, repo_path, &cmds, vars, "command", &mut progress).await
}

// ── step results ──────────────────────────────────────────────────────
//
// The setup runner's right-hand column ("1,842 packages", "37 migrations") is
// what makes the step list worth watching rather than a spinner — "37
// migrations" tells you the migrate step actually did something, which is
// exactly why people re-run setup.
//
// So this is NOT "the last line of output", which would usually be noise. Each
// known command kind has a pattern that yields a short, specific quantity;
// anything unrecognised produces no metadata at all, and the step renders with
// its bullet alone. A step never claims a count it wasn't given.

/// One progress update from a running command list.
pub enum Progress {
    /// a line of output (throttled)
    Line(String),
    /// step `index` (1-based) finished and produced a short quantity
    StepResult { index: usize, text: String },
}

/// Who owns the step number a command reports under.
///
/// `run_commands_in` used to always number over its own `cmds` array. That is
/// right where the array IS the step list (teardown, migrate, a one-off), but
/// setup runs ONE task per call: every task then announced itself as "[1/1]",
/// which clobbered the run's real total ("Step 1 of 1" however many tasks
/// there were) and — because the runner files output under the last marker it
/// saw — piled every task's output under task 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Numbering {
    /// Number the commands in this call: `label [i/len]`, results at `i`.
    Own,
    /// The caller announced this step and owns its number: emit no header of
    /// our own, and attach results to `n`.
    Caller(usize),
}

impl Numbering {
    /// The header for command `i` of `len`, or None when the caller printed one.
    fn header(self, label: &str, i: usize, len: usize, cmd: &str) -> Option<String> {
        match self {
            Numbering::Own => Some(format!("{label} [{}/{len}]: {cmd}", i + 1)),
            Numbering::Caller(_) => None,
        }
    }

    /// The step a result belongs to.
    fn index(self, i: usize) -> usize {
        match self {
            Numbering::Own => i + 1,
            Numbering::Caller(n) => n,
        }
    }
}

/// Group a number with thousands separators — the design writes "1,842", and
/// a bare "1842" reads as an id rather than a count.
fn commas(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// First run of digits in `line` after `marker`, if any.
fn number_after(line: &str, marker: &str) -> Option<u64> {
    let rest = line.to_lowercase();
    let at = rest.find(marker)? + marker.len();
    let digits: String = rest[at..].chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// The leading number on a line, e.g. "37 migrations were executed".
fn leading_number(line: &str) -> Option<u64> {
    let t = line.trim_start();
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Extract a short result quantity from one line of a command's output, given
/// the command that produced it. `None` for everything unrecognised.
fn match_step_result(cmd: &str, line: &str) -> Option<String> {
    let c = cmd.to_lowercase();
    let l = line.trim();
    let low = l.to_lowercase();

    // ── dependency installers ──
    if c.contains("install") || c.contains(" ci") || c.ends_with(" ci") {
        // npm: "added 1842 packages in 41s"
        if low.starts_with("added ") {
            if let Some(n) = number_after(&low, "added ") {
                return Some(format!("{} packages", commas(n)));
            }
        }
        // pnpm: "Packages: +1842"
        if low.starts_with("packages:") {
            if let Some(n) = number_after(&low, "+") {
                return Some(format!("{} packages", commas(n)));
            }
        }
        // yarn/npm no-op — worth showing, because "nothing happened" is the
        // answer people re-run setup to confirm
        if low.contains("up to date") || low.contains("already up-to-date") {
            return Some("up to date".into());
        }
    }

    // ── migrations ──
    if c.contains("migrat") {
        // knex: "Batch 1 run: 37 migrations"
        if low.contains("batch") && low.contains("run:") {
            if let Some(n) = number_after(&low, "run:") {
                return Some(format!("{} migrations", commas(n)));
            }
        }
        // typeorm: "37 migrations were successfully executed"
        if low.contains("migrations") && low.contains("execut") {
            if let Some(n) = leading_number(l) {
                return Some(format!("{} migrations", commas(n)));
            }
        }
        if low.contains("no migrations are pending") || low.contains("already up to date") {
            return Some("none pending".into());
        }
    }

    // ── database creation ──
    if (c.contains("createdb") || c.contains("db:create")) && (low.contains("created") || low.contains("database")) {
        return Some("created".into());
    }

    None
}

/// Minimum gap between forwarded output lines — npm can emit thousands of
/// lines; anything faster than this is dropped (step markers always pass).
const STREAM_THROTTLE: std::time::Duration = std::time::Duration::from_millis(120);

/// Run a list of commands sequentially via login shell on the pinned Node, with
/// `vars` + path vars exposed. Streams each command's output line-by-line
/// through `progress` (throttled); stops at the first failure.
async fn run_commands(
    wt_path: &str,
    repo_path: &str,
    cmds: &[String],
    vars: &HashMap<String, String>,
    label: &str,
    progress: &mut impl FnMut(Progress),
) -> Result<(), String> {
    run_commands_in(wt_path, wt_path, repo_path, cmds, vars, label, 0, Numbering::Own, progress).await
}

/// As `run_commands`, but with an explicit working directory and per-step
/// timeout. `wt_path` stays separate from `cwd` because WT_PATH/WTM_WORKTREE
/// must keep pointing at the worktree root even when a task runs in a
/// subdirectory — a task in `server/` still belongs to the same worktree.
#[allow(clippy::too_many_arguments)]
async fn run_commands_in(
    cwd: &str,
    wt_path: &str,
    repo_path: &str,
    cmds: &[String],
    vars: &HashMap<String, String>,
    label: &str,
    timeout_secs: u64,
    numbering: Numbering,
    progress: &mut impl FnMut(Progress),
) -> Result<(), String> {
    for (i, cmd) in cmds.iter().enumerate() {
        if let Some(head) = numbering.header(label, i, cmds.len(), cmd) {
            progress(Progress::Line(head));
        }
        let wrapped = crate::toolchain::with_pinned_node(cwd, cmd);
        let (shell, shargs) = crate::toolchain::shell_argv(&wrapped);
        let mut child = Command::new(shell)
            .args(&shargs)
            .current_dir(cwd)
            .envs(vars) // WT_*/WM_* etc.
            .env("WTM_REPO", repo_path)
            .env("WTM_WORKTREE", wt_path)
            .env("REPO_PATH", repo_path)
            .env("WT_PATH", wt_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("{label} spawn failed: {e}"))?;

        let mut out_lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut err_lines = BufReader::new(child.stderr.take().unwrap()).lines();
        // last stderr lines, kept for the failure message
        let mut stderr_tail: VecDeque<String> = VecDeque::new();
        let mut last_emit = std::time::Instant::now() - STREAM_THROTTLE;
        // The first recognised quantity this step produced. Scanned on the fly
        // rather than from a retained buffer: the throttle drops most lines
        // before they are ever forwarded, and the line carrying the count is
        // routinely one of the dropped ones.
        let mut found: Option<String> = None;
        let mut emit = |line: &str, progress: &mut dyn FnMut(Progress)| {
            let t = line.trim_end();
            if t.is_empty() {
                return;
            }
            if found.is_none() {
                found = match_step_result(cmd, t);
            }
            if last_emit.elapsed() >= STREAM_THROTTLE {
                progress(Progress::Line(t.to_string()));
                last_emit = std::time::Instant::now();
            }
        };
        // hard ceiling per command: npm installs legitimately run long, but a
        // command stuck on a dead registry or waiting for input it can never
        // get (stdin is null) must not hang setup forever.
        const DEFAULT_STEP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60 * 60);
        let step_timeout = if timeout_secs == 0 {
            DEFAULT_STEP_TIMEOUT
        } else {
            std::time::Duration::from_secs(timeout_secs)
        };
        let run_fut = async {
            let (mut out_done, mut err_done) = (false, false);
            while !(out_done && err_done) {
                tokio::select! {
                    l = out_lines.next_line(), if !out_done => match l {
                        Ok(Some(line)) => emit(&line, progress),
                        _ => out_done = true,
                    },
                    l = err_lines.next_line(), if !err_done => match l {
                        Ok(Some(line)) => {
                            stderr_tail.push_back(line.clone());
                            if stderr_tail.len() > 64 {
                                stderr_tail.pop_front();
                            }
                            emit(&line, progress);
                        }
                        _ => err_done = true,
                    },
                }
            }
            child.wait().await
        };
        let status = match tokio::time::timeout(step_timeout, run_fut).await {
            Ok(res) => res.map_err(|e| format!("{label} wait failed: {e}"))?,
            Err(_) => {
                // kills the shell; its own children get EOF on the shared pipes
                let _ = child.kill().await;
                return Err(format!("{label} step timed out after {}s: {cmd}", step_timeout.as_secs()));
            }
        };
        if !status.success() {
            // surface the first real error line plus the tail, so messages like
            // "Cannot find module" aren't buried under a stack.
            let headline = stderr_tail
                .iter()
                .find(|l| {
                    let t = l.trim_start();
                    t.starts_with("Error") || t.contains("npm error") || t.contains("ERR!") || t.contains("Cannot find")
                })
                .map(|l| format!("{}\n", l.trim()))
                .unwrap_or_default();
            let tail: Vec<&str> = stderr_tail.iter().rev().take(10).map(|s| s.as_str()).collect();
            let tail: String = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(format!("{label} step failed: {cmd}\n{headline}{tail}"));
        }
        if let Some(text) = found {
            progress(Progress::StepResult { index: numbering.index(i), text });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /* Step numbering — the runner builds its step list from these markers.

       `run_tasks` announces each task and then runs it as a ONE-command list,
       so the inner call must not number it again. When it did, every task
       reported "[1/1]": the footer read "Step 1 of 1" for a five-task run, and
       every task's output was filed under task 1. */
    #[test]
    fn lifecycle_edits_preserve_unknown_keys_and_fail_closed() {
        let dir = std::env::temp_dir().join(format!("canopy-lifecycle-edit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(".worktreemanager.json");
        std::fs::write(&file, r#"{"custom":{"keep":true},"teardown":["old"]}"#).unwrap();
        write_repo_config_sections(dir.to_str().unwrap(), &[], &[], None, Some(&["new".into()]), Some(&["migrate".into()])).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(value["custom"]["keep"], true);
        assert_eq!(value["teardown"][0], "new");
        assert_eq!(value["migrate"][0], "migrate");
        std::fs::write(&file, "{broken").unwrap();
        assert!(write_repo_config_sections(dir.to_str().unwrap(), &[], &[], None, Some(&[]), None).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{broken");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_caller_numbered_step_neither_renumbers_nor_re_announces() {
        // teardown/migrate hand over the whole list, so that call numbers it
        assert_eq!(Numbering::Own.header("setup", 0, 3, "pnpm install").as_deref(), Some("setup [1/3]: pnpm install"));
        assert_eq!(Numbering::Own.index(0), 1);
        assert_eq!(Numbering::Own.index(2), 3);

        // setup announces the task itself, then runs it alone
        assert_eq!(Numbering::Caller(4).header("setup", 0, 1, "pnpm install"), None);
        assert_eq!(Numbering::Caller(4).index(0), 4, "the result belongs to task 4, not step 1");
    }

    #[tokio::test]
    async fn every_setup_task_announces_its_own_number_exactly_once() {
        let dir = std::env::temp_dir().join("canopy_step_numbering_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_str().unwrap();

        let tasks = vec![
            SetupTask::plain("echo one"),
            SetupTask { cmd: "echo two".into(), cwd: String::new(), enabled: false },
            SetupTask::plain("echo three"),
        ];
        let mut lines: Vec<String> = Vec::new();
        run_tasks(d, d, &tasks, &SetupPolicy::default(), &HashMap::new(), false, false, &mut |p| {
            if let Progress::Line(l) = p {
                lines.push(l);
            }
        })
        .await
        .unwrap();

        let markers: Vec<&str> = lines.iter().filter(|l| l.starts_with("setup [")).map(|s| s.as_str()).collect();
        assert_eq!(
            markers,
            vec!["setup [1/2]: echo one", "setup [2/2]: echo three"],
            "one marker per enabled task, numbered over the enabled ones — got {lines:?}"
        );
        assert!(
            lines.iter().any(|l| l.contains("skipped (disabled): echo two")),
            "a disabled task is reported, not omitted — got {lines:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn setup_accepts_strings_and_objects_and_round_trips_plainly() {
        let dir = std::env::temp_dir().join("canopy_setup_tasks_test_xyz");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_str().unwrap();

        // A pre-existing config — a bare array of strings — must keep meaning
        // exactly what it always did.
        std::fs::write(dir.join(".worktreemanager.json"), r#"{ "setup": ["pnpm install", "pnpm db:migrate"] }"#).unwrap();
        let c = read_repo_config(d);
        assert_eq!(c.setup, vec![SetupTask::plain("pnpm install"), SetupTask::plain("pnpm db:migrate")]);
        assert_eq!(c.setup_policy, SetupPolicy::default(), "no policy key = built-in behaviour");

        // Objects carry cwd/enabled; a mixed array is fine.
        std::fs::write(
            dir.join(".worktreemanager.json"),
            r#"{ "setup": ["pnpm install", {"cmd":"pnpm build","cwd":"server"}, {"cmd":"seed","enabled":false}, 42],
                 "setupPolicy": {"onFailure":"continue","timeoutSecs":90} }"#,
        )
        .unwrap();
        let c = read_repo_config(d);
        assert_eq!(c.setup.len(), 3, "a non-string, non-object entry is skipped, not turned into an empty command");
        assert_eq!(c.setup[1].cwd, "server");
        assert!(c.setup[0].enabled, "enabled defaults to true");
        assert!(!c.setup[2].enabled);
        assert!(c.setup_policy.continue_on_failure);
        assert_eq!(c.setup_policy.timeout_secs, 90);

        // Writing back: a plain task stays a bare string, so enabling one
        // option on one task doesn't rewrite every line of the file.
        let tasks = vec![
            SetupTask::plain("pnpm install"),
            SetupTask { cmd: "pnpm build".into(), cwd: "server".into(), enabled: true },
            SetupTask { cmd: "seed".into(), cwd: String::new(), enabled: false },
        ];
        write_repo_config(d, &[], &tasks, Some(&SetupPolicy::default())).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".worktreemanager.json")).unwrap()).unwrap();
        assert_eq!(v["setup"][0], "pnpm install", "plain task round-trips as a string");
        assert_eq!(v["setup"][1]["cwd"], "server");
        assert_eq!(v["setup"][2]["enabled"], false);
        assert!(v.get("setupPolicy").is_none(), "a default policy is not written");

        write_repo_config(d, &[], &tasks, Some(&SetupPolicy { continue_on_failure: true, timeout_secs: 30 })).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".worktreemanager.json")).unwrap()).unwrap();
        assert_eq!(v["setupPolicy"]["onFailure"], "continue");
        assert_eq!(v["setupPolicy"]["timeoutSecs"], 30);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn setup_marker_round_trips_and_infers_for_legacy_worktrees() {
        let dir = std::env::temp_dir().join("canopy_setup_marker_test_xyz");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_str().unwrap();
        // a repo that declares one provisioned file + a setup command
        std::fs::write(
            dir.join(".worktreemanager.json"),
            r#"{ "provision": [{"path": ".env", "format": "dotenv", "keys": {"A": "1"}}], "setup": ["echo hi"] }"#,
        )
        .unwrap();

        // no marker, no provisioned file → never provisioned, but configured
        let (state, configured) = setup_status(d, d);
        assert!(state.is_none(), "no marker and no provisioned file = never ran");
        assert!(configured, "the repo declares provisioning");

        // legacy worktree: the declared file exists but no marker was ever
        // written — inferred rather than reported as unprovisioned
        std::fs::write(dir.join(".env"), "A=1\n").unwrap();
        let (state, _) = setup_status(d, d);
        let state = state.expect("presence of every declared file infers a run");
        assert_eq!(state.source, SetupSource::Inferred);
        assert!(state.ran_at.is_none(), "an inferred run has no timestamp");
        assert!(state.ok);

        // a real run writes the marker, which outranks the inference
        write_setup_marker(d, true);
        let (state, _) = setup_status(d, d);
        let state = state.expect("marker present");
        assert_eq!(state.source, SetupSource::Marker, "the marker wins over inference");
        assert!(state.ran_at.unwrap() > 0, "marker carries a timestamp");
        assert!(state.ok);
        assert_eq!(std::fs::read_to_string(dir.join(".canopy/.gitignore")).unwrap(), "*\n", "marker dir self-ignores");

        // a failed run is recorded as a failure, not as "never ran" — the UI
        // needs to distinguish half-provisioned from untouched
        write_setup_marker(d, false);
        let (state, _) = setup_status(d, d);
        assert!(!state.expect("marker present").ok, "failure is recorded");

        // a corrupt marker falls back to inference rather than being trusted
        std::fs::write(dir.join(".canopy/setup.json"), "{ truncated").unwrap();
        let (state, _) = setup_status(d, d);
        assert_eq!(state.expect("falls back").source, SetupSource::Inferred);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn setup_status_reports_unconfigured_repos() {
        let dir = std::env::temp_dir().join("canopy_setup_unconfigured_test_xyz");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_str().unwrap();
        // no .worktreemanager.json at all → nothing to provision, so a missing
        // marker must NOT read as an actionable "never provisioned"
        let (state, configured) = setup_status(d, d);
        assert!(state.is_none());
        assert!(!configured, "no config = nothing to run");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_dotenv_reads_the_shapes_we_write() {
        let text = "# comment\n\nPORT=3160\nexport PG_DB=tj_history\nQUOTED=\"a b\"\nSINGLE='c d'\nEMPTY=\nURL=postgres://h/db?x=1\nnot a pair\n";
        let pairs = parse_dotenv(text);
        assert_eq!(pairs[0], ("PORT".into(), "3160".into()));
        assert_eq!(pairs[1], ("PG_DB".into(), "tj_history".into()), "export prefix stripped");
        assert_eq!(pairs[2], ("QUOTED".into(), "a b".into()), "one layer of double quotes");
        assert_eq!(pairs[3], ("SINGLE".into(), "c d".into()), "one layer of single quotes");
        assert_eq!(pairs[4], ("EMPTY".into(), String::new()));
        assert_eq!(pairs[5], ("URL".into(), "postgres://h/db?x=1".into()), "only the first = splits");
        assert_eq!(pairs.len(), 6, "comments, blanks and non-pairs skipped");
    }

    #[test]
    fn step_results_are_specific_quantities_or_nothing() {
        let install = "pnpm install";
        // npm
        assert_eq!(
            match_step_result(install, "added 1842 packages in 41s"),
            Some("1,842 packages".into()),
            "grouped, because a bare 1842 reads as an id"
        );
        // pnpm
        assert_eq!(match_step_result(install, "Packages: +1842"), Some("1,842 packages".into()));
        // the no-op is worth reporting — it's what people re-run setup to confirm
        assert_eq!(match_step_result(install, "up to date, audited 12 packages"), Some("up to date".into()));

        // migrations, across the runners a repo might use
        let migrate = "pnpm db:migrate";
        assert_eq!(match_step_result(migrate, "Batch 1 run: 37 migrations"), Some("37 migrations".into()));
        assert_eq!(
            match_step_result(migrate, "37 migrations were successfully executed"),
            Some("37 migrations".into())
        );
        assert_eq!(match_step_result(migrate, "No migrations are pending"), Some("none pending".into()));

        // ── the negative cases matter more ──
        // ordinary output from a recognised command is NOT a result
        assert_eq!(match_step_result(install, "Progress: resolved 900, reused 880"), None);
        assert_eq!(match_step_result(migrate, "using environment: development"), None);
        // an unrecognised command produces nothing at all, however chatty
        assert_eq!(match_step_result("pnpm build:plugins", "added 12 chunks"), None);
        assert_eq!(match_step_result("pnpm build", "Done in 3.2s"), None);
        // a count from the wrong command kind is not borrowed
        assert_eq!(match_step_result("echo hello", "added 1842 packages"), None);
    }

    #[test]
    fn commas_groups_thousands() {
        assert_eq!(commas(0), "0");
        assert_eq!(commas(37), "37");
        assert_eq!(commas(999), "999");
        assert_eq!(commas(1842), "1,842");
        assert_eq!(commas(12345), "12,345");
        assert_eq!(commas(1234567), "1,234,567");

    }

    #[test]
    fn wt_slug_is_db_safe() {
        assert_eq!(wt_slug("/Users/me/wt/Feat-X.2"), "feat_x_2");
        assert_eq!(wt_slug("/w/plain"), "plain");
    }

    #[test]
    fn interpolates_braced_vars() {
        let mut v = HashMap::new();
        v.insert("WT_DB_NAME".to_string(), "tooljet_feature_x".to_string());
        v.insert("WT_SERVER_PORT".to_string(), "3010".to_string());
        assert_eq!(interpolate("${WT_DB_NAME}", &v), "tooljet_feature_x");
        assert_eq!(interpolate("http://localhost:${WT_SERVER_PORT}/api", &v), "http://localhost:3010/api");
        assert_eq!(interpolate("${UNKNOWN}", &v), "${UNKNOWN}"); // left as-is
    }

    #[test]
    fn dotenv_upserts_and_preserves() {
        let existing = "PG_HOST=localhost\nPG_DB=tooljet_prod\nPORT=3000\nSECRET=keep\n";
        let pairs = vec![
            ("PG_DB".to_string(), "tooljet_feature_x".to_string()),
            ("PORT".to_string(), "3010".to_string()),
            ("TOOLJET_SERVER_PORT".to_string(), "3010".to_string()),
        ];
        let out = upsert_dotenv_str(existing, &pairs);
        assert!(out.contains("PG_HOST=localhost"), "preserves untouched keys");
        assert!(out.contains("SECRET=keep"), "preserves untouched keys");
        assert!(out.contains("PG_DB=tooljet_feature_x"), "replaces PG_DB");
        assert!(out.contains("PORT=3010"), "replaces PORT");
        assert!(out.contains("TOOLJET_SERVER_PORT=3010"), "adds new key");
        assert_eq!(out.matches("PG_DB=").count(), 1, "no duplicate keys");
        assert_eq!(out.matches("PORT=").count(), 2, "PORT + TOOLJET_SERVER_PORT only");
    }

    #[test]
    fn json_upserts_dotted_keys() {
        let existing = "{\n  \"baseUrl\": \"http://old\",\n  \"keep\": true\n}";
        let pairs = vec![
            ("baseUrl".to_string(), "http://localhost:8082".to_string()),
            ("db.name".to_string(), "tooljet_feature_x".to_string()),
        ];
        let out = upsert_json_str(existing, &pairs).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["baseUrl"], "http://localhost:8082", "replaces top-level scalar");
        assert_eq!(v["db"]["name"], "tooljet_feature_x", "creates nested from dotted key");
        assert_eq!(v["keep"], true, "preserves untouched keys");
    }

    #[test]
    fn dotenv_handles_export_prefix() {
        let existing = "export PG_DB=old\nKEEP=1\n";
        let pairs = vec![("PG_DB".to_string(), "new_db".to_string())];
        let out = upsert_dotenv_str(existing, &pairs);
        assert!(out.contains("PG_DB=new_db"), "replaces export-prefixed key");
        assert!(!out.contains("export PG_DB=old"), "old export line removed");
        assert!(out.contains("KEEP=1"), "preserves other lines");
        assert_eq!(out.matches("PG_DB=").count(), 1, "no duplicate keys");
    }

    #[test]
    fn json_refuses_malformed_input() {
        // JSONC / trailing commas / half-edited files must NOT be wiped to {}
        let malformed = "{ \"a\": 1, }";
        let pairs = vec![("a".to_string(), "2".to_string())];
        let err = upsert_json_str(malformed, &pairs).unwrap_err();
        assert!(err.contains("malformed JSON"), "surfaces a parse error: {err}");
        // empty input is still fine (fresh file)
        assert!(upsert_json_str("", &pairs).is_ok());
    }

    #[test]
    fn write_repo_config_preserves_extras_and_refuses_malformed() {
        let dir = std::env::temp_dir().join("canopy_cfg_test_xyz");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cfg_path = dir.join(".worktreemanager.json");

        // valid existing file with extra keys → preserved, legacy env dropped
        std::fs::write(&cfg_path, r#"{ "env": {"A": "1"}, "teardown": ["dropdb"], "migrate": ["npm run m"] }"#).unwrap();
        let prov = vec![ProvisionFile {
            path: ".env".into(),
            format: "dotenv".into(),
            from: String::new(),
            interpolate: false,
            keys: vec![("A".into(), "1".into())],
        }];
        write_repo_config(dir.to_str().unwrap(), &prov, &[SetupTask::plain("echo hi")], None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&cfg_path).unwrap()).unwrap();
        assert!(v.get("env").is_none(), "legacy env dropped");
        assert_eq!(v["teardown"][0], "dropdb", "teardown preserved");
        assert_eq!(v["migrate"][0], "npm run m", "migrate preserved");
        assert_eq!(v["provision"][0]["path"], ".env");
        assert_eq!(v["$schema"], "canopy://worktree-manager/v1");

        // malformed existing file → hard error, file untouched
        std::fs::write(&cfg_path, "{ not json").unwrap();
        let err = write_repo_config(dir.to_str().unwrap(), &prov, &[], None).unwrap_err();
        assert!(err.contains("malformed"), "refuses to overwrite: {err}");
        assert_eq!(std::fs::read_to_string(&cfg_path).unwrap(), "{ not json", "file untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_config_migrates_legacy_env() {
        let dir = std::env::temp_dir().join("canopy_legacy_test_xyz");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".worktreemanager.json"),
            r#"{ "env": {"PG_DB": "${WT_DB_NAME}"}, "setup": ["echo hi"] }"#,
        )
        .unwrap();
        let c = read_repo_config(dir.to_str().unwrap());
        assert_eq!(c.provision.len(), 1, "legacy env becomes one provision entry");
        assert_eq!(c.provision[0].path, ".env");
        assert_eq!(c.provision[0].format, "dotenv");
        assert_eq!(c.provision[0].keys, vec![("PG_DB".to_string(), "${WT_DB_NAME}".to_string())]);
        assert_eq!(c.setup, vec![SetupTask::plain("echo hi")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn provision_rejects_escaping_paths() {
        let dir = std::env::temp_dir().join("canopy_contain_test_xyz");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let vars = HashMap::new();
        let mk = |path: &str, from: &str| ProvisionFile {
            path: path.into(),
            format: "dotenv".into(),
            from: from.into(),
            interpolate: false,
            keys: vec![("K".into(), "v".into())],
        };
        let d = dir.to_str().unwrap();
        assert!(provision_file(d, d, &mk("../escape.env", ""), &vars).is_err(), "rejects ..");
        assert!(provision_file(d, d, &mk("/etc/hosts", ""), &vars).is_err(), "rejects absolute");
        assert!(provision_file(d, d, &mk("ok.env", "../secrets"), &vars).is_err(), "rejects .. in from");
        assert!(provision_file(d, d, &mk("sub/ok.env", ""), &vars).is_ok(), "accepts subpath");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn yaml_detects_four_space_indent() {
        let existing = "development:\n    database: old_db\n    host: localhost\n";
        let pairs = vec![
            ("development.database".to_string(), "new_db".to_string()),
            ("production.database".to_string(), "prod_db".to_string()),
        ];
        let out = upsert_yaml_str(existing, &pairs);
        assert!(out.contains("    database: new_db"), "replaces at the file's own indent: {out}");
        assert_eq!(out.matches("database:").count(), 2, "replaced + appended, no duplicates: {out}");
        assert!(out.contains("production:\n    database: prod_db"), "appends with detected indent: {out}");
    }

    #[test]
    fn yaml_replaces_existing_and_appends_missing() {
        let existing = "# db config\ndevelopment:\n  database: old_db\n  host: localhost\ntest:\n  database: old_test\n";
        let pairs = vec![
            ("development.database".to_string(), "tooljet_feature_x".to_string()),
            ("test.database".to_string(), "tooljet_feature_x_test".to_string()),
            ("production.database".to_string(), "brand_new".to_string()),
        ];
        let out = upsert_yaml_str(existing, &pairs);
        assert!(out.contains("# db config"), "preserves comments");
        assert!(out.contains("  database: tooljet_feature_x\n"), "replaces nested value");
        assert!(out.contains("  host: localhost"), "preserves sibling");
        assert!(out.contains("  database: tooljet_feature_x_test"), "replaces second block");
        assert!(out.contains("production:") && out.contains("  database: brand_new"), "appends missing block");
    }
}
