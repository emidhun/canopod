// canopod-logos-v2.jsx — Canopod logo, round 2: bold, filled, geometric
const ACCENT = "#58c2c8";
const GREEN = "#3fb950";
const INK = "#1e1f22";

/* A — Frond: solid canopod dome whose veins ARE the branches, trunk grows into them */
function MarkFrond({ size = 48, color = "currentColor", alt, bg = INK }) {
  const veinW = size <= 20 ? 2.8 : size <= 32 ? 2.2 : 1.9;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M2.5 12.6a9.5 9.5 0 0 1 19 0z" fill={alt || color} />
      <g stroke={bg} strokeWidth={veinW} strokeLinecap="round">
        <path d="M12 12.6v-7" />
        <path d="M12 12.6l-5.4-4.5" />
        <path d="M12 12.6l5.4-4.5" />
      </g>
      <path d="M12 12.6v8.4" stroke={color} strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}

/* B — Tree: bold trunk forking to three filled nodes */
function MarkTree({ size = 48, color = "currentColor", alt }) {
  const n = alt || color;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2.7" strokeLinecap="round">
      <path d="M12 21v-12" />
      <path d="M12 15.6c0-3.2-3.2-3.4-5.5-5.8" />
      <path d="M12 15.6c0-3.2 3.2-3.4 5.5-5.8" />
      <circle cx="12" cy="5.6" r="2.5" fill={n} stroke="none" />
      <circle cx="5" cy="7.6" r="2.5" fill={n} stroke="none" />
      <circle cx="19" cy="7.6" r="2.5" fill={n} stroke="none" />
    </svg>
  );
}

/* C — Ring: fork inscribed in a canopod ring */
function MarkRing({ size = 48, color = "currentColor", alt }) {
  const n = alt || color;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2.1" strokeLinecap="round">
      <circle cx="12" cy="12" r="9.4" />
      <path d="M12 18.5v-6" />
      <path d="M12 12.5l-5-5.2" />
      <path d="M12 12.5l5-5.2" />
      <circle cx="12" cy="19.2" r="2.3" fill={n} stroke="none" />
      <circle cx="6" cy="6.2" r="2.3" fill={n} stroke="none" />
      <circle cx="18" cy="6.2" r="2.3" fill={n} stroke="none" />
    </svg>
  );
}

/* D — Shelter: bold Y with a floating canopod arc */
function MarkShelter({ size = 48, color = "currentColor", alt }) {
  const n = alt || color;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth="2.5" strokeLinecap="round">
      <path d="M4.7 5.9a9.3 9.3 0 0 1 14.6 0" />
      <path d="M12 21.3v-6.4" strokeWidth="2.9" />
      <path d="M12 14.9c0-2.6-1.2-3.3-2.9-4.3" />
      <path d="M12 14.9c0-2.6 1.2-3.3 2.9-4.3" />
      <circle cx="6.9" cy="10" r="2" fill={n} stroke="none" />
      <circle cx="17.1" cy="10" r="2" fill={n} stroke="none" />
    </svg>
  );
}

const MARKS = [
  { id: "frond", name: "A · Frond", C: MarkFrond, note: "The canopod is made of branches — veins radiate from the trunk. Solid silhouette, ownable." },
  { id: "shelter", name: "B · Shelter", C: MarkShelter, note: "A fork sheltered by a floating canopod arc. Calm, architectural." },
  { id: "tree", name: "C · Tree", C: MarkTree, note: "A git graph grown upward; commits become foliage." },
  { id: "ring", name: "D · Ring", C: MarkRing, note: "The fork inscribed in a ring — badge-ready, reads at any size." },
];

function SizeRow({ C, color }) {
  return (
    <div className="sizes">
      {[48, 28, 16].map((s) => (
        <div className="size-cell" key={s}>
          <C size={s} color={color} />
          <span className="cap">{s}px</span>
        </div>
      ))}
    </div>
  );
}

function MarkBoard({ m }) {
  return (
    <div className="board dark">
      <m.C size={88} color="#e8e8ea" />
      <SizeRow C={m.C} color="#9a9ba0" />
      <div className="note">{m.note}</div>
    </div>
  );
}

function ColorBoard({ m }) {
  return (
    <div className="board dark">
      <div className="sizes">
        <div className="size-cell"><m.C size={56} color="#e8e8ea" /><span className="cap">mono</span></div>
        <div className="size-cell"><m.C size={56} color={ACCENT} /><span className="cap">teal</span></div>
        <div className="size-cell"><m.C size={56} color="#e8e8ea" alt={GREEN} /><span className="cap">green nodes</span></div>
        <div className="size-cell"><m.C size={56} color={ACCENT} alt={GREEN} /><span className="cap">teal + green</span></div>
      </div>
    </div>
  );
}

function Lockup({ C, dark, alt }) {
  return (
    <div className={"board " + (dark ? "dark" : "light")}>
      <div className="lockup">
        <C size={46} color={dark ? "#e8e8ea" : "#23262c"} alt={alt} bg={dark ? INK : "#f4f5f7"} />
        <span className="wordmark">canopod</span>
      </div>
      <div className="lockup-sm">
        <C size={20} color={dark ? "#9a9ba0" : "#5b606b"} bg={dark ? INK : "#f4f5f7"} />
        <span className="wordmark-sm" style={{ color: dark ? "#9a9ba0" : "#5b606b" }}>canopod</span>
      </div>
    </div>
  );
}

function App() {
  return (
    <DesignCanvas title="Canopod — Logo v2">
      <DCSection id="marks" title="Marks — round 2" subtitle="Bolder, filled, geometric. Branch structure in every one.">
        {MARKS.map((m) => (
          <DCArtboard key={m.id} id={"mark-" + m.id} label={m.name} width={340} height={310}>
            <MarkBoard m={m} />
          </DCArtboard>
        ))}
      </DCSection>
      <DCSection id="color" title="Color" subtitle="Mono · teal · green nodes (= running services)">
        {MARKS.map((m) => (
          <DCArtboard key={m.id} id={"color-" + m.id} label={m.name} width={340} height={160}>
            <ColorBoard m={m} />
          </DCArtboard>
        ))}
      </DCSection>
      <DCSection id="lockups" title="Lockups" subtitle="Lead candidates with the wordmark">
        <DCArtboard id="lock-frond-d" label="A · Frond — dark" width={400} height={200}>
          <Lockup C={MarkFrond} dark />
        </DCArtboard>
        <DCArtboard id="lock-frond-l" label="A · Frond — light" width={400} height={200}>
          <Lockup C={MarkFrond} />
        </DCArtboard>
        <DCArtboard id="lock-shelter-d" label="B · Shelter — dark" width={400} height={200}>
          <Lockup C={MarkShelter} dark alt={ACCENT} />
        </DCArtboard>
        <DCArtboard id="lock-tree-d" label="C · Tree — dark" width={400} height={200}>
          <Lockup C={MarkTree} dark alt={ACCENT} />
        </DCArtboard>
      </DCSection>
      <DCSection id="context" title="In context" subtitle="Menu bar · titlebar · app icon">
        <DCArtboard id="ctx-menubar" label="Menu bar · 15px tray icon" width={420} height={150}>
          <div className="board dark">
            <div className="mbar">
              <span style={{ fontWeight: 700 }}></span>
              <span className="sp" />
              <span className="tray"><MarkShelter size={15} color="#fff" /></span>
              <span>Thu 9:41 AM</span>
            </div>
          </div>
        </DCArtboard>
        <DCArtboard id="ctx-titlebar" label="App titlebar" width={420} height={150}>
          <div className="board dark">
            <div className="titlebar-demo">
              <span className="lights"><i style={{ background: "#ff5f57" }} /><i style={{ background: "#febc2e" }} /><i style={{ background: "#28c840" }} /></span>
              <span className="tb-lock"><MarkFrond size={17} color={ACCENT} bg="#25272b" />Canopod</span>
            </div>
          </div>
        </DCArtboard>
        <DCArtboard id="ctx-appicon" label="App icon" width={460} height={230}>
          <div className="board dark">
            <div className="sizes">
              <div className="size-cell">
                <div className="appicon g1" style={{ width: 96, height: 96 }}><MarkFrond size={58} color={ACCENT} bg="#1d2a2e" /></div>
                <span className="cap">frond · dark</span>
              </div>
              <div className="size-cell">
                <div className="appicon g2" style={{ width: 96, height: 96 }}><MarkFrond size={58} color="#0d2426" bg="#43a8ad" /></div>
                <span className="cap">frond · teal</span>
              </div>
              <div className="size-cell">
                <div className="appicon g1" style={{ width: 96, height: 96 }}><MarkRing size={56} color={ACCENT} alt={GREEN} /></div>
                <span className="cap">ring · dark</span>
              </div>
            </div>
          </div>
        </DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
