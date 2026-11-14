import { useEffect, useRef, useState } from "react";
import { errText, hasBackend, ipc, type CustomCmd } from "../ipc";
import { useStore } from "../store";
import type { RepoNode, SubmoduleStatus, WorktreeNode } from "../types";
import { fmtRelTime, isLive } from "../types";
import { Copy, Editor, Finder, Fork, More, MoreV, Package, Play, Plus, Pull, Spinner, Stop, Terminal, Trash } from "../icons";
import SubmoduleMenu from "./SubmoduleMenu";
import SwitchBranchModal from "./SwitchBranchModal";

export default function WorktreeHeader({
  repo,
  wt,
  onRemove,
  onOpenSettings,
}: {
  repo: RepoNode;
  wt: WorktreeNode;
  onRemove: () => void;
  onOpenSettings: () => void;
}) {
  const startAll = useStore((s) => s.startAll);
  const stopAll = useStore((s) => s.stopAll);
  const gitPull = useStore((s) => s.gitPull);
  const openWorktree = useStore((s) => s.openWorktree);
  const showToast = useStore((s) => s.showToast);
  const opLog = useStore((s) => s.ops[wt.wtKey]);
  const [setupBusy, setSetupBusy] = useState(false);
  const [busyCmd, setBusyCmd] = useState<string | null>(null);
  const [customCmds, setCustomCmds] = useState<CustomCmd[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [showSwitch, setShowSwitch] = useState(false);
  const [switchEnabled, setSwitchEnabled] = useState(true);
  // per-submodule pull menu (welded ⋮ on the Pull link)
  const [subs, setSubs] = useState<SubmoduleStatus[]>([]);
  const [pullOpen, setPullOpen] = useState(false);
  const [pulling, setPulling] = useState<string | null>(null); // sub.path | "all" | null
  const [fetchedAt, setFetchedAt] = useState(0);
  const pullRef = useRef<HTMLDivElement>(null);

  const reloadSubs = () => {
    if (!hasBackend()) return;
    ipc
      .submoduleStatus(wt.wtKey)
      .then((s) => {
        setSubs(s);
        setFetchedAt(Date.now() / 1000);
      })
      .catch(() => {});
  };

  // load submodule status when the selected worktree changes
  useEffect(() => {
    if (!hasBackend()) {
      setSubs([]);
      return;
    }
    setPullOpen(false);
    let alive = true;
    ipc
      .submoduleStatus(wt.wtKey)
      .then((s) => {
        if (!alive) return;
        setSubs(s);
        setFetchedAt(Date.now() / 1000);
      })
      .catch(() => alive && setSubs([]));
    return () => {
      alive = false;
    };
  }, [wt.wtKey]);

  useEffect(() => {
    if (!hasBackend()) {
      setCustomCmds([]);
      return;
    }
    ipc
      .getSettings()
      .then((s) => {
        setCustomCmds(s.repos.find((r) => r.id === repo.repoId)?.customCommands || []);
        setSwitchEnabled(s.showSwitchBranch !== false);
      })
      .catch(() => {});
  }, [repo.repoId]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // pull menu: click-outside + Esc closes; ⌘/Ctrl+⏎ pulls everything while open
  useEffect(() => {
    if (!pullOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pullRef.current && !pullRef.current.contains(e.target as Node)) setPullOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPullOpen(false);
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        pullAll();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pullOpen, pulling]);

  async function copyPath() {
    setMenuOpen(false);
    const text = wt.wtKey;
    try {
      await navigator.clipboard.writeText(text);
      showToast("Worktree path copied");
      return;
    } catch {
      /* fall through */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      showToast(ok ? "Worktree path copied" : "Copy failed");
    } catch {
      showToast("Copy failed");
    }
  }

  async function runCustom(cc: CustomCmd) {
    setMenuOpen(false);
    if (busyCmd) return;
    setBusyCmd(cc.command);
    showToast(`Running ${cc.label} — ${wt.branch}…`);
    try {
      await ipc.runCustomCommand(wt.wtKey, cc.command);
      showToast(`${cc.label} finished — ${wt.branch}`);
    } catch (e) {
      showToast(`${cc.label} failed — ${errText(e)}`);
    } finally {
      setBusyCmd(null);
    }
  }

  async function runSetup() {
    if (setupBusy) return;
    setSetupBusy(true);
    showToast(`Running setup — ${wt.branch}…`);
    try {
      await ipc.runWorktreeSetup(wt.wtKey);
      showToast(`Setup complete — ${wt.branch}`);
    } catch (e) {
      showToast(`Setup failed — ${errText(e)}`);
    } finally {
      setSetupBusy(false);
    }
  }

  // ── pull actions (worktree + per-submodule) ──
  function pullAll() {
    if (pulling) return;
    if (!hasBackend()) {
      showToast(`Pulling from origin — ${wt.branch}`);
      return;
    }
    setPulling("all");
    showToast(`Pulling worktree + submodules — ${wt.branch}…`);
    ipc
      .gitPull(wt.wtKey)
      .then((summary) => {
        showToast(`✓ ${summary} — ${wt.branch}`);
        reloadSubs();
      })
      .catch((e) => showToast(`Pull failed — ${errText(e)}`))
      .finally(() => setPulling(null));
  }

  function pullOne(path: string) {
    if (pulling) return;
    const sub = subs.find((s) => s.path === path);
    setPulling(path);
    showToast(`Pulling ${sub?.name ?? path}…`);
    ipc
      .pullSubmodule(wt.wtKey, path)
      .then((r) => {
        showToast(`✓ ${sub?.name ?? path} — ${r}`);
        reloadSubs();
      })
      .catch((e) => showToast(`Pull failed — ${errText(e)}`))
      .finally(() => setPulling(null));
  }

  function pickBranch(path: string, branch: string) {
    const sub = subs.find((s) => s.path === path);
    if (sub?.branch === branch) return;
    showToast(`Switching ${sub?.name ?? path} → ${branch}…`);
    ipc
      .switchSubmoduleBranch(wt.wtKey, path, branch)
      .then(() => {
        showToast(`✓ ${sub?.name ?? path} → ${branch} · parent now shows this submodule modified`);
        reloadSubs();
      })
      .catch((e) => showToast(`Switch failed — ${errText(e)}`));
  }

  function refetch() {
    if (!hasBackend()) return;
    showToast("Fetching submodules…");
    ipc
      .fetchSubmodules(wt.wtKey)
      .then((n) => {
        showToast(`✓ Fetched ${n} submodule${n === 1 ? "" : "s"}`);
        reloadSubs();
      })
      .catch((e) => showToast(`Fetch failed — ${errText(e)}`));
  }

  const anyRunning = wt.services.some((s) => isLive(s.status));
  const synced = wt.git && wt.git.ahead === 0 && wt.git.behind === 0;

  return (
    <div className="head">
      <div className="head-top">
        <div className="branch">
          <span className="glyph">
            <Fork size={15} />
          </span>
          <span className="name">{wt.branch}</span>
        </div>

        <div className="iconbar">
          <button className="ib" title="Open in editor" onClick={() => openWorktree(wt.wtKey, "editor")}>
            <Editor size={15} />
          </button>
          <button className="ib" title="Reveal in Finder" onClick={() => openWorktree(wt.wtKey, "finder")}>
            <Finder size={15} />
          </button>
          <button className="ib" title="Open terminal" onClick={() => openWorktree(wt.wtKey, "terminal")}>
            <Terminal size={15} />
          </button>
        </div>

        {switchEnabled && (
          <button
            className="branchbtn"
            title="Check out a different branch in this worktree — dependencies are reused"
            onClick={() => setShowSwitch(true)}
          >
            <Fork size={14} />
            Switch branch
          </button>
        )}

        <button className="ghostbtn" title="Run setup" onClick={runSetup} disabled={setupBusy}>
          {setupBusy ? <Spinner size={15} /> : <Package size={15} />}
          Setup
        </button>

        {anyRunning ? (
          <button className="primary stop" title="Stop all services" onClick={() => stopAll(wt.wtKey)}>
            <Stop size={12} />
            Stop all
          </button>
        ) : (
          <button className="primary" title="Start all services" onClick={() => startAll(wt.wtKey)}>
            <Play size={13} />
            Start all
          </button>
        )}

        <div className="more" ref={menuRef}>
          <button className={menuOpen ? "on" : ""} title="More" onClick={() => setMenuOpen((o) => !o)}>
            <More size={17} />
          </button>
          {menuOpen && (
            <div className="menu down-right">
              <button className="item" title={wt.wtKey} onClick={copyPath}>
                <span className="mi">
                  <Copy size={14} />
                </span>
                Copy worktree path
              </button>
              <div className="sep" />
              <div className="mlabel">Custom commands</div>
              {customCmds.map((cc) => (
                <button
                  key={cc.label + " " + cc.command}
                  className="item"
                  title={`Run: ${cc.command}`}
                  onClick={() => runCustom(cc)}
                  disabled={busyCmd !== null}
                >
                  <span className="mi">{busyCmd === cc.command ? <Spinner size={14} /> : <Terminal size={14} />}</span>
                  {cc.label}
                </button>
              ))}
              <button
                className="item subtle"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSettings();
                }}
              >
                <span className="mi">
                  <Plus size={14} />
                </span>
                Add command…
              </button>
              <div className="sep" />
              <button
                className="item danger"
                disabled={wt.isMain}
                onClick={() => {
                  setMenuOpen(false);
                  if (wt.isMain) showToast("Main checkout cannot be removed");
                  else onRemove();
                }}
              >
                <span className="mi">
                  <Trash size={14} />
                </span>
                Remove worktree
              </button>
            </div>
          )}
        </div>
      </div>

      {opLog?.running && (
        <div className="op-strip">
          <span className="op-spin">
            <Spinner size={12} />
          </span>
          {opLog.step && <span className="op-step">{opLog.step}</span>}
          {opLog.lines.length > 0 && opLog.lines[opLog.lines.length - 1].text !== opLog.step && (
            <span className="op-line">{opLog.lines[opLog.lines.length - 1].text}</span>
          )}
        </div>
      )}

      <div className="status">
        <span className="repo">{repo.name}</span>
        {wt.git && (
          <>
            <span className="sep" />
            {synced ? (
              <span>in sync with origin</span>
            ) : (
              <span>
                ↑{wt.git.ahead} ↓{wt.git.behind} vs origin
              </span>
            )}
            <span className="sep" />
            {wt.git.dirty ? <span className="changed">uncommitted changes</span> : <span>clean</span>}
            <span className="sep" />
            <span className="commit">
              {fmtRelTime(wt.git.lastCommitTs)} · {wt.git.lastCommitMsg}
            </span>
          </>
        )}
        {subs.length > 0 ? (
          <div className="pull-wrap" ref={pullRef}>
            <div className="pull-split">
              <button className="pull-main" title="Pull worktree + all submodules from origin" onClick={pullAll}>
                {pulling === "all" ? <Spinner size={13} /> : <Pull size={13} />}
                Pull
              </button>
              <button
                className={"pull-caret" + (pullOpen ? " on" : "")}
                title="Pull individual submodules"
                aria-haspopup="menu"
                aria-expanded={pullOpen}
                onClick={() => setPullOpen((o) => !o)}
              >
                <MoreV size={16} />
              </button>
            </div>
            {pullOpen && (
              <SubmoduleMenu
                anchor={pullRef}
                wtKey={wt.wtKey}
                subs={subs}
                pulling={pulling}
                fetchedLabel={fetchedAt ? fmtRelTime(fetchedAt) : "just now"}
                onPullAll={pullAll}
                onPullOne={pullOne}
                onPickBranch={pickBranch}
                onRefetch={refetch}
              />
            )}
          </div>
        ) : (
          <button className="pull" title="Pull from origin" onClick={() => gitPull(wt.wtKey)}>
            <Pull size={13} />
            Pull
          </button>
        )}
      </div>

      {showSwitch && <SwitchBranchModal repo={repo} wt={wt} onClose={() => setShowSwitch(false)} />}
    </div>
  );
}
