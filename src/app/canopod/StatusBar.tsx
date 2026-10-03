/* The status bar — where the redesign put the tall metadata row.

   The old header spent ~90px restating git state. Here it is 23px of quiet
   text plus one welded control: the word "Pull" pulls everything, the ▾ opens
   per-submodule control. Anchored to the control that opened it, not centred. */
import { useEffect, useRef, useState } from "react";
import { Bell, Chevron, Fork, Info, Pull, Refresh, Search, Sparkle, Spinner } from "../../icons";
import { errText, hasBackend, ipc, type Branches } from "../../ipc";
import { useStore, type LaneSession } from "../../store";
import type { SubmoduleStatus, WorktreeNode } from "../../types";
import { fmtRelTime } from "../../types";
import { agentState, type AttnItem } from "../nextAction";
import { LAYOUTS, LAYOUT_ORDER, layoutLabel, type LayoutId, type PaneKind } from "./WorkSurface";

const EMPTY: LaneSession[] = [];

export default function StatusBar({
  wt,
  view,
  attn,
  panes,
  onLayout,
  onAttn,
  onSwitchBranch,
  worktreeCount,
  repoCount,
}: {
  wt: WorktreeNode | null;
  view: "wt" | "overview";
  attn: AttnItem[];
  panes: PaneKind[];
  onLayout: (layout: LayoutId) => void;
  onAttn: () => void;
  /** absent when Settings has turned the Switch-branch action off — the branch
      still shows, it just stops being a way in */
  onSwitchBranch?: () => void;
  worktreeCount: number;
  repoCount: number;
}) {
  const sessions = useStore((s) => (wt ? (s.sessions[wt.wtKey] ?? EMPTY) : EMPTY));
  const gitPull = useStore((s) => s.gitPull);
  const [pullOpen, setPullOpen] = useState(false);
  const caretRef = useRef<HTMLButtonElement>(null);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);
  const layoutTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!layoutOpen) return;
    layoutRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    const down = (e: MouseEvent) => {
      if (!layoutRef.current?.contains(e.target as Node)) setLayoutOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLayoutOpen(false);
        layoutTrigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [layoutOpen]);

  if (view === "overview" || !wt) {
    return (
      <div className="cxs-statusbar">
        <span className="cxs-sb">All worktrees</span>
        <span className="cxs-sdiv" />
        <span className="msg">
          {worktreeCount} worktree{worktreeCount === 1 ? "" : "s"} · {repoCount} {repoCount === 1 ? "repository" : "repositories"}
        </span>
        <button className="cxs-sb" onClick={onAttn} title="Needs you">
          <Bell size={11} />
          {attn.length}
        </button>
      </div>
    );
  }

  const g = wt.git;
  const agents = sessions.filter((s) => s.kind === "agent" && s.running);
  const waiting = agents.some((s) => agentState(s) === "waiting");
  // two panes reads as a split whatever the pair happens to be

  return (
    <div className="cxs-statusbar">
      {onSwitchBranch ? (
        <button className="cxs-sb cxs-sb--mono" onClick={onSwitchBranch} title="Switch branch…">
          <Fork size={11} />
          {wt.branch}
        </button>
      ) : (
        <span className="cxs-sb cxs-sb--mono" title={wt.branch}>
          <Fork size={11} />
          {wt.branch}
        </span>
      )}

      <span className="cxs-sdiv" />
      <span className="msg">{g ? `${fmtRelTime(g.lastCommitTs)} · ${g.lastCommitMsg}` : "no commits yet"}</span>

      {/* persistent pull — the word pulls everything, ▾ opens per-submodule */}
      <span className="cxs-pullwrap">
        <span className="cxs-pullsplit">
          <button
            className="cxs-sb cxs-pullmain"
            title="Pull worktree + all submodules from origin"
            onClick={() => gitPull(wt.wtKey)}
          >
            <Pull size={11} />
            Pull
          </button>
          <button
            ref={caretRef}
            className={"cxs-sb cxs-pullcaret" + (pullOpen ? " is-on" : "")}
            title="Pull individual submodules"
            aria-haspopup="menu"
            aria-expanded={pullOpen}
            onClick={() => setPullOpen((p) => !p)}
          >
            <Chevron size={9} />
          </button>
        </span>
        {pullOpen && <PullPop wt={wt} anchor={caretRef} onClose={() => setPullOpen(false)} />}
      </span>

      {agents.length > 0 && (
        <span className={"cxs-sb " + (waiting ? "cxs-sb--warn" : "cxs-sb--teal")}>
          <Sparkle size={11} />
          {waiting ? "agent waiting" : "agent working"}
        </span>
      )}

      <span className="cxs-sdiv" />
      <div className="cxs-viewwrap" ref={layoutRef}>
        <button className={"cxs-sb cxs-viewpick" + (layoutOpen ? " is-on" : "")} ref={layoutTrigger} aria-label={`Workspace layout: ${layoutLabel(panes)}`} aria-haspopup="dialog" aria-expanded={layoutOpen} onClick={() => setLayoutOpen((v) => !v)}>
          {layoutLabel(panes)}<Chevron size={9} />
        </button>
        {layoutOpen && <div className="cxs-viewpop" role="dialog" aria-label="Workspace layout">
          <div className="cxs-viewheading">Workspace layout</div>
          {LAYOUT_ORDER.map((l) => <button key={l} className="cxs-viewoption" aria-pressed={LAYOUTS[l].panes.join() === panes.join()} onClick={() => { onLayout(l); setLayoutOpen(false); layoutTrigger.current?.focus(); }}>
            {LAYOUTS[l].label}<span aria-hidden="true">{LAYOUTS[l].panes.join() === panes.join() ? "✓" : ""}</span>
          </button>)}
        </div>}
      </div>
      <button className="cxs-sb" onClick={onAttn} title="Needs you">
        <Bell size={11} />
        {attn.length}
      </button>
    </div>
  );
}

/* ── the welded pull popover ──────────────────────────────────────── */

function PullPop({ wt, onClose, anchor }: { wt: WorktreeNode; onClose: () => void; anchor?: React.RefObject<HTMLElement | null> }) {
  const showToast = useStore((s) => s.showToast);
  const syncSubmodules = useStore((s) => s.syncSubmodules);
  const syncing = useStore((s) => !!s.subSyncing[wt.wtKey]);
  const [subs, setSubs] = useState<SubmoduleStatus[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const reload = () => {
    if (!hasBackend()) {
      setLoaded(true);
      return;
    }
    ipc
      .submoduleStatus(wt.wtKey)
      .then((s) => {
        setSubs(s);
        setFetchedAt(Date.now());
      })
      .catch(() => setSubs([]))
      .finally(() => setLoaded(true));
  };

  useEffect(reload, [wt.wtKey]);

  useEffect(() => {
    const d = (e: MouseEvent) => {
      const t = e.target as Node;
      // the caret is outside this ref; without this the listener closes the
      // popover and the caret's click reopens it, so it can never dismiss
      if (anchor?.current?.contains(t)) return;
      if (ref.current && !ref.current.contains(t)) onClose();
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        pullAll();
      }
    };
    // ⇧⌘S is handled globally (App.tsx) — it works whether or not this popover
    // is open, so it is not re-bound here.
    document.addEventListener("mousedown", d);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", d);
      document.removeEventListener("keydown", k);
    };
  });

  function pullAll() {
    if (busy || !hasBackend()) return;
    setBusy("all");
    showToast(`Pulling worktree + submodules — ${wt.branch}…`);
    ipc
      .gitPull(wt.wtKey)
      .then((summary) => {
        showToast(`✓ ${summary} — ${wt.branch}`);
        reload();
      })
      .catch((e) => showToast(`Pull failed — ${errText(e)}`))
      .finally(() => setBusy(null));
  }

  function pullOne(sub: SubmoduleStatus) {
    if (busy || !hasBackend()) return;
    setBusy(sub.path);
    ipc
      .pullSubmodule(wt.wtKey, sub.path)
      .then((r) => {
        showToast(`✓ ${sub.name} — ${r}`);
        reload();
      })
      .catch((e) => showToast(`Pull failed — ${errText(e)}`))
      .finally(() => setBusy(null));
  }

  function pickBranch(sub: SubmoduleStatus, branch: string) {
    setOpen(null);
    if (sub.branch === branch) return;
    ipc
      .switchSubmoduleBranch(wt.wtKey, sub.path, branch)
      .then(() => {
        showToast(`✓ ${sub.name} → ${branch} · parent now shows this submodule modified`);
        reload();
      })
      .catch((e) => showToast(`Switch failed — ${errText(e)}`));
  }

  return (
    <div className="cxs-pullpop" ref={ref}>
      <button className="cxs-pp-all" onClick={pullAll} disabled={!hasBackend()}>
        <span className="cxs-pp-ic">{busy === "all" ? <Spinner size={14} /> : <Pull size={14} />}</span>
        <span className="cxs-pp-tx">
          <b>Pull everything</b>
          <span>{subs.length ? `worktree + ${subs.length} submodule${subs.length === 1 ? "" : "s"}` : "this worktree"}</span>
        </span>
        <span className="cx-kbd">⌘⏎</span>
      </button>

      {/* Pull moves submodules FORWARD onto their branches; this puts them back
          on the commit the parent pins — the repair after a branch switch. */}
      {subs.length > 0 && (
        <button className="cxs-pp-all" onClick={() => syncSubmodules(wt.wtKey)} disabled={!hasBackend() || syncing}>
          <span className="cxs-pp-ic">{syncing ? <Spinner size={14} /> : <Refresh size={14} />}</span>
          <span className="cxs-pp-tx">
            <b>Sync submodules</b>
            <span>re-pin {subs.length} submodule{subs.length === 1 ? "" : "s"} to this commit</span>
          </span>
          <span className="cx-kbd">⇧⌘S</span>
        </button>
      )}

      {(subs.length > 0 || !loaded) && (
        <>
          <div className="cxs-pp-sep" />
          <div className="cxs-pp-lab">
            Submodules
            {fetchedAt > 0 && <span className="cxs-pp-fetch">fetched {fmtRelTime(fetchedAt / 1000)}</span>}
          </div>
          <div className="cxs-pp-list">
            {!loaded && <div className="cxs-pp-empty">Reading submodules…</div>}
            {subs.map((s) => {
              const label = s.branch || `detached ${s.sha}`;
              const exp = open === s.path;
              return (
                <div key={s.path}>
                  <div className="cxs-pp-row">
                    <span className={`cxs-pp-dot cxs-pp-dot--${s.status}`} />
                    <span className="cxs-pp-nm">{s.name}</span>
                    {s.ahead && (
                      <span className="cxs-pp-ahead">
                        <Info size={9} />
                        ahead of pin
                      </span>
                    )}
                    <span className="cxs-pp-g" />
                    <button
                      className={
                        "cxs-pp-br" + (s.branch ? "" : " cxs-pp-br--detached") + (exp ? " is-open" : "")
                      }
                      disabled={s.dirty}
                      title={
                        s.dirty
                          ? `${s.name} has uncommitted changes — commit or stash them before switching its branch`
                          : `Switch ${s.name}'s branch`
                      }
                      onClick={() => setOpen(exp ? null : s.path)}
                    >
                      <Fork size={10} />
                      <span className="n">{label}</span>
                      {!s.dirty && <Chevron size={9} />}
                    </button>
                    <button className="cxs-pp-pull" title={`Pull ${s.name}`} onClick={() => pullOne(s)}>
                      {busy === s.path ? <Spinner size={11} /> : <Pull size={11} />}
                    </button>
                  </div>
                  {exp && <SubBranches wtKey={wt.wtKey} sub={s} onPick={(b) => pickBranch(s, b)} />}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function SubBranches({ wtKey, sub, onPick }: { wtKey: string; sub: SubmoduleStatus; onPick: (b: string) => void }) {
  const [branches, setBranches] = useState<Branches | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    let alive = true;
    ipc
      .listSubmoduleBranches(wtKey, sub.path)
      .then((b) => alive && setBranches(b))
      .catch(() => alive && setBranches({ local: [], remote: [], tags: [] }));
    return () => {
      alive = false;
    };
  }, [wtKey, sub.path]);

  const all = branches ? [...new Set([...branches.local, ...branches.remote])] : [];
  const t = q.trim().toLowerCase();
  const names = t ? all.filter((b) => b.toLowerCase().includes(t)) : all;
  // a search box earns its space once the list is long enough to scroll
  const showSearch = all.length > 6;
  return (
    <div className="cxs-pp-brl">
      {showSearch && (
        <div className="cxs-pp-search">
          <Search size={11} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search branches…"
            spellCheck={false}
            autoFocus
            // Escape clears the query first; an empty query lets it bubble to
            // the popover's own Escape-to-close handler
            onKeyDown={(e) => {
              if (e.key === "Escape" && q) {
                e.stopPropagation();
                setQ("");
              }
            }}
          />
        </div>
      )}
      <div className="cxs-pp-brscroll">
        {!branches && <div className="cxs-pp-empty">Loading branches…</div>}
        {branches && all.length === 0 && <div className="cxs-pp-empty">No branches found.</div>}
        {branches && all.length > 0 && names.length === 0 && <div className="cxs-pp-empty">No branches match “{q}”.</div>}
        {names.map((b) => (
          <button key={b} className={"cxs-pp-bri" + (b === sub.branch ? " is-current" : "")} onClick={() => onPick(b)}>
            <Fork size={10} />
            <span className="n">{b}</span>
            {b === sub.branch && <span className="cx-tag">current</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
