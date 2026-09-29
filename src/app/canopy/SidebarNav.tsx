/* The sidebar: navigation only, dense and grouped.

   Grouping is what makes a long list scannable — worktrees sort themselves by
   what they want from you, not by which repo they happen to live in.
   "Needs you" outranks everything; pinned worktrees hold the top of the rest. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Chevron, Editor, Fork, Logs, Pin, Play, Plus, Search, SidebarIcon, Sparkle, Spinner, Stop, Terminal, Trash } from "../../icons";
import { useStore, type LaneSession } from "../../store";
import { isLive, type RepoNode, type WorktreeNode } from "../../types";
import { agentState, dotClass, wtDot, type AttnItem } from "../nextAction";
import { isPinned, togglePin } from "../pins";
import { clear as clearSelection, retain, selectRange, setAnchor, toggle as toggleSelection, useMultiSelect } from "../multiselect";

type Flat = { wt: WorktreeNode; repo: RepoNode };

export default function SidebarNav({
  hidden,
  view,
  selKey,
  attn,
  onSelect,
  onOverview,
  onToggle,
  onNew,
  onOpenTerminal,
  onRemoveMany,
}: {
  hidden: boolean;
  view: "wt" | "overview";
  selKey: string | null;
  attn: AttnItem[];
  onSelect: (wtKey: string) => void;
  onOverview: () => void;
  onToggle: () => void;
  onNew: () => void;
  onOpenTerminal: (wtKey: string) => void;
  onRemoveMany: (wtKeys: string[]) => void;
}) {
  const tree = useStore((s) => s.tree);
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const sessions = useStore((s) => s.sessions);
  const toggleWorktree = useStore((s) => s.toggleWorktree);
  const openWorktree = useStore((s) => s.openWorktree);
  const addRepo = useStore((s) => s.addRepo);
  const creating = useStore((s) => s.creating);
  const removing = useStore((s) => s.removing);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [repoFilter, setRepoFilter] = useState<string | null>(null);

  const flat = useMemo<Flat[]>(() => tree.flatMap((repo) => repo.worktrees.map((wt) => ({ wt, repo }))), [tree]);
  const q = query.toLowerCase().trim();
  // a filter pointing at a removed repo falls back to "all" rather than hiding everything
  const activeRepo = repoFilter && tree.some((r) => r.repoId === repoFilter) ? repoFilter : null;

  const groups = useMemo(() => {
    const vis = flat.filter(({ wt, repo }) => (!activeRepo || repo.repoId === activeRepo) && (!q || `${wt.branch} ${repo.name}`.toLowerCase().includes(q)));
    // "a background job finished" is news, not a demand — it belongs in the
    // queue but must not drag its worktree into the Needs-you group
    const needs = new Set(attn.filter((a) => a.kind !== "info").map((a) => a.wtKey));
    const rest = vis.filter((f) => !needs.has(f.wt.wtKey));
    return [
      { k: "attn", label: "Needs you", items: vis.filter((f) => needs.has(f.wt.wtKey)) },
      { k: "pin", label: "Pinned", items: rest.filter((f) => f.wt.pinned) },
      {
        k: "run",
        label: "Running",
        items: rest.filter((f) => !f.wt.pinned && f.wt.services.some((s) => isLive(s.status))),
      },
      {
        k: "idle",
        label: "Idle",
        items: rest.filter((f) => !f.wt.pinned && !f.wt.services.some((s) => isLive(s.status))),
      },
    ].filter((g) => g.items.length);
  }, [flat, q, activeRepo, attn]);

  // in-flight creations, oldest first, filtered by the same repo filter the
  // real rows obey so the list doesn't contradict itself
  const pending = useMemo(
    () =>
      Object.entries(creating)
        .filter(([, p]) => !activeRepo || p.repoId === activeRepo)
        .filter(([, p]) => !q || `${p.branch} ${p.repoName}`.toLowerCase().includes(q))
        .sort((a, b) => a[1].startedAt - b[1].startedAt),
    [creating, activeRepo, q],
  );

  const multi = useMultiSelect();
  // the visible order across all groups — the axis Shift-click ranges walk
  const order = useMemo(() => groups.flatMap((g) => g.items.map((f) => f.wt.wtKey)), [groups]);
  // drop any selection entries for worktrees that no longer exist
  useEffect(() => retain(flat.map((f) => f.wt.wtKey)), [flat]);
  const selectedWts = useMemo(() => flat.filter((f) => multi.includes(f.wt.wtKey)).map((f) => f.wt), [flat, multi]);

  // ⌘/Ctrl-click toggles one; Shift-click extends a range; a plain click clears
  // the multi-selection and selects the single row.
  const activate = (wtKey: string, mods: { meta: boolean; shift: boolean }) => {
    if (mods.meta) toggleSelection(wtKey);
    else if (mods.shift) selectRange(order, wtKey);
    else {
      clearSelection();
      setAnchor(wtKey);
      onSelect(wtKey);
    }
  };


  return (
    <aside className={"cxs-side" + (hidden ? " is-hidden" : "")} inert={hidden || undefined} aria-hidden={hidden || undefined}>
      <div className="cxs-shead">
        <div className="cx-search cxs-sfilter">
          <Search size={12} />
          <input placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button className="cx-ib" title="Hide worktrees  (⌘B)" aria-pressed="true" onClick={onToggle}>
          <SidebarIcon size={14} />
        </button>
      </div>

      {tree.length > 1 && (
        <RepoFilter repos={tree.map((r) => ({ id: r.repoId, name: r.name }))} value={activeRepo} onPick={setRepoFilter} onAdd={addRepo} />
      )}

      <div className="cxs-slist">
        <button className={"cxs-ovrow" + (view === "overview" ? " is-on" : "")} onClick={onOverview}>
          <Logs size={13} />
          All worktrees
          <span className="n">{flat.length}</span>
        </button>

        {/* A worktree being created has no row in the tree yet — the backend
            only publishes it once it exists. Without this the sidebar is
            silent for the minutes `git worktree add` + setup take, which is
            exactly when "is it working?" gets asked. */}
        {pending.map(([wtPath, p]) => (
          <PendingRow key={wtPath} wtPath={wtPath} branch={p.branch} repoName={p.repoName} />
        ))}

        {groups.map((g) => (
          <div key={g.k}>
            <button
              className={"cxs-grp" + (closed[g.k] ? " is-closed" : "")}
              onClick={() => setClosed({ ...closed, [g.k]: !closed[g.k] })}
            >
              <span className="cv">
                <Chevron size={10} />
              </span>
              {g.label}
              <span className="gn">{g.items.length}</span>
            </button>
            {!closed[g.k] &&
              g.items.map(({ wt, repo }) => (
                <WorktreeRow
                  key={wt.wtKey}
                  wt={wt}
                  repoName={repo.name}
                  selected={wt.wtKey === selKey && view === "wt"}
                  removing={!!removing[wt.wtKey]}
                  isMulti={multi.includes(wt.wtKey)}
                  sessions={sessions[wt.wtKey] ?? EMPTY}
                  onActivate={(mods) => activate(wt.wtKey, mods)}
                  onToggleServices={() => toggleWorktree(wt.wtKey)}
                  onTerminal={() => onOpenTerminal(wt.wtKey)}
                  onEditor={() => openWorktree(wt.wtKey, "editor")}
                />
              ))}
          </div>
        ))}

        {groups.length === 0 && <div className="cxs-sempty">{q ? `No worktrees match “${query}”.` : "No worktrees yet."}</div>}
      </div>

      <div className="cxs-sfoot">
        {selectedWts.length > 0 ? (
          <div className="cxs-selbar">
            <span className="n">{selectedWts.length} selected</span>
            <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={clearSelection}>
              Clear
            </button>
            <button className="cx-btn cx-btn--danger cx-btn--sm" onClick={() => onRemoveMany(selectedWts.map((w) => w.wtKey))}>
              <Trash size={12} />
              Delete {selectedWts.length}
            </button>
          </div>
        ) : (
          <button className="cxs-newbtn" onClick={onNew}>
            <Plus size={13} />
            New worktree
          </button>
        )}
      </div>
    </aside>
  );
}

const EMPTY: LaneSession[] = [];

/* A worktree being created, before the tree knows about it.

   It subscribes to its own step marker rather than the sidebar subscribing to
   the whole `ops` map: that map is replaced on EVERY streamed output line, so
   reading it one level up re-rendered the entire worktree list once per line
   of `pnpm install`. Selecting a primitive means this row alone re-renders,
   and only when the step actually advances. */
function PendingRow({ wtPath, branch, repoName }: { wtPath: string; branch: string; repoName: string }) {
  const step = useStore((s) => s.ops[wtPath]?.step ?? null);
  return (
    <div className="cxs-wtr cxs-wtr--pending" title={`Creating ${branch} in ${repoName}`}>
      <span className="cxs-wtspin">
        <Spinner size={11} />
      </span>
      <span className="b">{branch}</span>
      <span className="meta">
        <span className="cxs-wtnote">{step ?? "creating…"}</span>
      </span>
    </div>
  );
}

/* Filter the list to one repository. Hidden when there's only one repo — the
   text field already narrows by branch (and repo name), so the dropdown only
   earns its space once worktrees span more than one repo.

   The menu also ends in "Add repository…", because the place you go to switch
   repositories is the place you notice one is missing. It is an action, not an
   option, so it sits below a rule and outside the listbox — a `role="option"`
   that opens a folder picker would be a lie to a screen reader. ⇧⌘N reaches it
   from anywhere, which is what covers the single-repo case where this whole
   control is hidden. */
function RepoFilter({ repos, value, onPick, onAdd }: { repos: { id: string; name: string }[]; value: string | null; onPick: (id: string | null) => void; onAdd: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const d = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", d);
    document.addEventListener("keydown", k, true);
    return () => {
      document.removeEventListener("mousedown", d);
      document.removeEventListener("keydown", k, true);
    };
  }, [open]);
  const sel = repos.find((r) => r.id === value);
  return (
    <div className="cxs-repobar" ref={ref}>
      <button className="cxs-repobtn" onClick={() => setOpen((o) => !o)} title="Filter by repository" aria-haspopup="menu" aria-expanded={open}>
        <Fork size={11} />
        <span className="nm">{sel ? sel.name : "All repositories"}</span>
        <Chevron size={10} />
      </button>
      {open && (
        <div className="cxs-repomenu">
          <div role="listbox" aria-label="Filter by repository">
            <button className={"cxs-repoitem" + (value === null ? " is-on" : "")} role="option" aria-selected={value === null} onClick={() => { onPick(null); setOpen(false); }}>
              <span className="nm">All repositories</span>
            </button>
            {repos.map((r) => (
              <button key={r.id} className={"cxs-repoitem" + (r.id === value ? " is-on" : "")} role="option" aria-selected={r.id === value} onClick={() => { onPick(r.id); setOpen(false); }}>
                <Fork size={11} />
                <span className="nm">{r.name}</span>
              </button>
            ))}
          </div>
          <div className="cxs-repomenu-sep" role="separator" />
          <button className="cxs-repoitem cxs-repoitem--add" onClick={() => { setOpen(false); onAdd(); }}>
            <Plus size={11} />
            <span className="nm">Add repository…</span>
            <span className="cx-kbd">⇧⌘N</span>
          </button>
        </div>
      )}
    </div>
  );
}

function WorktreeRow({
  wt,
  repoName,
  selected,
  removing,
  isMulti,
  sessions,
  onActivate,
  onToggleServices,
  onTerminal,
  onEditor,
}: {
  wt: WorktreeNode;
  repoName: string;
  selected: boolean;
  /** its removal is in flight — the row is read-only until the tree catches up */
  removing: boolean;
  isMulti: boolean;
  sessions: LaneSession[];
  onActivate: (mods: { meta: boolean; shift: boolean }) => void;
  onToggleServices: () => void;
  onTerminal: () => void;
  onEditor: () => void;
}) {
  const agents = sessions.filter((s) => s.kind === "agent" && s.running);
  const waiting = agents.some((s) => agentState(s) === "waiting");
  const live = wt.services.some((s) => isLive(s.status));
  // isLive() excludes `stopping`, so a worktree mid-shutdown reads as idle and
  // the toggle would offer "Start services" — which then races the shutdown.
  const settling = wt.services.some((s) => s.status === "starting" || s.status === "stopping");
  const pinned = isPinned(wt);

  // A removal in flight leaves the row in place but inert: the worktree is
  // still in the tree until the backend republishes it, and clicking into a
  // directory that is being deleted is not a thing to offer.
  if (removing)
    return (
      <div className="cxs-wtr cxs-wtr--pending" title={`Removing ${wt.branch}`}>
        <span className="cxs-wtspin">
          <Spinner size={11} />
        </span>
        <span className="b">{wt.branch}</span>
        <span className="meta">
          <span className="cxs-wtnote">removing…</span>
        </span>
      </div>
    );

  return (
    <div className={"cxs-wtr" + (selected ? " is-on" : "") + (isMulti ? " is-multi" : "")} title={`${repoName}: ${wt.branch}`}
      onClick={(e) => onActivate({ meta: e.metaKey || e.ctrlKey, shift: e.shiftKey })} role="button" tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate({ meta: e.metaKey || e.ctrlKey, shift: e.shiftKey });
        }
      }}
    >
      {isMulti ? <span className="cxs-wtck"><Check size={11} /></span> : <span className={dotClass(wtDot(wt))} />}
      <span className="b">{wt.branch}</span>

      <span className="meta">
        {wt.git?.dirty && <span className="dirty" title="uncommitted changes" />}
        {agents.length > 0 && (
          <span className={"agp" + (waiting ? " is-wait" : "")} title={`${agents.length} agent${agents.length > 1 ? "s" : ""}`}>
            <Sparkle size={9} />
            {agents.length > 1 ? agents.length : ""}
          </span>
        )}
        {pinned && (
          <span className="pin" title="pinned">
            <Pin size={10} />
          </span>
        )}
      </span>

      {/* quick actions — the common next moves without opening the worktree */}
      <span className="cxs-qa">
        <button
          className={"qb " + (live ? "st" : "go")}
          disabled={settling}
          title={settling ? "Waiting for services to settle…" : live ? "Stop services" : "Start services"}
          onClick={(e) => {
            e.stopPropagation();
            if (settling) return;
            onToggleServices();
          }}
        >
          {live ? <Stop size={10} /> : <Play size={11} />}
        </button>
        <button
          className="qb"
          title="Open terminal"
          onClick={(e) => {
            e.stopPropagation();
            onTerminal();
          }}
        >
          <Terminal size={11} />
        </button>
        <button
          className="qb"
          title="Open in editor"
          onClick={(e) => {
            e.stopPropagation();
            onEditor();
          }}
        >
          <Editor size={11} />
        </button>
        <button
          className={"qb" + (pinned ? " is-on" : "")}
          title={pinned ? "Unpin" : "Pin to the top"}
          onClick={(e) => {
            e.stopPropagation();
            togglePin(wt);
          }}
        >
          <Pin size={11} />
        </button>
      </span>
    </div>
  );
}
