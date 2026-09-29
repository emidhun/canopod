// Headless end-to-end test suite (WTM_SUITE=<repoId>) that drives the real
// command/service code paths and prints [suite] lines. Used to validate flows
// without clicking the UI. Not part of normal operation.
use crate::{services, setup, state};
use std::time::{Duration, Instant};
use crate::runtime::RuntimeContext;

fn pass(case: &str, detail: impl AsRef<str>) {
    eprintln!("[suite] PASS  {case} — {}", detail.as_ref());
}
fn fail(case: &str, detail: impl AsRef<str>) {
    eprintln!("[suite] FAIL  {case} — {}", detail.as_ref());
}
fn skip(case: &str, detail: impl AsRef<str>) {
    eprintln!("[suite] SKIP  {case} — {}", detail.as_ref());
}
fn info(detail: impl AsRef<str>) {
    eprintln!("[suite] ..    {}", detail.as_ref());
}

fn port_bound(port: u32) -> bool {
    std::process::Command::new("lsof")
        .args(["-i", &format!(":{port}"), "-sTCP:LISTEN"])
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

fn proc_running(app: &RuntimeContext, key: &str) -> bool {
    let t = app.state::<services::ProcTable>();
    let p = t.procs.lock();
    p.contains_key(key)
}
fn log_count(app: &RuntimeContext, key: &str) -> usize {
    let t = app.state::<services::ProcTable>();
    let l = t.logs.lock();
    l.get(key).map(|b| b.len()).unwrap_or(0)
}

pub fn run(app: RuntimeContext, repo_id: String) {
    app.executor().spawn(async move {
        // wait for initial scan
        tokio::time::sleep(Duration::from_secs(3)).await;
        eprintln!("[suite] ===== START repo={repo_id} =====");

        // ── Case 1: discovery + git meta ──
        let (repo_path, worktrees): (String, Vec<(String, String, bool, bool)>) = {
            let st = app.state::<state::AppState>();
            let tree = st.tree.read();
            match tree.iter().find(|r| r.repo_id == repo_id) {
                None => {
                    fail("discovery", format!("repo '{repo_id}' not in tree"));
                    eprintln!("[suite] ===== DONE (aborted) =====");
                    return;
                }
                Some(r) => (
                    r.path.clone(),
                    r.worktrees
                        .iter()
                        .map(|w| {
                            let has_git = w.git.is_some();
                            let deps = std::path::Path::new(&w.path).join("frontend/node_modules").exists();
                            (w.wt_key.clone(), w.branch.clone(), has_git, deps)
                        })
                        .collect(),
                ),
            }
        };
        pass("discovery", format!("{} worktrees found", worktrees.len()));
        let git_ok = worktrees.iter().filter(|w| w.2).count();
        if git_ok == worktrees.len() {
            pass("git-meta", format!("ahead/behind/dirty/commit present for all {git_ok}"));
        } else {
            fail("git-meta", format!("only {git_ok}/{} have git meta", worktrees.len()));
        }
        for (_, branch, _, deps) in &worktrees {
            info(format!("worktree {branch} (deps: {})", if *deps { "yes" } else { "no" }));
        }

        // For the start test prefer a NON-main worktree with deps whose port is
        // free (the main checkout's port is usually taken by the user's own dev
        // server). worktrees: (wt_key, branch, has_git, has_deps). index 0 = main.
        let with_deps = worktrees
            .iter()
            .enumerate()
            .filter(|(i, w)| *i != 0 && w.3)
            .map(|(_, w)| w.clone())
            .find(|w| {
                let port = {
                    let st = app.state::<state::AppState>();
                    let tree = st.tree.read();
                    tree.iter()
                        .flat_map(|r| r.worktrees.iter())
                        .filter(|x| x.wt_key == w.0)
                        .flat_map(|x| x.services.iter())
                        .find(|s| s.service_id == "frontend")
                        .and_then(|s| s.port)
                        .unwrap_or(0)
                };
                port != 0 && !port_bound(port)
            })
            .or_else(|| worktrees.iter().find(|w| w.3).cloned());
        let without_deps = worktrees.iter().find(|w| !w.3).cloned();

        // ── Case 2: start frontend on a deps-present worktree, expect port bind ──
        match &with_deps {
            None => skip("start-frontend", "no worktree has frontend deps"),
            Some((wt_key, branch, _, _)) => {
                let svc_key = format!("{wt_key}::frontend");
                let port = {
                    let st = app.state::<state::AppState>();
                    let tree = st.tree.read();
                    tree.iter()
                        .flat_map(|r| r.worktrees.iter())
                        .flat_map(|w| w.services.iter())
                        .find(|s| s.svc_key == svc_key)
                        .and_then(|s| s.port)
                        .unwrap_or(0)
                };
                info(format!("starting frontend on {branch} (port {port}); webpack compile can take ~1-2 min…"));
                match services::start_service(&app, &svc_key).await {
                    Err(e) => fail("start-frontend", format!("start errored: {e}")),
                    Ok(()) => {
                        // poll up to 180s for the dev server to bind the port
                        let deadline = Instant::now() + Duration::from_secs(180);
                        let mut bound = false;
                        while Instant::now() < deadline {
                            tokio::time::sleep(Duration::from_secs(5)).await;
                            if !proc_running(&app, &svc_key) {
                                break;
                            }
                            if port != 0 && port_bound(port) {
                                bound = true;
                                break;
                            }
                        }
                        let alive = proc_running(&app, &svc_key);
                        let logs = log_count(&app, &svc_key);
                        if bound {
                            pass("start-frontend", format!("webpack bound port {port}, {logs} log lines"));
                        } else if alive {
                            fail("start-frontend", format!("alive after 180s but port {port} not bound ({logs} logs)"));
                        } else {
                            fail("start-frontend", format!("process exited early ({logs} logs — see console)"));
                        }
                        // ── Case 3: stop ──
                        let _ = services::stop_service(&app, &svc_key).await;
                        tokio::time::sleep(Duration::from_secs(4)).await;
                        let stopped = !proc_running(&app, &svc_key);
                        let port_freed = port == 0 || !port_bound(port);
                        if stopped && port_freed {
                            pass("stop-frontend", "process group gone, port freed");
                        } else {
                            fail("stop-frontend", format!("stopped={stopped} port_freed={port_freed}"));
                        }
                    }
                }
            }
        }

        // ── Case 4: setup on a depless worktree (the user's fix) ──
        match &without_deps {
            None => skip("setup", "all worktrees already have deps"),
            Some((wt_key, branch, _, _)) => {
                if !setup::has_config(wt_key, &repo_path) {
                    skip("setup", "no .worktreemanager.json config");
                } else {
                    info(format!("running setup (npm install) on {branch} — several minutes…"));
                    let started = Instant::now();
                    match crate::operations::run_worktree_setup(app.clone(), wt_key.clone(), false).await {
                        Ok(()) => {
                            let deps = std::path::Path::new(wt_key).join("frontend/node_modules").exists();
                            if deps {
                                pass("setup", format!("deps installed in {}s", started.elapsed().as_secs()));
                            } else {
                                fail("setup", "command returned ok but frontend/node_modules missing");
                            }
                        }
                        Err(e) => fail("setup", format!("{e}")),
                    }
                }
            }
        }

        // ── Case 5: create worktree (submodules) ──
        // temporarily disable auto-setup so this case validates git+submodules
        // fast (the npm-install path is already covered by Case 4).
        let cfg = std::path::Path::new(&repo_path).join(".worktreemanager.json");
        let cfg_bak = std::path::Path::new(&repo_path).join(".worktreemanager.json.suitebak");
        let moved = std::fs::rename(&cfg, &cfg_bak).is_ok();
        let new_branch = "wtm/suite-check".to_string();
        info(format!("creating worktree {new_branch} (submodules; auto-setup disabled for speed)…"));
        let created = crate::operations::create_worktree(
            app.clone(),
            repo_id.clone(),
            new_branch.clone(),
            Some("HEAD".to_string()),
            true,
        )
        .await;
        match &created {
            Err(e) => fail("create-worktree", format!("{e}")),
            Ok(wt_path) => {
                let fe_sub = std::path::Path::new(wt_path).join("frontend/ee/.git").exists()
                    || std::fs::read_dir(std::path::Path::new(wt_path).join("frontend/ee"))
                        .map(|mut d| d.next().is_some())
                        .unwrap_or(false);
                let sv_sub = std::fs::read_dir(std::path::Path::new(wt_path).join("server/ee"))
                    .map(|mut d| d.next().is_some())
                    .unwrap_or(false);
                if fe_sub && sv_sub {
                    pass("create-worktree", "created; submodules frontend/ee + server/ee populated");
                } else {
                    fail("create-worktree", format!("submodules empty (fe={fe_sub} sv={sv_sub})"));
                }

                // ── Case 6: remove the worktree we created ──
                info("removing the created worktree…");
                match crate::operations::remove_worktree(app.clone(), wt_path.clone(), true, true).await {
                    Ok(()) => {
                        let gone = !std::path::Path::new(wt_path).exists();
                        let in_tree = {
                            let st = app.state::<state::AppState>();
                            let tree = st.tree.read();
                            tree.iter().flat_map(|r| r.worktrees.iter()).any(|w| &w.wt_key == wt_path)
                        };
                        if gone && !in_tree {
                            pass("remove-worktree", "worktree removed, dropped from tree");
                        } else {
                            fail("remove-worktree", format!("path_gone={gone} still_in_tree={in_tree}"));
                        }
                    }
                    Err(e) => fail("remove-worktree", format!("{e}")),
                }
            }
        }
        if moved {
            let _ = std::fs::rename(&cfg_bak, &cfg);
        }

        // ── Case 7: dirty report on the main checkout ──
        if let Some((wt_key, branch, _, _)) = worktrees.first() {
            match crate::git::dirty_report(wt_key).await {
                Ok(report) => pass("dirty-report", format!("{branch}: dirty={} ({} of {} shown)", report.dirty, report.details.len(), report.total)),
                Err(e) => fail("dirty-report", format!("{branch}: {e}")),
            }
        }

        // ── Case 8 (WTM_SUITE_FULL=1): the user's exact path —
        //    create → auto-setup (npm install) → start frontend → port bind → stop → remove ──
        if std::env::var("WTM_SUITE_FULL").is_ok() {
            let branch = "wtm/full-check".to_string();
            info(format!("FULL: creating {branch} with auto-setup (npm install — several minutes)…"));
            let started = Instant::now();
            match crate::operations::create_worktree(app.clone(), repo_id.clone(), branch.clone(), Some("HEAD".to_string()), true).await {
                Err(e) => fail("full-create+setup", format!("{e}")),
                Ok(wt_path) => {
                    let deps = std::path::Path::new(&wt_path).join("frontend/node_modules").exists();
                    if deps {
                        pass("full-create+setup", format!("worktree provisioned in {}s", started.elapsed().as_secs()));
                    } else {
                        fail("full-create+setup", "setup ran but frontend/node_modules missing");
                    }
                    // start its frontend, expect port bind
                    let svc_key = format!("{wt_path}::frontend");
                    let port = {
                        let st = app.state::<state::AppState>();
                        let tree = st.tree.read();
                        tree.iter().flat_map(|r| r.worktrees.iter()).flat_map(|w| w.services.iter())
                            .find(|s| s.svc_key == svc_key).and_then(|s| s.port).unwrap_or(0)
                    };
                    info(format!("FULL: starting frontend on new worktree (port {port})…"));
                    if services::start_service(&app, &svc_key).await.is_ok() {
                        let deadline = Instant::now() + Duration::from_secs(180);
                        let mut bound = false;
                        while Instant::now() < deadline {
                            tokio::time::sleep(Duration::from_secs(5)).await;
                            if !proc_running(&app, &svc_key) { break; }
                            if port != 0 && port_bound(port) { bound = true; break; }
                        }
                        if bound {
                            pass("full-start", format!("freshly created worktree's frontend bound port {port}"));
                        } else if proc_running(&app, &svc_key) {
                            fail("full-start", format!("alive but port {port} not bound in 180s ({} logs)", log_count(&app, &svc_key)));
                        } else {
                            fail("full-start", format!("exited early ({} logs)", log_count(&app, &svc_key)));
                        }
                        let _ = services::stop_service(&app, &svc_key).await;
                        tokio::time::sleep(Duration::from_secs(4)).await;
                    }
                    info("FULL: removing the worktree…");
                    match crate::operations::remove_worktree(app.clone(), wt_path.clone(), true, true).await {
                        Ok(()) => pass("full-remove", "cleaned up"),
                        Err(e) => fail("full-remove", format!("{e}")),
                    }
                }
            }
        }

        eprintln!("[suite] ===== DONE =====");
    });
}
