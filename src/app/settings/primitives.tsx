// The small shared controls every Settings page is built from — a switch, a
// labelled switch row, a disclosure, the "coming soon" banner and the template
// variable picker.
import { useEffect, useRef, useState } from "react";
import { ChevRight, Cube, Plus } from "../../icons";
import { VARS } from "./catalog";

export const Rot = ({ children, deg }: { children: React.ReactNode; deg: number }) => (
  <span style={{ display: "inline-flex", transform: `rotate(${deg}deg)` }}>{children}</span>
);

export function Toggle({ on, onClick, disabled }: { on: boolean; onClick?: () => void; disabled?: boolean }) {
  return <button className={"tgl" + (on ? " on" : "")} role="switch" aria-checked={on} disabled={disabled} onClick={onClick}><i /></button>;
}
export function TRow({ title, hint, on, onToggle, disabled }: { title: string; hint?: string; on: boolean; onToggle?: () => void; disabled?: boolean }) {
  return (
    <div className="tglrow">
      <span className="tt"><b>{title}</b>{hint && <span>{hint}</span>}</span>
      <Toggle on={on} onClick={onToggle} disabled={disabled} />
    </div>
  );
}
export function Adv({ n, label = "Advanced", children }: { n?: string; label?: string; children: React.ReactNode }) {
  return (
    <details className="adv">
      <summary><span className="cv"><ChevRight size={11} /></span>{label}{n && <span className="n">{n}</span>}</summary>
      <div className="advb">{children}</div>
    </details>
  );
}
export function Soon({ children }: { children: React.ReactNode }) {
  return (
    <div className="soon">
      <span className="ic"><Cube size={14} /></span>
      <span><b>Coming soon.</b> {children}</span>
    </div>
  );
}
export function InsertVar({ onPick }: { onPick: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const d = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", d);
    return () => document.removeEventListener("mousedown", d);
  }, [open]);
  return (
    <span className="varwrap" ref={ref}>
      <button className="btn sm gh" onClick={() => setOpen((o) => !o)}><Plus size={10} />Insert variable<span className="k">⌘/</span></button>
      {open && (
        <div className="varmenu">
          <div className="vh">Template variables</div>
          {VARS.map((v) => (
            <button className="vitem" key={v.t} onClick={() => { onPick(v.t); setOpen(false); }}><code>{v.t}</code><span>{v.d}</span></button>
          ))}
        </div>
      )}
    </span>
  );
}
