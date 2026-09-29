// Notifications — what Canopy is allowed to interrupt you for.
import { type NotifyCfg } from "../../../ipc";
import { TRow } from "../primitives";
import { DEFAULT_NOTIFY } from "../provision";
import type { PageProps } from "../types";

/* Notifications only fire while no Canopy window is on screen — the pip, the
   attention queue and the toast have already said it otherwise. */
export default function NotificationsPage({ settings, patch, markDirty }: PageProps) {
  const n = settings.notifications ?? DEFAULT_NOTIFY;
  const set = (p: Partial<NotifyCfg>) => { patch({ notifications: { ...n, ...p } }); markDirty("notifications"); };
  return (
    <>
      <div className="sec">
        <div className="slab">Notify me when<span className="n">only while Canopy isn't on screen</span></div>
        <TRow title="A service crashes" hint="It exited on its own. Nothing else in that worktree works until it's back." on={n.serviceCrash} onToggle={() => set({ serviceCrash: !n.serviceCrash })} />
        <TRow title="An agent needs a decision" hint="An agent is blocked waiting on input." on={n.agentWaiting} onToggle={() => set({ agentWaiting: !n.agentWaiting })} />
        <TRow title="Setup finishes" hint="Provisioning and setup tasks completed, or failed." on={n.setupDone} onToggle={() => set({ setupDone: !n.setupDone })} />
        <TRow title="A branch moves on origin" hint="Fires when you fall further behind, not for every refresh while you already are." on={n.branchMoved} onToggle={() => set({ branchMoved: !n.branchMoved })} />
      </div>
      <div className="sec">
        <div className="slab">How</div>
        <TRow title="Play a sound" on={n.sound} onToggle={() => set({ sound: !n.sound })} />
        <div className="fgrid" style={{ marginTop: 8 }}>
          <span className="lb">Badge</span>
          <select className="inp" value={n.badge} onChange={(e) => set({ badge: e.target.value })}>
            <option value="count">Count of things needing you</option>
            <option value="dot">A dot</option>
            <option value="off">Nothing</option>
          </select>
        </div>
      </div>
    </>
  );
}
