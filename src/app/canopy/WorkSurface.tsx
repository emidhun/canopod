/* The work surface — Logs, Terminal and Agent as tabs in ONE pane instead of
   three competing columns, splittable into two.

   Layout presets are the answer to "it doesn't adapt between runtime-heavy and
   AI-heavy work": each is one keystroke (⌘1–⌘4) and the panes are the same
   components either way. */
import { useEffect, useRef, useState } from "react";
import { Play, PopIn, PopOut, Sparkle, Spinner, Terminal as TerminalIcon, Logs as LogsIcon, Plus, X } from "../../icons";
import { hasBackend, type AgentCfg } from "../../ipc";
import { laneLabel, useStore, type LaneSession } from "../../store";
import type { ServiceNode, WorktreeNode } from "../../types";
import TerminalPane from "../TerminalPane";
import LogsPane from "./LogsPane";
import AnchoredMenu from "./AnchoredMenu";
import { agentState, nextClass, type NextAction } from "../nextAction";
import { useWtContext } from "../WorktreeContext";
import { Chevron } from "../../icons";
import type { LaneLaunch } from "./laneLaunch";

export type PaneKind = "logs" | "shell" | "agent";
export type LayoutId = "runtime" | "split" | "agent" | "shell" | "terminal";

export const LAYOUTS: Record<LayoutId, { panes: PaneKind[]; label: string }> = {
  runtime: { panes: ["logs"], label: "Runtime" },
  split: { panes: ["logs", "agent"], label: "Split" },
  agent: { panes: ["agent"], label: "Agent" },
  shell: { panes: ["shell", "logs"], label: "Shell" },
  // Terminal alone. The handoff stops at four presets, but it has logs alone
  // and agent alone, so the omission reads as a gap rather than a decision.
  terminal: { panes: ["shell"], label: "Terminal" },
};

/** ⌘1–⌘5, and the order the status bar cycles through. */
export const LAYOUT_ORDER: LayoutId[] = ["runtime", "split", "agent", "shell", "terminal"];

/** The pane set IS the state — a preset is just a named one. Deriving the
    label instead of storing a preset id means a hand-made combination (swap
    one pane's tab to something no preset covers) is a first-class layout
    rather than a click that silently does nothing. */
export function layoutLabel(panes: PaneKind[]): string {
  const key = LAYOUT_ORDER.find((l) => LAYOUTS[l].panes.join() === panes.join());
  return key ? LAYOUTS[key].label : "Custom";
}

export const panesOf = (l: LayoutId): PaneKind[] => [...LAYOUTS[l].panes];

const TAB_META: Record<PaneKind, { label: string; Icon: typeof LogsIcon }> = {
  logs: { label: "Logs", Icon: LogsIcon },
  shell: { label: "Terminal", Icon: TerminalIcon },
  agent: { label: "Agent", Icon: Sparkle },
};

const EMPTY: LaneSession[] = [];

/* Settings lets a repo configure several agent CLIs, but every launch here
   silently took the first one — so the second and third were configurable and
   unreachable. With more than one configured, launching asks which; with one,
   it stays a single click. `render` receives the click handler so the caller
   keeps its own button styling (a tab chip, or the empty state's primary). */
function StartAgent({
  agents,
  onPick,
  render,
}: {
  agents: AgentCfg[];
  onPick: (profile?: AgentCfg) => void;
  render: (open: () => void, ref: React.RefObject<HTMLButtonElement | null>) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const many = agents.length > 1;
  return (
    <>
      {render(() => (many ? setOpen((o) => !o) : onPick()), ref)}
      {open && many && (
        <AnchoredMenu anchor={ref} onClose={() => setOpen(false)} align="left" width={214}>
          <div className="cx-pop__head">
            <Sparkle size={11} />
            Start an agent
          </div>
          {agents.map((a, i) => (
            <button
              key={a.id}
              className="cx-pop__item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(a);
              }}
            >
              <span className="cx-pop__ic">
                <Sparkle size={13} />
              </span>
              {a.name || a.command}
              {i === 0 && <span className="cx-k">default</span>}
            </button>
          ))}
        </AnchoredMenu>
      )}
    </>
  );
}

export default function WorkSurface({
  wt,
  panes,
  setPanes,
  filter,
  onFilter,
  na,
  onNext,
  onRestart,
  launch,
  onEditContext,
}: {
  wt: WorktreeNode;
  panes: PaneKind[];
  setPanes: (p: PaneKind[]) => void;
  filter: string;
  onFilter: (svcKey: string) => void;
  na: NextAction | null;
  onNext: () => void;
  onRestart: (s: ServiceNode) => void;
  launch: LaneLaunch;
  onEditContext: () => void;
}) {
  const [split, setSplit] = useState(0.56);
  const [drag, setDrag] = useState(false);
  const workRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!drag) return;
    const mv = (e: MouseEvent) => {
      const r = workRef.current?.getBoundingClientRect();
      if (!r) return;
      setSplit(Math.min(0.78, Math.max(0.22, (e.clientX - r.left) / r.width)));
    };
    const up = () => setDrag(false);
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", mv);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [drag]);

  /** Swapping one pane's tab always takes effect; the status bar names the
      result, falling back to "Custom" when it isn't one of the presets. */
  const setPane = (index: number, kind: PaneKind) => {
    const next = panes.slice();
    next[index] = kind;
    setPanes(next);
  };

  return (
    <div className="cxs-work" ref={workRef}>
      {panes.map((p, n) => (
        <div
          key={p + n}
          style={panes.length > 1 ? { flex: n === 0 ? split : 1 - split, display: "flex", minWidth: 0 } : { flex: 1, display: "flex", minWidth: 0 }}
        >
          {n > 0 && <div className={"cxs-vdiv" + (drag ? " is-on" : "")} onMouseDown={(e) => { e.preventDefault(); setDrag(true); }} />}
          <Pane
            kind={p}
            index={n}
            wt={wt}
            setPane={setPane}
            filter={filter}
            onFilter={onFilter}
            na={na}
            onNext={onNext}
            onRestart={onRestart}
            launch={launch}
            onEditContext={onEditContext}
          />
        </div>
      ))}
    </div>
  );
}

function Pane({
  kind,
  index,
  wt,
  setPane,
  filter,
  onFilter,
  na,
  onNext,
  onRestart,
  launch,
  onEditContext,
}: {
  kind: PaneKind;
  index: number;
  wt: WorktreeNode;
  setPane: (i: number, k: PaneKind) => void;
  filter: string;
  onFilter: (svcKey: string) => void;
  na: NextAction | null;
  onNext: () => void;
  onRestart: (s: ServiceNode) => void;
  launch: LaneLaunch;
  onEditContext: () => void;
}) {
  const [ctx] = useWtContext(wt.wtKey);
  const all = useStore((s) => s.sessions[wt.wtKey] ?? EMPTY);
  const activeTerm = useStore((s) => s.activeTerm[wt.wtKey]);
  const setActiveTerm = useStore((s) => s.setActiveTerm);
  const closeSession = useStore((s) => s.closeSession);
  const restartSession = useStore((s) => s.restartSession);
  const detached = useStore((s) => s.detachedTerms);
  const setTermDetached = useStore((s) => s.setTermDetached);
  const showToast = useStore((s) => s.showToast);

  const laneKind = kind === "shell" ? "shell" : "agent";
  const mine = all.filter((s) => s.kind === laneKind);
  const active = mine.find((s) => s.id === activeTerm) ?? mine[mine.length - 1];
  const agentSess = all.find((s) => s.kind === "agent" && s.running);

  const popOut = async (id: string) => {
    if (!hasBackend()) {
      showToast("Pop-out is available in the desktop app");
      return;
    }
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const label = laneLabel(id);
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      existing.setFocus();
      return;
    }
    const sess = mine.find((s) => s.id === id);
    const title = sess?.title ?? "Terminal";
    // carry the command: if this window ends up creating the PTY, it must
    // launch the agent, not a bare login shell
    const cmd = sess?.command ? `&cmd=${encodeURIComponent(sess.command)}` : "";
    const url = `terminal.html?id=${encodeURIComponent(id)}&cwd=${encodeURIComponent(wt.path)}&branch=${encodeURIComponent(wt.branch)}&title=${encodeURIComponent(title)}${cmd}`;
    const win = new WebviewWindow(label, {
      url,
      width: 560,
      height: 360,
      minWidth: 360,
      minHeight: 220,
      title: `${title} — ${wt.branch}`,
      decorations: false,
      resizable: true,
    });
    win.once("tauri://created", () => setTermDetached(id, true));
    win.once("tauri://error", () => showToast("Could not open terminal window"));
    win.once("tauri://destroyed", () => setTermDetached(id, false));
  };

  const bringBack = async (id: string) => {
    if (hasBackend()) {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const w = await WebviewWindow.getByLabel(laneLabel(id));
      await w?.close();
    }
    setTermDetached(id, false);
  };

  return (
    <div className="cxs-pane">
      {kind === "agent" && (
        <button className="cxs-ctxbar" onClick={onEditContext} title="Edit the context this worktree's agents inherit">
          <span className="lb">Context</span>
          <span className={"ti" + (ctx.title.trim() ? "" : " is-empty")}>
            {ctx.title.trim() || "No task set — the agent still inherits branch, ports and database"}
          </span>
          {ctx.links.length > 0 && <span className="lk">{ctx.links.length} links</span>}
          <Chevron size={11} />
        </button>
      )}
      <div className="cx-tabs">
        <div className="cx-tabs__scroll">
          {(Object.keys(TAB_META) as PaneKind[]).map((t) => {
            const { label, Icon } = TAB_META[t];
            const state = t === "agent" && agentSess ? agentState(agentSess) : null;
            return (
              <button key={t} className={"cx-tab" + (kind === t ? " is-on" : "")} onClick={() => setPane(index, t)}>
                <Icon size={12} />
                {label}
                {state && <span className={"cx-tab__pip" + (state === "waiting" ? " cx-tab__pip--wait" : "")} />}
              </button>
            );
          })}

          {kind !== "logs" && mine.length > 0 && (
            <div className="cxs-sess">
              {mine.map((s) => {
                const st = s.kind === "agent" ? agentState(s) : s.running ? "busy" : "idle";
                return (
                  <span
                    key={s.id}
                    className={"cxs-sc" + (active?.id === s.id ? " is-on" : "")}
                    onClick={(e) => {
                      // the close button lives inside; don't re-select on its click
                      if ((e.target as HTMLElement).closest(".x")) return;
                      setActiveTerm(wt.wtKey, s.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setActiveTerm(wt.wtKey, s.id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <span className={"d " + (st === "waiting" ? "wait" : st === "busy" ? "run" : "")} />
                    {s.title}
                    <button
                      className="x"
                      aria-label={`Close ${s.title}`}
                      title={`Close ${s.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeSession(s.id);
                      }}
                    >
                      <X size={9} />
                    </button>
                  </span>
                );
              })}
              {kind === "agent" ? (
                <StartAgent
                  agents={launch.agents}
                  onPick={(profile) => launch.startAgent(profile ? { profile } : undefined)}
                  render={(open, ref) => (
                    <button
                      ref={ref}
                      className="cxs-sc"
                      title={launch.agents.length > 1 ? "New agent — choose which" : "New agent"}
                      onClick={open}
                    >
                      <Plus size={10} />
                    </button>
                  )}
                />
              ) : (
                <button className="cxs-sc" title="New shell" onClick={() => launch.startShell()}>
                  <Plus size={10} />
                </button>
              )}
            </div>
          )}
        </div>

        {kind !== "logs" && active && (
          <button
            className="cx-ib cx-ib--tab"
            title="Open in a separate window"
            onClick={() => popOut(active.id)}
          >
            <PopOut size={12} />
          </button>
        )}
      </div>

      {kind === "logs" ? (
        <LogsPane wt={wt} filter={filter} onFilter={onFilter} na={na} onNext={onNext} onRestart={onRestart} />
      ) : mine.length === 0 ? (
        <div className="cxs-empty">
          <span className="eic">{kind === "agent" ? <Sparkle size={17} /> : <TerminalIcon size={17} />}</span>
          <span className="et">{kind === "agent" ? "No agent running here" : "No terminal open here"}</span>
          <span className="es">
            {kind === "agent"
              ? "It starts in a real terminal, seeded with this worktree's context — the task, its links, and the branch, database and ports."
              : "A login shell in this worktree's directory, on its pinned toolchain."}
          </span>
          {kind === "agent" ? (
            <StartAgent
              agents={launch.agents}
              onPick={(profile) => launch.startAgent(profile ? { profile } : undefined)}
              render={(open, ref) => (
                <button ref={ref} className={nextClass("primary")} onClick={open}>
                  <Sparkle size={12} />
                  Start agent
                  {launch.agents.length > 1 && <Chevron size={10} />}
                </button>
              )}
            />
          ) : (
            <button className={nextClass("primary")} onClick={() => launch.startShell()}>
              <TerminalIcon size={12} />
              Open terminal
            </button>
          )}
        </div>
      ) : (
        <div className="cxs-pbody cxs-pbody--term">
          {mine.map((s) => {
            const isActive = active?.id === s.id;
            if (detached.has(s.id))
              return (
                isActive && (
                  <div className="cxs-empty" key={s.id}>
                    <span className="eic">
                      <PopOut size={19} />
                    </span>
                    <span className="et">Running in a detached window</span>
                    <span className="es">
                      The session keeps running — output goes to the floating window. Close it or bring it back any time.
                    </span>
                    <button className="cx-btn cx-btn--sm" onClick={() => bringBack(s.id)}>
                      <PopIn size={13} />
                      Bring back
                    </button>
                  </div>
                )
              );
            return (
              <div key={s.id} className={"term-body" + (isActive ? "" : " hidden")} role="tabpanel" aria-label={s.title} aria-hidden={!isActive}>
                <TerminalPane
                  key={`${s.id}#${s.gen}`}
                  termId={s.id}
                  cwd={wt.path}
                  command={s.command}
                  hidden={!isActive}
                  readOnly={!s.running}
                />
              </div>
            );
          })}

          {active && !active.running && !detached.has(active.id) && (
            <div className="cxs-fixbar cxs-endedbar">
              <span className="tx">
                <b>{active.title}</b> ended. Its output is kept above.
              </span>
              <button className="cx-btn cx-btn--sm cx-btn--fix" onClick={() => restartSession(active.id)}>
                <Play size={10} />
                Restart
              </button>
              <button className="cx-btn cx-btn--sm" onClick={() => closeSession(active.id)}>
                Close
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { Spinner };
