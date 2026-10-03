// canopod-brand.jsx — Canopod brandmark sheet (refined git-fork)
const ACCENT = "#58c2c8";
const GREEN = "#3fb950";

/* ── Canonical mark ──────────────────────────────────────────────
   Three nodes — two parents (top), one child (bottom) — joined by a
   rounded bar + stem. Built on a 24-unit grid, 2u stroke, 2u nodes. */
function Canopod({ size = 48, color = "currentColor", nodes, sw = 2, solid = false }) {
  const nc = nodes || color;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 8v1.5a2.5 2.5 0 0 0 2.5 2.5h5a2.5 2.5 0 0 0 2.5 -2.5v-1.5" />
      <path d="M12 12v4" />
      {solid ? (
        <g fill={nc} stroke="none">
          <circle cx="7" cy="6" r="2.05" />
          <circle cx="17" cy="6" r="2.05" />
          <circle cx="12" cy="18" r="2.05" />
        </g>
      ) : (
        <g stroke={nc}>
          <circle cx="7" cy="6" r="2.05" />
          <circle cx="17" cy="6" r="2.05" />
          <circle cx="12" cy="18" r="2.05" />
        </g>
      )}
    </svg>
  );
}

/* ── Construction blueprint ──────────────────────────────────────── */
function Blueprint({ px = 300 }) {
  const u = px / 24;
  const gridLine = "rgba(255,255,255,.06)";
  const guide = "rgba(88,194,200,.5)";
  const keyline = "rgba(88,194,200,.32)";
  const lines = [];
  for (let i = 0; i <= 24; i += 2) {
    lines.push(<line key={"v" + i} x1={i} y1="0" x2={i} y2="24" stroke={gridLine} strokeWidth="0.06" />);
    lines.push(<line key={"h" + i} x1="0" y1={i} x2="24" y2={i} stroke={gridLine} strokeWidth="0.06" />);
  }
  return (
    <svg width={px} height={px} viewBox="0 0 24 24" className="blueprint">
      {lines}
      {/* keyline circles around nodes */}
      <circle cx="7" cy="6" r="3.4" fill="none" stroke={keyline} strokeWidth="0.08" strokeDasharray="0.5 0.5" />
      <circle cx="17" cy="6" r="3.4" fill="none" stroke={keyline} strokeWidth="0.08" strokeDasharray="0.5 0.5" />
      <circle cx="12" cy="18" r="3.4" fill="none" stroke={keyline} strokeWidth="0.08" strokeDasharray="0.5 0.5" />
      {/* center + symmetry guides */}
      <line x1="12" y1="0" x2="12" y2="24" stroke={guide} strokeWidth="0.07" strokeDasharray="0.4 0.4" />
      <line x1="0" y1="6" x2="24" y2="6" stroke={guide} strokeWidth="0.07" strokeDasharray="0.4 0.4" opacity=".6" />
      <line x1="0" y1="18" x2="24" y2="18" stroke={guide} strokeWidth="0.07" strokeDasharray="0.4 0.4" opacity=".6" />
      {/* the mark */}
      <g fill="none" stroke="#e8e8ea" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 8v1.5a2.5 2.5 0 0 0 2.5 2.5h5a2.5 2.5 0 0 0 2.5 -2.5v-1.5" />
        <path d="M12 12v4" />
        <circle cx="7" cy="6" r="2.05" />
        <circle cx="17" cy="6" r="2.05" />
        <circle cx="12" cy="18" r="2.05" />
      </g>
    </svg>
  );
}

/* ── Clear-space diagram ─────────────────────────────────────────── */
function ClearSpace({ px = 220 }) {
  return (
    <svg width={px} height={px} viewBox="0 0 48 48">
      <rect x="12" y="12" width="24" height="24" fill="none" stroke="rgba(88,194,200,.4)" strokeWidth="0.4" strokeDasharray="1.4 1.4" />
      {[[12,12],[36,12],[12,36],[36,36]].map(([x,y],i)=>(
        <g key={i} stroke="rgba(255,255,255,.16)" strokeWidth="0.35">
          <line x1={x-2} y1={y} x2={x+2} y2={y} /><line x1={x} y1={y-2} x2={x} y2={y+2} />
        </g>
      ))}
      <text x="24" y="9.5" fill="#6a6c72" fontSize="2.6" textAnchor="middle" fontFamily="ui-monospace,monospace">clear space = node ⌀</text>
      <g transform="translate(12,12)">
        <g fill="none" stroke="#e8e8ea" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 8v1.5a2.5 2.5 0 0 0 2.5 2.5h5a2.5 2.5 0 0 0 2.5 -2.5v-1.5" />
          <path d="M12 12v4" />
          <circle cx="7" cy="6" r="2.05" /><circle cx="17" cy="6" r="2.05" /><circle cx="12" cy="18" r="2.05" />
        </g>
      </g>
    </svg>
  );
}

function Sec({ eyebrow, title, sub, children }) {
  return (
    <section>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <div className="sec-head"><h2>{title}</h2>{sub && <p>{sub}</p>}</div>
      {children}
    </section>
  );
}

function App() {
  return (
    <div className="sheet">
      {/* HERO */}
      <div className="hero">
        <div className="lock">
          <Canopod size={84} color="#e8e8ea" nodes={ACCENT} sw={2} />
          <span className="wm">canopod</span>
        </div>
        <p className="tag">Run every worktree's services from your menu bar. <b>One branch, one click.</b></p>
      </div>

      {/* THE MARK */}
      <Sec eyebrow="Identity" title="The mark" sub="A git fork — two parents converging into one branch.">
        <div className="grid g3">
          <div className="card"><Canopod size={92} color="#e8e8ea" sw={2} /><span className="cap"><b>Primary</b> · outline</span></div>
          <div className="card"><Canopod size={92} color="#e8e8ea" nodes={ACCENT} sw={2} /><span className="cap"><b>Accent nodes</b> · teal</span></div>
          <div className="card"><Canopod size={92} color="#e8e8ea" sw={2} solid /><span className="cap"><b>Solid nodes</b> · small sizes</span></div>
        </div>
      </Sec>

      {/* CONSTRUCTION */}
      <Sec eyebrow="Geometry" title="Construction" sub="Built on a 24-unit grid; symmetric about the vertical axis.">
        <div className="construct">
          <Blueprint px={300} />
          <div className="legend">
            <ul>
              <li><span className="k" style={{background:ACCENT}} />Three nodes on a 2-unit radius — perfectly mirrored left/right.</li>
              <li><span className="k" style={{background:"rgba(88,194,200,.4)"}} />Stroke weight locked at 2 units for nodes, bar and stem.</li>
              <li><span className="k" style={{background:"#6a6c72"}} />Parents sit on row 6, child on row 18 — a clean 12-unit drop.</li>
              <li><span className="k" style={{background:"#6a6c72"}} />Connector corners use a 2.5-unit radius so curves stay optically even.</li>
            </ul>
          </div>
        </div>
      </Sec>

      {/* CLEAR SPACE + MIN SIZE */}
      <Sec eyebrow="Usage" title="Clear space & minimum size" sub="Give it room; never crowd the nodes.">
        <div className="cs-wrap">
          <div className="card" style={{padding:"30px"}}><ClearSpace px={210} /><span className="cap">Minimum clear space on all sides equals one node diameter.</span></div>
          <div className="card">
            <div style={{display:"flex",alignItems:"flex-end",gap:"30px"}}>
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:"9px"}}><Canopod size={44} color="#e8e8ea" sw={2} /><span className="cap">44px</span></div>
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:"9px"}}><Canopod size={24} color="#e8e8ea" sw={2.1} /><span className="cap">24px</span></div>
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:"9px"}}><Canopod size={16} color="#e8e8ea" sw={2.3} solid /><span className="cap">16px · min</span></div>
            </div>
            <span className="cap">Below 20px, switch to solid nodes so it holds up in the tray.</span>
          </div>
        </div>
      </Sec>

      {/* COLOR */}
      <Sec eyebrow="Palette" title="Color" sub="Ink ground, teal accent, green for live state.">
        <div className="grid g4">
          <div className="card" style={{background:"#1e1f22"}}><Canopod size={60} color="#e8e8ea" nodes={ACCENT} /><div className="swatch-line"><span className="dot" style={{background:"#1e1f22"}} />#1E1F22</div></div>
          <div className="card" style={{background:"#1e1f22"}}><Canopod size={60} color={ACCENT} /><div className="swatch-line"><span className="dot" style={{background:ACCENT}} />#58C2C8</div></div>
          <div className="card" style={{background:"#1e1f22"}}><Canopod size={60} color="#e8e8ea" nodes={GREEN} /><div className="swatch-line"><span className="dot" style={{background:GREEN}} />#3FB950</div></div>
          <div className="card light" style={{background:"#f4f5f7",border:"1px solid #e2e4e9"}}><Canopod size={60} color="#23262c" nodes={ACCENT} /><div className="swatch-line" style={{color:"#5b606b"}}><span className="dot" style={{background:"#f4f5f7"}} />#F4F5F7</div></div>
        </div>
      </Sec>

      {/* LOCKUPS */}
      <Sec eyebrow="Wordmark" title="Lockups" sub="Lowercase “canopod”, tight tracking. Mark leads.">
        <div className="grid g2">
          <div className="card lock-card">
            <div className="lock-h"><Canopod size={48} color="#e8e8ea" nodes={ACCENT} /><span className="wm wm-lg">canopod</span></div>
            <span className="cap">Horizontal · primary</span>
          </div>
          <div className="card lock-card light">
            <div className="lock-h"><Canopod size={48} color="#23262c" nodes={ACCENT} /><span className="wm wm-lg" style={{color:"#23262c"}}>canopod</span></div>
            <span className="cap" style={{color:"#8a8f99"}}>Horizontal · light ground</span>
          </div>
          <div className="card lock-card">
            <div className="lock-v"><Canopod size={56} color="#e8e8ea" nodes={ACCENT} /><span className="wm wm-md">canopod</span></div>
            <span className="cap">Stacked · for square spaces</span>
          </div>
          <div className="card lock-card">
            <div className="lock-h"><Canopod size={30} color="#9a9ba0" /><span className="wm" style={{fontSize:"20px",color:"#9a9ba0"}}>canopod</span></div>
            <span className="cap">Mono · UI chrome / footers</span>
          </div>
        </div>
      </Sec>

      {/* APP ICON */}
      <Sec eyebrow="Product" title="App icon" sub="macOS squircle, three ways.">
        <div className="grid g3">
          <div className="card"><div className="appicon ic-dark" style={{width:108,height:108}}><Canopod size={62} color="#e8e8ea" nodes={ACCENT} /></div><span className="cap"><b>Dark</b> · default</span></div>
          <div className="card"><div className="appicon ic-teal" style={{width:108,height:108}}><Canopod size={62} color="#0d2426" /></div><span className="cap"><b>Teal</b> · marketing</span></div>
          <div className="card"><div className="appicon ic-ink" style={{width:108,height:108}}><Canopod size={62} color={ACCENT} nodes={GREEN} /></div><span className="cap"><b>Ink</b> · with live nodes</span></div>
        </div>
      </Sec>

      {/* IN CONTEXT */}
      <Sec eyebrow="Product" title="In context" sub="Where it actually lives.">
        <div className="grid g2">
          <div className="card">
            <div className="mbar"><span style={{fontWeight:700}}></span><span className="sp" /><span className="tray"><Canopod size={15} color="#fff" sw={2.3} solid /></span><span>Thu 9:41 AM</span></div>
            <span className="cap">Menu-bar tray · 15px</span>
          </div>
          <div className="card">
            <div className="tbar"><span className="lights"><i style={{background:"#ff5f57"}} /><i style={{background:"#febc2e"}} /><i style={{background:"#28c840"}} /></span><span className="tt"><Canopod size={17} color={ACCENT} sw={2.1} />Canopod</span></div>
            <span className="cap">App titlebar · 17px</span>
          </div>
        </div>
      </Sec>

      <div className="footer"><span>Canopod — brandmark</span><span>git-fork · symmetric · 24u grid</span></div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
