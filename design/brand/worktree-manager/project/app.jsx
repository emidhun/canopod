// app.jsx — page composition, shared state, macOS scene, Tweaks
const { useState, useEffect, useRef } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "granularity": "worktree",
  "treatment": "fork",
  "density": "comfortable",
  "iconStyle": "outline",
  "separators": true,
  "accent": "#58c2c8"
}/*EDITMODE-END*/;

/* clone helper */
const clone = (t) => t.map(r => ({ ...r, worktrees: r.worktrees.map(w => ({ ...w, services: w.services.map(s => ({ ...s })) })) }));

/* simple inline status icons for the menubar (wifi/battery) */
const WifiIco = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 18l0 .01" /><path d="M9.172 15.172a4 4 0 0 1 5.656 0" />
    <path d="M6.343 12.343a8 8 0 0 1 11.314 0" /><path d="M3.515 9.515c4.686 -4.687 12.284 -4.687 17 0" />
  </svg>
);
const BatteryIco = () => (
  <svg width="22" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="8" width="15" height="8" rx="1.5" /><path d="M21 11v2" />
    <rect x="5" y="10" width="9" height="4" rx="0.5" fill="currentColor" stroke="none" />
  </svg>
);

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(id);
  }, []);
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const h = now.getHours(); const m = now.getMinutes();
  const hh = ((h % 12) || 12); const ap = h < 12 ? "AM" : "PM";
  return `${days[now.getDay()]} ${hh}:${String(m).padStart(2,"0")} ${ap}`;
}

function MacScene({ tree, onToggle, onToggleWorktree, onReset, onOpen, resetting, tw, open, setOpen, onOpenManager, onQuit, flash }) {
  const clock = useClock();
  const anyRunning = tree.some(r => r.worktrees.some(w => w.services.some(s => window.isLive(s.status))));
  return (
    <div className="mac">
      <div className="desk-icons" aria-hidden="true">
        <div className="desk-ico"><div className="glyph" /><span>Projects</span></div>
        <div className="desk-ico"><div className="glyph" /><span>Notes.txt</span></div>
      </div>
      <div className="menubar">
        <span className="apple"></span>
        <span className="appname">Worktree Manager</span>
        <span className="mb-menu">File</span>
        <span className="mb-menu">View</span>
        <span className="mb-menu">Help</span>
        <span className="spacer" />
        <div className="mb-status">
          <WifiIco />
          <BatteryIco />
          <button className={"tray-btn" + (open ? " active" : "")}
                  onClick={() => setOpen(o => !o)} title="Worktree Manager">
            <window.GitFork size={15} />
          </button>
          {anyRunning && <span className="tray-running-dot" />}
          <span className="mb-clock">{clock}</span>
        </div>
      </div>

      {open && (
        <div className="mac-pop-anchor" style={{ right: 8 }}>
          <window.Popover
            tree={tree} onToggle={onToggle} onToggleWorktree={onToggleWorktree}
            onReset={onReset} onOpen={onOpen} resetting={resetting}
            onOpenManager={onOpenManager} onQuit={onQuit}
            granularity={tw.granularity} treatment={tw.treatment} density={tw.density}
            iconStyle={tw.iconStyle} separators={tw.separators} accent={tw.accent}
            flash={flash}
          />
        </div>
      )}
      <div className="scene-hint">
        {open ? "Click the branch icon to dismiss (mimics blur-to-hide)" : "Click the branch icon in the menu bar ↑"}
      </div>
    </div>
  );
}

function App() {
  const [tw, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [tree, setTree] = useState(() => clone(window.INITIAL_TREE));
  const [open, setOpen] = useState(true);
  const [flash, setFlash] = useState(null);   // "manager" | "quit"
  const [toast, setToast] = useState(null);
  const [resetting, setResetting] = useState({});  // { "repo|branch": true }
  const timers = useRef({});

  // optimistic flip + simulated async confirm (§6 behavior)
  function toggle(id) {
    setTree(prev => {
      const next = clone(prev);
      for (const r of next) for (const w of r.worktrees) for (const s of w.services) {
        if (s.id === id) {
          s.status = window.isLive(s.status) ? "stopping" : "starting";
        }
      }
      return next;
    });
    clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(() => {
      setTree(prev => {
        const next = clone(prev);
        for (const r of next) for (const w of r.worktrees) for (const s of w.services) {
          if (s.id === id) s.status = s.status === "starting" ? "running" : "stopped";
        }
        return next;
      });
    }, 850 + Math.random() * 500);
  }

  // worktree-level toggle: bring the whole tree up or down at once
  function toggleWorktree(repoName, branch) {
    setTree(prev => {
      const next = clone(prev);
      const wt = next.find(r => r.repo === repoName)?.worktrees.find(w => w.branch === branch);
      if (!wt) return prev;
      const anyRunning = wt.services.some(s => window.isLive(s.status));
      wt.services.forEach(s => { s.status = anyRunning ? "stopping" : "starting"; });
      return next;
    });
    const key = repoName + "|" + branch;
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => {
      setTree(prev => {
        const next = clone(prev);
        const wt = next.find(r => r.repo === repoName)?.worktrees.find(w => w.branch === branch);
        if (wt) wt.services.forEach(s => { s.status = s.status === "starting" ? "running" : "stopped"; });
        return next;
      });
    }, 900 + Math.random() * 450);
  }

  function fire(kind, msg) {
    setFlash(kind); setToast(msg);
    setTimeout(() => setFlash(null), 360);
    setTimeout(() => setToast(null), 1800);
  }
  const onOpenManager = () => {
    fire("manager", "Opening main window…");
    setTimeout(() => { window.location.href = "Worktree Manager App.html"; }, 420);
  };
  const onQuit = () => fire("quit", "Quitting — killing all processes…");
  const onOpen = (repo, branch) => fire(null, "Opening worktree — " + repo + " · " + branch);

  // reset db: brief spinner on the row, then a confirmation toast
  function onReset(repo, branch) {
    const key = repo + "|" + branch;
    if (resetting[key]) return;
    setResetting(r => ({ ...r, [key]: true }));
    setToast("Resetting database — " + repo + " · " + branch + "…");
    setTimeout(() => {
      setResetting(r => { const n = { ...r }; delete n[key]; return n; });
      setToast("Database reset ✓ " + repo + " · " + branch);
      setTimeout(() => setToast(null), 1600);
    }, 1300);
  }

  return (
    <div className="page">
      <div className="page-head">
        <p className="eyebrow">Canopod · Menu-bar</p>
        <h1>Status popover</h1>
        <p>Replaces the native tray menu with a custom frameless popover. Each worktree shows its services as status chips, with three quick actions: <b>open</b> the worktree, <b>reset its database</b>, and <b>Start / Stop</b> the whole tree at once. Both views share one state and stay in sync. <a href="Worktree Manager App.html" style={{color:'#3a7f84',fontWeight:550,textDecoration:'none'}}>Open the main window →</a></p>
      </div>

      <div className="stage">
        <div>
          <div className="frame-label">
            <span className="n">1</span>
            <h2>Standalone popover</h2>
            <span className="hint">the §6 deliverable</span>
          </div>
          <div className="swatch-card">
            <window.Popover
              tree={tree} onToggle={toggle} onToggleWorktree={toggleWorktree}
              onReset={onReset} onOpen={onOpen} resetting={resetting}
              onOpenManager={onOpenManager} onQuit={onQuit}
              granularity={tw.granularity} treatment={tw.treatment} density={tw.density}
              iconStyle={tw.iconStyle} separators={tw.separators} accent={tw.accent}
              flash={flash}
            />
          </div>
        </div>

        <div>
          <div className="frame-label">
            <span className="n">2</span>
            <h2>In the menu bar</h2>
            <span className="hint">anchored under the tray icon</span>
          </div>
          <MacScene tree={tree} onToggle={toggle} onToggleWorktree={toggleWorktree}
                    onReset={onReset} onOpen={onOpen} resetting={resetting} tw={tw}
                    open={open} setOpen={setOpen}
                    onOpenManager={onOpenManager} onQuit={onQuit} flash={flash} />
        </div>
      </div>

      <p className="footnote">
        <b>Per worktree:</b> service chips show each service's live status (<span style={{color:'#3fb950'}}>●</span> up, <span style={{color:'#6a6c72'}}>●</span> down). The <b>open</b> (↗) and <b>reset DB</b> (⌫) icons sit beside one <b>Start / Stop</b> that brings the whole tree up or down — clicking shows a transient spinner, then settles. Repo headers are non-interactive.
      </p>

      <TweaksPanel>
        <TweakSection label="Control" />
        <TweakRadio label="Granularity" value={tw.granularity}
          options={["worktree", "service"]}
          onChange={(v) => setTweak("granularity", v)} />
        <TweakSection label="Group label" />
        <TweakRadio label="Treatment" value={tw.treatment}
          options={["fork", "caps", "slash", "pill"]}
          onChange={(v) => setTweak("treatment", v)} />
        <TweakToggle label="Divider between groups" value={tw.separators}
          onChange={(v) => setTweak("separators", v)} />
        <TweakSection label="Rows" />
        <TweakRadio label="Status icon" value={tw.iconStyle}
          options={["outline", "filled", "dot"]}
          onChange={(v) => setTweak("iconStyle", v)} />
        <TweakRadio label="Density" value={tw.density}
          options={["comfortable", "compact"]}
          onChange={(v) => setTweak("density", v)} />
        <TweakSection label="Color" />
        <TweakColor label="Accent (fork glyph)" value={tw.accent}
          options={["#58c2c8", "#3fb950", "#7aa2f7", "#e0a458", "#c678dd"]}
          onChange={(v) => setTweak("accent", v)} />
      </TweaksPanel>

      {toast && <div style={{
        position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)",
        background: "#1e1f22", color: "#e8e8ea", padding: "9px 18px", borderRadius: 10,
        fontSize: 13.5, fontFamily: "var(--wm-sans)", boxShadow: "0 10px 30px rgba(0,0,0,.3)",
        border: "1px solid #3a3d42", zIndex: 50,
      }}>{toast}</div>}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
