/* The topbar: global state, always visible.

   Left is identity (brand + which worktree you're in), centre is the one
   global entry point (⌘K), right is the cross-worktree signal — how much is
   running, how many agents, and what needs a human. */
import { useEffect, useRef, type RefObject } from "react";
import { Bell, Check, ChevRight, Cube, Fork, Refresh, Settings, Sparkle, Alert, X } from "../../icons";
import type { AttnItem } from "../nextAction";
import type { RepoNode, WorktreeNode } from "../../types";

export function TopBar({
  repo,
  wt,
  attn,
  running,
  agents,
  onPalette,
  onAttn,
  onOverview,
  onRefresh,
  onSettings,
  attnRef,
}: {
  repo: RepoNode | null;
  wt: WorktreeNode | null;
  attn: AttnItem[];
  running: number;
  agents: number;
  onPalette: () => void;
  onAttn: () => void;
  onOverview: () => void;
  onRefresh: () => void;
  onSettings: () => void;
  /** shared with AttentionPop so the trigger can close its own popover */
  attnRef?: RefObject<HTMLButtonElement | null>;
}) {
  // a backgrounded op that failed is as red as a crashed service — both mean
  // something you asked for is not running
  const crashes = attn.filter((a) => a.kind === "crash" || a.kind === "error").length;

  return (
    <div className="cxs-topbar" data-tauri-drag-region>
      <div className="cxs-tb-l">
        <div className="cxs-brand">
          <span className="fk">
            <Fork size={13} />
          </span>
          Canopy
        </div>
        <span className="cxs-tdiv" />
        {repo && wt && (
          <div className="cxs-crumb">
            <span className="rp">{repo.name}</span>
            <span className="rpchev">
              <ChevRight size={11} />
            </span>
            <span className="br">{wt.branch}</span>
          </div>
        )}
      </div>

      <div className="cxs-tb-c">
        <button className="cxs-gsearch" onClick={onPalette} title="Search or run command  (⌘K)">
          <span className="k">⌘K</span>
          <span className="ph">Search or run command…</span>
        </button>
      </div>

      <div className="cxs-tb-r">
        <button className="cxs-gchip" onClick={onOverview} title="All worktrees  (⌘O)">
          <span className="cx-dot cx-dot--running" />
          <span>{running}</span>
          <span className="lbl">running</span>
        </button>
        {agents > 0 && (
          <button className="cxs-gchip cxs-gchip--agent" onClick={onOverview} title="Active agents">
            <Sparkle size={11} />
            <span>{agents}</span>
            <span className="lbl">{agents === 1 ? "agent" : "agents"}</span>
          </button>
        )}
        {attn.length > 0 ? (
          <button ref={attnRef} className={"cxs-attn" + (crashes ? " cxs-attn--crash" : "")} onClick={onAttn}>
            <span className="d" />
            <span>{attn.length}</span>
            <span className="lbl">{`need${attn.length === 1 ? "s" : ""} you`}</span>
          </button>
        ) : (
          <button ref={attnRef} className="cxs-attn cxs-attn--clear" onClick={onAttn} title="Nothing needs you">
            <Check size={12} />
            <span className="lbl">All clear</span>
          </button>
        )}
        <span className="cxs-tdiv" />
        <button className="cx-ib" aria-label="Sync external worktrees" title="Sync external worktrees — discover Git worktrees created by other agents and reconcile deleted ones" onClick={onRefresh}>
          <Refresh size={14} />
        </button>
        <button className="cx-ib" title="Settings" onClick={onSettings}>
          <Settings size={14} />
        </button>
      </div>
    </div>
  );
}

/** The attention queue — everything needing a human, across worktrees, ranked. */
export function AttentionPop({
  items,
  onPick,
  onDismiss,
  onClose,
  anchor,
}: {
  items: AttnItem[];
  onPick: (a: AttnItem) => void;
  /** clear a notice row without acting on it (crashes have no dismiss — they
      leave the queue by being fixed) */
  onDismiss: (a: AttnItem) => void;
  onClose: () => void;
  /** the trigger, so its own mousedown isn't treated as "outside" — otherwise
      the listener closes the popover and the click immediately reopens it,
      making the trigger unable to dismiss what it opened */
  anchor?: React.RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const d = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchor?.current?.contains(t)) return;
      if (ref.current && !ref.current.contains(t)) onClose();
    };
    document.addEventListener("mousedown", d);
    return () => document.removeEventListener("mousedown", d);
  }, [onClose, anchor]);

  return (
    <div className="cx-pop cxs-attnpop" ref={ref}>
      <div className="cx-pop__head">
        <Bell size={11} />
        Needs you
        <span className="cxs-pop__count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="cxs-pop-empty">
          <div className="ic">
            <Check size={17} />
          </div>
          Nothing needs you. Everything is running.
        </div>
      ) : (
        items.map((a) => (
          <div className="cxs-attn-r" key={a.id}>
            <button className="cxs-attn-i" onClick={() => onPick(a)}>
              <span className={"ic " + a.kind}>
                {a.kind === "crash" || a.kind === "error" ? (
                  <Alert size={12} />
                ) : a.kind === "wait" ? (
                  <Sparkle size={12} />
                ) : a.kind === "info" ? (
                  <Check size={12} />
                ) : (
                  <Cube size={12} />
                )}
              </span>
              <span className="tx">
                <span className="tt">{a.title}</span>
                <span className="wt">{a.wt}</span>
              </span>
              {/* a completion notice is dismissed by the X alone — showing a
                  second "Dismiss ›" affordance beside it is redundant */}
              {a.kind !== "info" && (
                <span className="go">
                  {a.act}
                  <ChevRight size={11} />
                </span>
              )}
            </button>
            {a.noticeId && (
              <button className="cxs-attn-x" title="Dismiss" aria-label={`Dismiss ${a.title}`} onClick={() => onDismiss(a)}>
                <X size={10} />
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
