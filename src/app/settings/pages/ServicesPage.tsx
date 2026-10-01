// Services — the long-running processes Canopy starts per worktree.
import { useState } from "react";
import { type ServiceCfg } from "../../../ipc";
import { ChevRight, Copy, Plus, Trash } from "../../../icons";
import { emptyService, envToStr, strToEnv, uid } from "../provision";
import { Adv } from "../primitives";
import { missingText, rowKey } from "../incomplete";
import type { PageProps } from "../types";

export default function ServicesPage({ repo, patchRepo, markDirty, invalid }: PageProps) {
  const [open, setOpen] = useState<string | null>(repo?.services[0]?.id ?? null);
  if (!repo) return null;
  const svcs = repo.services;
  const patch = (id: string, p: Partial<ServiceCfg>) => { patchRepo({ services: svcs.map((s) => (s.id === id ? { ...s, ...p } : s)) }); markDirty("services"); };
  return (
    <div className="sec">
      <div className="slab">Services<span className="n">ports derive from the worktree index</span></div>
      <div className="objs">
        {svcs.map((s, i) => {
          const bad = invalid.get(rowKey("service", i));
          return (
          <div className={"obj" + (open === s.id ? " open" : "") + (bad ? " incomplete" : "")} aria-invalid={bad ? true : undefined} key={s.id}>
            <button className="ohead" onClick={() => setOpen(open === s.id ? null : s.id)}>
              <span className="cv"><ChevRight size={11} /></span>
              <span className="nm">{s.name || "New service"}</span>
              <span className="tag">{s.kind}</span>
              {bad && <span className="tag warn">{missingText(bad)}</span>}
              <span className="gr" />
              <span className="mono" style={{ maxWidth: 210 }}>{s.command}</span>
              {s.basePort != null && <span className="port">:{s.basePort}</span>}
              <span className="oacts">
                <span className="ico" title="Duplicate" onClick={(e) => { e.stopPropagation(); patchRepo({ services: svcs.concat([{ ...s, id: uid("svc"), name: s.name + " copy" }]) }); markDirty("services"); }}><Copy size={11} /></span>
                <span className="ico bad" title="Remove" onClick={(e) => { e.stopPropagation(); patchRepo({ services: svcs.filter((x) => x.id !== s.id) }); markDirty("services"); }}><Trash size={11} /></span>
              </span>
            </button>
            {open === s.id && (
              <div className="obody">
                <div className="fgrid">
                  <span className="lb">Name</span><input className="inp" value={s.name} onChange={(e) => patch(s.id, { name: e.target.value })} />
                  <span className="lb">Command</span><input className="inp mono" value={s.command} onChange={(e) => patch(s.id, { command: e.target.value })} />
                  <span className="lb">Directory</span><input className="inp mono" value={s.cwd} placeholder="repo root" onChange={(e) => patch(s.id, { cwd: e.target.value })} />
                  <span className="lb">Base port</span>
                  <div className="row">
                    <input className="inp mono" value={s.basePort ?? ""} style={{ width: 84 }} inputMode="numeric"
                      onChange={(e) => patch(s.id, { basePort: e.target.value.trim() === "" ? null : Number(e.target.value) || 0 })} />
                    {s.basePort != null && <span className="hint" style={{ marginTop: 0 }}>+ index × 10 → <span className="tokchip" style={{ fontFamily: "var(--mono)" }}>{s.basePort + 30}</span> on index 3</span>}
                  </div>
                  <span className="lb">Kind</span>
                  <select className="inp" value={s.kind} onChange={(e) => patch(s.id, { kind: e.target.value })}>
                    <option value="web">web</option><option value="server">server</option><option value="worker">worker</option>
                  </select>
                </div>
                <Adv n="env, health">
                  <div className="fgrid">
                    <span className="lb">Extra env</span>
                    <textarea className="inp" value={envToStr(s.env)} placeholder="KEY=VALUE (one per line)" onChange={(e) => patch(s.id, { env: strToEnv(e.target.value) })} />
                    <span className="lb">Health check</span>
                    <input className="inp mono" value={s.health} placeholder="/api/health" onChange={(e) => patch(s.id, { health: e.target.value })} />
                    <span className="lb" />
                    <span className="hint" style={{ marginTop: 0 }}>
                      A path on this service's own port. While set, the service stays “starting” until it answers — so green means it responded, not that the shell forked.
                    </span>
                  </div>
                </Adv>
              </div>
            )}
          </div>
          );
        })}
      </div>
      <button className="btn" style={{ marginTop: 8 }} onClick={() => { const s = { ...emptyService(), name: "New service", basePort: 4000 }; patchRepo({ services: svcs.concat([s]) }); setOpen(s.id); markDirty("services"); }}>
        <Plus size={11} />Add service</button>
    </div>
  );
}
