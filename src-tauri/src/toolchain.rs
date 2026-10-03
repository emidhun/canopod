// Respect a project's pinned Node version when spawning commands.
//
// Repos pin Node via .nvmrc / .node-version (nvm/fnm convention) or
// .tool-versions (asdf). A login shell only honors the pin if the user's
// version manager is configured for that file — e.g. asdf ignores .nvmrc
// unless legacy_version_file is on, so a ToolJet worktree resolves the asdf
// *global* Node instead of the pinned one, and engine-strict installs fail.
//
// We locate the pinned version's actual bin dir (asdf or nvm install) and, if
// found, prepend it inside the spawned command so it wins after profile init.
use std::path::Path;

fn read_pin(dir: &Path) -> Option<String> {
    for f in [".nvmrc", ".node-version"] {
        if let Ok(v) = std::fs::read_to_string(dir.join(f)) {
            let v = v.trim().trim_start_matches('v').to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    if let Ok(tv) = std::fs::read_to_string(dir.join(".tool-versions")) {
        for line in tv.lines() {
            if let Some(rest) = line.trim().strip_prefix("nodejs ") {
                let v = rest.trim().trim_start_matches('v').to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// The user's home directory. `$HOME` on Unix; `%USERPROFILE%` (with `$HOME`
/// honored if a shell like Git Bash set it) on Windows.
fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|s| !s.is_empty()))
}

fn bin_for_version(version: &str) -> Option<String> {
    let home = home_dir()?;
    // `mut` is only exercised under cfg(windows) where extra candidates are pushed
    #[allow(unused_mut)]
    let mut candidates = vec![
        format!("{home}/.asdf/installs/nodejs/{version}/bin"),
        format!("{home}/.asdf/installs/nodejs/v{version}/bin"),
        format!("{home}/.nvm/versions/node/v{version}/bin"),
        format!("{home}/.local/share/fnm/node-versions/v{version}/installation/bin"),
    ];
    #[cfg(target_os = "windows")]
    {
        // nvm-windows drops node.exe directly under %APPDATA%\nvm\vX (no bin/).
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(format!("{appdata}\\nvm\\v{version}"));
        }
        // fnm's default data dir on Windows is %APPDATA%\fnm (roaming); also honor
        // an explicit FNM_DIR and the older %LOCALAPPDATA%\fnm layout.
        let fnm_bases = [
            std::env::var("FNM_DIR").ok(),
            std::env::var("APPDATA").ok().map(|p| format!("{p}\\fnm")),
            std::env::var("LOCALAPPDATA").ok().map(|p| format!("{p}\\fnm")),
        ];
        for base in fnm_bases.into_iter().flatten() {
            candidates.push(format!("{base}\\node-versions\\v{version}\\installation"));
        }
        // Volta
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(format!("{local}\\Volta\\tools\\image\\node\\{version}"));
        }
    }
    candidates.into_iter().find(|c| {
        let p = Path::new(c);
        p.join("node").exists() || p.join("node.exe").exists()
    })
}

/// Convert a native path into a form the command shell accepts on PATH. On
/// Windows commands run through Git Bash, whose PATH wants MSYS form
/// (`C:\Users\me` → `/c/Users/me`); elsewhere it's the identity.
#[cfg(target_os = "windows")]
pub(crate) fn bash_path(p: &str) -> String {
    let p = p.replace('\\', "/");
    if let Some((drive, rest)) = p.split_once(":/") {
        if drive.len() == 1 {
            return format!("/{}/{}", drive.to_lowercase(), rest);
        }
    }
    p
}
#[cfg(not(target_os = "windows"))]
pub(crate) fn bash_path(p: &str) -> String {
    p.to_string()
}

/// Walk up from `dir` looking for a Node pin; return the bin dir of that version
/// if it's installed locally. None if unpinned or the version isn't installed.
pub fn pinned_node_bin(dir: &str) -> Option<String> {
    let mut cur = Some(Path::new(dir));
    while let Some(d) = cur {
        if let Some(v) = read_pin(d) {
            return bin_for_version(&v);
        }
        cur = d.parent();
    }
    None
}

/// Wrap a command so the worktree's pinned Node bin is first on PATH. The
/// prepend runs after the login shell's profile, so it wins over asdf/nvm shims.
pub fn with_pinned_node(cwd: &str, command: &str) -> String {
    match pinned_node_bin(cwd) {
        Some(bin) => format!("export PATH=\"{}:$PATH\"; {command}", bash_path(&bin)),
        None => command.to_string(),
    }
}

/// The shell Canopod runs commands through. Honors `$SHELL` (so bash/fish/etc.
/// users get their own shell + profile), falling back to zsh on macOS, Git Bash
/// on Windows, and sh on other Unix. Commands run as a *login* shell so version
/// managers (nvm/asdf/volta) and the user's PATH are initialized.
pub fn user_shell() -> String {
    if let Some(s) = std::env::var("SHELL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && Path::new(s).exists())
    {
        return s;
    }
    default_shell()
}

#[cfg(target_os = "windows")]
fn default_shell() -> String {
    // Windows runs commands through Git for Windows' bash, keeping the whole
    // POSIX execution model (&&, pipes, export, quoting) working unchanged.
    find_git_bash().unwrap_or_else(|| "bash.exe".into())
}
#[cfg(target_os = "macos")]
fn default_shell() -> String {
    "/bin/zsh".into()
}
#[cfg(all(unix, not(target_os = "macos")))]
fn default_shell() -> String {
    "/bin/sh".into()
}

/// Locate Git for Windows' `bash.exe`. `$SHELL` in Git Bash is an MSYS virtual
/// path (`/usr/bin/bash`) that a native process can't stat, so probe the known
/// install locations, then fall back to `where bash`.
#[cfg(target_os = "windows")]
fn find_git_bash() -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(p) = std::env::var(var) {
            candidates.push(format!("{p}\\Git\\bin\\bash.exe"));
        }
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        candidates.push(format!("{la}\\Programs\\Git\\bin\\bash.exe"));
    }
    for c in &candidates {
        if Path::new(c).exists() {
            return Some(c.clone());
        }
    }
    if let Ok(out) = std::process::Command::new("where").arg("bash").output() {
        if out.status.success() {
            if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let line = line.trim();
                if !line.is_empty() {
                    return Some(line.to_string());
                }
            }
        }
    }
    None
}

/// PATH as a login shell resolves it, captured ONCE per run and unioned with
/// the process PATH. Internal tool invocations (db CLIs) use this instead of
/// paying profile-sourcing (nvm/asdf init: dozens of file reads + often a
/// node exec, 300ms–1s) on every spawn. Capture failure degrades to the
/// process PATH — which fix_path_env already promoted at startup.
#[cfg(unix)]
pub fn effective_path() -> String {
    use std::sync::OnceLock;
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let cur = std::env::var("PATH").unwrap_or_default();
        let captured = std::process::Command::new(user_shell())
            .args(["-l", "-c", "printf %s \"$PATH\""])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());
        match captured {
            Some(c) if c != cur && !cur.is_empty() => format!("{c}:{cur}"),
            Some(c) => c,
            None => cur,
        }
    })
    .clone()
}

#[cfg(windows)]
pub fn effective_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}

/// Fast non-login shell for INTERNAL tool invocations — command lines Canopod
/// composes itself (psql/pg_dump/pg_restore/createdb/dropdb), which are pure
/// POSIX and need only PATH (see `effective_path`). User-authored commands
/// (services, setup, custom, reset) MUST keep `shell_argv`'s login shell:
/// their PATH and functions may come from profile files.
pub fn fast_shell_argv(cmdline: &str) -> (String, Vec<String>) {
    // Windows: Git Bash without `-l` skips /etc/profile + ~/.bash_profile —
    // same speedup, same POSIX syntax. Unix: /bin/sh is fine because the
    // composed lines avoid bashisms (no pipefail — see db.rs).
    #[cfg(target_os = "windows")]
    let shell = user_shell();
    #[cfg(not(target_os = "windows"))]
    let shell = "/bin/sh".to_string();
    (shell, vec!["-c".into(), cmdline.to_string()])
}

/// Build `(shell, argv)` to run `cmdline` through the user's shell. Flags are
/// chosen per shell family: pass `-l` and `-c` as *separate* args so fish parses
/// them (it rejects the combined `-lc`), and drop `-l` for plain `sh`/`dash`
/// which don't accept a login flag.
pub fn shell_argv(cmdline: &str) -> (String, Vec<String>) {
    let shell = user_shell();
    let name = Path::new(&shell).file_name().and_then(|s| s.to_str()).unwrap_or("");
    // on Windows the shell is `bash.exe`; normalize so family checks below match
    let name = name.strip_suffix(".exe").unwrap_or(name);
    let mut args: Vec<String> = Vec::new();
    if !matches!(name, "sh" | "dash") {
        args.push("-l".into());
    }
    args.push("-c".into());
    args.push(cmdline.to_string());
    (shell, args)
}

/// Wrap `s` as a single POSIX shell word. Inside single quotes every byte is
/// literal, so the only case needing care is `'` itself: close the quote, emit
/// an escaped quote, reopen — `'\''`. (Applying the *double*-quote idiom here,
/// `'\"'\"'`, silently mangles any path containing an apostrophe.)
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::{fast_shell_argv, sh_quote, shell_argv};

    /// The fast path's whole contract: `-c` yes, `-l` NEVER (skipping profile
    /// init is the point), command last.
    #[test]
    fn fast_shell_argv_skips_login_flag() {
        let (shell, args) = fast_shell_argv("echo hi");
        assert!(!args.iter().any(|a| a == "-l"), "must not source profiles: {args:?}");
        assert!(args.contains(&"-c".to_string()));
        assert_eq!(args.last().unwrap(), "echo hi");
        #[cfg(not(target_os = "windows"))]
        assert_eq!(shell, "/bin/sh");
        let _ = shell;
    }

    #[cfg(unix)]
    #[test]
    fn fast_shell_executes_posix() {
        let (shell, args) = fast_shell_argv("printf %s canopod-ok");
        let out = std::process::Command::new(shell).args(args).output().expect("spawn");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "canopod-ok");
    }

    /// Composed db command lines must stay pure POSIX: dash (Debian/Ubuntu
    /// /bin/sh) is the shell that killed the pipefail approach — `set` is a
    /// special builtin and an unknown option exits the shell outright. This
    /// pins the exact export-PATH-prefix shape db.rs generates against dash
    /// itself (macOS ships /bin/dash too, so this runs on both CI unixes).
    #[cfg(unix)]
    #[test]
    fn composed_db_line_shape_is_dash_safe() {
        if !std::path::Path::new("/bin/dash").exists() {
            return; // no dash on this box — the ubuntu CI job covers it
        }
        let line = format!("export PATH={}:\"$PATH\"; printf %s ok", sh_quote("/nonexistent dir/bin"));
        let out = std::process::Command::new("/bin/dash").args(["-c", &line]).output().expect("spawn");
        assert!(out.status.success(), "dash rejected the composed shape: {}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(String::from_utf8_lossy(&out.stdout), "ok");
    }

    #[cfg(unix)]
    #[test]
    fn effective_path_is_nonempty_and_cached() {
        let p1 = super::effective_path();
        assert!(!p1.is_empty());
        assert!(
            p1.split(':').any(|d| d == "/usr/bin" || d == "/bin"),
            "system dirs must survive the union: {p1}"
        );
        assert_eq!(p1, super::effective_path(), "second call must hit the cache");
    }

    #[test]
    fn sh_quote_round_trips_through_the_shell() {
        assert_eq!(sh_quote("/tmp/plain.txt"), "'/tmp/plain.txt'");
        assert_eq!(sh_quote("/tmp/it's.txt"), r"'/tmp/it'\''s.txt'");
        // spaces, globs and command substitution stay inert
        assert_eq!(sh_quote("/a b/$(rm -rf ~)/*.rs"), "'/a b/$(rm -rf ~)/*.rs'");
        // and the shell actually parses it back to the original
        for raw in ["/tmp/it's.txt", "/a b/c.rs", "/x/$(echo hi).ts", "/q/\"dq\".ts"] {
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(format!("printf %s {}", sh_quote(raw)))
                .output()
                .expect("sh");
            assert_eq!(String::from_utf8_lossy(&out.stdout), raw, "round-trip failed for {raw}");
        }
    }

    #[test]
    fn shell_argv_passes_login_and_command_separately() {
        // whatever $SHELL resolves to, the command must be the last arg and
        // -c must precede it (login flag optional per shell family)
        let (_shell, args) = shell_argv("echo hi");
        assert_eq!(args.last().unwrap(), "echo hi");
        assert!(args.iter().any(|a| a == "-c"));
    }
}
