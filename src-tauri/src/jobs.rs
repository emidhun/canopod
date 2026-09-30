//! Bounded durable job journal. Execution/leases remain in shared operations.
//! MCP creation/setup uses this journal. The runtime owner
//! must outlive the registry and all flush tasks; only one registry may write it.
#[path = "job_output.rs"]
pub(crate) mod capture;
use crate::credentials::PrivateSnapshots;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex as AsyncMutex, Notify, Semaphore};

// Scoped to an owned MCP job. Ordinary UI operations have no cancellation token.
tokio::task_local! { static EXECUTION_CANCEL: (crate::runtime::RuntimeContext, tokio_util::sync::CancellationToken); }
pub(crate) async fn with_cancellation<T>(app: crate::runtime::RuntimeContext, token: tokio_util::sync::CancellationToken, work: impl std::future::Future<Output = T>) -> T {
    EXECUTION_CANCEL.scope((app, token), work).await
}
pub(crate) fn is_cancelled() -> bool {
    EXECUTION_CANCEL.try_with(|(_, token)| token.is_cancelled()).unwrap_or(false)
}
pub(crate) async fn cancelled() {
    match EXECUTION_CANCEL.try_with(|(_, token)| token.clone()) {
        Ok(token) => token.cancelled().await,
        Err(_) => std::future::pending::<()>().await,
    }
}
pub(crate) fn prepare_output(repo: &str, wt: &str, cwd: &str, vars: &std::collections::HashMap<String, String>) {
    let _ = EXECUTION_CANCEL.try_with(|(app, _)| capture::prepare(app, repo, wt, cwd, vars));
}
pub(crate) fn is_tracked() -> bool { EXECUTION_CANCEL.try_with(|_| ()).is_ok() }

#[cfg(unix)]
pub(crate) struct CommandRecord { app: crate::runtime::RuntimeContext, key: String, pgid: i32 }
#[cfg(unix)]
pub(crate) fn track_group(group: &crate::proc::ProcGroup) -> Option<CommandRecord> {
    let app = EXECUTION_CANCEL.try_with(|(app, _)| app.clone()).ok()?;
    let pgid = crate::proc::group_key(group) as i32;
    let key = format!("mcp-job-process::{pgid}");
    app.state::<crate::state::AppState>().retained_orphans.lock().push(crate::settings::OrphanProc {
        svc_key: key.clone(), pgid, spawn_time_secs: now() / 1000, owner: crate::ownership::current_process_owner(),
    });
    crate::services::persist_orphans(&app);
    Some(CommandRecord { app, key, pgid })
}
#[cfg(unix)]
impl Drop for CommandRecord {
    fn drop(&mut self) {
        self.app.state::<crate::state::AppState>().retained_orphans.lock().retain(|record| record.svc_key != self.key || record.pgid != self.pgid);
        crate::services::persist_orphans(&self.app);
    }
}

#[derive(Clone)]
pub(crate) struct Tracking { pub registry: Arc<Registry>, pub id: String }
impl Tracking {
    pub async fn created(&self, path: &str) -> Result<()> {
        self.registry.created(&self.id, path.to_owned()).await
    }
}

pub const RETAINED_JOBS: usize = 128;
pub const ACTIVE_JOBS: usize = 4;
pub const OUTPUT_BYTES: usize = 256 * 1024;
const SNAPSHOT_BYTES: usize = OUTPUT_BYTES + 32 * 1024;
fn bounded_path(path: &str) -> bool {
    !path.is_empty() && serde_json::to_vec(path).is_ok_and(|bytes| bytes.len() <= 4096)
}
// Accepted inputs fit below these defensive limits: encoded target <=4 KiB,
// merged outcome <=20 KiB, and bounded IDs/repo metadata fit the remaining
// 7 KiB. Output is independently capped at 256 KiB; the final 1 KiB covers the
// snapshot envelope. These checks guard future fields and hand-edited records.
fn encode_snapshot(snapshot: &Snapshot) -> Result<Vec<u8>> {
    if serde_json::to_vec(&snapshot.record)
        .map_err(JournalError::storage)?
        .len()
        > 31 * 1024
    {
        return Err(JournalError::new(
            "invalid_input",
            "job metadata exceeds retention limit",
        ));
    }
    let bytes = serde_json::to_vec(snapshot).map_err(JournalError::storage)?;
    if bytes.len() > SNAPSHOT_BYTES {
        return Err(JournalError::new(
            "invalid_input",
            "job snapshot exceeds retention limit",
        ));
    }
    Ok(bytes)
}
const RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const LINE_BYTES: usize = 4096;
const SECRET_KEY_PATTERN: &str =
    r"password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key";
fn sensitive_key(key: &str) -> bool {
    static KEYS: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(&format!("(?i)(?:{SECRET_KEY_PATTERN})")).unwrap());
    KEYS.is_match(key)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalError {
    pub code: &'static str,
    pub message: String,
    pub retry_after_ms: Option<u64>,
}
impl JournalError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retry_after_ms: None,
        }
    }
    fn storage(error: impl std::fmt::Display) -> Self {
        Self::new("storage", format!("job persistence failed: {error}"))
    }
    fn busy() -> Self {
        Self {
            code: "busy",
            message: "job capacity is full".into(),
            retry_after_ms: Some(500),
        }
    }
}
impl std::fmt::Display for JournalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for JournalError {}
type Result<T> = std::result::Result<T, JournalError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Create,
    Setup,
    Migrate,
    Custom,
    Snapshot,
    Export,
    Restore,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Queued,
    Running,
    Succeeded,
    Failed,
    Interrupted,
}
impl Status {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Interrupted)
    }
}

pub struct Submission {
    pub operation: Operation,
    pub repo_id: String,
    pub target: String,
    pub request_key: String,
    pub payload: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Failure {
    pub code: String,
    pub message: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Outcome {
    #[serde(default)]
    pub details_truncated: bool,
    pub result: Option<Value>,
    pub error: Option<Failure>,
    pub exit_code: Option<i32>,
    /// Set as soon as creation succeeds, including a later provisioning failure.
    pub created_path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub id: String,
    pub operation: Operation,
    pub repo_id: String,
    pub target: String,
    request_hash: String,
    payload_hash: String,
    pub created_at_ms: u64,
    pub started_at_ms: Option<u64>,
    pub finished_at_ms: Option<u64>,
    pub status: Status,
    pub next_sequence: u64,
    pub output_complete: bool,
    pub outcome: Outcome,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutputLine {
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub text: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    version: u8,
    record: Record,
    output: VecDeque<OutputLine>,
}
struct Entry {
    snapshot: Snapshot,
    output_bytes: usize,
    revision: u64,
    persisted_revision: u64,
    persisted_sequence: u64,
    durability_error: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub record: Record,
    pub persisted_sequence: u64,
    pub persistence_pending: bool,
    pub durability_error: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub lines: Vec<OutputLine>,
    pub next_cursor: u64,
    pub earliest_cursor: u64,
    pub has_more: bool,
    pub output_complete: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    pub job: View,
    pub reused: bool,
}

/// Known secret values plus conservative credential-shaped text filtering.
/// It is a best-effort filter, not a guarantee that arbitrary programs cannot
/// print secrets. Filtering happens before bytes enter either ring or disk.
#[derive(Clone, Default)]
pub struct SecretFilter {
    matcher: Option<Arc<aho_corasick::AhoCorasick>>,
}
impl SecretFilter {
    pub fn new(mut values: Vec<String>) -> Result<Self> {
        if values.len() > 256
            || values.iter().any(|v| v.len() > 4096)
            || values.iter().map(String::len).sum::<usize>() > 64 * 1024
        {
            return Err(JournalError::new(
                "invalid_input",
                "secret filter exceeds its bound",
            ));
        }
        values.retain(|v| !v.is_empty());
        values.sort();
        values.dedup();
        let matcher = if values.is_empty() {
            None
        } else {
            Some(Arc::new(
                aho_corasick::AhoCorasickBuilder::new()
                    .match_kind(aho_corasick::MatchKind::LeftmostLongest)
                    .build(values)
                    .map_err(JournalError::storage)?,
            ))
        };
        Ok(Self { matcher })
    }
    pub(crate) fn text(&self, input: &str) -> (String, bool) {
        if input.len() > 64 * 1024 {
            return ("[oversized output omitted]".into(), true);
        }
        static URL: LazyLock<regex::Regex> = LazyLock::new(|| {
            regex::Regex::new(r"(?i)([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^@\s]+@").unwrap()
        });
        static BEARER: LazyLock<regex::Regex> =
            LazyLock::new(|| regex::Regex::new(r"(?i)\bBearer\s+[^\s,;]+").unwrap());
        static ASSIGNMENT: LazyLock<regex::Regex> = LazyLock::new(|| {
            regex::Regex::new(&format!(
            r#"(?i)((?:[\w-]*(?:{SECRET_KEY_PATTERN})[\w-]*)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)"#
        )).unwrap()
        });
        // Match only original bytes: a replacement must never be rescanned as
        // another secret (which can amplify output or leak overlapping values).
        let mut value = match &self.matcher {
            Some(matcher) => {
                matcher.replace_all(input, &vec!["[REDACTED]"; matcher.patterns_len()])
            }
            None => input.to_owned(),
        };
        value = URL.replace_all(&value, "${1}[REDACTED]@").into_owned();
        value = BEARER.replace_all(&value, "Bearer [REDACTED]").into_owned();
        value = ASSIGNMENT
            .replace_all(&value, "${1}[REDACTED]")
            .into_owned();
        let truncated = value.len() > LINE_BYTES;
        if truncated {
            let mut end = LINE_BYTES;
            while !value.is_char_boundary(end) {
                end -= 1;
            }
            value.truncate(end);
        }
        (value, truncated)
    }
    fn outcome(&self, mut value: Outcome) -> Result<Outcome> {
        let encoded = serde_json::to_vec(&value).map_err(JournalError::storage)?;
        if encoded.len() > 16 * 1024 {
            return Err(JournalError::new(
                "invalid_input",
                "job outcome exceeds 16 KiB",
            ));
        }
        fn redact(
            filter: &SecretFilter,
            value: &mut Value,
            depth: usize,
            truncated: &mut bool,
        ) -> Result<()> {
            if depth > 32 {
                return Err(JournalError::new(
                    "invalid_input",
                    "job outcome is too deeply nested",
                ));
            }
            match value {
                Value::String(text) => {
                    let (filtered, cut) = filter.text(text);
                    *text = filtered;
                    *truncated |= cut;
                }
                Value::Array(items) => {
                    for item in items {
                        redact(filter, item, depth + 1, truncated)?;
                    }
                }
                Value::Object(items) => {
                    for (key, item) in items {
                        if sensitive_key(key) {
                            *item = Value::String("[REDACTED]".into());
                        } else {
                            redact(filter, item, depth + 1, truncated)?;
                        }
                    }
                }
                _ => {}
            }
            Ok(())
        }
        if let Some(result) = &mut value.result {
            redact(self, result, 0, &mut value.details_truncated)?;
        }
        if let Some(error) = &mut value.error {
            let (message, cut) = self.text(&error.message);
            error.message = message;
            value.details_truncated |= cut;
            if error.code.is_empty()
                || error.code.len() > 64
                || !error
                    .code
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                return Err(JournalError::new("invalid_input", "invalid job error code"));
            }
        }
        if value
            .created_path
            .as_ref()
            .is_some_and(|path| !bounded_path(path))
        {
            return Err(JournalError::new(
                "invalid_input",
                "invalid created worktree path",
            ));
        }
        if serde_json::to_vec(&value)
            .map_err(JournalError::storage)?
            .len()
            > 16 * 1024
        {
            return Err(JournalError::new(
                "invalid_input",
                "redacted job outcome exceeds 16 KiB",
            ));
        }
        Ok(value)
    }
}

pub struct Registry {
    store: Arc<PrivateSnapshots>,
    entries: Mutex<Vec<Option<Entry>>>,
    /// Every writer takes this before reading a snapshot or selecting a slot.
    /// Old queued flushes therefore cannot overwrite a reused slot.
    writer: AsyncMutex<()>,
    changed: Notify,
    transactions: Arc<Semaphore>,
    closed: AtomicBool,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn hash(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
fn canonical(value: &Value, depth: usize) -> Result<Value> {
    if depth > 32 {
        return Err(JournalError::new(
            "invalid_input",
            "job payload is too deeply nested",
        ));
    }
    Ok(match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            let mut result = serde_json::Map::new();
            for key in keys {
                result.insert(key.clone(), canonical(&map[key], depth + 1)?);
            }
            Value::Object(result)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| canonical(v, depth + 1))
                .collect::<Result<_>>()?,
        ),
        other => other.clone(),
    })
}
fn view(entry: &Entry) -> View {
    View {
        record: entry.snapshot.record.clone(),
        persisted_sequence: entry.persisted_sequence,
        persistence_pending: entry.revision != entry.persisted_revision,
        durability_error: entry.durability_error.clone(),
    }
}
fn encoded_output(lines: &VecDeque<OutputLine>) -> Result<usize> {
    lines
        .iter()
        .map(|line| {
            serde_json::to_vec(line)
                .map(|v| v.len() + 1)
                .map_err(JournalError::storage)
        })
        .sum()
}
impl Registry {
    /// Startup/recovery does blocking bounded I/O. Call before accepting work,
    /// on a blocking worker if opening from an async transport.
    pub fn open(data: &Path) -> Result<Arc<Self>> {
        let store = Arc::new(PrivateSnapshots::open(data).map_err(JournalError::storage)?);
        let mut entries = Vec::with_capacity(RETAINED_JOBS);
        let mut ids = std::collections::HashSet::new();
        let mut request_keys = std::collections::HashSet::new();
        for slot in 0..RETAINED_JOBS {
            let path = data.join(format!("jobs/job-{slot:03}.json"));
            let storage = |error: &dyn std::fmt::Display| {
                JournalError::storage(format!("{}: {error}", path.display()))
            };
            store.recover_temporary(slot).map_err(|e| {
                JournalError::storage(format!(
                    "{}: {e}",
                    data.join(format!("jobs/job-{slot:03}.tmp")).display()
                ))
            })?;
            let Some(bytes) = store.read(slot, SNAPSHOT_BYTES).map_err(|e| storage(&e))? else {
                entries.push(None);
                continue;
            };
            let mut snapshot: Snapshot = serde_json::from_slice(&bytes).map_err(|e| storage(&e))?;
            let record = &snapshot.record;
            let output_bytes = encoded_output(&snapshot.output).map_err(|e| storage(&e))?;
            if snapshot.version != 1
                || record.id.len() != 32
                || !record.id.bytes().all(|b| b.is_ascii_hexdigit())
                || !ids.insert(record.id.clone())
                || output_bytes > OUTPUT_BYTES
                || serde_json::to_vec(record).map_err(|e| storage(&e))?.len() > 31 * 1024
                || record
                    .outcome
                    .created_path
                    .as_ref()
                    .is_some_and(|p| !bounded_path(p))
                || [&record.request_hash, &record.payload_hash]
                    .iter()
                    .any(|hash| hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()))
                || record.repo_id.is_empty()
                || record.repo_id.len() > 256
                || !bounded_path(&record.target)
                || record.status.terminal() != record.finished_at_ms.is_some()
                || (record.status == Status::Queued && record.started_at_ms.is_some())
                || (record.status == Status::Running && record.started_at_ms.is_none())
                || snapshot
                    .output
                    .back()
                    .map(|line| line.sequence.checked_add(1))
                    != if record.next_sequence == 0 {
                        None
                    } else {
                        Some(Some(record.next_sequence))
                    }
                || snapshot
                    .output
                    .iter()
                    .any(|l| l.text.len() > LINE_BYTES || l.sequence >= record.next_sequence)
                || snapshot
                    .output
                    .iter()
                    .zip(snapshot.output.iter().skip(1))
                    .any(|(a, b)| a.sequence.checked_add(1) != Some(b.sequence))
            {
                return Err(JournalError::new(
                    "corrupt",
                    format!(
                        "invalid job snapshot {}; preserved for diagnosis",
                        path.display()
                    ),
                ));
            }
            if record.status.terminal()
                && now().saturating_sub(record.finished_at_ms.unwrap_or(record.created_at_ms))
                    > RETENTION_MS
            {
                store.remove(slot).map_err(|e| storage(&e))?;
                entries.push(None);
                continue;
            }
            if !request_keys.insert(record.request_hash.clone()) {
                return Err(JournalError::new(
                    "corrupt",
                    format!(
                        "duplicate retained job request identity in {}",
                        path.display()
                    ),
                ));
            }
            let warning = if !record.status.terminal() {
                snapshot.record.status = Status::Interrupted;
                snapshot.record.finished_at_ms = Some(now());
                snapshot.record.output_complete = false;
                snapshot.record.outcome.error = Some(Failure {
                    code: "interrupted".into(),
                    message: "backend stopped before job completion; work was not replayed".into(),
                });
                store
                    .write(slot, &encode_snapshot(&snapshot).map_err(|e| storage(&e))?)
                    .map_err(|e| storage(&e))?
                    .map(|e| e.to_string())
            } else {
                None
            };
            let persisted_sequence = snapshot.record.next_sequence;
            entries.push(Some(Entry {
                snapshot,
                output_bytes,
                revision: 0,
                persisted_revision: 0,
                persisted_sequence,
                durability_error: warning,
            }));
        }
        Ok(Arc::new(Self {
            store,
            entries: Mutex::new(entries),
            writer: AsyncMutex::new(()),
            changed: Notify::new(),
            transactions: Arc::new(Semaphore::new(8)),
            closed: AtomicBool::new(false),
        }))
    }
    // An admitted transaction owns its task through disk commit AND memory
    // publication. Dropping a client future cannot release writer serialization
    // while spawn_blocking still writes a fixed temporary filename.
    async fn transaction<T: Send + 'static, F, Fut>(self: &Arc<Self>, operation: F) -> Result<T>
    where
        F: FnOnce(Arc<Self>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<T>> + Send + 'static,
    {
        if self.closed.load(Ordering::Acquire) {
            return Err(JournalError::new("stopping", "job journal is closing"));
        }
        let permit = self
            .transactions
            .clone()
            .try_acquire_owned()
            .map_err(|_| JournalError::busy())?;
        if self.closed.load(Ordering::Acquire) {
            return Err(JournalError::new("stopping", "job journal is closing"));
        }
        let registry = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            operation(registry).await
        })
        .await
        .map_err(JournalError::storage)?
    }
    /// Stop transaction admission and join every owned write before releasing
    /// runtime ownership. Execution owners must stop/finish jobs first.
    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let _drained = self.transactions.clone().acquire_many_owned(8).await;
        // Synchronize with synchronous appenders that entered before close.
        // The execution owner flushes/finishes jobs before calling close.
        drop(self.entries.lock());
    }
    pub async fn admit(self: &Arc<Self>, request: Submission) -> Result<Admission> {
        self.transaction(move |registry| async move { registry.admit_inner(request).await })
            .await
    }
    async fn admit_inner(&self, request: Submission) -> Result<Admission> {
        if request.repo_id.is_empty()
            || request.repo_id.len() > 256
            || !bounded_path(&request.target)
            || request.request_key.is_empty()
            || request.request_key.len() > 256
        {
            return Err(JournalError::new(
                "invalid_input",
                "invalid job repository, target or request key",
            ));
        }
        let payload =
            serde_json::to_vec(&canonical(&request.payload, 0)?).map_err(JournalError::storage)?;
        if payload.len() > 64 * 1024 {
            return Err(JournalError::new(
                "invalid_input",
                "job payload exceeds 64 KiB",
            ));
        }
        let payload_hash = hash(&payload);
        let request_hash = hash(
            &serde_json::to_vec(&(
                request.operation,
                &request.repo_id,
                &request.target,
                &request.request_key,
            ))
            .map_err(JournalError::storage)?,
        );
        let _writer = self.writer.lock().await;
        let slot = {
            let entries = self.entries.lock();
            for entry in entries.iter().flatten() {
                let record = &entry.snapshot.record;
                if record.request_hash == request_hash && !expired(record) {
                    if record.payload_hash != payload_hash {
                        return Err(JournalError::new(
                            "conflict",
                            "request key was already used with a different payload",
                        ));
                    }
                    return Ok(Admission {
                        job: view(entry),
                        reused: true,
                    });
                }
            }
            if entries
                .iter()
                .flatten()
                .filter(|e| !e.snapshot.record.status.terminal())
                .count()
                >= ACTIVE_JOBS
            {
                return Err(JournalError::busy());
            }
            // Reuse an expired matching slot even if an empty slot exists.
            // Otherwise a clock rollback can revive two durable retry identities.
            let matching = entries.iter().position(|entry| {
                entry
                    .as_ref()
                    .is_some_and(|e| e.snapshot.record.request_hash == request_hash)
            });
            if matching.is_some_and(|slot| {
                entries[slot]
                    .as_ref()
                    .is_some_and(|e| e.revision != e.persisted_revision)
            }) {
                return Err(JournalError::storage(
                    "expired job outcome was not persisted; repair storage and flush the job before retrying",
                ));
            }
            matching
                .or_else(|| entries.iter().position(Option::is_none))
                .or_else(|| {
                    entries
                        .iter()
                        .enumerate()
                        .filter_map(|(i, e)| {
                            e.as_ref()
                                .filter(|e| {
                                    e.snapshot.record.status.terminal()
                                        && e.revision == e.persisted_revision
                                })
                                .map(|e| (i, e.snapshot.record.finished_at_ms.unwrap_or(0)))
                        })
                        .min_by_key(|(_, time)| *time)
                        .map(|(i, _)| i)
                })
                .ok_or_else(JournalError::busy)?
        };
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(JournalError::storage)?;
        let id = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let snapshot = Snapshot {
            version: 1,
            record: Record {
                id,
                operation: request.operation,
                repo_id: request.repo_id,
                target: request.target,
                request_hash,
                payload_hash,
                created_at_ms: now(),
                started_at_ms: None,
                finished_at_ms: None,
                status: Status::Queued,
                next_sequence: 0,
                output_complete: true,
                outcome: Outcome::default(),
            },
            output: VecDeque::new(),
        };
        let warning = self.write(slot, &snapshot).await?;
        let entry = Entry {
            snapshot,
            output_bytes: 0,
            revision: 0,
            persisted_revision: 0,
            persisted_sequence: 0,
            durability_error: warning,
        };
        let job = view(&entry);
        self.entries.lock()[slot] = Some(entry);
        self.changed.notify_waiters();
        Ok(Admission { job, reused: false })
    }
    async fn write(&self, slot: usize, snapshot: &Snapshot) -> Result<Option<String>> {
        let bytes = encode_snapshot(snapshot)?;
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            store
                .write(slot, &bytes)
                .map(|warning| warning.map(|e| e.to_string()))
        })
        .await
        .map_err(JournalError::storage)?
        .map_err(JournalError::storage)
    }
    pub fn get(&self, id: &str) -> Result<View> {
        let entries = self.entries.lock();
        let entry = entries
            .iter()
            .flatten()
            .find(|e| e.snapshot.record.id == id && !expired(&e.snapshot.record))
            .ok_or_else(|| JournalError::new("expired", "job is unknown or outside retention"))?;
        Ok(view(entry))
    }
    /// Record output without disk I/O. Flush on a 250 ms execution timer and
    /// before final completion; callers can distinguish durable sequence from
    /// the current sequence. No unbounded queue or silently dropped enqueue.
    pub fn append(&self, id: &str, text: &str, filter: &SecretFilter) -> Result<()> {
        let (text, truncated) = filter.text(text);
        let mut entries = self.entries.lock();
        if self.closed.load(Ordering::Acquire) {
            return Err(JournalError::new("stopping", "job journal is closing"));
        }
        let entry = find_mut(&mut entries, id)?;
        if entry.snapshot.record.status.terminal() {
            return Err(JournalError::new("conflict", "job has finished"));
        }
        let sequence = entry.snapshot.record.next_sequence;
        let next = sequence
            .checked_add(1)
            .ok_or_else(|| JournalError::new("limit", "job sequence exhausted"))?;
        let line = OutputLine {
            sequence,
            timestamp_ms: now(),
            text,
        };
        entry.output_bytes += serde_json::to_vec(&line)
            .map_err(JournalError::storage)?
            .len()
            + 1;
        entry.snapshot.output.push_back(line);
        while entry.output_bytes > OUTPUT_BYTES {
            let old = entry.snapshot.output.pop_front().unwrap();
            entry.output_bytes -= serde_json::to_vec(&old)
                .map_err(JournalError::storage)?
                .len()
                + 1;
            entry.snapshot.record.output_complete = false;
        }
        entry.snapshot.record.next_sequence = next;
        entry.snapshot.record.output_complete &= !truncated;
        entry.revision += 1;
        self.changed.notify_waiters();
        Ok(())
    }
    pub fn mark_output_incomplete(&self, id: &str) {
        let mut entries = self.entries.lock();
        if let Ok(entry) = find_mut(&mut entries, id) {
            entry.snapshot.record.output_complete = false;
            entry.revision += 1;
        }
    }
    pub fn earliest_cursor(&self, id: &str) -> Result<u64> {
        let entries = self.entries.lock();
        let entry = entries.iter().flatten().find(|e| e.snapshot.record.id == id && !expired(&e.snapshot.record))
            .ok_or_else(|| JournalError::new("expired", "job no longer retained"))?;
        Ok(entry.snapshot.output.front().map(|l| l.sequence).unwrap_or(entry.snapshot.record.next_sequence))
    }
    pub fn output(&self, id: &str, cursor: u64, limit: usize) -> Result<Page> {
        if !(1..=500).contains(&limit) {
            return Err(JournalError::new(
                "invalid_input",
                "output limit must be 1–500",
            ));
        }
        let entries = self.entries.lock();
        let entry = entries
            .iter()
            .flatten()
            .find(|e| e.snapshot.record.id == id && !expired(&e.snapshot.record))
            .ok_or_else(|| JournalError::new("expired", "job is unknown or outside retention"))?;
        let earliest = entry
            .snapshot
            .output
            .front()
            .map(|line| line.sequence)
            .unwrap_or(entry.snapshot.record.next_sequence);
        if cursor < earliest {
            return Err(JournalError::new(
                "cursor_expired",
                format!("output rotated; earliest cursor is {earliest}"),
            ));
        }
        if cursor > entry.snapshot.record.next_sequence {
            return Err(JournalError::new(
                "invalid_input",
                "cursor is beyond the job output",
            ));
        }
        let mut bytes = 0;
        let lines: Vec<_> = entry
            .snapshot
            .output
            .iter()
            .filter(|line| line.sequence >= cursor)
            .take(limit)
            .take_while(|line| {
                bytes += serde_json::to_vec(line)
                    .map(|v| v.len())
                    .unwrap_or(usize::MAX);
                bytes <= 31 * 1024
            })
            .cloned()
            .collect();
        let next_cursor = lines.last().map(|line| line.sequence + 1).unwrap_or(cursor);
        Ok(Page {
            lines,
            next_cursor,
            earliest_cursor: earliest,
            has_more: next_cursor < entry.snapshot.record.next_sequence,
            output_complete: entry.snapshot.record.output_complete,
        })
    }
    pub async fn flush(self: &Arc<Self>, id: &str) -> Result<()> {
        let id = id.to_owned();
        self.transaction(move |registry| async move { registry.flush_inner(&id).await })
            .await
    }
    async fn flush_inner(&self, id: &str) -> Result<()> {
        let _writer = self.writer.lock().await;
        self.flush_locked(id).await
    }
    async fn flush_locked(&self, id: &str) -> Result<()> {
        let (slot, snapshot, revision) = {
            let entries = self.entries.lock();
            let (slot, entry) = entries
                .iter()
                .enumerate()
                .find_map(|(i, e)| {
                    e.as_ref()
                        .filter(|e| e.snapshot.record.id == id)
                        .map(|e| (i, e))
                })
                .ok_or_else(|| JournalError::new("expired", "job no longer retained"))?;
            if entry.revision == entry.persisted_revision {
                return Ok(());
            }
            (slot, entry.snapshot.clone(), entry.revision)
        };
        let result = self.write(slot, &snapshot).await;
        let mut entries = self.entries.lock();
        let entry = find_mut(&mut entries, id)?;
        match result {
            Ok(warning) => {
                entry.persisted_revision = revision;
                entry.persisted_sequence = snapshot.record.next_sequence;
                entry.durability_error = warning;
            }
            Err(error) => {
                entry.durability_error = Some(error.to_string());
                return Err(error);
            }
        }
        self.changed.notify_waiters();
        Ok(())
    }
    /// Commit Running before the shared execution layer invokes the operation.
    pub async fn start(self: &Arc<Self>, id: &str) -> Result<()> {
        let id = id.to_owned();
        self.transaction(move |registry| async move { registry.start_inner(&id).await })
            .await
    }
    async fn start_inner(&self, id: &str) -> Result<()> {
        let _writer = self.writer.lock().await;
        {
            let mut entries = self.entries.lock();
            let entry = find_mut(&mut entries, id)?;
            if entry.snapshot.record.status != Status::Queued {
                return Err(JournalError::new("conflict", "job is not queued"));
            }
            entry.snapshot.record.status = Status::Running;
            entry.snapshot.record.started_at_ms = Some(now());
            entry.revision += 1;
        }
        let result = self.flush_locked(id).await;
        if result.is_err() {
            let mut entries = self.entries.lock();
            let entry = find_mut(&mut entries, id)?;
            entry.snapshot.record.status = Status::Queued;
            entry.snapshot.record.started_at_ms = None;
            entry.revision += 1;
        }
        result
    }
    /// Checkpoint partial creation before provisioning starts.
    pub async fn created(self: &Arc<Self>, id: &str, path: String) -> Result<()> {
        if !bounded_path(&path) {
            return Err(JournalError::new(
                "invalid_input",
                "invalid created worktree path",
            ));
        }
        let id = id.to_owned();
        self.transaction(move |registry| async move {
            let _writer = registry.writer.lock().await;
            {
                let mut entries = registry.entries.lock();
                let entry = find_mut(&mut entries, &id)?;
                if entry.snapshot.record.status != Status::Running {
                    return Err(JournalError::new("conflict", "job is not running"));
                }
                entry.snapshot.record.outcome.created_path = Some(path);
                entry.revision += 1;
            }
            registry.flush_locked(&id).await
        })
        .await
    }
    pub async fn finish(
        self: &Arc<Self>,
        id: &str,
        status: Status,
        outcome: Outcome,
        filter: &SecretFilter,
    ) -> Result<()> {
        let id = id.to_owned();
        let filter = filter.clone();
        self.transaction(move |registry| async move {
            registry.finish_inner(&id, status, outcome, &filter).await
        })
        .await
    }
    async fn finish_inner(
        &self,
        id: &str,
        status: Status,
        outcome: Outcome,
        filter: &SecretFilter,
    ) -> Result<()> {
        if !status.terminal() {
            return Err(JournalError::new(
                "invalid_input",
                "completion must be terminal",
            ));
        }
        if status == Status::Failed && outcome.error.is_none() {
            return Err(JournalError::new(
                "invalid_input",
                "failed job must contain an error",
            ));
        }
        if status == Status::Succeeded && outcome.error.is_some() {
            return Err(JournalError::new(
                "invalid_input",
                "successful job cannot contain an error",
            ));
        }
        let mut outcome = filter.outcome(outcome)?;
        let _writer = self.writer.lock().await;
        {
            let mut entries = self.entries.lock();
            let entry = find_mut(&mut entries, id)?;
            if entry.snapshot.record.status.terminal() {
                return Err(JournalError::new("conflict", "job already finished"));
            }
            if status == Status::Succeeded && entry.snapshot.record.status != Status::Running {
                return Err(JournalError::new(
                    "conflict",
                    "job must run before succeeding",
                ));
            }
            if outcome.created_path.is_none() {
                outcome.created_path = entry.snapshot.record.outcome.created_path.clone();
            }
            // A previously checkpointed path is merged after filtering. Reserve
            // 4 KiB for it in addition to the 16 KiB caller outcome budget.
            // None serializes as null, so replacing it with an encoded path
            // <=4096 bytes grows the accepted outcome by at most 4092 bytes.
            // Accepted input therefore cannot hit this defensive 20 KiB check.
            if serde_json::to_vec(&outcome)
                .map_err(JournalError::storage)?
                .len()
                > 20 * 1024
            {
                return Err(JournalError::new(
                    "invalid_input",
                    "completed job outcome exceeds 20 KiB",
                ));
            }
            entry.snapshot.record.status = status;
            entry.snapshot.record.finished_at_ms = Some(now());
            entry.snapshot.record.outcome = outcome;
            if status == Status::Interrupted {
                entry.snapshot.record.output_complete = false;
            }
            entry.revision += 1;
        }
        // On failure the live outcome remains truthful but explicitly not
        // durable. Restart may show Interrupted; never pretend a disk write won.
        self.flush_locked(id).await
    }
    pub async fn wait(&self, id: &str, wait_ms: u64) -> Result<View> {
        if wait_ms > 1000 {
            return Err(JournalError::new("invalid_input", "waitMs must be 0–1000"));
        }
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms);
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let state = self.get(id)?;
            if state.record.status.terminal() || wait_ms == 0 {
                return Ok(state);
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return self.get(id);
            }
        }
    }
}
fn expired(record: &Record) -> bool {
    record.status.terminal()
        && now().saturating_sub(record.finished_at_ms.unwrap_or(record.created_at_ms))
            > RETENTION_MS
}
fn find_mut<'a>(entries: &'a mut [Option<Entry>], id: &str) -> Result<&'a mut Entry> {
    entries
        .iter_mut()
        .flatten()
        .find(|e| e.snapshot.record.id == id)
        .ok_or_else(|| JournalError::new("expired", "job no longer retained"))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "canopy-jobs-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn request(key: &str) -> Submission {
        Submission {
            operation: Operation::Create,
            repo_id: "repo".into(),
            target: "/worktree".into(),
            request_key: key.into(),
            payload: serde_json::json!({"branch":"feature","base":"main"}),
        }
    }
    fn plain() -> SecretFilter {
        SecretFilter::default()
    }

    #[tokio::test]
    async fn expired_unpersisted_retry_reports_storage_until_repaired() {
        let fixture = Fixture::new();
        let registry = Registry::open(&fixture.0).unwrap();
        let id = registry
            .admit(request("failed-final-write"))
            .await
            .unwrap()
            .job
            .record
            .id;
        registry.start(&id).await.unwrap();
        let temporary = fixture.0.join("jobs/job-000.tmp");
        std::fs::create_dir(&temporary).unwrap();
        assert_eq!(
            registry
                .finish(&id, Status::Succeeded, Outcome::default(), &plain())
                .await
                .unwrap_err()
                .code,
            "storage"
        );
        assert!(registry.get(&id).unwrap().persistence_pending);
        registry.entries.lock()[0]
            .as_mut()
            .unwrap()
            .snapshot
            .record
            .finished_at_ms = Some(0);
        let error = registry
            .admit(request("failed-final-write"))
            .await
            .unwrap_err();
        assert_eq!(error.code, "storage");
        assert_eq!(
            error.retry_after_ms, None,
            "storage repair is required, not automatic retry"
        );
        std::fs::remove_dir(temporary).unwrap();
        registry.flush(&id).await.unwrap();
        let next = registry.admit(request("failed-final-write")).await.unwrap();
        assert!(!next.reused);
        assert_ne!(next.job.record.id, id);
        registry.close().await;
    }

    #[tokio::test]
    async fn hand_edited_over_limit_paths_are_rejected_and_preserved() {
        for created in [false, true] {
            let fixture = Fixture::new();
            let registry = Registry::open(&fixture.0).unwrap();
            registry.admit(request("hand-edited")).await.unwrap();
            registry.close().await;
            let mut snapshot = registry.entries.lock()[0]
                .as_ref()
                .unwrap()
                .snapshot
                .clone();
            // Raw length fits; encoded length exceeds 4096 because of escaping.
            let path = "\\".repeat(2048);
            if created {
                snapshot.record.outcome.created_path = Some(path);
            } else {
                snapshot.record.target = path;
            }
            let bytes = serde_json::to_vec(&snapshot).unwrap();
            registry.store.write(0, &bytes).unwrap();
            drop(registry);
            let error = Registry::open(&fixture.0).err().unwrap();
            assert!(error.message.contains("job-000.json"), "{error}");
            assert_eq!(
                std::fs::read(fixture.0.join("jobs/job-000.json")).unwrap(),
                bytes
            );
        }
    }

    #[tokio::test]
    async fn expired_retry_reuses_its_slot_even_with_empty_slots_and_clock_rollback() {
        let fixture = Fixture::new();
        let registry = Registry::open(&fixture.0).unwrap();
        let old = registry.admit(request("same")).await.unwrap().job.record.id;
        registry
            .finish(&old, Status::Interrupted, Outcome::default(), &plain())
            .await
            .unwrap();
        // Model expiry in the live clock, then rollback at restart: disk still
        // contains a recent timestamp unless admission replaces the same slot.
        registry.entries.lock()[0]
            .as_mut()
            .unwrap()
            .snapshot
            .record
            .finished_at_ms = Some(0);
        let new = registry.admit(request("same")).await.unwrap();
        assert!(!new.reused);
        assert_ne!(new.job.record.id, old);
        assert!(!fixture.0.join("jobs/job-001.json").exists());
        registry.close().await;
        drop(registry);
        let reopened = Registry::open(&fixture.0).unwrap();
        assert_eq!(
            reopened.admit(request("same")).await.unwrap().job.record.id,
            new.job.record.id
        );
    }

    #[tokio::test]
    async fn escaped_metadata_full_output_and_recovery_stay_within_snapshot_bound() {
        let fixture = Fixture::new();
        let registry = Registry::open(&fixture.0).unwrap();
        let mut submission = request("escaped");
        submission.target = "\u{0001}".repeat(4096);
        assert_eq!(
            registry.admit(submission).await.unwrap_err().code,
            "invalid_input"
        );
        let mut submission = request("escaped");
        submission.target = "\u{0001}".repeat(680);
        let id = registry.admit(submission).await.unwrap().job.record.id;
        registry.start(&id).await.unwrap();
        assert!(registry
            .created(&id, "\u{0001}".repeat(4096))
            .await
            .is_err());
        registry.created(&id, "\u{0001}".repeat(680)).await.unwrap();
        for _ in 0..100 {
            registry
                .append(&id, &"\u{0001}".repeat(4096), &plain())
                .unwrap();
        }
        registry.flush(&id).await.unwrap();
        registry.close().await;
        drop(registry);
        let reopened = Registry::open(&fixture.0).unwrap();
        assert_eq!(
            reopened.get(&id).unwrap().record.status,
            Status::Interrupted
        );
        assert!(
            std::fs::metadata(fixture.0.join("jobs/job-000.json"))
                .unwrap()
                .len()
                <= SNAPSHOT_BYTES as u64
        );
        let id = reopened
            .admit(request("finished"))
            .await
            .unwrap()
            .job
            .record
            .id;
        reopened.start(&id).await.unwrap();
        reopened.created(&id, "\u{0001}".repeat(680)).await.unwrap();
        for _ in 0..100 {
            reopened
                .append(&id, &"\u{0001}".repeat(4096), &plain())
                .unwrap();
        }
        let outcome = Outcome {
            result: Some(serde_json::json!([
                "a".repeat(4000),
                "b".repeat(4000),
                "c".repeat(4000),
                "d".repeat(3900)
            ])),
            ..Default::default()
        };
        reopened
            .finish(&id, Status::Succeeded, outcome, &plain())
            .await
            .unwrap();
        assert!(!reopened.get(&id).unwrap().persistence_pending);
    }

    #[tokio::test]
    async fn crash_temporary_is_removed_without_replacing_committed_snapshot() {
        let fixture = Fixture::new();
        let registry = Registry::open(&fixture.0).unwrap();
        let id = registry
            .admit(request("committed"))
            .await
            .unwrap()
            .job
            .record
            .id;
        registry
            .finish(&id, Status::Interrupted, Outcome::default(), &plain())
            .await
            .unwrap();
        let path = fixture.0.join("jobs/job-000.json");
        let bytes = std::fs::read(&path).unwrap();
        registry
            .store
            .create_temporary_for_test(0, b"incomplete write")
            .unwrap();
        registry.close().await;
        drop(registry);
        let reopened = Registry::open(&fixture.0).unwrap();
        assert_eq!(
            reopened.get(&id).unwrap().record.status,
            Status::Interrupted
        );
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        assert!(!fixture.0.join("jobs/job-000.tmp").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn insecure_or_hardlinked_temporary_is_preserved_and_named() {
        use std::os::unix::fs::PermissionsExt;
        for hardlink in [false, true] {
            let fixture = Fixture::new();
            let registry = Registry::open(&fixture.0).unwrap();
            registry
                .store
                .create_temporary_for_test(7, b"preserve")
                .unwrap();
            let path = fixture.0.join("jobs/job-007.tmp");
            if hardlink {
                std::fs::hard_link(&path, fixture.0.join("other")).unwrap();
            } else {
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            }
            registry.close().await;
            drop(registry);
            let error = Registry::open(&fixture.0).err().unwrap();
            assert!(error.message.contains("job-007.tmp"));
            assert_eq!(std::fs::read(path).unwrap(), b"preserve");
        }
    }
    #[tokio::test]
    async fn durable_dedupe_scopes_keys_and_compares_canonical_payloads() {
        let fixture = Fixture::new();
        let registry = Registry::open(&fixture.0).unwrap();
        let first = registry.admit(request("retry")).await.unwrap();
        let mut reordered = request("retry");
        reordered.payload = serde_json::json!({"base":"main","branch":"feature"});
        let retry = registry.admit(reordered).await.unwrap();
        assert!(retry.reused);
        assert_eq!(first.job.record.id, retry.job.record.id);
        let mut conflict = request("retry");
        conflict.payload["branch"] = Value::String("other".into());
        assert_eq!(registry.admit(conflict).await.unwrap_err().code, "conflict");
        let mut scoped = request("retry");
        scoped.target = "/another".into();
        assert!(!registry.admit(scoped).await.unwrap().reused);
        registry.close().await;
        drop(registry);
        let reopened = Registry::open(&fixture.0).unwrap();
        let retry = reopened.admit(request("retry")).await.unwrap();
        assert!(retry.reused);
        assert_eq!(retry.job.record.status, Status::Interrupted);
        assert!(!retry.job.record.output_complete);
    }
    #[tokio::test]
    async fn admission_bounds_active_jobs_but_matching_retry_still_works() {
        let fixture = Fixture::new();
        let registry = Registry::open(&fixture.0).unwrap();
        for i in 0..ACTIVE_JOBS {
            registry.admit(request(&i.to_string())).await.unwrap();
        }
        assert_eq!(
            registry
                .admit(request("overflow"))
                .await
                .unwrap_err()
                .retry_after_ms,
            Some(500)
        );
        assert!(registry.admit(request("0")).await.unwrap().reused);
        assert_eq!(
            registry.wait("unknown", 1001).await.unwrap_err().code,
            "invalid_input"
        );
    }
    #[tokio::test]
    async fn output_is_redacted_before_memory_and_disk_and_pagination_survives_restart() {
        let fixture = Fixture::new();
        let registry = Registry::open(&fixture.0).unwrap();
        let id = registry.admit(request("logs")).await.unwrap().job.record.id;
        registry.start(&id).await.unwrap();
        let filter = SecretFilter::new(vec!["specific-private-value".into()]).unwrap();
        for text in [
            "specific-private-value",
            "PASSWORD=hunter2",
            "Bearer abc123",
            "postgres://user:database-pass@host/db",
            "safe output",
        ] {
            registry.append(&id, text, &filter).unwrap();
        }
        let page = registry.output(&id, 0, 2).unwrap();
        assert_eq!(page.next_cursor, 2);
        assert!(page.has_more);
        let all = serde_json::to_string(&registry.output(&id, 0, 500).unwrap()).unwrap();
        for secret in [
            "specific-private-value",
            "hunter2",
            "abc123",
            "database-pass",
        ] {
            assert!(!all.contains(secret));
        }
        registry
            .finish(
                &id,
                Status::Succeeded,
                Outcome {
                    result: Some(
                        serde_json::json!({"token":"hidden","message":"specific-private-value"}),
                    ),
                    ..Default::default()
                },
                &filter,
            )
            .await
            .unwrap();
        let bytes = std::fs::read_to_string(fixture.0.join("jobs/job-000.json")).unwrap();
        for secret in [
            "specific-private-value",
            "hunter2",
            "abc123",
            "database-pass",
            "hidden",
        ] {
            assert!(!bytes.contains(secret));
        }
        registry.close().await;
        drop(registry);
        let reopened = Registry::open(&fixture.0).unwrap();
        assert_eq!(reopened.get(&id).unwrap().record.status, Status::Succeeded);
        assert_eq!(reopened.output(&id, 2, 500).unwrap().lines.len(), 3);
    }
    #[tokio::test]
    async fn rotation_marks_expired_cursors_and_bounds_encoded_output() {
        let fixture = Fixture::new();
        let registry = Registry::open(&fixture.0).unwrap();
        let id = registry
            .admit(request("rotate"))
            .await
            .unwrap()
            .job
            .record
            .id;
        registry.start(&id).await.unwrap();
        for _ in 0..100 {
            registry
                .append(&id, &"\u{0001}".repeat(4096), &plain())
                .unwrap();
        }
        assert_eq!(
            registry.output(&id, 0, 500).unwrap_err().code,
            "cursor_expired"
        );
        let earliest = registry.entries.lock()[0]
            .as_ref()
            .unwrap()
            .snapshot
            .output
            .front()
            .unwrap()
            .sequence;
        let page = registry.output(&id, earliest, 500).unwrap();
        assert!(!page.output_complete);
        assert!(!page.lines.is_empty());
        assert!(serde_json::to_vec(&page).unwrap().len() <= 33 * 1024);
        registry.flush(&id).await.unwrap();
        assert!(
            std::fs::metadata(fixture.0.join("jobs/job-000.json"))
                .unwrap()
                .len()
                <= SNAPSHOT_BYTES as u64
        );
        registry
            .append(&id, &"x".repeat(64 * 1024 + 1), &plain())
            .unwrap();
        assert_eq!(
            registry.entries.lock()[0]
                .as_ref()
                .unwrap()
                .snapshot
                .output
                .back()
                .unwrap()
                .text,
            "[oversized output omitted]"
        );
    }
    #[tokio::test]
    async fn persistence_failure_preserves_truthful_live_outcome_and_partial_create_path() {
        let fixture = Fixture::new();
        let registry = Registry::open(&fixture.0).unwrap();
        let id = registry
            .admit(request("partial"))
            .await
            .unwrap()
            .job
            .record
            .id;
        let temporary = fixture.0.join("jobs/job-000.tmp");
        std::fs::create_dir(&temporary).unwrap();
        assert!(registry.start(&id).await.is_err());
        assert_eq!(registry.get(&id).unwrap().record.status, Status::Queued);
        std::fs::remove_dir(&temporary).unwrap();
        registry.start(&id).await.unwrap();
        registry
            .created(&id, "/created/worktree".into())
            .await
            .unwrap();
        registry
            .append(&id, "output before crash", &plain())
            .unwrap();
        registry.flush(&id).await.unwrap();
        std::fs::create_dir(&temporary).unwrap();
        assert!(registry
            .finish(
                &id,
                Status::Failed,
                Outcome {
                    error: Some(Failure {
                        code: "setup".into(),
                        message: "provision failed".into()
                    }),
                    ..Default::default()
                },
                &plain()
            )
            .await
            .is_err());
        let live = registry.get(&id).unwrap();
        assert_eq!(live.record.status, Status::Failed);
        assert!(live.persistence_pending);
        assert!(live.durability_error.is_some());
        assert_eq!(
            live.record.outcome.created_path.as_deref(),
            Some("/created/worktree")
        );
        std::fs::remove_dir(&temporary).unwrap();
        registry.close().await;
        drop(registry);
        let reopened = Registry::open(&fixture.0).unwrap();
        let recovered = reopened.get(&id).unwrap();
        assert_eq!(recovered.record.status, Status::Interrupted);
        assert_eq!(
            recovered.record.outcome.created_path.as_deref(),
            Some("/created/worktree")
        );
        assert_eq!(
            reopened.output(&id, 0, 100).unwrap().lines[0].text,
            "output before crash"
        );
    }
    #[tokio::test]
    async fn client_cancellation_does_not_cancel_owned_admission_or_release_write_fencing() {
        let fixture = Fixture::new();
        let registry = Registry::open(&fixture.0).unwrap();
        let blocked = registry.writer.lock().await;
        let clone = registry.clone();
        let client = tokio::spawn(async move { clone.admit(request("cancel-client")).await });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while registry.transactions.available_permits() == 8 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "admission did not acquire a transaction permit"
            );
            tokio::task::yield_now().await;
        }
        client.abort();
        let _ = client.await;
        drop(blocked);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while registry.transactions.available_permits() != 8 {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::task::yield_now().await;
        }
        assert!(
            registry
                .admit(request("cancel-client"))
                .await
                .unwrap()
                .reused
        );
        registry.close().await;
        assert_eq!(
            registry
                .admit(request("after-close"))
                .await
                .unwrap_err()
                .code,
            "stopping"
        );
    }
    #[tokio::test]
    async fn reused_slots_expire_old_ids_and_stale_flush_cannot_overwrite_new_job() {
        let fixture = Fixture::new();
        let registry = Registry::open(&fixture.0).unwrap();
        registry.entries.lock().truncate(1); // exercise the same bounded allocator with one slot
        let old = registry.admit(request("old")).await.unwrap().job.record.id;
        registry.start(&old).await.unwrap();
        registry
            .finish(&old, Status::Succeeded, Outcome::default(), &plain())
            .await
            .unwrap();
        let new = registry.admit(request("new")).await.unwrap().job.record.id;
        assert_eq!(registry.flush(&old).await.unwrap_err().code, "expired");
        assert_eq!(registry.get(&new).unwrap().record.status, Status::Queued);
        registry.close().await;
        drop(registry);
        let reopened = Registry::open(&fixture.0).unwrap();
        assert_eq!(reopened.get(&old).unwrap_err().code, "expired");
        assert_eq!(
            reopened.get(&new).unwrap().record.status,
            Status::Interrupted
        );
    }
    #[test]
    fn malformed_snapshots_are_preserved_and_private_modes_are_required() {
        let fixture = Fixture::new();
        let registry = Registry::open(&fixture.0).unwrap();
        registry.store.write(0, b"{bad").unwrap();
        drop(registry);
        let error = Registry::open(&fixture.0).err().unwrap();
        assert!(error.message.contains("job-000.json"), "{error}");
        assert_eq!(
            std::fs::read(fixture.0.join("jobs/job-000.json")).unwrap(),
            b"{bad"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(fixture.0.join("jobs"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(fixture.0.join("jobs/job-000.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn overlapping_secrets_are_filtered_once_without_rescanning_replacements() {
        let filter = SecretFilter::new(vec![
            "E".into(),
            "REDACTED".into(),
            "overlap".into(),
            "overlapping".into(),
        ])
        .unwrap();
        assert_eq!(filter.text("E overlapping").0, "[REDACTED] [REDACTED]");
        let filter = SecretFilter::new(vec!["x".into()]).unwrap();
        let huge = Outcome {
            result: Some(Value::Array(vec![Value::String("x".repeat(1000)); 16])),
            ..Default::default()
        };
        assert_eq!(filter.outcome(huge).unwrap_err().code, "invalid_input");
    }

    #[tokio::test]
    async fn bounded_wait_observes_terminal_transition_and_close_rejects_late_output() {
        let fixture = Fixture::new();
        let registry = Registry::open(&fixture.0).unwrap();
        let id = registry.admit(request("wait")).await.unwrap().job.record.id;
        registry.start(&id).await.unwrap();
        let clone = registry.clone();
        let waiting_id = id.clone();
        let waiter = tokio::spawn(async move { clone.wait(&waiting_id, 1000).await.unwrap() });
        registry
            .finish(&id, Status::Succeeded, Outcome::default(), &plain())
            .await
            .unwrap();
        assert_eq!(waiter.await.unwrap().record.status, Status::Succeeded);
        registry.close().await;
        assert_eq!(
            registry.append(&id, "late", &plain()).unwrap_err().code,
            "stopping"
        );
    }

    #[test]
    fn structured_and_json_log_credentials_share_key_detection() {
        let filter = plain();
        for key in [
            "password",
            "passwd",
            "api-key",
            "api_key",
            "ApiKey",
            "authorization",
            "COOKIE",
            "private-key",
        ] {
            let input = serde_json::json!({key:"quoted\"private-value"});
            let text = filter.text(&input.to_string()).0;
            assert!(!text.contains("private-value"), "{text}");
            let output = filter
                .outcome(Outcome {
                    result: Some(input),
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(output.result.unwrap()[key], "[REDACTED]");
        }
    }
    #[tokio::test]
    async fn expired_request_key_can_be_reused_without_corrupting_restart() {
        let fixture = Fixture::new();
        let registry = Registry::open(&fixture.0).unwrap();
        let id = registry
            .admit(request("expired-retry"))
            .await
            .unwrap()
            .job
            .record
            .id;
        registry.start(&id).await.unwrap();
        registry
            .finish(&id, Status::Succeeded, Outcome::default(), &plain())
            .await
            .unwrap();
        {
            let mut entries = registry.entries.lock();
            let snapshot = &mut entries[0].as_mut().unwrap().snapshot;
            snapshot.record.finished_at_ms = Some(1);
            registry
                .store
                .write(0, &serde_json::to_vec(snapshot).unwrap())
                .unwrap();
        }
        assert_eq!(registry.get(&id).unwrap_err().code, "expired");
        let fresh = registry.admit(request("expired-retry")).await.unwrap();
        assert!(!fresh.reused);
        registry.close().await;
        drop(registry);
        let reopened = Registry::open(&fixture.0).unwrap();
        assert!(
            reopened
                .admit(request("expired-retry"))
                .await
                .unwrap()
                .reused
        );
    }
}
