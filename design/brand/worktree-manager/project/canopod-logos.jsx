// canopod-logos.jsx — Canopod logo exploration
const ACCENT = "#58c2c8";
const GREEN = "#3fb950";

function base(size, color, sw) {
  return { width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: color, strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round" };
}

/* A — Dome: trunk forks to two nodes under a canopod arc */
function MarkDome({ size = 48, color = "currentColor", nodes, sw = 1.8 }) {
  return (
    <svg {...base(size, color, sw)}>
      <path d="M3 11a9 8.5 0 0 1 18 0" />
      <path d="M12 21.5v-7" />
      <path d="M12 14.5c0-2.5-1.5-3.5-3.4-4.2" />
      <path d="M12 14.5c0-2.5 1.5-3.5 3.4-4.2" />
      <circle cx="7" cy="9.5" r="1.9" stroke={nodes || color} />
      <circle cx="17" cy="9.5" r="1.9" stroke={nodes || color} />
    </svg>
  );
}

/* B — Graph: root node fans out to three canopod nodes */
function MarkGraph({ size = 48, color = "currentColor", nodes, sw = 1.8 }) {
  return (
    <svg {...base(size, color, sw)}>
      <circle cx="12" cy="19.4" r="2.1" />
      <path d="M12 17.2v-9.9" />
      <path d="M10.5 17.9c-3.4-2.4-4.9-5.3-5.3-7.4" />
      <path d="M13.5 17.9c3.4-2.4 4.9-5.3 5.3-7.4" />
      <circle cx="12" cy="4.9" r="2.1" stroke={nodes || color} />
      <circle cx="4.8" cy="7.9" r="2.1" stroke={nodes || color} />
      <circle cx="19.2" cy="7.9" r="2.1" stroke={nodes || color} />
    </svg>
  );
}

/* C — Monogram: a "C" with an inner branch + nodes at the tips */
function MarkMono({ size = 48, color = "currentColor", nodes, sw = 1.8 }) {
  return (
    <svg {...base(size, color, sw)}>
      <path d="M17.2 5.4a8.6 8.6 0 1 0 0 13.2" />
      <circle cx="18.7" cy="4.2" r="1.9" stroke={nodes || color} />
      <circle cx="18.7" cy="19.8" r="1.9" stroke={nodes || color} />
      <path d="M4.8 16.2c2.2-.4 4.3-1.5 5.8-3.2" />
      <circle cx="11.9" cy="11.5" r="1.9" stroke={nodes || color} />
    </svg>
  );
}

/* D — Crown: filled leafy crown over a forking trunk */
function MarkCrown({ size = 48, color = "currentColor", crown, sw = 1.8 }) {
  const c = crown || color;
  return (
    <svg {...base(size, color, sw)}>
      <g fill={c} stroke="none">
        <circle cx="7.3" cy="7.2" r="4.1" />
        <circle cx="16.7" cy="7.2" r="4.1" />
        <circle cx="12" cy="4.9" r="4.3" />
        <circle cx="12" cy="8.3" r="4.6" />
      </g>
      <path d="M12 21.5v-8" />
      <path d="M12 17.2c0-2-1.8-2.4-2.9-3.6" />
      <path d="M12 17.2c0-2 1.8-2.4 2.9-3.6" />
      <circle cx="8.1" cy="12.6" r="1.5" />
      <circle cx="15.9" cy="12.6" r="1.5" />
    </svg>
  );
}

const MARKS = [
  { id: "dome", name: "A · Dome", C: MarkDome, note: "Canopod arc sheltering a fork — branch tips are commit nodes." },
  { id: "graph", name: "B · Graph", C: MarkGraph, note: "A git graph growing upward; three nodes form the canopod." },
  { id: "mono", name: "C · Monogram", C: MarkMono, note: "“C” for Canopod with a branch growing inside it." },
  { id: "crown", name: "D · Crown", C: MarkCrown, note: "Solid leafy crown over a forking trunk — most literal tree." },
];

function SizeRow({ C, color, nodes }) {
  return (
    <div className="sizes">
      {[48, 28, 16].map((s) => (
        <div className="size-cell" key={s}>
          <C size={s} color={color} nodes={nodes} crown={nodes} sw={s <= 16 ? 2.2 : 1.8} />
          <span className="cap">{s}px</span>
        </div>
      ))}
    </div>
  );
}

function MarkBoard({ m }) {
  return (
    <div className="board dark">
      <m.C size={86} color="#e8e8ea" sw={1.7} />
      <SizeRow C={m.C} color="#9a9ba0" />
      <div className="note">{m.note}</div>
    </div>
  );
}

/* color treatments of each mark */
function ColorBoard({ m }) {
  return (
    <div className="board dark">
      <div className="sizes">
        <div className="size-cell"><m.C size={56} color="#e8e8ea" sw={1.7} /><span className="cap">mono</span></div>
        <div className="size-cell"><m.C size={56} color={ACCENT} sw={1.7} /><span className="cap">teal</span></div>
        <div className="size-cell"><m.C size={56} color="#e8e8ea" nodes={GREEN} crown={GREEN} sw={1.7} /><span className="cap">two-tone</span></div>
        <div className="size-cell"><m.C size={56} color={ACCENT} nodes={GREEN} crown={GREEN} sw={1.7} /><span className="cap">teal + green</span></div>
      </div>
    </div>
  );
}

function Lockup({ C, dark, accentNodes }) {
  return (
    <div className={"board " + (dark ? "dark" : "light")}>
      <div className="lockup">
        <C size={44} color={dark ? "#e8e8ea" : "#23262c"} nodes={accentNodes ? ACCENT : undefined} crown={accentNodes ? ACCENT : undefined} sw={1.7} />
        <span className="wordmark">canopod</span>
      </div>
      <div className="lockup-sm">
        <C size={20} color={dark ? "#9a9ba0" : "#5b606b"} sw={2} />
        <span className="wordmark-sm" style={{ color: dark ? "#9a9ba0" : "#5b606b" }}>canopod</span>
      </div>
    </div>
  );
}

function ContextBoards({ C }) {
  return (
    <React.Fragment>
      <DCArtboard id="ctx-menubar" label="Menu bar · 15px tray icon" width={420} height={150}>
        <div className="board dark">
          <div className="mbar">
            <span style={{ fontWeight: 700 }}></span>
            <span className="sp" />
            <span className="tray"><C size={15} color="#fff" sw={2.2} /></span>
            <span>Thu 9:41 AM</span>
          </div>
        </div>
      </DCArtboard>
      <DCArtboard id="ctx-titlebar" label="App titlebar" width={420} height={150}>
        <div className="board dark">
          <div className="titlebar-demo">
            <span className="lights"><i style={{ background: "#ff5f57" }} /><i style={{ background: "#febc2e" }} /><i style={{ background: "#28c840" }} /></span>
            <span className="tb-lock"><C size={16} color={ACCENT} sw={2} />Canopod</span>
          </div>
        </div>
      </DCArtboard>
      <DCArtboard id="ctx-appicon" label="App icon" width={420} height={230}>
        <div className="board dark">
          <div className="sizes">
            <div className="size-cell">
              <div className="appicon g1" style={{ width: 96, height: 96 }}><C size={56} color={ACCENT} nodes={GREEN} crown={GREEN} sw={1.7} /></div>
              <span className="cap">dark badge</span>
            </div>
            <div className="size-cell">
              <div className="appicon g2" style={{ width: 96, height: 96 }}><C size={56} color="#0d2426" sw={1.8} /></div>
              <span className="cap">teal badge</span>
            </div>
            <div className="size-cell">
              <div className="appicon g1" style={{ width: 34, height: 34 }}><C size={21} color={ACCENT} sw={2.1} /></div>
              <span className="cap">32px</span>
            </div>
          </div>
        </div>
      </DCArtboard>
    </React.Fragment>
  );
}

function App() {
  const Lead = MarkDome;
  return (
    <DesignCanvas title="Canopod — Logo">
      <DCSection id="marks" title="Marks" subtitle="Four directions — every one keeps the branching structure">
        {MARKS.map((m) => (
          <DCArtboard key={m.id} id={"mark-" + m.id} label={m.name} width={340} height={300}>
            <MarkBoard m={m} />
          </DCArtboard>
        ))}
      </DCSection>
      <DCSection id="color" title="Color" subtitle="Mono · teal · two-tone (green nodes = running)">
        {MARKS.map((m) => (
          <DCArtboard key={m.id} id={"color-" + m.id} label={m.name} width={340} height={160}>
            <ColorBoard m={m} />
          </DCArtboard>
        ))}
      </DCSection>
      <DCSection id="lockups" title="Lockups" subtitle="Lead mark (A · Dome) with the wordmark — lowercase, tight">
        <DCArtboard id="lock-dark" label="Dark" width={420} height={210}>
          <Lockup C={Lead} dark accentNodes />
        </DCArtboard>
        <DCArtboard id="lock-light" label="Light" width={420} height={210}>
          <Lockup C={Lead} accentNodes />
        </DCArtboard>
        <DCArtboard id="lock-graph" label="Alt — B · Graph" width={420} height={210}>
          <Lockup C={MarkGraph} dark accentNodes />
        </DCArtboard>
      </DCSection>
      <DCSection id="context" title="In context" subtitle="Where the mark actually lives">
        <ContextBoards C={Lead} />
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
