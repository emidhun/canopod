/* The service rail — everything the old service cards said, in one 34px row.

   Running services read as filled tokens; idle ones recede to text. A chip
   opens Service detail — the port override, metrics and failure live there.
   Log filtering is the log toolbar's own chip row, so one click never has to
   mean two things. */
import { useEffect, useRef, useState } from "react";
import AnchoredMenu from "./AnchoredMenu";
import { Database, More, Play, Restart, Spinner, Stop } from "../../icons";
import { useStore } from "../../store";
import type { ServiceNode, WorktreeNode } from "../../types";
import { isLive } from "../../types";
import { svcDotClass } from "../nextAction";
import CommandButtons from "./CommandButtons";

export default function ServiceRail({
  wt,
  onOpenService,
  onDatabase,
}: {
  wt: WorktreeNode;
  onOpenService: (s: ServiceNode) => void;
  onDatabase: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(2);
  const rail = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { setOpen(false); }, [wt.wtKey]);
  useEffect(() => {
    if (!rail.current) return;
    const observer = new ResizeObserver(([entry]) => setVisibleCount(entry.contentRect.width < 480 ? 1 : 2));
    observer.observe(rail.current);
    return () => observer.disconnect();
  }, []);
  const startService = useStore((s) => s.startService);
  const stopService = useStore((s) => s.stopService);
  const restartService = useStore((s) => s.restartService);
  const openPort = useStore((s) => s.openPort);

  const empty = wt.services.length === 0 && !wt.dbName;

  const action = (s: ServiceNode) => {
    if (s.status === "error") return { title: `Restart ${s.name}`, icon: <Restart size={11} />, run: () => restartService(s.svcKey) };
    if (s.status === "stopped") return { title: `Start ${s.name}`, icon: <Play size={10} />, run: () => startService(s.svcKey) };
    if (s.status === "running") return { title: `Stop ${s.name}`, icon: <Stop size={9} />, run: () => stopService(s.svcKey) };
    return null;
  };

  const service = (s: ServiceNode) => {
        const live = s.status === "running";
        const act = action(s);
        return (
          <div
            key={s.svcKey}
            className={
              "cxs-svc" +
              (live ? "" : " cxs-svc--off") +
              (s.status === "error" ? " cxs-svc--error" : "")
            }
          >
            <button className="svc-detail" onClick={() => onOpenService(s)} title={`${s.name} — ${s.status}`} aria-label={`${s.name} details — ${s.status}`}><span className={svcDotClass(s)} /><span className="nm">{s.name}</span></button>
            {s.port != null && (
              <button className="pt svc-port" disabled={!live} onClick={() => openPort(s.port as number)} aria-label={`Open ${s.name} on port ${s.port}`}>:{s.port}</button>
            )}
            {s.status === "starting" || s.status === "stopping" ? (
              <span className="act">
                <Spinner size={10} />
              </span>
            ) : (
              act && (
                <button
                  className="act"
                  title={act.title}
                  onClick={(e) => {
                    e.stopPropagation();
                    act.run();
                  }}
                >
                  {act.icon}<span>{act.title.split(" ")[0]}</span>
                </button>
              )
            )}
          </div>
        );
  };
  const overflow = wt.services.slice(visibleCount);
  return (
    <div className="cxs-rail">
      <div className="cxs-railscroll" ref={rail}>
        {empty && <span className="cxs-railempty">No services configured for this worktree.</span>}
        {wt.services.slice(0, visibleCount).map(service)}
        {(overflow.length > 0 || wt.dbName) && <button ref={trigger} className="cx-ib cxs-runtime-more" title="More services and database" aria-label={`More services and database${overflow.length ? ` — ${overflow.length} more services` : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}><More size={15} />{overflow.length > 0 && <span>+{overflow.length}</span>}</button>}
        {open && <AnchoredMenu anchor={trigger} align="left" width={overflow.length ? 320 : 240} role="dialog" label="Services and database" onClose={() => { setOpen(false); trigger.current?.focus(); }}>
          <div className="cxs-runtime-pop">
            {overflow.length > 0 && <div className="cx-pop__label">More services</div>}
            {overflow.map(service)}
            {wt.dbName && <button className={"cxs-runtime-db" + (overflow.length ? " has-services" : "")} onClick={() => { setOpen(false); onDatabase(); }} title={wt.dbName}><Database size={13} /><span><b>Database tools</b><small>{wt.dbName}</small></span></button>}
          </div>
        </AnchoredMenu>}
      </div>
      <CommandButtons wt={wt} />
    </div>
  );
}

export const anyLive = (wt: WorktreeNode) => wt.services.some((s) => isLive(s.status));
