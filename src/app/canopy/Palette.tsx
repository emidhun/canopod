/* ⌘K — whose first section is what to do NEXT, not an A–Z list of commands.

   The palette opens already knowing what you most likely came here to do: the
   selected worktree's next action, then whatever else needs a human. Those
   rows call the same runner the worktree bar's button does, so they can never
   drift apart. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType } from "react";
import { Alert, Bolt, Cube, Fork, Logs, Play, Plus, Pull, Search, Settings, Single, Sparkle, Split, Stop, Terminal, X } from "../../icons";
import { useStore } from "../../store";
import { nextAction, wtDot, dotClass, type AttnItem, type NextAction } from "../nextAction";
import type { LayoutId } from "./WorkSurface";

interface Row {
  g: string;
  nm: string;
  why?: string;
  icon?: ComponentType<{ size?: number }>;
  /** rendered instead of an icon, for worktree rows */
  dot?: string;
  mono?: boolean;
  tone?: "crash" | "urgent";
  run: () => void;
}

export default function Palette({
  selKey,
  attn,
  onClose,
  onSelect,
  onOverview,
  onAction,
  onRunFor,
  onLayout,
  onNewWorktree,
  onSettings,
  onOpenTerminal,
  onStartAgent,
}: {
  selKey: string | null;
  attn: AttnItem[];
  onClose: () => void;
  onSelect: (wtKey: string) => void;
  onOverview: () => void;
  onAction: (a: NextAction) => void;
  /** run the ranked next action for another worktree, the way the overview does */
  onRunFor: (wtKey: string) => void;
  onLayout: (l: LayoutId) => void;
  onNewWorktree: () => void;
  onSettings: () => void;
  onOpenTerminal: () => void;
  onStartAgent: () => void;
}) {
  const tree = useStore((s) => s.tree);
  const sessions = useStore((s) => s.sessions);
  const startAll = useStore((s) => s.startAll);
  const stopAll = useStore((s) => s.stopAll);
  const gitPull = useStore((s) => s.gitPull);
  const addRepo = useStore((s) => s.addRepo);
  const showToast = useStore((s) => s.showToast);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const ql = q.toLowerCase().trim();

  const flat = useMemo(() => tree.flatMap((repo) => repo.worktrees.map((wt) => ({ wt, repo }))), [tree]);
  const sel = flat.find((f) => f.wt.wtKey === selKey);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];

    // SUGGESTED first: what this state implies.
    if (!ql) {
      if (sel) {
        const na = nextAction(sel.wt, sessions[sel.wt.wtKey] ?? []);
        out.push({ g: "Suggested", icon: na.icon, nm: na.label, why: na.why, run: () => onAction(na) });
      }
      // Notices are read, not run — the palette's rows all perform something,
      // and a row that did nothing when picked would be the odd one out.
      attn
        .filter((a) => !a.noticeId)
        .slice(0, 3)
        .forEach((a) =>
          out.push({
            g: "Suggested",
            icon: a.kind === "crash" ? Alert : a.kind === "wait" ? Sparkle : Cube,
            tone: a.kind === "crash" ? "crash" : "urgent",
            // The row is labelled with an imperative ("Restart — API crashed"),
            // so it has to perform it. Selecting and leaving the crash in place
            // would make ⌘K the one surface that disagrees with the others.
            nm: `${a.act} — ${a.title}`,
            why: a.wt,
            run: () => onRunFor(a.wtKey),
          }),
        );
    }

    flat.forEach(({ wt, repo }) => {
      if (ql && !`${wt.branch} ${repo.name}`.toLowerCase().includes(ql)) return;
      out.push({ g: "Worktrees", mono: true, dot: dotClass(wtDot(wt)), nm: wt.branch, why: repo.name, run: () => onSelect(wt.wtKey) });
    });

    const acts: Row[] = [
      {
        g: "Actions",
        nm: "Start all services",
        icon: Play,
        run: () => {
          flat.forEach((f) => startAll(f.wt.wtKey));
          showToast("Starting every worktree…");
        },
      },
      {
        g: "Actions",
        nm: "Stop all services",
        icon: Stop,
        run: () => {
          flat.forEach((f) => stopAll(f.wt.wtKey));
          showToast("Stopping every worktree…");
        },
      },
      { g: "Actions", nm: "New worktree", icon: Plus, run: onNewWorktree },
      // "repository" is the word people search for when the sidebar's menu is
      // hidden — which it is until a second repo exists
      { g: "Actions", nm: "Add repository", icon: Fork, why: "⇧⌘N", run: addRepo },
      {
        g: "Actions",
        nm: "Pull all worktrees",
        icon: Pull,
        run: () => {
          flat.forEach((f) => gitPull(f.wt.wtKey));
        },
      },
      { g: "Actions", nm: "Start agent here", icon: Sparkle, run: onStartAgent },
      { g: "Actions", nm: "Open terminal here", icon: Terminal, run: onOpenTerminal },
      { g: "Actions", nm: "Layout: Logs", icon: Single, why: "⌘1", run: () => onLayout("runtime") },
      { g: "Actions", nm: "Layout: Terminal", icon: Terminal, why: "⌘2", run: () => onLayout("terminal") },
      { g: "Actions", nm: "Layout: Terminal + logs", icon: Split, why: "⌘3", run: () => onLayout("shell") },
      { g: "Actions", nm: "All worktrees", icon: Logs, why: "⌘O", run: onOverview },
      { g: "Actions", nm: "Settings", icon: Settings, run: onSettings },
    ];
    acts.forEach((a) => {
      if (!ql || a.nm.toLowerCase().includes(ql)) out.push(a);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ql, sel, attn, flat, sessions, onRunFor]);

  useEffect(() => setI(0), [ql]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setI((x) => Math.min(rows.length - 1, x + 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setI((x) => Math.max(0, x - 1));
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const r = rows[i];
        if (r) {
          r.run();
          onClose();
        }
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [rows, i, onClose]);

  // keep the highlighted row in view when arrowing past the fold
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  }, [i]);

  let lastG: string | null = null;
  return (
    <div className="cxs-pal-veil" onMouseDown={onClose}>
      <div className="cxs-pal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cxs-pal-in">
          <Search size={16} />
          <input
            autoFocus
            placeholder="Jump to a worktree, or run an action…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q && (
            <button className="cx-ib" onClick={() => setQ("")}>
              <X size={12} />
            </button>
          )}
        </div>

        <div className="cxs-pal-list" ref={listRef}>
          {rows.length === 0 && <div className="cxs-pal-empty">Nothing matches “{q}”.</div>}
          {rows.map((r, n) => {
            const head = r.g !== lastG ? (lastG = r.g) : null;
            const Icon = r.icon ?? Bolt;
            return (
              <div key={`${r.g}-${r.nm}-${n}`}>
                {head && <div className={"cxs-pal-g" + (r.g === "Suggested" ? " cxs-pal-g--sug" : "")}>{r.g}</div>}
                <button
                  className={"cxs-pal-i" + (n === i ? " is-on" : "")}
                  data-i={n}
                  onMouseEnter={() => setI(n)}
                  onClick={() => {
                    r.run();
                    onClose();
                  }}
                >
                  {r.dot ? <span className={r.dot} /> : <span className={"ic " + (r.tone ?? "")}><Icon size={14} /></span>}
                  <span className={"nm" + (r.mono ? " mono" : "")}>{r.nm}</span>
                  {r.why && <span className="why">{r.why}</span>}
                </button>
              </div>
            );
          })}
        </div>

        <div className="cxs-pal-foot">
          <span>
            <span className="cx-kbd">↑↓</span>navigate
          </span>
          <span>
            <span className="cx-kbd">⏎</span>run
          </span>
          <span>
            <span className="cx-kbd">esc</span>close
          </span>
          <span style={{ marginLeft: "auto" }}>
            {rows.length} result{rows.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </div>
  );
}
