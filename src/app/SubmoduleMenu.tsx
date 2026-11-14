// Per-submodule pull + branch-switch menu, opened from the "⋮" welded to the
// worktree header's "↓ Pull" link. State (subs, pulling, fetched) lives in
// WorktreeHeader; this component is presentational + owns which row is expanded.
import { useEffect, useRef, useState, type RefObject } from "react";
import { useViewportPopover } from "./canopod/viewportPopover";
import { ipc, type Branches } from "../ipc";
import type { SubmoduleStatus } from "../types";
import { Chevron, Fork, Pull, Refresh, Search, Spinner } from "../icons";

/** Inline searchable branch list for one submodule (fetched on expand). */
function SubBranchList({
  wtKey,
  sub,
  onPick,
}: {
  wtKey: string;
  sub: SubmoduleStatus;
  onPick: (name: string) => void;
}) {
  const [q, setQ] = useState("");
  const [branches, setBranches] = useState<Branches | null>(null);

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

  const match = (n: string) => !q || n.toLowerCase().includes(q.toLowerCase());
  const groups = branches
    ? [
        { key: "local", label: "Local", items: branches.local.filter(match) },
        { key: "remote", label: "Remote", items: branches.remote.filter(match) },
      ].filter((g) => g.items.length)
    : [];

  return (
    <div className="br-panel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="br-search">
        <Search size={13} />
        <input placeholder={`Switch ${sub.name} to…`} value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="br-scroll">
        {!branches && <div className="br-empty">Loading branches…</div>}
        {branches && groups.length === 0 && <div className="br-empty">No branches match “{q}”.</div>}
        {groups.map((g) => (
          <div key={g.key}>
            <div className="br-glabel">{g.label}</div>
            {g.items.map((name) => (
              <button className={"br-item" + (name === sub.branch ? " sel" : "")} key={g.key + name} onClick={() => onPick(name)}>
                <span className="br-i-ic">
                  <Fork size={12} />
                </span>
                <span className="br-i-nm">{name}</span>
                {name === sub.branch && <span className="br-i-cur">current</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SubmoduleMenu({
  wtKey,
  anchor,
  subs,
  pulling,
  fetchedLabel,
  onPullAll,
  onPullOne,
  onPickBranch,
  onRefetch,
}: {
  wtKey: string;
  anchor: RefObject<HTMLElement | null>;
  subs: SubmoduleStatus[];
  pulling: string | null; // sub.path | "all" | null
  fetchedLabel: string;
  onPullAll: () => void;
  onPullOne: (path: string) => void;
  onPickBranch: (path: string, branch: string) => void;
  onRefetch: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useViewportPopover(anchor, menu, true, 440, 400);
  const [openPath, setOpenPath] = useState<string | null>(null);

  return (
    <div className="sm-menu" ref={menu} popover="manual" onMouseDown={(e) => e.stopPropagation()}>
      <button className="sm-all" onClick={onPullAll}>
        <span className="sm-all-ic">{pulling === "all" ? <Spinner size={17} /> : <Pull size={17} />}</span>
        <span className="sm-all-tx">
          <b>Pull everything</b>
          <span className="sub">
            worktree + {subs.length} submodule{subs.length === 1 ? "" : "s"}
          </span>
        </span>
        <span className="kbd">⌘⏎</span>
      </button>

      <div className="sm-div" />

      <div className="sm-label">
        <b>Submodules</b>
        <span className="sm-fetched">
          fetched {fetchedLabel}
          <button className="sm-refresh" title="Re-fetch submodules" onClick={onRefetch}>
            <Refresh size={13} />
          </button>
        </span>
      </div>

      <div className="sm-list">
        {subs.map((sub) => {
          const label = sub.branch || `detached ${sub.sha}`;
          const expanded = openPath === sub.path;
          const tip = sub.dirty
            ? `${sub.name} has uncommitted changes — commit or stash them before switching its branch.`
            : `Switch ${sub.name}'s branch`;
          return (
            <div key={sub.path}>
              <div className="sm-row">
                <span className={"sm-dot " + sub.status} />
                <div className="sm-main">
                  <span className="sm-name">{sub.name}</span>
                  {sub.ahead && <span className="sm-ahead">ahead of pin</span>}
                </div>
                <button
                  className={"br-chip" + (sub.branch ? "" : " detached") + (expanded ? " open" : "") + (sub.dirty ? " disabled" : "")}
                  title={tip}
                  onClick={() => {
                    if (sub.dirty) return;
                    setOpenPath(expanded ? null : sub.path);
                  }}
                >
                  <span className="br-fk">
                    <Fork size={12} />
                  </span>
                  <span className="br-nm">{label}</span>
                  {!sub.dirty && (
                    <span className="br-cv">
                      <Chevron size={12} />
                    </span>
                  )}
                </button>
                <button className="sm-pull" title={`Pull ${sub.name}`} disabled={pulling === sub.path} onClick={() => onPullOne(sub.path)}>
                  {pulling === sub.path ? <Spinner size={14} /> : <Pull size={14} />}
                </button>
              </div>
              {expanded && !sub.dirty && (
                <SubBranchList
                  wtKey={wtKey}
                  sub={sub}
                  onPick={(name) => {
                    onPickBranch(sub.path, name);
                    setOpenPath(null);
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
