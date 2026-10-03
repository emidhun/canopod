/* Agent and shell sessions share a persistent Terminal workspace. Logs can
   appear alongside it without remounting sessions or resetting filters. */
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

// Legacy layout IDs remain valid for commands and saved preferences.
export const LAYOUTS: Record<LayoutId, { panes: PaneKind[]; label: string }> = {
  runtime: { panes: ["logs"], label: "Logs" },
  terminal: { panes: ["shell"], label: "Terminal" },
  shell: { panes: ["shell", "logs"], label: "Terminal + Logs" },
  agent: { panes: ["shell"], label: "Terminal" },
  split: { panes: ["shell", "logs"], label: "Terminal + Logs" },
};
export const LAYOUT_ORDER: LayoutId[] = ["runtime", "terminal", "shell"];
export function layoutLabel(panes: PaneKind[]): string {
  return panes.every(p => p === "logs") ? "Logs" : panes.includes("logs") ? "Terminal + Logs" : "Terminal";
}
export const panesOf = (l: LayoutId): PaneKind[] => [...LAYOUTS[l].panes];

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
  const [split, setSplit] = useState(0.6);
  const [drag, setDrag] = useState(false);
  const [alongside, setAlongside] = useState(panes.length > 1);
  const workRef = useRef<HTMLDivElement>(null);
  const terminalVisible = panes.some(p => p !== "logs");
  const showLogs = !terminalVisible || panes.includes("logs");
  useEffect(() => { if (terminalVisible) setAlongside(panes.includes("logs")); }, [terminalVisible, panes]);
  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      const rect = workRef.current?.getBoundingClientRect();
      if (rect?.width) setSplit(Math.min(0.75, Math.max(0.35, (e.clientX - rect.left) / rect.width)));
    };
    const up = () => setDrag(false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    const cursor = document.body.style.cursor, selection = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = selection;
    };
  }, [drag]);
  return <div className="cxs-work cxs-work--unified">
    <div className="cx-tabs cxs-worknav" aria-label="Workspace view">
      <button className={"cx-tab" + (!terminalVisible ? " is-on" : "")} aria-pressed={!terminalVisible} onClick={() => setPanes(["logs"])}><LogsIcon size={12} />Logs</button>
      <button className={"cx-tab" + (terminalVisible ? " is-on" : "")} aria-pressed={terminalVisible} onClick={() => setPanes(alongside ? ["shell", "logs"] : ["shell"])}><TerminalIcon size={12} />Terminal</button>
      {terminalVisible && <button className="cx-btn cx-btn--sm cxs-alongside" aria-pressed={showLogs} onClick={() => { setAlongside(!showLogs); setPanes(showLogs ? ["shell"] : ["shell", "logs"]); }}>Logs alongside</button>}
    </div>
    <div className={"cxs-workbody" + (terminalVisible && showLogs ? " is-split" : "")} ref={workRef}>
      <div className="cxs-workslot" hidden={!terminalVisible} style={{ flex: showLogs ? split : 1 }}>
        <Pane wt={wt} hidden={!terminalVisible} launch={launch} onEditContext={onEditContext} />
      </div>
      {terminalVisible && showLogs && <div className={"cxs-vdiv" + (drag ? " is-on" : "")} role="separator" aria-label="Resize terminal pane" aria-orientation="vertical" aria-valuemin={35} aria-valuemax={75} aria-valuenow={Math.round(split * 100)} tabIndex={0}
        onMouseDown={e => { e.preventDefault(); setDrag(true); }}
        onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setSplit(v => Math.min(0.75, Math.max(0.35, v + (e.key === "ArrowRight" ? 0.02 : -0.02)))); } }} />}
      <div className="cxs-workslot cxs-workslot--logs" hidden={!showLogs} style={{ flex: terminalVisible ? 1 - split : 1 }}>
        <div className="cxs-pane"><LogsPane visible={showLogs} wt={wt} filter={filter} onFilter={onFilter} na={na} onNext={onNext} onRestart={onRestart} /></div>
      </div>
    </div>
  </div>;
}

function Pane({ wt, hidden, launch, onEditContext }: {
  wt: WorktreeNode;
  hidden: boolean;
  launch: LaneLaunch;
  onEditContext: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [pickProfile, setPickProfile] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const [ctx] = useWtContext(wt.wtKey);
  const all = useStore((s) => s.sessions[wt.wtKey] ?? EMPTY);
  const activeTerm = useStore((s) => s.activeTerm[wt.wtKey]);
  const setActiveTerm = useStore((s) => s.setActiveTerm);
  const closeSession = useStore((s) => s.closeSession);
  const restartSession = useStore((s) => s.restartSession);
  const detached = useStore((s) => s.detachedTerms);
  const setTermDetached = useStore((s) => s.setTermDetached);
  const showToast = useStore((s) => s.showToast);

  const mine = all;
  const active = mine.find(s => s.id === activeTerm) ?? mine[mine.length - 1];
  const startAgent = (profile?: AgentCfg) => {
    setAddOpen(false);
    setPickProfile(false);
    void launch.startAgent(profile ? { profile } : undefined);
  };

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
      <div className="cxs-sessionbar">
        <div className="cxs-sessionlist" aria-label="Terminal sessions">
          {mine.map(s => {
            const state = !s.running ? "Ended" : s.kind === "agent" && agentState(s) === "waiting" ? "Waiting" : "Running";
            const Icon = s.kind === "agent" ? Sparkle : TerminalIcon;
            return <div key={s.id} className={"cxs-sessionchip" + (active?.id === s.id ? " is-on" : "")}>
              <button className="cxs-sc" aria-pressed={active?.id === s.id} onClick={() => setActiveTerm(wt.wtKey, s.id)} title={`${s.title} · ${state}`}>
                <span className={"d " + (state === "Waiting" ? "wait" : state === "Running" ? "run" : "")} /><Icon size={11} />{s.title}<span className="cxs-sessionstate">{state}</span>
              </button>
              <button className="cx-ib cxs-sessionclose" aria-label={`Close ${s.title}`} title={`Close ${s.title}`} onClick={() => closeSession(s.id)}><X size={9} /></button>
            </div>;
          })}
        </div>
        <button ref={addRef} className="cx-ib cxs-sessionadd" aria-label="Add session" title="Add session" aria-haspopup="menu" aria-expanded={addOpen} onClick={() => { setPickProfile(false); setAddOpen(v => !v); }}><Plus size={12} /></button>
        {addOpen && <AnchoredMenu anchor={addRef} onClose={() => setAddOpen(false)} width={214} label={pickProfile ? "Choose agent profile" : "Add session"}>
          {pickProfile ? launch.agents.map(profile => <button className="cx-pop__item" role="menuitem" key={profile.id} onClick={() => startAgent(profile)}><Sparkle size={12} />{profile.name || profile.command}</button>) : <>
            <button className="cx-pop__item" role="menuitem" onClick={() => launch.agents.length > 1 ? setPickProfile(true) : startAgent()}><Sparkle size={12} />Start agent{launch.agents.length > 1 && <Chevron size={10} />}</button>
            <button className="cx-pop__item" role="menuitem" onClick={() => { setAddOpen(false); launch.startShell(); }}><TerminalIcon size={12} />Open terminal</button>
          </>}
        </AnchoredMenu>}
        {active && !detached.has(active.id) && <button className="cx-btn cx-btn--sm cxs-sessionpop" onClick={() => void popOut(active.id)} title="Open in a separate window"><PopOut size={12} />Pop out</button>}
      </div>
      {active?.kind === "agent" && <button className="cxs-ctxbar" onClick={onEditContext} title="Edit the context this worktree's agents inherit">
        <span className="lb">Task context</span><span className={"ti" + (ctx.title.trim() ? "" : " is-empty")}>{ctx.title.trim() || "No task set — branch, ports and database are included"}</span>
        {ctx.links.length > 0 && <span className="lk">{ctx.links.length} links</span>}<Chevron size={11} />
      </button>}
      {mine.length === 0 ? <div className="cxs-empty">
        <span className="eic"><TerminalIcon size={17} /></span>
        <span className="et">Start working in this terminal</span>
        <span className="es">Start an agent with this worktree’s context, or open a shell in its directory.</span>
        <div className="cxs-emptyactions">
          <StartAgent agents={launch.agents} onPick={startAgent} render={(open, ref) => <button ref={ref} className={nextClass("primary")} onClick={open}><Sparkle size={12} />Start agent{launch.agents.length > 1 && <Chevron size={10} />}</button>} />
          <button className="cx-btn cx-btn--sm" onClick={() => launch.startShell()}><TerminalIcon size={12} />Open terminal</button>
        </div>
      </div> : (
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
              <div key={s.id} className={"term-body" + (isActive ? "" : " hidden")} role="tabpanel" aria-label={s.title} aria-hidden={hidden || !isActive}>
                <TerminalPane
                  key={`${s.id}#${s.gen}`}
                  termId={s.id}
                  cwd={wt.path}
                  command={s.command}
                  hidden={hidden || !isActive}
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
