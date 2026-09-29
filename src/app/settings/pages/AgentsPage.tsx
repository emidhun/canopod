// Agents — which agent CLIs are available in this repo.
import { useState } from "react";
import { type AgentCfg } from "../../../ipc";
import { Check, ChevRight, Plus, Sparkle, Trash } from "../../../icons";
import { emptyAgent } from "../provision";
import { Toggle, TRow } from "../primitives";
import { missingText, rowKey } from "../incomplete";
import { DEFAULT_AGENT_CONTEXT } from "../provision";
import type { PageProps } from "../types";

export default function AgentsPage({ repo, patchRepo, markDirty, flash, invalid }: PageProps) {
  if (!repo) return null;
  const agents = repo.agents || [];
  const patch = (id: string, p: Partial<AgentCfg>) => { patchRepo({ agents: agents.map((a) => (a.id === id ? { ...a, ...p } : a)) }); markDirty("agents"); };
  const makeDefault = (id: string) => { const a = agents.find((x) => x.id === id); if (!a) return; patchRepo({ agents: [a, ...agents.filter((x) => x.id !== id)] }); markDirty("agents"); flash(`${a.name || a.command} is now the default agent`); };
  const [open, setOpen] = useState<string | null>(null);
  const ac = repo.agentContext ?? DEFAULT_AGENT_CONTEXT;
  const setAc = (p: Partial<typeof ac>) => { patchRepo({ agentContext: { ...ac, ...p } }); markDirty("agents"); };
  return (
    <>
      <div className="sec">
        <div className="slab">Agent CLIs<span className="n">the first is the default</span></div>
        <div className="objs">
          {agents.map((a, i) => {
            const bad = invalid.get(rowKey("agent", i));
            return (
            <div className={"obj" + (open === a.id ? " open" : "") + (bad ? " incomplete" : "")} aria-invalid={bad ? true : undefined} key={a.id}>
              <button className="ohead" onClick={() => setOpen(open === a.id ? null : a.id)}>
                <span className="cv"><ChevRight size={11} /></span>
                <Sparkle size={12} />
                <span className="nm">{a.name || "Untitled"}</span>
                {bad && <span className="tag warn">{missingText(bad)}</span>}
                {i === 0 && <span className="tag" style={{ color: "var(--action-primary)", background: "var(--accent-dim)" }}>default</span>}
                <span className="gr" />
                <span className="mono">{a.command}</span>
                <span className="oacts">
                  {i !== 0 && <span className="ico" title="Make default" onClick={(e) => { e.stopPropagation(); makeDefault(a.id); }}><Check size={11} /></span>}
                  <span className="ico bad" title="Remove" onClick={(e) => { e.stopPropagation(); patchRepo({ agents: agents.filter((x) => x.id !== a.id) }); markDirty("agents"); }}><Trash size={11} /></span>
                </span>
              </button>
              {open === a.id && (
                <div className="obody">
                  <div className="fgrid">
                    <span className="lb">Name</span><input className="inp" value={a.name} placeholder="Claude Code" onChange={(e) => patch(a.id, { name: e.target.value })} />
                    <span className="lb">Command</span><input className="inp mono" value={a.command} placeholder="claude" onChange={(e) => patch(a.id, { command: e.target.value })} />
                  </div>
                  <div className="fgrid">
                    <span className="lb">Waiting phrases</span>
                    <textarea
                      className="inp mono"
                      rows={3}
                      value={a.waitingPatterns}
                      placeholder={"Do you want to proceed?\nApprove this edit"}
                      onChange={(e) => patch(a.id, { waitingPatterns: e.target.value })}
                    />
                  </div>
                  <div className="hint">
                    One phrase per line. Canopy already recognises the common prompt shapes —
                    add a line only when this CLI asks in a way it misses.
                  </div>
                  <div className="tglrow" style={{ borderTop: 0 }}>
                    <span className="tt"><b>Prompt on launch</b><span>Append Canopy's structured handoff as the first prompt.</span></span>
                    <Toggle on={a.promptOnLaunch} onClick={() => patch(a.id, { promptOnLaunch: !a.promptOnLaunch })} />
                  </div>
                </div>
              )}
            </div>
            );
          })}
        </div>
        <button className="btn" style={{ marginTop: 8 }} onClick={() => { const a = { ...emptyAgent(), name: "New agent" }; patchRepo({ agents: agents.concat([a]) }); setOpen(a.id); markDirty("agents"); }}>
          <Plus size={11} />Add agent</button>
      </div>
      <div className="sec">
        <div className="slab">Context handed to every agent</div>
        <TRow title="Worktree context" hint="Task title, description and linked PR or issue." on={ac.worktreeContext} onToggle={() => setAc({ worktreeContext: !ac.worktreeContext })} />
        <TRow title="Runtime facts" hint="Branch, path, database name and resolved ports." on={ac.runtimeFacts} onToggle={() => setAc({ runtimeFacts: !ac.runtimeFacts })} />
        <TRow title="Recent failing logs" hint="The last error lines from unhealthy services. Off by default — it is the one part that can carry arbitrary process output into a prompt sent to a third-party CLI." on={ac.failingLogs} onToggle={() => setAc({ failingLogs: !ac.failingLogs })} />
        <p className="hint">The task title always survives, whatever these say — a handoff opening with no heading reads as a truncation bug rather than a configured omission.</p>
      </div>
      <div className="sec">
        <div className="slab">Advanced</div>
        <div className="fgrid">
          <span className="lb">Max parallel</span>
          <div className="row">
            <input className="inp mono" style={{ width: 80 }} value={repo.maxParallelAgents || ""} placeholder="no limit"
              onChange={(e) => { patchRepo({ maxParallelAgents: Number(e.target.value) || 0 }); markDirty("agents"); }} />
            <span className="hint" style={{ marginTop: 0 }}>Agents at once across this repo. A launch past the limit is refused, not queued.</span>
          </div>
          <span className="lb">Idle timeout</span>
          <div className="row">
            <input className="inp mono" style={{ width: 80 }} value={repo.agentIdleTimeoutMin || ""} placeholder="never"
              onChange={(e) => { patchRepo({ agentIdleTimeoutMin: Number(e.target.value) || 0 }); markDirty("agents"); }} />
            <span className="hint" style={{ marginTop: 0 }}>Minutes with no output or input before an agent is closed. Blank never closes one — a quiet agent may just be waiting for you.</span>
          </div>
        </div>
      </div>
    </>
  );
}
