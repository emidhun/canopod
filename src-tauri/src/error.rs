// Structured errors crossing the IPC boundary.
//
// Every #[tauri::command] returns `Result<T, CanopodError>`. The error
// serializes as `{ "code": "...", "message": "..." }` so the frontend can
// branch on `code` (retry vs. destructive-confirm vs. plain toast) instead of
// pattern-matching display strings. Internal modules (git.rs, db.rs, setup.rs)
// keep returning `String` — they wrap external tools whose stderr *is* the
// message — and the command layer stamps the domain code at the boundary.
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// git CLI failure (pull/fetch/worktree/submodule…)
    Git,
    /// Postgres tooling failure (psql/pg_dump/pg_restore/createdb)
    Db,
    /// provisioning / setup / migrate / custom command failure
    Setup,
    /// dev-service process control (spawn/stop/restart)
    Process,
    /// embedded PTY session failure
    Terminal,
    /// settings / repo-config file problems
    Config,
    /// the referenced repo / worktree / service isn't registered
    NotFound,
    /// the request itself is invalid (bad port, empty name…)
    InvalidInput,
    /// the operation conflicts with current state (already exists / in progress)
    Conflict,
    /// anything unclassified — the safe default for `?` on a bare String
    Internal,
}

#[derive(Debug, Clone, Serialize)]
pub struct CanopodError {
    pub code: ErrorCode,
    pub message: String,
}

impl CanopodError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn git(m: impl Into<String>) -> Self {
        Self::new(ErrorCode::Git, m)
    }
    pub fn db(m: impl Into<String>) -> Self {
        Self::new(ErrorCode::Db, m)
    }
    pub fn setup(m: impl Into<String>) -> Self {
        Self::new(ErrorCode::Setup, m)
    }
    pub fn process(m: impl Into<String>) -> Self {
        Self::new(ErrorCode::Process, m)
    }
    pub fn terminal(m: impl Into<String>) -> Self {
        Self::new(ErrorCode::Terminal, m)
    }
    pub fn config(m: impl Into<String>) -> Self {
        Self::new(ErrorCode::Config, m)
    }
    pub fn not_found(m: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, m)
    }
    pub fn invalid_input(m: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, m)
    }
    pub fn conflict(m: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, m)
    }
    pub fn internal(m: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, m)
    }
}

impl std::fmt::Display for CanopodError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CanopodError {}

/// Bare-`?` compatibility while internal modules still return `String`.
impl From<String> for CanopodError {
    fn from(m: String) -> Self {
        Self::internal(m)
    }
}

impl From<&str> for CanopodError {
    fn from(m: &str) -> Self {
        Self::internal(m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_code_and_message() {
        let e = CanopodError::git("pull failed");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "git");
        assert_eq!(v["message"], "pull failed");
    }

    #[test]
    fn bare_string_maps_to_internal() {
        let e: CanopodError = "boom".into();
        assert_eq!(e.code, ErrorCode::Internal);
        assert_eq!(e.to_string(), "boom");
    }
}
