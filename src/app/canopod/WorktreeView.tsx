/* The worktree bar + service rail + work surface.

   The bar is ONE line: the branch is the only elastic item, and the actions
   never shrink — a shrinking action group just clips its own button. The
   reason rides in front of the next action and is the first thing to yield. */
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Copy, Cube, Database, Doc, Editor, Finder, Fork, More, Pull, Refresh, SidebarIcon, Swap, Trash } from "../../icons";
import { useStore } from "../../store";
import type { ServiceNode, WorktreeNode } from "../../types";
import { nextClass, type NextAction } from "../nextAction";
import AnchoredMenu from "./AnchoredMenu";
import ServiceRail from "./ServiceRail";
import WorkSurface, { type PaneKind } from "./WorkSurface";
import type { LaneLaunch } from "./laneLaunch";

function MenuItem({
  icon: Icon,
  label,
  k,
  danger,
  onPick,
}: {
  icon: ComponentType<{ size?: number }>;
  label: string;
  k?: string;
  danger?: boolean;
  onPick: () => void;
}) {
  return (
    <button className={"cx-pop__item" + (danger ? " cx-pop__item--danger" : "")} onClick={onPick} role="menuitem">
      <span className="cx-pop__ic">
        <Icon size={13} />
      </span>
      {label}
      {k && <span className="cx-k">{k}</span>}
    </button>
  );
}

export default function WorktreeView({
  wt,
  na,
  onNext,
  panes,
  setPanes,
  launch,
  sideHidden,
  onShowSide,
  onRemove,
  onDatabase,
  onSetup,
  onOpenService,
  onEditContext,
  onDirty,
  onSwitchBranch,
}: {
  wt: WorktreeNode;
  na: NextAction;
  onNext: () => void;
  panes: PaneKind[];
  setPanes: (p: PaneKind[]) => void;
  launch: LaneLaunch;
  sideHidden: boolean;
  onShowSide: () => void;
  onRemove: () => void;
  onDatabase: () => void;
  onSetup: () => void;
  onOpenService: (s: ServiceNode) => void;
  onEditContext: () => void;
  onDirty: () => void;
  /** absent when Settings has turned the Switch-branch action off */
  onSwitchBranch?: () => void;
}) {
  const openWorktree = useStore((s) => s.openWorktree);
  const gitPull = useStore((s) => s.gitPull);
  const syncSubmodules = useStore((s) => s.syncSubmodules);
  const showToast = useStore((s) => s.showToast);
  const restartService = useStore((s) => s.restartService);
  const [filter, setFilter] = useState("all");
  const [menu, setMenu] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const NaIcon = na.icon;

  // a filter naming a service that no longer exists would silently hide
  // everything, so fall back to "all" when the worktree changes
  useEffect(() => setFilter("all"), [wt.wtKey]);

  const runSetup = () => {
    setMenu(false);
    onSetup();
  };

  return (
    <div className="cxs-main">
      <div className="cxs-wtbar">
        {/* the toggle lives in the sidebar; collapsed, it reappears here —
            flush against the edge the sidebar just vacated */}
        {sideHidden && (
          <button className="cx-ib" title="Show worktrees  (⌘B)" onClick={onShowSide}>
            <SidebarIcon size={14} />
          </button>
        )}
        <span className="fk">
          <Fork size={14} />
        </span>
        <h1 title={wt.path}>{wt.branch}</h1>

        <div className="cxs-gitchips">
          {wt.git && wt.git.ahead > 0 && <span className="cxs-gc cxs-gc--up">↑{wt.git.ahead}</span>}
          {wt.git && wt.git.behind > 0 && <span className="cxs-gc cxs-gc--down">↓{wt.git.behind}</span>}
          {wt.git?.dirty && (
            <button className="cxs-gc cxs-gc--dirty" aria-label="Review uncommitted changes" title="Review uncommitted changes — commit, stash or discard" onClick={onDirty}>
              <span className="cxs-gc-dot" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="cxs-acts">
          <button className="cx-ib" title="Open in editor" onClick={() => openWorktree(wt.wtKey, "editor")}>
            <Editor size={14} />
          </button>
          {/* Reveal in Finder lives in the ⋯ menu — one route, not two. */}
          <button className="cx-ib" title="More" onClick={() => setMenu((m) => !m)} ref={moreRef} aria-haspopup="menu" aria-expanded={menu}>
            <More size={15} />
          </button>
          {menu && (
            <AnchoredMenu anchor={moreRef} onClose={() => setMenu(false)} width={246}>
              {onSwitchBranch && (
                <MenuItem icon={Swap} label="Switch branch…" k="⌘\" onPick={() => { setMenu(false); onSwitchBranch(); }} />
              )}
              <MenuItem icon={Pull} label="Pull" onPick={() => { setMenu(false); gitPull(wt.wtKey); }} />
              <MenuItem icon={Refresh} label="Sync submodules" k="⇧⌘S" onPick={() => { setMenu(false); syncSubmodules(wt.wtKey); }} />
              <MenuItem icon={Cube} label="Run setup…" onPick={runSetup} />
              <div className="cx-pop__sep" />
              <MenuItem icon={Database} label="Database…" onPick={() => { setMenu(false); onDatabase(); }} />
              <MenuItem icon={Doc} label="Context…" onPick={() => { setMenu(false); onEditContext(); }} />
              <div className="cx-pop__sep" />
              <MenuItem icon={Finder} label="Reveal in Finder" onPick={() => { setMenu(false); openWorktree(wt.wtKey, "finder"); }} />
              <MenuItem
                icon={Copy}
                label="Copy path"
                onPick={() => {
                  setMenu(false);
                  navigator.clipboard?.writeText(wt.path).then(
                    () => showToast("Path copied"),
                    () => showToast("Could not copy to the clipboard"),
                  );
                }}
              />
              {!wt.isMain && (
                <>
                  <div className="cx-pop__sep" />
                  <MenuItem icon={Trash} label="Remove worktree…" danger onPick={() => { setMenu(false); onRemove(); }} />
                </>
              )}
            </AnchoredMenu>
          )}

          <span className="cxs-actdiv" />

          {/* the reason, then the action — never a bare button */}
          <span className="cx-why">{na.why}</span>
          <button className={nextClass(na.kind)} onClick={onNext} disabled={na.kind === "busy"}>
            <NaIcon size={12} />
            {na.label}
            {na.key && <span className="cx-k">{na.key}</span>}
          </button>
        </div>
      </div>

      <ServiceRail wt={wt} onOpenService={onOpenService} onDatabase={onDatabase} />

      <WorkSurface
        wt={wt}
        panes={panes}
        setPanes={setPanes}
        filter={filter}
        onFilter={setFilter}
        na={na}
        onNext={onNext}
        onRestart={(s: ServiceNode) => restartService(s.svcKey)}
        launch={launch}
        onEditContext={onEditContext}
      />
    </div>
  );
}
