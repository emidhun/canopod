// The agent lane (VariantC) — a first-class right-hand column holding the
// per-worktree context and any number of agent / shell tabs. Every tab is
// backed by its own live PTY (see TerminalPane) and by a LaneSession in the
// store; switching tabs, or switching worktrees, keeps them all alive.
import { useEffect, useMemo, useRef, useState } from "react";
import type { RepoNode, WorktreeNode } from "../types";
import { laneLabel, nextTermId, useStore, type LaneSession } from "../store";
import { errText, hasBackend, ipc, type AgentCfg } from "../ipc";
import { ChevLeft, ChevRight, Doc, ExpandH, Play, Plus, PopIn, PopOut, Spinner, Sparkle, Terminal as TerminalIcon, X } from "../icons";
import TerminalPane from "./TerminalPane";
import { ContextEditor, bodyPreview, composeAgentPrompt, composeContextMd, isBlank, runtimeFor, useWtContext } from "./WorktreeContext";

function DetachedPlaceholder({ onBack }: { onBack: () => void }) {
  return (
    <div className="term-ph">
      <span className="ph-ic">
        <PopOut size={19} />
      </span>
      <span className="ph-t">
        Running in a detached window <PopOut size={12} />
      </span>
      <span className="ph-s">
        The shell keeps running — output goes to the floating window. Close it or bring it back here any time.
      </span>
      <button className="btn-sm" onClick={onBack}>
        <PopIn size={13} />
        Bring back
      </button>
    </div>
  );
}

/** A tab whose process has exited: its output stays readable (the backend keeps
    the final scrollback), shown read-only above a bar offering restart/close.
    The pane must never *open* a session here — that would re-run the command
    without the user asking. */
function EndedSession({
  session,
  cwd,
  hidden,
  onRestart,
  onClose,
}: {
  session: LaneSession;
  cwd: string;
  hidden: boolean;
  onRestart: () => void;
  onClose: () => void;
}) {
  return (
    <div className="term-ended">
      <div className="te-bar">
        {session.kind === "agent" ? <Sparkle size={12} /> : <TerminalIcon size={12} />}
        <span className="te-t">{session.title} ended</span>
        <span className="grow" />
        <button className="btn-sm" onClick={onRestart}>
          <Play size={12} />
          Restart
        </button>
        <button className="btn-sm" onClick={onClose}>
          <X size={12} />
          Close
        </button>
      </div>
      <div className="te-body">
        <TerminalPane key={session.gen} termId={session.id} cwd={cwd} hidden={hidden} readOnly />
      </div>
    </div>
  );
}

/** Empty lane: pick which agent to start, or drop straight into a shell. */
function LaneIdle({ agents, onAgent, onShell }: { agents: AgentCfg[]; onAgent: (a: AgentCfg) => void; onShell: () => void }) {
  return (
    <div className="term-ph">
      <span className="ph-ic">
        <Sparkle size={19} />
      </span>
      <span className="ph-t">Nothing running here</span>
      <span className="ph-s">
        Start a coding agent in this worktree — it runs in a real terminal, seeded with the context above. Run as many as you like, side by side.
      </span>
      <span className="ph-actions">
        {agents.map((a) => (
          <button className="startagent" key={a.id} onClick={() => onAgent(a)}>
            <Sparkle size={13} />
            {a.name}
            <span className="ar">▸</span>
          </button>
        ))}
        <button className="btn-sm" onClick={onShell}>
          <TerminalIcon size={13} />
          New shell
        </button>
      </span>
    </div>
  );
}

const COLLAPSE_KEY = "canopy.lane.collapsed";
const WIDTH_KEY = "canopy.lane.width";

// layout constants (match terminal.css): sidebar, main-pane floor, focus rail.
const SIDE = 264;
const MIN_MAIN = 460;
const RAIL = 52;
const MIN_LANE = 300;
const DEFAULT_LANE = 372;
// below this the lane can't be a flex sibling without squeezing the main pane
// past its floor — it becomes an overlay drawer instead (see the handoff).
const TIGHT = 1180;

const NO_SESSIONS: LaneSession[] = [];
const defaultAgent = (legacy: string): AgentCfg => ({ id: "default", name: "Claude", command: legacy.trim() || "claude", promptOnLaunch: true, waitingPatterns: "" });
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export default function AgentLane({ repo, wt }: { repo: RepoNode; wt: WorktreeNode }) {
  const showToast = useStore((s) => s.showToast);
  const mainRailed = useStore((s) => s.mainRailed);
  const setMainRailed = useStore((s) => s.setMainRailed);
  // Sessions live in the store so they survive this lane remounting on worktree
  // switch — the PTYs behind them keep running either way.
  const sessions = useStore((s) => s.sessions[wt.wtKey] ?? NO_SESSIONS);
  const activeId = useStore((s) => s.activeTerm[wt.wtKey] ?? null);
  const openSession = useStore((s) => s.openSession);
  const closeSession = useStore((s) => s.closeSession);
  const stopSession = useStore((s) => s.stopSession);
  const restartSession = useStore((s) => s.restartSession);
  const setActiveTerm = useStore((s) => s.setActiveTerm);
  // detached tracking lives in the store so it survives this lane remounting on
  // worktree switch (the window stays open; the placeholder must persist).
  const detached = useStore((s) => s.detachedTerms);
  const setTermDetached = useStore((s) => s.setTermDetached);
  const settingsRev = useStore((s) => s.settingsRev);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctx, setCtx] = useWtContext(wt.wtKey);
  // laneW is the width the user *asked* for; shownW below is it clamped to what
  // currently fits. Keeping them separate means a narrow window never destroys
  // the chosen width — it comes back when there's room again.
  const [laneW, setLaneW] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_LANE);
  const [rowW, setRowW] = useState(0);
  /** mirrors laneW so the focus effect can read it without re-subscribing */
  const laneWRef = useRef(laneW);
  laneWRef.current = laneW;
  const [resizing, setResizing] = useState(false);
  const [tight, setTight] = useState(() => window.innerWidth < TIGHT);
  const [agents, setAgents] = useState<AgentCfg[]>([defaultAgent("")]);
  const [addOpen, setAddOpen] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  /** pointer x + rendered lane width at mousedown, so the drag is a pure delta */
  const dragRef = useRef<{ x: number; w: number } | null>(null);
  /** width to restore when leaving focus mode, + the transition edge it keys off */
  const preFocusW = useRef<number | null>(null);
  const wasRailed = useRef(mainRailed);
  const runtime = useMemo(() => runtimeFor(repo, wt), [repo, wt]);

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0] ?? null;
  const liveAgents = sessions.filter((s) => s.kind === "agent" && s.running).length;

  useEffect(() => {
    if (!hasBackend()) return;
    let alive = true;
    ipc
      .getSettings()
      .then((settings) => {
        if (!alive) return;
        const configured = settings.repos.find((r) => r.id === repo.repoId);
        const next = (configured?.agents ?? []).filter((a) => a.id.trim() && a.command.trim());
        setAgents(next.length ? next : [defaultAgent(configured?.agentCommand || "")]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo.repoId, settingsRev]);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);
  useEffect(() => {
    // focus mode blows the lane up to fill the window — persisting that would
    // make the next launch start at the ceiling instead of the chosen width
    if (!mainRailed) localStorage.setItem(WIDTH_KEY, String(laneW));
  }, [laneW, mainRailed]);

  // keep the focused tab in view — a new tab is appended past the right edge
  // once the strip overflows, and switching tabs can target an off-screen one.
  useEffect(() => {
    tabsRef.current?.querySelector(".lt.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, sessions.length]);

  // close the "+" menu on an outside click / Escape
  useEffect(() => {
    if (!addOpen) return;
    const away = (e: MouseEvent) => {
      if (!addRef.current?.contains(e.target as Node)) setAddOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAddOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [addOpen]);

  // Widest the lane may be at a given main-pane floor. Never returns below
  // MIN_LANE — a too-narrow window used to report zero room, which silently
  // killed the drag outright instead of just clamping it.
  const maxLaneFor = (railed: boolean) => {
    const w = rowW || asideRef.current?.parentElement?.clientWidth || 0;
    if (!w) return null;
    return Math.max(MIN_LANE, w - SIDE - (railed ? RAIL : MIN_MAIN));
  };
  const maxLane = maxLaneFor(mainRailed);
  /** what actually gets rendered: the requested width, capped to what fits */
  const shownW = Math.round(Math.min(Math.max(laneW, MIN_LANE), maxLane ?? Infinity));

  // narrow-window fallback: overlay drawer + auto-collapse on first crossing
  useEffect(() => {
    if (window.innerWidth < TIGHT) setCollapsed(true); // start collapsed when tight
    const onResize = () => {
      const t = window.innerWidth < TIGHT;
      setTight((was) => {
        if (t && !was) {
          setCollapsed(true);
          setMainRailed(false);
        }
        return t;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setMainRailed]);

  // React to focus mode rather than handling it in the toggle: the collapsed
  // rail un-rails via its own buttons (App.tsx), so a handler-based restore left
  // the lane blown up whenever focus was exited from there. Keyed on the
  // transition so an unrelated re-render can't re-trigger it.
  useEffect(() => {
    if (mainRailed === wasRailed.current) return;
    wasRailed.current = mainRailed;
    if (mainRailed) {
      preFocusW.current = laneWRef.current;
      const max = maxLaneFor(true);
      if (max != null) setLaneW(max);
    } else {
      setLaneW(preFocusW.current ?? DEFAULT_LANE);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainRailed]);

  // Track the row's width so the ceiling can be applied at render time. Writing
  // the clamp back into laneW instead made two writers race for it (a window
  // resize or a focus toggle could overwrite the width the user just dragged),
  // and lost the original width when the window grew back.
  useEffect(() => {
    const body = asideRef.current?.parentElement;
    if (!body) return;
    const measure = () => setRowW(body.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    return () => ro.disconnect();
  }, []);

  // Drag the lane's left edge to resize. Tracked as a delta from where the drag
  // started rather than against the container's right edge: the pointer then
  // stays glued to the grip even when the rendered width is clamped mid-drag
  // (hitting MIN_LANE or the ceiling), instead of the edge creeping away.
  useEffect(() => {
    if (!resizing) return;
    const origin = dragRef.current;
    if (!origin) return;
    const move = (e: MouseEvent) => {
      const max = maxLaneFor(mainRailed);
      if (max == null) return;
      setLaneW(Math.round(Math.min(max, Math.max(MIN_LANE, origin.w + (origin.x - e.clientX)))));
    };
    const up = () => setResizing(false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    // a drag over text would otherwise select half the app as it passes
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizing, mainRailed]);

  // focus mode: collapse the middle pane to a rail, give the lane the rest
  const toggleFocus = () => {
    if (!mainRailed) showToast("Terminal focus — worktree details collapsed");
    setMainRailed(!mainRailed);
  };

  /** "Claude", then "Claude 2", … — tab labels stay tellable apart at a glance.
      Reads live store state, not this render's snapshot, so two launches in the
      same tick can't both claim the unsuffixed name. */
  /** Arrow keys move between tabs; Home/End jump to the ends. Selection follows
      focus, which is the expected behaviour for a tablist of live terminals. */
  const onTabKey = (e: React.KeyboardEvent, id: string) => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const i = sessions.findIndex((s) => s.id === id);
    if (i < 0) return;
    e.preventDefault();
    const to =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? sessions.length - 1
          : (i + (e.key === "ArrowRight" ? 1 : -1) + sessions.length) % sessions.length;
    const next = sessions[to];
    if (!next) return;
    setActiveTerm(wt.wtKey, next.id);
    requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(next.id)}"]`)?.focus());
  };

  const uniqueTitle = (base: string) => {
    const live = useStore.getState().sessions[wt.wtKey] ?? NO_SESSIONS;
    // probe for the first free suffix rather than counting matches: closing
    // "Claude 2" while "Claude 3" is open would otherwise hand out a second
    // "Claude 3", leaving two tabs indistinguishable.
    const taken = new Set(live.map((s) => s.title));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  };

  // Start a coding agent as its OWN PTY session (the terminal *is* the chat).
  // Running it as the session's command means the session ends — and the tab
  // flips to "ended" — exactly when the agent exits. The context is written to
  // .canopy/context.md first so the agent can read the full handoff.
  const startAgent = async (profile: AgentCfg) => {
    setCtxOpen(false);
    setAddOpen(false);
    const id = nextTermId(wt.wtKey, "agent");
    const title = uniqueTitle(profile.name || "Agent");
    if (!hasBackend()) {
      openSession({ id, wtKey: wt.wtKey, kind: "agent", title, agentId: profile.id, command: "agent" });
      showToast(`${title} — ${repo.name} · ${wt.branch}`);
      return;
    }
    try {
      // Always write the handoff: even a blank user brief includes the branch,
      // database and resolved service ports the agent needs to work safely.
      await ipc.writeWorktreeContext(wt.path, composeContextMd(ctx, runtime));
      const prompt = composeAgentPrompt(ctx, runtime);
      // A profile can opt out for CLIs that do not accept an initial positional
      // prompt; those still receive CANOPY_CONTEXT_FILE via the context file.
      const command = profile.promptOnLaunch ? `${profile.command} ${shellQuote(prompt)}` : profile.command;
      openSession({ id, wtKey: wt.wtKey, kind: "agent", title, agentId: profile.id, command });
      showToast(`${title} started — ${repo.name} · ${wt.branch}`);
    } catch (e) {
      showToast(`Agent start failed — ${errText(e)}`);
    }
  };

  const startShell = () => {
    setAddOpen(false);
    const id = nextTermId(wt.wtKey, "shell");
    openSession({ id, wtKey: wt.wtKey, kind: "shell", title: uniqueTitle("Shell") });
  };

  // Pop a terminal into its own OS window that attaches to the SAME PTY. The
  // lane shows a placeholder while detached; closing the window (or "Bring
  // back") re-docks it — the shell never stops.
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
    const sess = sessions.find((s) => s.id === id);
    const title = sess?.title ?? "Terminal";
    // carry the command: if this window is the one that ends up *creating* the
    // PTY (the tab was popped out before its session existed), it must launch
    // the agent, not a bare login shell.
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

  if (collapsed) {
    return (
      <aside className="lane collapsed">
        <div className="lane-head" style={{ padding: 0, justifyContent: "center" }}>
          <button className="ib" title="Open agent lane" onClick={() => setCollapsed(false)}>
            <ChevLeft size={16} />
          </button>
        </div>
        <div className="lane-rail">
          <button className="ib" title={`Agents${liveAgents ? ` — ${liveAgents} running` : ""}`} onClick={() => setCollapsed(false)}>
            <Sparkle size={15} />
            {liveAgents > 0 && <span className="rail-n">{liveAgents}</span>}
          </button>
          <button className="ib" title="Shells" onClick={() => setCollapsed(false)}>
            <TerminalIcon size={15} />
          </button>
          <button
            className="ib"
            title="Context"
            onClick={() => {
              setCollapsed(false);
              setCtxOpen(true);
            }}
          >
            <Doc size={15} />
          </button>
          <span className="vtxt">Agent</span>
        </div>
      </aside>
    );
  }

  return (
    <aside
      ref={asideRef}
      className={"lane" + (tight ? " overlay" : "") + (resizing ? " resizing" : "")}
      style={tight ? undefined : { width: shownW }}
    >
      {!tight && (
        <span
          className={"lane-grip" + (resizing ? " on" : "")}
          title="Drag to resize · double-click to reset"
          onMouseDown={(e) => {
            e.preventDefault();
            // seed from the *rendered* width, not laneW — they can differ after
            // a window resize clamps the lane, and the drag must start where
            // the user actually sees the edge.
            const w = asideRef.current?.getBoundingClientRect().width ?? laneW;
            dragRef.current = { x: e.clientX, w };
            setResizing(true);
          }}
          onDoubleClick={() => {
            const max = maxLaneFor(mainRailed);
            setLaneW(max == null ? DEFAULT_LANE : Math.min(DEFAULT_LANE, max));
          }}
        />
      )}
      <div className="lane-head">
        <span
          className={"ag-pip" + (liveAgents > 0 ? " busy" : "")}
          style={{ width: 26, height: 26, borderRadius: 8, background: "var(--accent-dim)", color: "var(--accent)" }}
        >
          <Sparkle size={14} />
        </span>
        <div className="lh-t">
          <b>Agent</b>
          <span>{wt.branch}</span>
        </div>
        <span className="grow" />
        {active && (
          <button
            className="ib"
            title={active.running ? `Open ${active.title} in a separate window` : `Restart ${active.title} in a separate window`}
            onClick={() => {
              // an ended tab has no PTY behind it; restart so the detached
              // window attaches to a real session rather than a bare shell
              if (!active.running) restartSession(active.id);
              popOut(active.id);
            }}
          >
            <PopOut size={14} />
          </button>
        )}
        {!tight && (
          <button className="ib" title={mainRailed ? "Show worktree details" : "Focus the terminal"} onClick={toggleFocus}>
            <ExpandH size={15} />
          </button>
        )}
        <button
          className="ib"
          title="Collapse lane"
          onClick={() => {
            setCollapsed(true);
            setMainRailed(false);
          }}
        >
          <ChevRight size={16} />
        </button>
      </div>

      <div className="lane-ctx">
        <div className="lc-lbl">
          <Doc size={11} />
          Context
          <span className="grow" />
          <button className="ib" style={{ height: 22, fontSize: 11, padding: "0 7px" }} onClick={() => setCtxOpen(true)}>
            Edit
          </button>
        </div>
        {isBlank(ctx) ? (
          <>
            <div className="lc-title" style={{ color: "var(--faint)" }}>
              What is this worktree for?
            </div>
            <div className="lc-body">Set a task or PR description to seed the agent and pre-fill the PR body.</div>
          </>
        ) : (
          <>
            <div className="lc-title">{ctx.title || "Untitled"}</div>
            <div className="lc-body">{bodyPreview(ctx.body) || `${ctx.links.length} link(s)`}</div>
          </>
        )}
      </div>

      {/* with nothing running the idle pane carries the launchers, so the strip
          would just be an empty bar — it appears with the first tab. */}
      {sessions.length > 0 && (
      <div className="lane-tabs">
        <div className="lt-scroll" ref={tabsRef} role="tablist" aria-label="Terminal sessions">
          {sessions.map((s) => (
            <span
              key={s.id}
              className={"lt" + (s.id === active?.id ? " on" : "") + (s.running ? "" : " ended")}
              onAuxClick={(e) => {
                if (e.button === 1) closeSession(s.id); // middle-click closes, as in an editor
              }}
            >
              {/* roving tabindex: only the selected tab is in the tab order, and
                  arrows move between them — the standard tablist pattern */}
              <button
                className="lt-main"
                role="tab"
                data-tab={s.id}
                aria-selected={s.id === active?.id}
                tabIndex={s.id === active?.id ? 0 : -1}
                title={`${s.title}${s.running ? "" : " — ended"}`}
                onClick={() => setActiveTerm(wt.wtKey, s.id)}
                onKeyDown={(e) => onTabKey(e, s.id)}
              >
                {s.kind === "agent" ? <Sparkle size={11} /> : <TerminalIcon size={11} />}
                <span className="lt-n">{s.title}</span>
                <span className={"lt-d" + (s.running ? " live" : "")} />
              </button>
              <button className="lt-x" title="Close tab" aria-label={`Close ${s.title}`} onClick={() => closeSession(s.id)}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
        <div className="lt-add" ref={addRef}>
          <button className="ib" title="New agent or shell" onClick={() => setAddOpen((v) => !v)}>
            <Plus size={15} />
          </button>
          {addOpen && (
            <div className="lt-menu">
              <div className="lt-menu-h">Coding agents</div>
              {agents.map((a) => (
                <button key={a.id} onClick={() => startAgent(a)}>
                  <Sparkle size={12} />
                  {a.name}
                </button>
              ))}
              <div className="lt-menu-sep" />
              <button onClick={startShell}>
                <TerminalIcon size={12} />
                Shell
              </button>
            </div>
          )}
        </div>
      </div>
      )}

      <div className="lane-body">
        <div className="term">
          {sessions.length === 0 ? (
            <div className="term-body">
              <LaneIdle agents={agents} onAgent={startAgent} onShell={startShell} />
            </div>
          ) : (
            sessions.map((s) => {
              const on = s.id === active?.id;
              return (
                <div
                  className={"term-body" + (on ? "" : " hidden")}
                  key={s.id}
                  role="tabpanel"
                  aria-label={s.title}
                  // NB: not the `hidden` attribute — that is display:none, which
                  // leaves xterm's renderer without dimensions (see terminal.css)
                  aria-hidden={!on}
                >
                  {detached.has(s.id) ? (
                    <DetachedPlaceholder onBack={() => bringBack(s.id)} />
                  ) : s.running ? (
                    // `gen` in the key forces a full remount on restart, which is
                    // what re-creates the PTY under the same id.
                    <TerminalPane key={s.gen} termId={s.id} cwd={wt.path} hidden={!on} command={s.command} />
                  ) : (
                    <EndedSession
                      session={s}
                      cwd={wt.path}
                      hidden={!on}
                      onRestart={() => restartSession(s.id)}
                      onClose={() => closeSession(s.id)}
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="lane-foot">
        {active?.running ? (
          <span className="agent-live" style={{ flex: 1 }}>
            {active.kind === "agent" ? <Spinner size={12} /> : <TerminalIcon size={12} />}
            {active.kind === "agent" ? `${active.title} working` : `${active.title} running`}
            <span className="grow" />
            <button className="stopx" title={`Stop ${active.title}`} onClick={() => stopSession(active.id)}>
              <X size={12} />
            </button>
          </span>
        ) : active ? (
          <>
            <button className="btn-sm" style={{ flex: 1, justifyContent: "center" }} onClick={() => restartSession(active.id)}>
              <Play size={13} />
              Restart {active.title}
            </button>
            <button className="btn-sm" title="Close tab" onClick={() => closeSession(active.id)}>
              <X size={13} />
            </button>
          </>
        ) : (
          <button
            className="startagent"
            style={{ flex: 1, justifyContent: "center", height: 30 }}
            onClick={() => agents[0] && startAgent(agents[0])}
          >
            <Sparkle size={13} />
            Start {agents[0]?.name || "agent"}
            <span className="ar">▸</span>
          </button>
        )}
      </div>

      {ctxOpen && (
        <ContextEditor
          ctx={ctx}
          setCtx={setCtx}
          runtime={runtime}
          wtKey={wt.wtKey}
          onClose={() => setCtxOpen(false)}
          onSeed={() => agents[0] && startAgent(agents[0])}
          onToast={showToast}
        />
      )}
    </aside>
  );
}
