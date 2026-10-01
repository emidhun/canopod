// Setup — the commands run in order the first time a worktree is created.
import { useState } from "react";
import { errText, hasBackend, ipc } from "../../../ipc";
import { Chevron, Play, Plus, Trash } from "../../../icons";
import { Rot, Toggle, Adv } from "../primitives";
import type { PageProps } from "../types";

export default function SetupPage({ setup, setSetup, policy, setPolicy, markDirty, flash, selKey }: PageProps) {
  const [openTask, setOpenTask] = useState<number | null>(null);
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= setup.length) return; const n = setup.slice(); [n[i], n[j]] = [n[j], n[i]]; setSetup(n); markDirty("setup"); };
  const patch = (i: number, p: Partial<(typeof setup)[number]>) => { setSetup(setup.map((t, j) => (j === i ? { ...t, ...p } : t))); markDirty("setup"); };
  const add = () => { setSetup(setup.concat([{ cmd: "", cwd: "", enabled: true }])); setOpenTask(setup.length); markDirty("setup"); };
  const enabledCount = setup.filter((t) => t.enabled && t.cmd.trim()).length;

  return (
    <div className="sec">
      <div className="slab">Setup tasks<span className="n">run in order when a worktree is created</span></div>
      {setup.length === 0 ? (
        <div className="empty"><p>No setup tasks. Add commands like <code>pnpm install</code> — they run in order the first time a worktree is created.</p>
          <button className="btn sm" onClick={add}><Plus size={10} />Add task</button></div>
      ) : (
        <div className="objs">
          {setup.map((t, i) => (
            <div className={"obj" + (openTask === i ? " open" : "")} key={i}>
              <div className="ohead" style={{ cursor: "default" }}>
                <span className="num" style={{ width: 16, height: 16, borderRadius: 4, display: "grid", placeItems: "center", font: "var(--fw-bold) var(--fs-label) var(--sans)", background: "var(--btn)", color: "var(--text-tertiary)", flex: "none" }}>{i + 1}</span>
                <input className="inp mono gr" value={t.cmd} style={{ height: 25, opacity: t.enabled ? 1 : 0.55 }} placeholder="pnpm install" onChange={(e) => patch(i, { cmd: e.target.value })} />
                <Toggle on={t.enabled} onClick={() => patch(i, { enabled: !t.enabled })} />
                <span className="oacts" style={{ opacity: 1 }}>
                  <span className="ico" title={openTask === i ? "Hide options" : "Working directory"} onClick={() => setOpenTask(openTask === i ? null : i)}><Chevron size={11} /></span>
                  <span className="ico" title="Move up" onClick={() => move(i, -1)}><Rot deg={180}><Chevron size={11} /></Rot></span>
                  <span className="ico" title="Move down" onClick={() => move(i, 1)}><Chevron size={11} /></span>
                  <span className="ico bad" title="Remove" onClick={() => { setSetup(setup.filter((_, j) => j !== i)); markDirty("setup"); }}><Trash size={11} /></span>
                </span>
              </div>
              {openTask === i && (
                <div className="obody">
                  <div className="fgrid">
                    <span className="lb">Working directory</span>
                    <input className="inp mono" value={t.cwd} placeholder="the worktree root" onChange={(e) => patch(i, { cwd: e.target.value })} />
                  </div>
                  <div className="hint">Relative to the worktree root, and must stay inside it. Leave blank to run from the root.</div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" onClick={add}><Plus size={11} />Add task</button>
        <button
          className="btn"
          title="Print exactly what would run, without running it"
          onClick={() => {
            if (!hasBackend() || !selKey) { flash("Open a worktree to dry-run setup"); return; }
            ipc.runWorktreeSetup(selKey, true)
              .then(() => flash(`Dry run complete — ${enabledCount} task${enabledCount === 1 ? "" : "s"} would run`))
              .catch((e) => flash(`Dry run failed — ${errText(e)}`));
          }}
        ><Play size={11} />Dry run</button>
        <span className="hint" style={{ marginTop: 0 }}>A dry run provisions nothing and executes nothing — it reports the plan in the setup runner.</span>
      </div>
      <Adv>
        <div className="fgrid">
          <span className="lb">On failure</span>
          <select className="inp" value={policy.continueOnFailure ? "continue" : "stop"}
            onChange={(e) => { setPolicy({ ...policy, continueOnFailure: e.target.value === "continue" }); markDirty("setup"); }}>
            <option value="stop">Stop and report</option>
            <option value="continue">Continue, report at the end</option>
          </select>
          <span className="lb">Timeout</span>
          <div className="row">
            <input className="inp mono" style={{ width: 90 }} value={policy.timeoutSecs || ""} placeholder="3600"
              onChange={(e) => { setPolicy({ ...policy, timeoutSecs: Number(e.target.value) || 0 }); markDirty("setup"); }} />
            <span className="hint" style={{ marginTop: 0 }}>Seconds any one task may run. Blank uses the built-in one hour.</span>
          </div>
        </div>
        <p className="hint">
          Stop-and-report is the default because a task list usually encodes an order — continuing past a failed install
          just produces a second, more confusing failure. Either way the run is reported as failed.
        </p>
      </Adv>
    </div>
  );
}
