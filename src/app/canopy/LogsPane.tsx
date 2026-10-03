/* The logs pane — one stream for the whole worktree.

   The shipped app kept a tab per service; the redesign merges them and makes
   the service a filter instead, because what you actually want to read is "what
   happened here", in order, across processes. Recovery is offered inline, right
   where the failure is visible, so you never leave the thing you're reading to
   act on it. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Check, Chevron, Restart, Search, Sliders, X } from "../../icons";
import { useStore } from "../../store";
import type { LogLevel, LogLine, ServiceNode, WorktreeNode } from "../../types";
import type { NextAction } from "../nextAction";
import { nextClass } from "../nextAction";

interface Row extends LogLine {
  svcKey: string;
  svc: string;
}

const LEVELS: [LogLevel, string, string][] = [
  ["err", "Errors", "var(--state-error)"],
  ["warn", "Warnings", "var(--state-attention)"],
  ["info", "Info", "var(--state-idle)"],
];

/** "ok" lines are informational — they ride with Info rather than earning a
    fourth filter nobody would think to turn off. */
const bucket = (lv: LogLevel): LogLevel => (lv === "ok" ? "info" : lv);

function LevelFilter({ lv, setLv }: { lv: Record<string, boolean>; setLv: (v: Record<string, boolean>) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const d = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); box.current?.querySelector<HTMLButtonElement>("button")?.focus(); } };
    document.addEventListener("mousedown", d);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", d); document.removeEventListener("keydown", key); };
  }, [open]);

  const off = LEVELS.filter(([k]) => !lv[k]).length;
  return (
    <div className="cxs-fltwrap" ref={box}>
      <button className={"cxs-fchip" + (off ? " is-on" : "")} onClick={() => setOpen((o) => !o)} title="Filter levels" aria-haspopup="dialog" aria-expanded={open}>
        <Sliders size={11} />
        Levels
        {off > 0 && <span className="badge">{LEVELS.length - off}</span>}
      </button>
      {open && (
        <div className="cxs-fltpop" role="dialog" aria-label="Log levels">
          {LEVELS.map(([k, label, colour]) => (
            <button key={k} className={"cxs-fltrow" + (lv[k] ? " is-on" : "")} aria-pressed={lv[k]} onClick={() => setLv({ ...lv, [k]: !lv[k] })}>
              <span className="bx">{lv[k] && <Check size={10} />}</span>
              <span className="d" style={{ background: colour }} />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ServiceFilter({ services, filter, onFilter }: { services: ServiceNode[]; filter: string; onFilter: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); box.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  const options = [{ key: "all", label: "All services", color: "var(--state-idle)" }, ...services.map(s => ({ key: s.svcKey, label: s.name, color: s.status === "running" ? "var(--state-running)" : s.status === "error" ? "var(--state-error)" : "var(--state-idle)" }))];
  return <div className="cxs-fltwrap" ref={box}>
    <button className="cxs-fchip cxs-service-filter" aria-label="Log source" title="Filter services" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <span>{options.find(o => o.key === filter)?.label ?? "All services"}</span><Chevron size={9} />
    </button>
    {open && <div className="cxs-fltpop" role="dialog" aria-label="Log services">
      {options.map(o => <button key={o.key} className={"cxs-fltrow" + (filter === o.key ? " is-on" : "")} aria-pressed={filter === o.key} title={o.label} onClick={() => { onFilter(o.key); setOpen(false); box.current?.querySelector<HTMLButtonElement>("button")?.focus(); }}>
        <span className="bx">{filter === o.key && <Check size={10} />}</span>
        <span className="d" style={{ background: o.color }} />
        <span className="cxs-fltlabel">{o.label}</span>
      </button>)}
    </div>}
  </div>;
}

export default function LogsPane({
  wt,
  filter,
  onFilter,
  na,
  onNext,
  onRestart,
  navigation,
  visible = true,
}: {
  navigation?: ReactNode;
  visible?: boolean;
  wt: WorktreeNode;
  filter: string;
  onFilter: (svcKey: string) => void;
  na: NextAction | null;
  onNext: () => void;
  onRestart: (s: ServiceNode) => void;
}) {
  const logs = useStore((s) => s.logs);
  const clearLogs = useStore((s) => s.clearLogs);
  const [lv, setLv] = useState<Record<string, boolean>>({ err: true, warn: true, info: true });
  const [q, setQ] = useState("");
  const [follow, setFollow] = useState(true);
  const [newLines, setNewLines] = useState(0);
  const previous = useRef<Record<string, LogLine[]>>(logs);
  const body = useRef<HTMLDivElement>(null);
  const crashed = wt.services.find((s) => s.status === "error");

  useEffect(() => { setQ(""); setFollow(true); setNewLines(0); previous.current = logs; }, [wt.wtKey]);
  useEffect(() => {
    let added = 0;
    for (const service of wt.services) {
      const current = logs[service.svcKey] ?? [];
      const prior = previous.current[service.svcKey] ?? [];
      if (current === prior || !current.length) continue;
      const last = prior[prior.length - 1];
      const index = last ? current.indexOf(last) : -1;
      added += index >= 0 ? current.length - index - 1 : current.length;
    }
    previous.current = logs;
    if (follow) setNewLines(0);
    else if (added) setNewLines(n => n + added);
  }, [logs, wt.services, follow]);

  /* Merge every service's ring buffer into one stream. The buffers are
     independently capped, so sort by timestamp to interleave them; `t` is
     HH:MM:SS, which orders correctly as a string within a session. */
  const merged = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const s of wt.services) for (const l of logs[s.svcKey] ?? []) out.push({ ...l, svcKey: s.svcKey, svc: s.name });
    return out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  }, [logs, wt.services]);

  const shown = useMemo(() => {
    const needle = q.toLowerCase();
    return merged.filter(
      (l) => (filter === "all" || l.svcKey === filter) && lv[bucket(l.lv)] !== false && (!needle || l.text.toLowerCase().includes(needle)),
    );
  }, [merged, filter, lv, q]);

  useEffect(() => {
    if (visible && follow && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [shown.length, follow, visible]);

  // A worktree with nothing to run has nothing to read — offer the next step
  // instead. Declared after every hook so hook order stays stable across
  // worktree switches.
  if (wt.services.length === 0) {
    const Icon = na?.icon;
    return (
      <> <div className="cxs-ltool">{navigation}</div><div className="cxs-empty">
        <span className="eic">{Icon && <Icon size={17} />}</span>
        <span className="et">No services yet</span>
        <span className="es">
          This worktree has no services configured, so there is nothing running and nothing to log.
        </span>
        {na && (
          <button className={nextClass(na.kind)} onClick={onNext}>
            {Icon && <Icon size={12} />}
            {na.label}
            {na.key && <span className="cx-k">{na.key}</span>}
          </button>
        )}
      </div></>
    );
  }

  return (
    <>
      <div className="cxs-ltool">
        {navigation}
        <ServiceFilter services={wt.services} filter={filter} onFilter={onFilter} />
        <LevelFilter lv={lv} setLv={setLv} />
        <div className="cxs-lsearch">
          <Search size={11} />
          <input aria-label="Search logs" placeholder="Search logs…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className={"cxs-fchip" + (follow ? " is-on" : "")} onClick={() => setFollow(!follow)} title="Follow tail" aria-pressed={follow}>
          {follow ? "Follow" : "Paused"}
        </button>
        <button
          className="cx-ib cx-ib--tool"
          title="Clear"
          onClick={() => wt.services.forEach((s) => clearLogs(s.svcKey))}
        >
          <X size={12} />
        </button>
      </div>

      {/* recovery offered right where the failure is visible */}
      {crashed && (
        <div className="cxs-fixbar">
          <span className="ic">
            <Alert size={14} />
          </span>
          <span className="tx">
            <b>{crashed.name} exited.</b> The stack trace is at the end of this log.
          </span>
          <button
            className="cx-btn cx-btn--sm cx-btn--jump"
            onClick={() => {
              onFilter(crashed.svcKey);
              setLv({ err: true, warn: false, info: false });
              setFollow(true);
              if (body.current) body.current.scrollTop = body.current.scrollHeight;
            }}
          >
            Jump to error
          </button>
          <button className="cx-btn cx-btn--sm cx-btn--fix" onClick={() => onRestart(crashed)}>
            <Restart size={11} />
            Restart
          </button>
        </div>
      )}

      {!follow && <div className="cxs-logpause" role="status"><span>Paused{newLines > 0 ? ` · ${newLines} new ${newLines === 1 ? "line" : "lines"}` : ""}</span><button className="cx-btn cx-btn--sm" onClick={() => { setNewLines(0); setFollow(true); }}>Return to latest</button></div>}
      <div className="cxs-pbody" ref={body} onScroll={e => {
        if (!visible) return;
        const node = e.currentTarget;
        const atLatest = node.scrollHeight - node.clientHeight - node.scrollTop <= 24;
        if (!atLatest && follow) setFollow(false);
        else if (atLatest && !follow) { setFollow(true); setNewLines(0); }
      }}>
        <div className="cx-logs cxs-logs">
          {shown.length === 0 ? (
            <div className="cxs-logempty">
              {merged.length === 0 ? "Nothing logged yet — start a service to see output here." : "No lines match these filters."}
            </div>
          ) : (
            shown.map((l, n) => (
              <div className={"cx-log" + (l.lv === "err" ? " cx-log--error" : l.lv === "warn" ? " cx-log--warn" : l.lv === "ok" ? " cx-log--ok" : "")} key={`${l.svcKey}-${n}-${l.t}`}>
                <span className="cx-log__t">{l.t}</span>
                <span className="cx-log__src">{l.svc}</span>
                <span className="cx-log__msg">{l.text}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
