// ⌘F — searches every setting, not just page names, and jumps to the match.
import { useEffect, useMemo, useState } from "react";
import { Search, Sliders, X } from "../../icons";
import { pageOf, INDEX, ICONS, type PageId } from "./catalog";

export default function SearchOverlay({ onClose, onGo }: { onClose: () => void; onGo: (r: { page: PageId; label: string }) => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const ql = q.trim().toLowerCase();
  const rows = useMemo(() => {
    const hit = (s: { page: PageId; label: string; hint: string }) => (s.label + " " + s.hint + " " + pageOf(s.page).title).toLowerCase().includes(ql);
    return (ql ? INDEX.filter(hit) : INDEX.slice(0, 8)).slice(0, 40);
  }, [ql]);
  useEffect(() => setI(0), [ql]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(x + 1, rows.length - 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
      if (e.key === "Enter" && rows[i]) { e.preventDefault(); onGo(rows[i]); }
    };
    document.addEventListener("keydown", k, true);
    return () => document.removeEventListener("keydown", k, true);
  }, [rows, i, onClose, onGo]);
  const hl = (text: string) => {
    if (!ql) return text;
    const idx = text.toLowerCase().indexOf(ql);
    if (idx < 0) return text;
    return <>{text.slice(0, idx)}<em>{text.slice(idx, idx + ql.length)}</em>{text.slice(idx + ql.length)}</>;
  };
  return (
    <div className="sr" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="srp">
        <div className="srf">
          <Search size={15} />
          <input autoFocus value={q} placeholder="Search all settings…" onChange={(e) => setQ(e.target.value)} />
          {q && <button className="ib" onClick={() => setQ("")}><X size={12} /></button>}
        </div>
        <div className="srl">
          {rows.length === 0 && <div className="srempty">No setting matches “{q}”.</div>}
          {!ql && rows.length > 0 && <div className="srg">Common settings</div>}
          {rows.map((r, n) => {
            const p = pageOf(r.page);
            const Ic = ICONS[p.ic] || Sliders;
            return (
              <button key={r.page + r.label} className={"sri" + (n === i ? " on" : "")} onMouseEnter={() => setI(n)} onClick={() => onGo(r)}>
                <span className="ic"><Ic size={13} /></span>
                <span className="st"><b>{hl(r.label)}</b><span>{hl(r.hint)}</span></span>
                <span className="where">{p.title}</span>
              </button>
            );
          })}
        </div>
        <div className="srfoot">
          <span><span className="kbd">↑↓</span>navigate</span>
          <span><span className="kbd">⏎</span>go to setting</span>
          <span><span className="kbd">esc</span>close</span>
          <span style={{ marginLeft: "auto" }}>{INDEX.length} settings</span>
        </div>
      </div>
    </div>
  );
}
