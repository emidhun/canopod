// app-window.jsx — Worktree Manager main window
const { useState, useEffect, useRef, useMemo } = React;
const I = window.Icons;

/* ── Mock data ───────────────────────────────────────────────────── */
const SEED = [
  { repo: "acme-web", worktrees: [
    { branch: "main", path: "~/code/acme-web", git: { ahead: 0, behind: 0, dirty: false }, commit: { msg: "checkout: fix tax rounding", when: "2h ago" },
      services: [
        { id: "aw-m-fe", name: "Frontend", kind: "web", port: 3000, status: "running" },
        { id: "aw-m-sv", name: "Server", kind: "server", port: 4000, status: "running" },
      ]},
    { branch: "feature/checkout", path: "~/code/.wt/acme-web-checkout", git: { ahead: 7, behind: 2, dirty: true }, commit: { msg: "wip: express checkout drawer", when: "11m ago" },
      services: [
        { id: "aw-c-fe", name: "Frontend", kind: "web", port: 3010, status: "stopped" },
        { id: "aw-c-sv", name: "Server", kind: "server", port: 4010, status: "stopped" },
      ]},
  ]},
  { repo: "payments-api", worktrees: [
    { branch: "main", path: "~/code/payments-api", git: { ahead: 0, behind: 0, dirty: false }, commit: { msg: "bump stripe sdk to 14.2", when: "1d ago" },
      services: [
        { id: "pa-m-api", name: "API", kind: "server", port: 8080, status: "running" },
        { id: "pa-m-wrk", name: "Worker", kind: "worker", port: null, status: "stopped" },
      ]},
    { branch: "hotfix/refund", path: "~/code/.wt/payments-refund", git: { ahead: 3, behind: 0, dirty: true }, commit: { msg: "refund: idempotency key guard", when: "4m ago" },
      services: [
        { id: "pa-h-api", name: "API", kind: "server", port: 8090, status: "running" },
      ]},
  ]},
  { repo: "design-system", worktrees: [
    { branch: "main", path: "~/dev/design-system", git: { ahead: 1, behind: 0, dirty: false }, commit: { msg: "Button: focus ring tokens", when: "5h ago" },
      services: [
        { id: "ds-sb", name: "Storybook", kind: "web", port: 6006, status: "running" },
      ]},
  ]},
];

const KEY = (repo, branch) => repo + "|" + branch;
const KIND_ICON = { web: I.globe, server: I.server, worker: I.cog };
const isLive = (s) => s === "running" || s === "starting";

function aggStatus(wt) {
  const ss = wt.services.map((s) => s.status);
  if (ss.some((s) => s === "starting" || s === "stopping")) return "running";
  if (ss.every((s) => s === "running")) return "running";
  if (ss.some((s) => s === "running")) return "part";
  return "stopped";
}
function fmtUptime(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return m + "m " + r + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}
const now2 = () => new Date().toTimeString().slice(0, 8);

/* ── Log generation ──────────────────────────────────────────────── */
const LOGS = {
  web: [
    ["info", "hmr update applied in 41ms"],
    ["ok", "compiled successfully"],
    ["info", "GET / 200 — 12ms"],
    ["info", "GET /assets/app.js 200 — 4ms"],
    ["warn", "chunk vendors.js is 612 KiB (large)"],
    ["info", "page reload: src/App.tsx"],
  ],
  server: [
    ["info", "GET /api/health 200 — 3ms"],
    ["info", "POST /api/orders 201 — 88ms"],
    ["ok", "db pool: 8 idle / 2 active"],
    ["warn", "slow query 214ms — orders.findMany"],
    ["info", "GET /api/users/42 200 — 19ms"],
    ["err", "401 /api/admin — missing token"],
  ],
  worker: [
    ["info", "job processed id=8821 (queue: jobs)"],
    ["ok", "batch flush ok — 24 records"],
    ["info", "queue depth: 3"],
    ["warn", "retry 1/3 — job id=8830"],
  ],
};
function genLine(svc) {
  const pool = LOGS[svc.kind] || LOGS.server;
  const [lv, text] = pool[Math.floor(Math.random() * pool.length)];
  return { t: now2(), lv, text };
}

/* ── Sidebar ─────────────────────────────────────────────────────── */
function seedLogs() {
  const L = {};
  for (const r of SEED) for (const w of r.worktrees) for (const s of w.services) {
    if (s.status !== "running") continue;
    const arr = [{ t: now2(), lv: "ok", text: s.port ? "listening on http://localhost:" + s.port : "worker ready" }];
    const n = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) arr.push(genLine(s));
    L[s.id] = arr;
  }
  return L;
}
function seedStats() {
  const st = {};
  for (const r of SEED) for (const w of r.worktrees) for (const s of w.services) {
    if (s.status !== "running") continue;
    const baseC = s.kind === "web" ? 6 : s.kind === "worker" ? 3 : 9;
    const baseM = s.kind === "web" ? 180 : s.kind === "worker" ? 90 : 240;
    st[s.id] = { cpu: baseC, mem: baseM };
  }
  return st;
}

function Sidebar({ repos, query, setQuery, selKey, onSelect, onAdd }) {
  return (
    <div className="side">
      <div className="side-search">
        <div className="search">
          <I.search /><input placeholder="Filter worktrees…" value={query}
            onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      <div className="side-scroll">
        {repos.map((repo) => {
          const wts = repo.worktrees.filter((w) =>
            !query || (repo.repo + " " + w.branch).toLowerCase().includes(query.toLowerCase()));
          if (!wts.length) return null;
          return (
            <div key={repo.repo}>
              <div className="repo-head">
                <span className="fork"><I.fork size={13} /></span>
                <span>{repo.repo}</span>
                <span className="count">{repo.worktrees.length}</span>
              </div>
              {wts.map((w) => {
                const st = aggStatus(w);
                const running = w.services.filter((s) => isLive(s.status)).length;
                const k = KEY(repo.repo, w.branch);
                return (
                  <button key={w.branch} className={"wt-item" + (k === selKey ? " sel" : "")}
                          onClick={() => onSelect(k)}>
                    <span className={"wt-dot " + (st === "run" ? "run" : st === "part" ? "part" : "")} />
                    <span className="wt-branch">{w.branch}</span>
                    <span className="wt-svccount">{running}/{w.services.length}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="side-foot">
        <button className="addbtn" onClick={onAdd}><I.plus size={13} />New worktree</button>
      </div>
    </div>
  );
}

/* ── Worktree header ─────────────────────────────────────────────── */
function Header({ repo, wt, resetting, onAct, onStartAll, onStopAll }) {
  const anyRunning = wt.services.some((s) => isLive(s.status));
  return (
    <div className="wt-header">
      <div className="wt-title-row">
        <div className="wt-titleblock">
          <h1 className="wt-h1">
            <span className="fork"><I.fork size={17} /></span>
            <span>{wt.branch}</span>
            <span className="sep">·</span>
            <span className="repo">{repo}</span>
          </h1>
          <div className="wt-path">{wt.path}</div>
          <div className="wt-meta">
            <span className="chip"><span className="gitnum">↑{wt.git.ahead}</span> <span className="gitnum">↓{wt.git.behind}</span> vs origin</span>
            {wt.git.dirty
              ? <span className="chip dirty">● uncommitted changes</span>
              : <span className="chip">○ clean</span>}
            <span className="chip">last commit <b>{wt.commit.when}</b> — {wt.commit.msg}</span>
          </div>
        </div>
        <div className="wt-actions">
          <button className="iconbtn" title="Open in editor" onClick={() => onAct("editor")}><I.editor /></button>
          <button className="iconbtn" title="Reveal in Finder" onClick={() => onAct("finder")}><I.finder /></button>
          <button className="iconbtn" title="Open Terminal" onClick={() => onAct("terminal")}><I.terminal /></button>
          <span className="div" />
          <button className="iconbtn" title="Pull from origin" onClick={() => onAct("pull")}><I.pull />Pull</button>
          <button className="iconbtn" title="Reset database" onClick={() => onAct("reset")} disabled={resetting}>
            {resetting ? <I.spinner size={15} /> : <I.database />}Reset DB
          </button>
          <span className="div" />
          {anyRunning
            ? <button className="iconbtn" title="Stop all services" onClick={onStopAll}><I.stop size={13} />Stop all</button>
            : <button className="iconbtn primary" title="Start all services" onClick={onStartAll}><I.play size={14} />Start all</button>}
          <button className="iconbtn" title="More" onClick={() => onAct("more")}><I.more /></button>
        </div>
      </div>
    </div>
  );
}

/* ── Service row ─────────────────────────────────────────────────── */
function ServiceRow({ svc, uptime, stats, showStats, selected, onToggle, onRestart, onLogs, onOpen }) {
  const Kind = KIND_ICON[svc.kind] || I.server;
  const busy = svc.status === "starting" || svc.status === "stopping";
  const running = svc.status === "running";
  const StatusIco = busy ? I.spinner : running ? I.check : I.x;
  const scls = busy ? "busy" : running ? "run" : "stop";
  const subText = busy ? (svc.status === "starting" ? "Starting…" : "Stopping…")
    : running ? "Running" : "Stopped";
  return (
    <div className={"svc" + (selected ? " is-sel" : "")}>
      <div className={"svc-status " + scls}><StatusIco size={19} /></div>
      <div className="svc-id">
        <div className="svc-name"><span className="kind"><Kind size={15} /></span>{svc.name}</div>
        <div className={"svc-sub" + (running ? " run" : "")}>{subText}</div>
      </div>
      {svc.port
        ? <button className={"svc-port" + (running ? "" : " off")} disabled={!running}
                  onClick={() => running && onOpen(svc)} title={running ? "Open localhost:" + svc.port : "Not running"}>
            :{svc.port}{running && <I.external size={12} />}
          </button>
        : <span className="svc-port off">no&nbsp;port</span>}
      <div className="svc-stats">
        {showStats ? <React.Fragment>
          <div className={"s" + (running ? "" : " muted")}><span>CPU</span><span>{running ? stats.cpu + "%" : "—"}</span></div>
          <div className={"s" + (running ? "" : " muted")}><span>MEM</span><span>{running ? stats.mem + "mb" : "—"}</span></div>
          <div className={"s" + (running ? "" : " muted")}><span>Uptime</span><span>{running ? uptime : "—"}</span></div>
        </React.Fragment> : <div className={"s" + (running ? "" : " muted")}><span>Uptime</span><span>{running ? uptime : "—"}</span></div>}
      </div>
      <div className="svc-ctl">
        <button className="ghostbtn" title="Restart" disabled={busy || !running} onClick={() => onRestart(svc)}><I.restart size={14} /></button>
        <button className={"ghostbtn" + (selected ? " sel" : "")} title="View logs" onClick={() => onLogs(svc)}><I.logs size={14} /></button>
        <button className={"ghostbtn startstop" + (running ? " run" : "")} disabled={busy} onClick={() => onToggle(svc)}>
          {running ? "Stop" : "Start"}
        </button>
      </div>
    </div>
  );
}

/* ── Console ─────────────────────────────────────────────────────── */
function Console({ wt, lines, tabId, setTab, collapsed, setCollapsed, onClear }) {
  const bodyRef = useRef(null);
  useEffect(() => {
    if (bodyRef.current && !collapsed) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines, collapsed]);
  return (
    <div className={"console" + (collapsed ? " collapsed" : "")}>
      <div className="console-tabs">
        {wt.services.map((s) => (
          <button key={s.id} className={"console-tab" + (s.id === tabId ? " sel" : "")}
                  onClick={() => { setTab(s.id); setCollapsed(false); }}>
            <span className={"d" + (isLive(s.status) ? " run" : "")} />{s.name}
          </button>
        ))}
        <span className="console-spacer" />
        <button className="iconbtn" title="Clear" onClick={onClear} style={{ height: 26 }}>Clear</button>
        <button className="iconbtn" title={collapsed ? "Show logs" : "Hide logs"}
                onClick={() => setCollapsed((c) => !c)} style={{ height: 26 }}>
          {collapsed ? "▴ Logs" : "▾ Logs"}
        </button>
      </div>
      <div className="console-body" ref={bodyRef}>
        {lines.length === 0
          ? <div className="log-empty">No output — service is stopped.</div>
          : lines.map((l, i) => (
              <div className="logline" key={i}>
                <span className="t">{l.t} </span>
                <span className={"lv-" + l.lv}>{l.lv === "err" ? "ERROR" : l.lv === "warn" ? "WARN " : l.lv === "ok" ? "✓" : "›"} </span>
                {l.text}
              </div>
            ))}
      </div>
    </div>
  );
}

/* ── App ─────────────────────────────────────────────────────────── */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#58c2c8",
  "density": "comfortable",
  "showStats": true
}/*EDITMODE-END*/;

function App() {
  const [tw, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [repos, setRepos] = useState(() => JSON.parse(JSON.stringify(SEED)));
  const [selKey, setSelKey] = useState("acme-web|main");
  const [query, setQuery] = useState("");
  const [tabId, setTabId] = useState("aw-m-fe");
  const [collapsed, setCollapsed] = useState(false);
  const [logs, setLogs] = useState(seedLogs);         // { svcId: [line] }
  const [startedAt, setStartedAt] = useState({ "aw-m-fe": Date.now() - 372000, "aw-m-sv": Date.now() - 372000, "pa-m-api": Date.now() - 5400000, "pa-h-api": Date.now() - 240000, "ds-sb": Date.now() - 18000000 });
  const [stats, setStats] = useState(seedStats);
  const [resetting, setResetting] = useState({});
  const [toast, setToast] = useState(null);
  const [, setTick] = useState(0);
  const timers = useRef({});
  const dataRef = useRef(repos);
  dataRef.current = repos;

  // selected worktree
  const sel = useMemo(() => {
    for (const r of repos) for (const w of r.worktrees)
      if (KEY(r.repo, w.branch) === selKey) return { repo: r.repo, wt: w };
    return { repo: repos[0].repo, wt: repos[0].worktrees[0] };
  }, [repos, selKey]);

  // ensure console tab belongs to selected worktree
  const effTab = useMemo(() => {
    const ids = sel.wt.services.map((s) => s.id);
    if (ids.includes(tabId)) return tabId;
    const run = sel.wt.services.find((s) => isLive(s.status));
    return (run || sel.wt.services[0]).id;
  }, [sel, tabId]);

  function flash(msg) { setToast(msg); clearTimeout(timers.current.__toast); timers.current.__toast = setTimeout(() => setToast(null), 2000); }

  function pushLog(svcId, line) {
    setLogs((L) => {
      const arr = (L[svcId] || []).concat(line);
      if (arr.length > 160) arr.splice(0, arr.length - 160);
      return { ...L, [svcId]: arr };
    });
  }
  function setSvc(svcId, status) {
    setRepos((R) => {
      const n = JSON.parse(JSON.stringify(R));
      for (const r of n) for (const w of r.worktrees) for (const s of w.services)
        if (s.id === svcId) s.status = status;
      return n;
    });
  }

  function startService(svc) {
    if (isLive(svc.status)) return;
    setSvc(svc.id, "starting");
    pushLog(svc.id, { t: now2(), lv: "info", text: "starting " + svc.name.toLowerCase() + "…" });
    clearTimeout(timers.current[svc.id]);
    timers.current[svc.id] = setTimeout(() => {
      setSvc(svc.id, "running");
      setStartedAt((s) => ({ ...s, [svc.id]: Date.now() }));
      pushLog(svc.id, { t: now2(), lv: "ok", text: svc.port ? "listening on http://localhost:" + svc.port : "worker ready" });
    }, 700 + Math.random() * 600);
  }
  function stopService(svc) {
    if (svc.status === "stopped") return;
    setSvc(svc.id, "stopping");
    clearTimeout(timers.current[svc.id]);
    timers.current[svc.id] = setTimeout(() => {
      setSvc(svc.id, "stopped");
      setStartedAt((s) => { const n = { ...s }; delete n[svc.id]; return n; });
      pushLog(svc.id, { t: now2(), lv: "warn", text: "process exited (SIGTERM)" });
    }, 500 + Math.random() * 400);
  }
  const toggleService = (svc) => isLive(svc.status) ? stopService(svc) : startService(svc);
  function restartService(svc) {
    setSvc(svc.id, "stopping");
    pushLog(svc.id, { t: now2(), lv: "warn", text: "restarting…" });
    clearTimeout(timers.current[svc.id]);
    timers.current[svc.id] = setTimeout(() => {
      setSvc(svc.id, "starting");
      timers.current[svc.id] = setTimeout(() => {
        setSvc(svc.id, "running");
        setStartedAt((s) => ({ ...s, [svc.id]: Date.now() }));
        pushLog(svc.id, { t: now2(), lv: "ok", text: "restarted — " + (svc.port ? "http://localhost:" + svc.port : "worker ready") });
      }, 700);
    }, 600);
  }
  const startAll = () => sel.wt.services.forEach((s) => !isLive(s.status) && startService(s));
  const stopAll = () => sel.wt.services.forEach((s) => s.status !== "stopped" && stopService(s));

  function headerAct(kind) {
    const where = sel.wt.branch + " · " + sel.repo;
    if (kind === "reset") {
      const k = selKey;
      if (resetting[k]) return;
      setResetting((r) => ({ ...r, [k]: true }));
      flash("Resetting database — " + where + "…");
      const dbSvc = sel.wt.services.find((s) => s.kind === "server") || sel.wt.services[0];
      pushLog(dbSvc.id, { t: now2(), lv: "warn", text: "db: dropping schema + re-seeding…" });
      setTimeout(() => {
        setResetting((r) => { const n = { ...r }; delete n[k]; return n; });
        pushLog(dbSvc.id, { t: now2(), lv: "ok", text: "db: reset complete (42 rows seeded)" });
        flash("Database reset ✓ " + where);
      }, 1500);
      return;
    }
    const labels = { editor: "Opening in editor", finder: "Revealing in Finder", terminal: "Opening Terminal", pull: "Pulling from origin", more: "Worktree menu" };
    flash((labels[kind] || "Action") + " — " + where);
  }
  const openInBrowser = (svc) => flash("Opening http://localhost:" + svc.port);
  const addWorktree = () => flash("New worktree… (git worktree add)");

  // live tick: uptime re-render, stats jitter, streaming logs
  useEffect(() => {
    const id = setInterval(() => {
      setTick((t) => t + 1);
      const running = [];
      for (const r of dataRef.current) for (const w of r.worktrees) for (const s of w.services)
        if (s.status === "running") running.push(s);
      // stats
      setStats((prev) => {
        const n = { ...prev };
        running.forEach((s) => {
          const baseC = s.kind === "web" ? 6 : s.kind === "worker" ? 3 : 9;
          const baseM = s.kind === "web" ? 180 : s.kind === "worker" ? 90 : 240;
          n[s.id] = { cpu: Math.max(0, baseC + Math.round((Math.random() - .5) * 8)), mem: baseM + Math.round((Math.random() - .5) * 40) };
        });
        return n;
      });
      // stream a line into the visible service (if running) + occasional others
      running.forEach((s) => {
        if (s.id === effTab || Math.random() < 0.25) {
          if (s.id === effTab || Math.random() < 0.5) pushLog(s.id, genLine(s));
        }
      });
    }, 1600);
    return () => clearInterval(id);
  }, [effTab]);

  const lines = logs[effTab] || [];

  return (
    <div className="wrap" style={{ "--accent": tw.accent, "--accent-dim": tw.accent + "29" }}>
      <div className="caption">
        <p className="eyebrow">Canopod</p>
        <h1>Main window</h1>
        <p>The full app the menu-bar popover launches into — every worktree's services with per-service start/stop, restart, live logs, ports, and git status. Depth lives here; the <a href="Worktree Manager Popover.html">popover</a> stays a glanceable launcher.</p>
      </div>

      <div className="win">
        <div className="titlebar">
          <div className="lights"><i className="r" /><i className="y" /><i className="g" /></div>
          <div className="tb-title"><span className="fork"><I.fork size={15} /></span>Canopod</div>
          <span className="tb-spacer" />
          <div className="tb-actions">
            <button className="iconbtn" title="Refresh" onClick={() => flash("Rescanning worktrees…")}><I.refresh /></button>
            <button className="iconbtn" title="Settings" onClick={() => flash("Settings")}><I.settings /></button>
          </div>
        </div>
        <div className="body">
          <Sidebar repos={repos} query={query} setQuery={setQuery} selKey={selKey}
                   onSelect={setSelKey} onAdd={addWorktree} />
          <div className="main">
            <Header repo={sel.repo} wt={sel.wt} resetting={!!resetting[selKey]}
                    onAct={headerAct} onStartAll={startAll} onStopAll={stopAll} />
            <div className="pane-scroll">
              <div className="svc-section">
                <div className="svc-section-head">
                  <h2>Services</h2><span className="line" />
                </div>
                <div className={"svc-list" + (tw.density === "compact" ? " compact" : "")}>
                  {sel.wt.services.map((svc) => (
                    <ServiceRow key={svc.id} svc={svc}
                      uptime={fmtUptime(Date.now() - (startedAt[svc.id] || Date.now()))}
                      stats={stats[svc.id] || { cpu: "—", mem: "—" }} showStats={tw.showStats}
                      selected={svc.id === effTab && !collapsed}
                      onToggle={toggleService} onRestart={restartService}
                      onLogs={(s) => { setTabId(s.id); setCollapsed(false); }}
                      onOpen={openInBrowser} />
                  ))}
                </div>
              </div>
            </div>
            <Console wt={sel.wt} lines={lines} tabId={effTab} setTab={setTabId}
                     collapsed={collapsed} setCollapsed={setCollapsed}
                     onClear={() => setLogs((L) => ({ ...L, [effTab]: [] }))} />
          </div>
        </div>
      </div>

      <TweaksPanel>
        <TweakSection label="Appearance" />
        <TweakColor label="Accent" value={tw.accent}
          options={["#58c2c8", "#3fb950", "#7aa2f7", "#e0a458", "#c678dd"]}
          onChange={(v) => setTweak("accent", v)} />
        <TweakRadio label="Density" value={tw.density} options={["comfortable", "compact"]}
          onChange={(v) => setTweak("density", v)} />
        <TweakToggle label="Show CPU / MEM" value={tw.showStats}
          onChange={(v) => setTweak("showStats", v)} />
      </TweaksPanel>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
