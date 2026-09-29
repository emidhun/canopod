use canopy_lib::backend;
use std::path::PathBuf;

const USAGE: &str = "canopy-backend serve [--config-dir PATH] [--data-dir PATH] [--log-dir PATH]\n\nRuns in the foreground without a GUI. Use a process supervisor for persistence.\nStop with Ctrl-C or SIGTERM (Unix). HTTP/MCP attachment is not available yet.";

struct StderrLogger;
impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::max_level()
    }
    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("{} {}: {}", record.level(), record.target(), record.args());
        }
    }
    fn flush(&self) {}
}
static LOGGER: StderrLogger = StderrLogger;
fn main() {
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(
        std::env::var("RUST_LOG")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(log::LevelFilter::Info),
    );
    if let Err(error) = run() {
        eprintln!("canopy-backend: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = std::env::args_os().skip(1);
    match args.next().as_deref().and_then(|arg| arg.to_str()) {
        Some("--help" | "-h") => {
            println!("{USAGE}");
            return Ok(());
        }
        Some("--version") => {
            println!("canopy-backend {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Some("serve") => {}
        _ => return Err(USAGE.into()),
    }
    let mut paths = backend::default_paths()?;
    let mut seen = std::collections::HashSet::new();
    while let Some(flag) = args.next() {
        let name = flag.to_str().ok_or("directory option must be UTF-8")?;
        if matches!(name, "--help" | "-h") {
            println!("{USAGE}");
            return Ok(());
        }
        let target = match name {
            "--config-dir" => &mut paths.config,
            "--data-dir" => &mut paths.data,
            "--log-dir" => &mut paths.logs,
            _ => return Err(format!("unknown option {name}\n{USAGE}")),
        };
        if !seen.insert(name.to_owned()) {
            return Err(format!("duplicate option {name}"));
        }
        let path = PathBuf::from(
            args.next()
                .ok_or_else(|| format!("missing path for {name}"))?,
        );
        if !path.is_dir() {
            return Err(format!(
                "{name} must name an existing directory: {}",
                path.display()
            ));
        }
        *target =
            std::fs::canonicalize(&path).map_err(|e| format!("resolve {}: {e}", path.display()))?;
    }
    // Either shared directory permits legacy state races. Isolated hosts must
    // override both config and data; binary install locations are not evidence.
    let defaults = backend::default_paths()?;
    let canonical = |path: &std::path::Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    if canonical(&paths.data) == canonical(&defaults.data) || canonical(&paths.config) == canonical(&defaults.config) {
        canopy_lib::ownership::refuse_legacy_desktop()?;
    }
    let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("start executor: {e}"))?;
    let result = runtime.block_on(async {
        let stop = backend::shutdown_signal()?;
        let app = backend::open(paths)?;
        eprintln!(
            "canopy-backend {} running in foreground (pid {}); no network listener",
            env!("CARGO_PKG_VERSION"),
            std::process::id()
        );
        backend::serve(app, stop).await
    });
    // Detached process waiters may briefly retain the context/owner lock. Give
    // them time to finish; OS process exit is the final ownership boundary.
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
    result
}
