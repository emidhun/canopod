// Built-in Postgres helpers for the snapshot / switch-database features.
// Connection params come from the worktree's .env (standard PG_* keys), so the
// user configures nothing — they just click. All CLIs run via a login shell so
// psql/pg_dump/createdb resolve (Postgres.app etc.), with PGPASSWORD injected.
use std::collections::HashMap;
use std::path::Path;
use tokio::process::Command;

/// PG_* connection settings read from a worktree's .env.
pub struct PgConn {
    pub host: String,
    pub port: String,
    pub user: String,
    pub pass: Option<String>,
    pub db: String,
}

fn read_env(wt_path: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    if let Ok(txt) = std::fs::read_to_string(Path::new(wt_path).join(".env")) {
        for line in txt.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                m.insert(k.trim().to_string(), v.trim().trim_matches('"').trim_matches('\'').to_string());
            }
        }
    }
    m
}

pub fn conn(wt_path: &str) -> Result<PgConn, String> {
    let e = read_env(wt_path);
    let db = e.get("PG_DB").cloned().ok_or("PG_DB not set in this worktree's .env")?;
    Ok(PgConn {
        host: e.get("PG_HOST").cloned().unwrap_or_else(|| "localhost".into()),
        port: e.get("PG_PORT").cloned().unwrap_or_else(|| "5432".into()),
        user: e.get("PG_USER").cloned().unwrap_or_else(|| "postgres".into()),
        pass: e.get("PG_PASS").cloned().filter(|s| !s.is_empty()),
        db,
    })
}

impl PgConn {
    /// `-h host -p port -U user` shared connection args.
    fn args(&self) -> Vec<String> {
        vec!["-h".into(), self.host.clone(), "-p".into(), self.port.clone(), "-U".into(), self.user.clone()]
    }
}

/// Cap for one Postgres CLI invocation — dumps/restores of big databases take
/// a while, but a hung server must not wedge the command forever.
const PG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(900);

/// Run a shell command line in the worktree dir with PGPASSWORD set.
/// Uses the fast non-login shell: these lines are composed by Canopod (pure
/// POSIX, need only PATH), and a login shell's profile init cost 300ms–1s
/// PER invocation — a snapshot chains five of them before any data moves.
async fn run(wt_path: &str, c: &PgConn, cmdline: &str) -> Result<String, String> {
    let (shell, shargs) = crate::toolchain::fast_shell_argv(cmdline);
    let mut cmd = Command::new(shell);
    cmd.args(&shargs)
        .current_dir(wt_path)
        .env("PATH", crate::toolchain::effective_path())
        .kill_on_drop(true);
    if let Some(p) = &c.pass {
        cmd.env("PGPASSWORD", p);
    }
    let out = match tokio::time::timeout(PG_TIMEOUT, cmd.output()).await {
        Ok(res) => res.map_err(|e| format!("failed to run: {e}"))?,
        Err(_) => return Err(format!("database command timed out after {}s", PG_TIMEOUT.as_secs())),
    };
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(err.lines().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"))
    }
}

/// shell-quote a single argument (wrap in single quotes, escape embedded quotes)
fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The server's major version (e.g. 16) via `SHOW server_version_num`. `None` if
/// it can't be read (any client psql can run this against any server).
async fn server_major(wt_path: &str, c: &PgConn) -> Option<u32> {
    let conn_args = c.args().iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
    let out = run(
        wt_path,
        c,
        &format!("psql {conn_args} -d {} -tAc {}", q(&c.db), q("SHOW server_version_num")),
    )
    .await
    .ok()?;
    out.trim().parse::<u32>().ok().map(|n| n / 10000)
}

/// Return an `export PATH="<bin>:$PATH"; ` prefix selecting a suitable
/// pg_dump/pg_restore. Prefer the binaries matching the **server's** major
/// version: a dump from a newer client emits directives the server can't restore
/// (e.g. PG17's `SET transaction_timeout` into a PG16 server) and produces a
/// newer archive an older pg_restore can't read. Only when no exact match is
/// installed fall back to the newest available (newer can dump older).
#[derive(Clone, Copy)]
#[cfg_attr(not(test), allow(dead_code))]
enum PgPlatform {
    MacOs,
    Linux,
    Windows,
}

fn pg_version_bins(platform: PgPlatform, major: u32) -> Vec<String> {
    match platform {
        PgPlatform::MacOs => vec![
            format!("/Applications/Postgres.app/Contents/Versions/{major}/bin"),
            format!("/opt/homebrew/opt/postgresql@{major}/bin"),
            format!("/usr/local/opt/postgresql@{major}/bin"),
        ],
        PgPlatform::Linux => vec![
            format!("/usr/lib/postgresql/{major}/bin"),
            format!("/usr/pgsql-{major}/bin"),
        ],
        PgPlatform::Windows => vec![format!(r"C:\Program Files\PostgreSQL\{major}\bin")],
    }
}

fn pg_bin_candidates(platform: PgPlatform, server_major: Option<u32>) -> Vec<String> {
    let mut candidates: Vec<String> = server_major.into_iter()
        .flat_map(|major| pg_version_bins(platform, major)).collect();
    if matches!(platform, PgPlatform::MacOs) {
        candidates.push("/Applications/Postgres.app/Contents/Versions/latest/bin".into());
    }
    for major in (12..=18).rev().filter(|major| Some(*major) != server_major) {
        candidates.extend(pg_version_bins(platform, major));
    }
    candidates
}

fn pg_prefix_from(candidates: Vec<String>, exists: impl Fn(&Path) -> bool) -> String {
    for dir in candidates {
        let p = Path::new(&dir);
        if exists(&p.join("pg_dump")) || exists(&p.join("pg_dump.exe")) {
            return format!("export PATH={}:\"$PATH\"; ", q(&crate::toolchain::bash_path(&dir)));
        }
    }
    String::new()
}

fn pg_path_prefix_for(server_major: Option<u32>) -> String {
    #[cfg(target_os = "macos")]
    let platform = PgPlatform::MacOs;
    #[cfg(target_os = "windows")]
    let platform = PgPlatform::Windows;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let platform = PgPlatform::Linux;
    pg_prefix_from(pg_bin_candidates(platform, server_major), Path::exists)
}

pub fn current_db(wt_path: &str) -> Option<String> {
    read_env(wt_path).get("PG_DB").cloned().filter(|s| !s.is_empty())
}

/// All non-template databases the connection user can see.
pub async fn list_databases(wt_path: &str) -> Result<Vec<String>, String> {
    let c = conn(wt_path)?;
    let conn_args = c.args().iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
    let sql = "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname";
    let out = run(
        wt_path,
        &c,
        &format!("psql {conn_args} -d {} -tAc {}", q("postgres"), q(sql)),
    )
    .await?;
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

pub async fn database_exists(wt_path: &str, name: &str) -> Result<bool, String> {
    Ok(list_databases(wt_path).await?.iter().any(|d| d == name))
}

/// Drop a database by name, taking connection settings from `conn_wt_path`
/// (typically the repo's main checkout, which still exists). Used by Sync-prune
/// to reclaim a vanished worktree's database — the worktree's own .env is gone,
/// so we can't `conn()` from it. `--if-exists` makes an already-dropped db a no-op.
pub async fn drop_database_named(conn_wt_path: &str, name: &str) -> Result<(), String> {
    let c = conn(conn_wt_path)?;
    let conn_args = c.args().iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
    run(conn_wt_path, &c, &format!("dropdb {conn_args} --if-exists {}", q(name))).await.map(|_| ())
}

/// Clone the worktree's current DB into a new database `target`. Uses a
/// pg_dump|pg_restore pipe so it works while the server is connected (no
/// template lock). Refuses to overwrite an existing database.
pub async fn clone_database(wt_path: &str, target: &str, mut progress: impl FnMut(String)) -> Result<(), String> {
    let c = conn(wt_path)?;
    if database_exists(wt_path, target).await? {
        return Err(format!("A database named '{target}' already exists"));
    }
    let conn_args = c.args().iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
    progress(format!("creating database {target}…"));
    run(wt_path, &c, &format!("createdb {conn_args} {}", q(target))).await?;
    progress(format!("copying {} → {target}…", c.db));
    // Dump piped straight into restore — but the pipe lives in RUST, not the
    // shell. A shell pipeline's exit status is the last command's (a failed
    // pg_dump feeding a tolerant pg_restore reports success), and `set -o
    // pipefail` is not a portable fix: `set` is a POSIX *special builtin*, so
    // on dash (Debian/Ubuntu /bin/sh) an unknown option exits the shell
    // outright — braces and `|| true` do not contain it. Connecting the two
    // children ourselves checks BOTH statuses, names the failing stage, and
    // stages nothing on disk (a temp file would double a big DB's footprint).
    let pre = pg_path_prefix_for(server_major(wt_path, &c).await);
    let result = run_piped(
        wt_path,
        &c,
        &format!("{pre}pg_dump {conn_args} -Fc {src}", src = q(&c.db)),
        &format!("{pre}pg_restore {conn_args} --no-owner --no-acl -d {dst}", dst = q(target)),
        &c.db,
        target,
    )
    .await;
    if let Err(e) = result {
        // don't strand the half-filled database we just created — a retry
        // would otherwise die on "already exists"
        progress(format!("copy failed — dropping partially created {target}…"));
        let _ = run(wt_path, &c, &format!("dropdb {conn_args} --if-exists {}", q(target))).await;
        return Err(e);
    }
    progress("snapshot ready".into());
    Ok(())
}

/// Spawn `producer | consumer` with the pipe held by us: producer's stdout
/// feeds consumer's stdin, both run through the login shell (PATH), both exit
/// statuses are checked, and the whole pair shares one timeout.
async fn run_piped(
    wt_path: &str,
    c: &PgConn,
    producer: &str,
    consumer: &str,
    src_label: &str,
    dst_label: &str,
) -> Result<(), String> {
    use std::process::Stdio;
    let spawn = |line: &str, stdin: Stdio, stdout: Stdio| {
        // fast non-login shell — see `run` for why this is safe here
        let (shell, args) = crate::toolchain::fast_shell_argv(line);
        let mut cmd = Command::new(shell);
        cmd.args(&args)
            .current_dir(wt_path)
            .env("PATH", crate::toolchain::effective_path())
            .kill_on_drop(true)
            .stdin(stdin)
            .stdout(stdout)
            .stderr(Stdio::piped());
        if let Some(p) = &c.pass {
            cmd.env("PGPASSWORD", p);
        }
        cmd.spawn()
    };
    let mut prod = spawn(producer, Stdio::null(), Stdio::piped()).map_err(|e| format!("pg_dump spawn failed: {e}"))?;
    let prod_out = prod.stdout.take().ok_or("pg_dump stdout unavailable")?;
    let pipe: Stdio = prod_out.try_into().map_err(|e| format!("pipe setup failed: {e}"))?;
    let cons = spawn(consumer, pipe, Stdio::null()).map_err(|e| format!("pg_restore spawn failed: {e}"))?;

    // wait on both concurrently: if the consumer dies early the producer gets
    // EPIPE and exits, and vice versa the consumer sees EOF — no deadlock.
    let waited = tokio::time::timeout(PG_TIMEOUT, async {
        tokio::join!(prod.wait_with_output(), cons.wait_with_output())
    })
    .await;
    let (p_out, c_out) = match waited {
        Ok(pair) => pair,
        Err(_) => return Err(format!("copy timed out after {}s", PG_TIMEOUT.as_secs())),
    };
    let p_out = p_out.map_err(|e| format!("pg_dump wait failed: {e}"))?;
    let c_out = c_out.map_err(|e| format!("pg_restore wait failed: {e}"))?;
    if !p_out.status.success() {
        return Err(format!("dump of {src_label} failed: {}", tail(&p_out.stderr)));
    }
    if !c_out.status.success() {
        return Err(format!("restore into {dst_label} failed: {}", tail(&c_out.stderr)));
    }
    Ok(())
}

/// Last few stderr lines, newest-last — the actionable part of a pg error.
fn tail(stderr: &[u8]) -> String {
    let s = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = s.lines().rev().take(4).collect();
    lines.into_iter().rev().collect::<Vec<_>>().join("\n")
}

/// Dump the worktree's current DB to a custom-format file at `file_path`.
pub async fn export_database(wt_path: &str, file_path: &str, mut progress: impl FnMut(String)) -> Result<(), String> {
    let c = conn(wt_path)?;
    let conn_args = c.args().iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
    progress(format!("exporting {} to file…", c.db));
    let pre = pg_path_prefix_for(server_major(wt_path, &c).await);
    run(wt_path, &c, &format!("{pre}pg_dump {conn_args} -Fc {} -f {}", q(&c.db), q(file_path))).await?;
    progress("export complete".into());
    Ok(())
}

/// An explicit restore destination. Creating never replaces an existing DB.
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreOptions {
    pub target: String,
    pub mode: RestoreMode,
    #[serde(default)]
    pub activate: bool,
}
#[derive(Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RestoreMode {
    Replace,
    Create,
}

fn validate_restore_target(target: &str) -> Result<(), String> {
    if target.trim().is_empty() || target.len() > 63 || target.chars().any(char::is_control) {
        return Err("database name must contain 1–63 bytes and no control characters".into());
    }
    if matches!(target, "postgres" | "template0" | "template1") {
        return Err("choose an application database, not a PostgreSQL maintenance database".into());
    }
    Ok(())
}

fn restore_commands(
    c: &PgConn,
    file: &str,
    prefix: &str,
    options: Option<&RestoreOptions>,
) -> Result<Vec<String>, String> {
    let args = c.args().iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
    let target = options.map_or(c.db.as_str(), |o| o.target.as_str());
    if options.is_some() {
        validate_restore_target(target)?;
    }
    let mut commands = Vec::new();
    // Validate archives BEFORE dropping a destination. Plain SQL is checked by
    // psql inside its restore transaction; syntax cannot be validated offline.
    if !file.to_lowercase().ends_with(".sql") {
        commands.push(format!("{prefix}pg_restore --list {} > /dev/null", q(file)));
    }
    if let Some(options) = options {
        if options.mode == RestoreMode::Replace {
            // Do not force-terminate unrelated clients: active connections fail
            // before the database is dropped and the error identifies the cause.
            commands.push(format!(
                "{prefix}dropdb {args} --maintenance-db=postgres -- {}",
                q(target)
            ));
        }
        commands.push(format!(
            "{prefix}createdb {args} --maintenance-db=postgres --template=template0 -- {}",
            q(target)
        ));
    }
    let line = if file.to_lowercase().ends_with(".sql") {
        format!(
            "{prefix}psql {args} -X -v ON_ERROR_STOP=1 --single-transaction -d {} -f {}",
            q(target),
            q(file)
        )
    } else {
        let clean = if options.is_none() {
            "--clean --if-exists "
        } else {
            ""
        };
        format!("{prefix}pg_restore {args} --no-owner --no-acl --exit-on-error --single-transaction {clean}-d {} {}", q(target), q(file))
    };
    commands.push(line);
    Ok(commands)
}

pub async fn restore_database(
    wt_path: &str,
    file_path: &str,
    options: Option<&RestoreOptions>,
    mut progress: impl FnMut(String),
) -> Result<(), String> {
    // Reject an unreadable/missing/empty input before doing anything destructive.
    let input =
        std::fs::File::open(file_path).map_err(|e| format!("cannot read dump {file_path}: {e}"))?;
    let meta = input.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() == 0 {
        return Err("choose a nonempty dump file".into());
    }
    let mut c = conn(wt_path)?;
    let original = c.db.clone();
    c.db = "postgres".into(); // metadata must work even if the old app DB is missing
    let pre = pg_path_prefix_for(server_major(wt_path, &c).await);
    c.db = original;
    let commands = restore_commands(&c, file_path, &pre, options)?;
    if let Some(options) = options {
        let args = c.args().iter().map(|a| q(a)).collect::<Vec<_>>().join(" ");
        let databases = run(
            wt_path,
            &c,
            &format!(
                "psql {args} -X -d postgres -tAc {}",
                q("SELECT datname FROM pg_database")
            ),
        )
        .await?;
        let exists = databases.lines().any(|name| name == options.target);
        if exists == (options.mode == RestoreMode::Create) {
            return Err(if exists {
                "database already exists; choose a new name"
            } else {
                "selected database no longer exists; refresh the list"
            }
            .into());
        }
    }
    let target = options.map_or(c.db.as_str(), |o| o.target.as_str());
    progress(format!("restoring into {target}…"));
    for line in commands {
        run(wt_path, &c, &line).await?;
    }
    progress(format!("restore into {target} complete"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pg_discovery_prefers_linux_server_version_then_newest_and_path() {
        let candidates = pg_bin_candidates(PgPlatform::Linux, Some(16));
        let prefix = pg_prefix_from(candidates.clone(), |path| {
            path == Path::new("/usr/pgsql-16/bin/pg_dump")
                || path == Path::new("/usr/lib/postgresql/18/bin/pg_dump")
        });
        assert!(prefix.contains("/usr/pgsql-16/bin"));
        assert!(pg_prefix_from(candidates.clone(), |path| path == Path::new("/usr/lib/postgresql/18/bin/pg_dump")).contains("/usr/lib/postgresql/18/bin"));
        assert_eq!(pg_prefix_from(candidates.clone(), |_| false), "");
        assert!(candidates.iter().all(|p| !p.contains("Postgres.app") && !p.contains("homebrew")));
        assert_eq!(pg_bin_candidates(PgPlatform::Linux, Some(23))[0], "/usr/lib/postgresql/23/bin");
    }

    #[test]
    fn pg_discovery_preserves_mac_and_windows_layouts() {
        let mac = pg_bin_candidates(PgPlatform::MacOs, Some(16));
        assert!(mac[0].ends_with("Versions/16/bin"));
        let windows = pg_bin_candidates(PgPlatform::Windows, Some(16));
        assert!(pg_prefix_from(windows, |p| p == Path::new(r"C:\Program Files\PostgreSQL\16\bin").join("pg_dump.exe")).contains("PostgreSQL"));
    }

    #[test]
    fn quotes_args_safely() {
        assert_eq!(q("tooljet_main"), "'tooljet_main'");
        assert_eq!(q("a'b"), "'a'\\''b'");
    }

    #[test]
    fn tail_keeps_last_lines_in_order() {
        assert_eq!(tail(b"a\nb\nc\nd\ne\nf"), "c\nd\ne\nf");
        assert_eq!(tail(b"only"), "only");
        assert_eq!(tail(b""), "");
    }

    /// only the Unix-gated pipe test uses this (the test spawns POSIX shell
    /// commands, so it doesn't run on the Windows job)
    #[cfg(unix)]
    fn test_conn() -> PgConn {
        PgConn {
            host: "h".into(),
            port: "1".into(),
            user: "u".into(),
            pass: None,
            db: "d".into(),
        }
    }

    #[test]
    fn restore_empties_only_the_selected_database_after_archive_preflight() {
        let c = PgConn {
            host: "localhost".into(),
            port: "5432".into(),
            user: "postgres".into(),
            pass: None,
            db: "original".into(),
        };
        let options = RestoreOptions {
            target: "selected".into(),
            mode: RestoreMode::Replace,
            activate: false,
        };
        let commands = restore_commands(&c, "/tmp/in.dump", "", Some(&options)).unwrap();
        assert!(commands[0].starts_with("pg_restore --list "));
        assert!(commands[1].starts_with("dropdb ") && commands[1].ends_with("-- 'selected'"));
        assert!(!commands[1].contains("--force"));
        assert!(
            commands[2].starts_with("createdb ") && commands[2].contains("--template=template0")
        );
        assert!(commands[3].contains("-d 'selected'"));
        assert!(!commands.iter().any(|c| c.contains("original")));
    }

    #[test]
    fn fresh_restore_never_drops_and_sql_errors_abort_the_transaction() {
        let c = PgConn {
            host: "localhost".into(),
            port: "5432".into(),
            user: "postgres".into(),
            pass: None,
            db: "original".into(),
        };
        let options = RestoreOptions {
            target: "new db's".into(),
            mode: RestoreMode::Create,
            activate: false,
        };
        let commands = restore_commands(&c, "/tmp/in.sql", "", Some(&options)).unwrap();
        assert_eq!(commands.len(), 2);
        assert!(commands[0].starts_with("createdb "));
        assert!(commands[0].ends_with(&format!("-- {}", q(&options.target))));
        assert!(
            commands[1].contains(" -X ")
                && commands[1].contains("ON_ERROR_STOP=1")
                && commands[1].contains("--single-transaction")
        );
        for target in ["", "postgres", "template0", "template1", "bad\nname"] {
            assert!(validate_restore_target(target).is_err());
        }
    }

    /// THE invariant clone_database depends on: both children's exit statuses
    /// are checked, and the error names the failing stage. A shell pipeline
    /// reports only the last command's status — this is the regression that
    /// motivated the Rust-held pipe, so it gets a live process test.
    #[cfg(unix)]
    #[tokio::test]
    async fn run_piped_checks_both_exit_statuses() {
        let c = test_conn();
        let wt = std::env::temp_dir();
        let wt = wt.to_str().unwrap();

        // happy path: bytes flow producer → consumer, both exit 0
        run_piped(wt, &c, "printf %s data", "cat >/dev/null", "src", "dst")
            .await
            .expect("clean pipe");

        // producer fails while the consumer exits 0 — exactly the case a
        // shell pipeline would report as success
        let e = run_piped(wt, &c, "printf x; echo boom >&2; exit 7", "cat >/dev/null", "srcdb", "dst")
            .await
            .unwrap_err();
        assert!(e.contains("dump of srcdb failed"), "names the dump stage: {e}");
        assert!(e.contains("boom"), "carries producer stderr: {e}");

        // consumer fails after a clean producer
        let e = run_piped(wt, &c, "printf %s data", "cat >/dev/null; exit 3", "src", "dstdb")
            .await
            .unwrap_err();
        assert!(e.contains("restore into dstdb failed"), "names the restore stage: {e}");
    }
}
