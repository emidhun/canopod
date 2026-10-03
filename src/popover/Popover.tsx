// Menu-bar tray — ported from the design system's "Canopod Tray.html".
// A per-repo, status-grouped worktree list with search, keyboard nav, hover
// actions, a footer menu and a health status bar. State comes from the shared
// store; gaps the tray can't own (creating worktrees, settings, the updater)
// degrade to opening the manager rather than fabricating behaviour.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore, getUptimeSec } from "../store";
import type { RepoNode, WorktreeNode } from "../types";
import { aggStatus, fmtUptime } from "../types";
import { hasBackend } from "../ipc";
import { Alert, Check, Chevron, Database, Editor, External, Fork, Play, Plus, Power, Search, Settings, Spinner, Stop, Terminal, WindowIcon } from "../icons";

/** design status buckets: run · err (serving) / boot (transitional) / off (idle) */
type Vis = "run" | "err" | "boot" | "off";
function visOf(wt: WorktreeNode): Vis {
  const s = aggStatus(wt);
  if (s === "running") return "run";
  if (s === "error") return "err";
  if (s === "starting" || s === "stopping") return "boot";
  return "off";
}
const serving = (v: Vis) => v === "run" || v === "err";

/** the service whose port + uptime represents the worktree (web first) */
function primary(wt: WorktreeNode) {
  return wt.services.find((s) => s.kind === "web" && s.port != null) ?? wt.services.find((s) => s.port != null) ?? wt.services[0];
}

/** case-insensitive query highlight → text with a <mark> around the match */
function hl(text: string, q: string): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="mk">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** branch name: the `owner/` prefix recedes; the tail truncates at its HEAD */
function BranchName({ branch, q }: { branch: string; q: string }) {
  const i = branch.indexOf("/");
  const seg = i < 0 ? "" : branch.slice(0, i + 1);
  const tail = i < 0 ? branch : branch.slice(i + 1);
  return (
    <span className="branch" title={branch}>
      {seg && <span className="seg">{hl(seg, q)}</span>}
      <span className="bn">
        <span>{hl(tail, q)}</span>
      </span>
    </span>
  );
}

function RowMeta({ wt, vis }: { wt: WorktreeNode; vis: Vis }) {
  if (vis === "boot") return <span className="meta">starting…</span>;
  if (vis === "off") {
    const ahead = wt.git?.ahead ?? 0;
    return <span className="meta">{ahead ? `${ahead} ahead` : "idle"}</span>;
  }
  const svc = primary(wt);
  const errs = wt.services.filter((s) => s.status === "error").length;
  const up = fmtUptime(getUptimeSec(svc?.svcKey ?? ""));
  return (
    <span className="meta">
      {errs > 0 && (
        <span className="warnct">
          <Alert size={11} />
          {errs}
        </span>
      )}
      {svc?.port != null && <span className="port">:{svc.port}</span>}
      {up !== "—" && <span className="up">{up}</span>}
    </span>
  );
}

function RowActions({ wt, vis }: { wt: WorktreeNode; vis: Vis }) {
  const startAll = useStore((s) => s.startAll);
  const stopAll = useStore((s) => s.stopAll);
  const openWorktree = useStore((s) => s.openWorktree);
  const openPort = useStore((s) => s.openPort);
  const resetDb = useStore((s) => s.resetDb);
  const resetting = useStore((s) => !!s.resetting[wt.wtKey]);
  const stop = (e: React.MouseEvent) => {
    e.stopPropagation();
    stopAll(wt.wtKey);
  };
  // Reset this worktree's database (store guards against concurrent resets and
  // surfaces progress/completion via the toast).
  const db = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!resetting) resetDb(wt.wtKey);
  };
  const DbButton = () => (
    <button className="ib" title="Reset database" onClick={db} disabled={resetting}>
      {resetting ? <Spinner size={13} className="cx-spin" /> : <Database size={13} />}
    </button>
  );
  const term = (e: React.MouseEvent) => {
    e.stopPropagation();
    openWorktree(wt.wtKey, "terminal");
  };
  if (vis === "boot") {
    return (
      <span className="acts">
        <button className="ib" title="Terminal" onClick={term}>
          <Terminal size={13} />
        </button>
        <DbButton />
        <button className="ib danger" title="Cancel start" onClick={stop}>
          <Stop size={12} />
        </button>
      </span>
    );
  }
  if (vis === "off") {
    return (
      <span className="acts">
        <button className="ib" title="Open in editor" onClick={(e) => { e.stopPropagation(); openWorktree(wt.wtKey, "editor"); }}>
          <Editor size={13} />
        </button>
        <button className="ib" title="Terminal" onClick={term}>
          <Terminal size={13} />
        </button>
        <button className="ib play" title="Start" onClick={(e) => { e.stopPropagation(); startAll(wt.wtKey); }}>
          <Play size={12} />
        </button>
      </span>
    );
  }
  const svc = primary(wt);
  return (
    <span className="acts">
      <button
        className="ib"
        title={svc?.port != null ? "Open in browser" : "No port to open"}
        onClick={(e) => { e.stopPropagation(); if (svc?.port != null) openPort(svc.port); }}
      >
        <External size={13} />
      </button>
      <button className="ib" title="Terminal" onClick={term}>
        <Terminal size={13} />
      </button>
      <DbButton />
      <button className="ib danger" title="Stop" onClick={stop}>
        <Stop size={12} />
      </button>
    </span>
  );
}

function Row({ wt, vis, q, selected, onHover, onFocusWt }: {
  wt: WorktreeNode;
  vis: Vis;
  q: string;
  selected: boolean;
  onHover: () => void;
  onFocusWt: () => void;
}) {
  const dot = vis === "run" ? "run" : vis === "err" ? "err" : vis === "boot" ? "boot" : "idle";
  return (
    <div
      className={"row" + (vis === "off" ? " off" : "") + (selected ? " sel" : "")}
      title={wt.branch}
      data-sel={selected ? "1" : undefined}
      onMouseEnter={onHover}
      onClick={onFocusWt}
    >
      <span className={"dot " + dot} />
      <BranchName branch={wt.branch} q={q} />
      <RowMeta wt={wt} vis={vis} />
      <RowActions wt={wt} vis={vis} />
    </div>
  );
}

export default function Popover() {
  const tree = useStore((s) => s.tree);
  const toast = useStore((s) => s.toast);
  const showToast = useStore((s) => s.showToast);
  const select = useStore((s) => s.select);
  const startAll = useStore((s) => s.startAll);
  const openManager = useStore((s) => s.openManager);
  const quit = useStore((s) => s.quit);

  const [repoId, setRepoId] = useState<string | null>(null);
  const [repoMenu, setRepoMenu] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(-1);
  const [ver, setVer] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // keep the selected repo valid as the tree changes; default to the first
  const repo: RepoNode | undefined = useMemo(
    () => tree.find((r) => r.repoId === repoId) ?? tree[0],
    [tree, repoId],
  );

  const ql = q.trim().toLowerCase();
  // visible worktrees for this repo, ordered as they render: running → starting → idle
  const { groups, rows } = useMemo(() => {
    const wts = (repo?.worktrees ?? []).filter((w) => w.branch.toLowerCase().includes(ql));
    const tagged = wts.map((wt) => ({ wt, vis: visOf(wt) }));
    const run = tagged.filter((t) => serving(t.vis));
    const boot = tagged.filter((t) => t.vis === "boot");
    const idle = tagged.filter((t) => t.vis === "off");
    return {
      groups: [
        { label: "Running", items: run },
        { label: "Starting", items: boot },
        { label: ql ? "Matches" : "Idle", items: idle },
      ].filter((g) => g.items.length),
      rows: [...run, ...boot, ...idle],
    };
  }, [repo, ql]);

  const runningCount = (repo?.worktrees ?? []).filter((w) => serving(visOf(w))).length;
  const total = repo?.worktrees.length ?? 0;

  // app-wide health for the status bar — reflects real state, not a claim
  const errCount = tree.reduce((n, r) => n + r.worktrees.filter((w) => visOf(w) === "err").length, 0);
  const anyRunning = tree.some((r) => r.worktrees.some((w) => serving(visOf(w))));

  const focusWt = (wt: WorktreeNode) => {
    select(wt.wtKey);
    openManager();
  };

  useEffect(() => {
    if (hasBackend()) import("@tauri-apps/api/app").then((m) => m.getVersion().then(setVer).catch(() => setVer("")));
  }, []);

  // entry animation, matching the design's `pin`
  useEffect(() => {
    const el = popRef.current;
    if (!el) return;
    el.classList.add("is-in");
    const done = () => el.classList.remove("is-in");
    el.addEventListener("animationend", done, { once: true });
    return () => el.removeEventListener("animationend", done);
  }, []);

  // reset the keyboard cursor whenever the visible set changes
  useEffect(() => setSel(-1), [ql, repoId]);

  // keep the keyboard-selected row inside the scroll port
  useEffect(() => {
    if (sel < 0) return;
    listRef.current?.querySelector<HTMLElement>('.row[data-sel="1"]')?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // keyboard: arrows move the cursor, Enter acts, ⌘K focuses, Esc clears,
  // any other typing focuses the filter. Mouse movement drops keyboard mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        document.body.classList.add("kb");
        if (!rows.length) return;
        setSel((at) => {
          const d = e.key === "ArrowDown" ? 1 : rows.length - 1;
          const base = at < 0 ? (e.key === "ArrowDown" ? -1 : 0) : at;
          return (base + d + rows.length) % rows.length;
        });
      } else if (e.key === "Enter" && sel >= 0) {
        const r = rows[sel];
        if (!r) return;
        r.vis === "off" ? startAll(r.wt.wtKey) : focusWt(r.wt);
      } else if (e.metaKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.select();
        inputRef.current?.focus();
      } else if (e.metaKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newWorktree();
      } else if (e.metaKey && e.key === ",") {
        // the hint the gear has always carried, now with a listener behind it
        e.preventDefault();
        openSettings();
      } else if (e.key === "Escape") {
        if (q) setQ("");
      } else if (e.key !== "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        inputRef.current?.focus();
      }
    };
    const onMove = () => document.body.classList.remove("kb");
    document.addEventListener("keydown", onKey);
    addEventListener("mousemove", onMove, { passive: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      removeEventListener("mousemove", onMove);
    };
  }, [rows, sel, q]);

  // close the repo menu on outside click
  useEffect(() => {
    if (!repoMenu) return;
    const d = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".repo")) setRepoMenu(false);
    };
    document.addEventListener("mousedown", d);
    return () => document.removeEventListener("mousedown", d);
  }, [repoMenu]);

  // The new-worktree modal and the overview live in the main window. Show that
  // window (openManager) and emit a command it listens for (App.tsx). In a plain
  // browser (no backend) there's nothing to emit to, so fall back to a toast.
  const command = (name: string, fallback: string) => {
    openManager();
    if (hasBackend()) import("@tauri-apps/api/event").then((m) => m.emit(name)).catch(() => {});
    else showToast(fallback);
  };
  const newWorktree = () => command("tray:new-worktree", "Create a worktree in the manager");
  const openManagerOverview = () => command("tray:overview", "Opening all worktrees");
  const openSettings = () => command("tray:settings", "Settings — opening the manager");

  return (
    <div className="pop" ref={popRef}>
      <div className="ph">
        <div className="repo">
          <button onClick={() => setRepoMenu((o) => !o)} disabled={tree.length < 2} aria-haspopup="listbox" aria-expanded={repoMenu}>
            <Fork size={13} nodeColor="var(--teal)" />
            <span className="nm">{repo?.name ?? "No repository"}</span>
            {tree.length > 1 && <Chevron size={10} />}
          </button>
          <span className="sum">
            {runningCount > 0 ? (
              <>
                <span className="dot run" />
                <b>{runningCount} running</b> · {total} total
              </>
            ) : (
              `${total} ${total === 1 ? "worktree" : "worktrees"}`
            )}
          </span>
          <button className="gear" title="Settings… ⌘," onClick={openSettings}>
            <Settings size={14} />
          </button>
          {repoMenu && (
            <div className="repomenu" role="listbox">
              {tree.map((r) => (
                <button
                  key={r.repoId}
                  className={r.repoId === (repo?.repoId ?? "") ? "on" : ""}
                  role="option"
                  aria-selected={r.repoId === repo?.repoId}
                  onClick={() => { setRepoId(r.repoId); setRepoMenu(false); }}
                >
                  <Fork size={13} nodeColor="var(--teal)" />
                  {r.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <label className="search">
          <Search size={13} />
          <input
            ref={inputRef}
            value={q}
            placeholder="Filter worktrees"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd>⌘K</kbd>
        </label>
      </div>

      <div className="list" ref={listRef}>
        {rows.length ? (
          groups.map((g) => {
            const startIdx = rows.findIndex((r) => r === g.items[0]);
            return (
              <div key={g.label}>
                <div className="glabel">
                  {g.label}
                  <span className="ct">{g.items.length}</span>
                  <span className="rule" />
                </div>
                {g.items.map((t, j) => (
                  <Row
                    key={t.wt.wtKey}
                    wt={t.wt}
                    vis={t.vis}
                    q={ql}
                    selected={sel === startIdx + j}
                    onHover={() => setSel(startIdx + j)}
                    onFocusWt={() => focusWt(t.wt)}
                  />
                ))}
              </div>
            );
          })
        ) : (
          <div className="empty">
            {ql ? (
              <>
                No worktree matches <code>{q}</code>
              </>
            ) : (
              "No worktrees yet"
            )}
          </div>
        )}
      </div>

      <div className="pf">
        <div className="pfrow">
          <button className="mi" title="New worktree… ⌘N" onClick={newWorktree}>
            <Plus size={13} />
            New worktree
          </button>
          <span className="vr" />
          <button className="mi" title="Open Manager ⌘⇧C" onClick={openManagerOverview}>
            <WindowIcon size={13} />
            Open Manager
          </button>
          <span className="vr" />
          <button className="mi" title="Quit Canopod ⌘Q" onClick={quit}>
            <Power size={13} />
            Quit
          </button>
        </div>
        <div className="pstat">
          <span className="hlth" style={{ color: errCount > 0 ? "var(--amber)" : "var(--green)", display: "inline-flex" }}>
            {errCount > 0 ? <Alert size={13} /> : <Check size={13} />}
          </span>
          <span>
            {errCount > 0
              ? `${errCount} service${errCount > 1 ? "s" : ""} stopped unexpectedly`
              : anyRunning
                ? "Canopod is running smoothly"
                : "No services running"}
          </span>
          {ver && <span className="ver">v{ver}</span>}
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
