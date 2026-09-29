// Custom commands — named one-off scripts, launchable from any worktree.
import { useState } from "react";
import { errText, hasBackend, ipc, type CustomCmd } from "../../../ipc";
import { ChevRight, Chevron, Copy, Play, Plus, Spinner, Trash } from "../../../icons";
import { Rot } from "../primitives";
import { groupNames } from "../../canopy/commandGroups";
import { missingText, rowKey } from "../incomplete";
import type { PageProps } from "../types";

export default function CommandsPage({ repo, patchRepo, markDirty, flash, selKey, invalid }: PageProps) {
  const [open, setOpen] = useState<number | null>(null);
  const [ran, setRan] = useState<{ i: number; state: "running" | "done" } | null>(null);
  if (!repo) return null;
  const cmds = repo.customCommands || [];
  const patch = (i: number, p: Partial<CustomCmd>) => { patchRepo({ customCommands: cmds.map((c, j) => (j === i ? { ...c, ...p } : c)) }); markDirty("commands"); };
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= cmds.length) return; const n = cmds.slice(); [n[i], n[j]] = [n[j], n[i]]; patchRepo({ customCommands: n }); markDirty("commands"); };
  const test = (i: number, cmd: string) => {
    if (!hasBackend() || !selKey) { flash("Open a worktree to test a command"); return; }
    setRan({ i, state: "running" });
    ipc.runCustomCommand(selKey, cmd).then(() => setRan({ i, state: "done" })).catch((e) => { setRan(null); flash(`Command failed — ${errText(e)}`); });
  };
  // Existing groups become suggestions: grouping is only useful when names
  // match exactly, and free typing is how you end up with "Build" and "build".
  const groupNameList = groupNames(cmds);
  return (
    <>
      <div className="sec">
        <div className="slab">Database operations<span className="n">used by “Reset database” and “Run migrations” on a worktree</span></div>
        <div className="fgrid">
          <span className="lb">Reset command</span>
          <input className="inp mono" value={repo.resetDb || ""} placeholder="pnpm db:reset" spellCheck={false} onChange={(e) => { patchRepo({ resetDb: e.target.value }); markDirty("commands"); }} />
          <span className="lb">Migrate command</span>
          <input className="inp mono" value={repo.migrateDb || ""} placeholder="pnpm db:migrate" spellCheck={false} onChange={(e) => { patchRepo({ migrateDb: e.target.value }); markDirty("commands"); }} />
        </div>
      </div>
      <div className="sec">
        <datalist id="cx-cmd-groups">{groupNameList.map((g) => <option key={g} value={g} />)}</datalist>
        <div className="slab">Custom commands<span className="n">launchers in the agent lane's + menu</span></div>
        {cmds.length === 0 ? (
          <div className="empty">
            <p>No commands yet. Add one like <code>Lint</code> = <code>pnpm lint</code> — it appears in every worktree's + menu.</p>
            <button className="btn sm" onClick={() => { patchRepo({ customCommands: [{ label: "", command: "", group: "" }] }); markDirty("commands"); }}><Plus size={10} />Add command</button>
          </div>
        ) : (
          <div className="objs">
            {cmds.map((c, i) => {
              const bad = invalid.get(rowKey("command", i));
              return (
              <div className={"obj" + (open === i ? " open" : "") + (bad ? " incomplete" : "")} aria-invalid={bad ? true : undefined} key={i}>
                <button className="ohead" onClick={() => setOpen(open === i ? null : i)}>
                  <span className="cv"><ChevRight size={11} /></span>
                  <span className="nm">{c.label || "Untitled"}</span>
                  {bad && <span className="tag warn">{missingText(bad)}</span>}
                  <span className="gr" />
                  <span className="mono" style={{ maxWidth: 250 }}>{c.command}</span>
                  <span className="oacts">
                    <span className="ico" title="Run once to test" onClick={(e) => { e.stopPropagation(); setOpen(i); test(i, c.command); }}>{ran && ran.i === i && ran.state === "running" ? <Spinner size={11} /> : <Play size={10} />}</span>
                    <span className="ico" title="Move up" onClick={(e) => { e.stopPropagation(); move(i, -1); }}><Rot deg={180}><Chevron size={11} /></Rot></span>
                    <span className="ico" title="Move down" onClick={(e) => { e.stopPropagation(); move(i, 1); }}><Chevron size={11} /></span>
                    <span className="ico" title="Duplicate" onClick={(e) => { e.stopPropagation(); patchRepo({ customCommands: cmds.concat([{ ...c, label: c.label + " copy" }]) }); markDirty("commands"); }}><Copy size={11} /></span>
                    <span className="ico bad" title="Remove" onClick={(e) => { e.stopPropagation(); patchRepo({ customCommands: cmds.filter((_, j) => j !== i) }); markDirty("commands"); }}><Trash size={11} /></span>
                  </span>
                </button>
                {open === i && (
                  <div className="obody">
                    <div className="fgrid">
                      <span className="lb">Label</span><input className="inp" value={c.label} placeholder="Lint" onChange={(e) => patch(i, { label: e.target.value })} />
                      <span className="lb">Command</span><input className="inp mono" value={c.command} placeholder="pnpm lint" onChange={(e) => patch(i, { command: e.target.value })} />
                      <span className="lb">Group</span>
                      <input className="inp" value={c.group ?? ""} placeholder="ungrouped" list="cx-cmd-groups"
                        title="Commands sharing a group get a header in the rail's Commands menu"
                        onChange={(e) => patch(i, { group: e.target.value })} />
                    </div>
                    {ran && ran.i === i && (
                      <div className="testout">
                        <div className="th">{ran.state === "running" ? <><Spinner size={10} />running in the current worktree…</> : <><span className="ok">✓</span>finished</>}</div>
                      </div>
                    )}
                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="btn sm" onClick={() => test(i, c.command)}><Play size={10} />Test in current worktree</button>
                    </div>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
        {cmds.length > 0 && (
          <button className="btn" style={{ marginTop: 8 }} onClick={() => { patchRepo({ customCommands: cmds.concat([{ label: "", command: "", group: "" }]) }); setOpen(cmds.length); markDirty("commands"); }}><Plus size={11} />Add command</button>
        )}
      </div>
    </>
  );
}
