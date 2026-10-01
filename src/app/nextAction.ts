/* The workflow engine.

   `nextAction()` answers one question: what would a developer do next in this
   worktree? Four surfaces render the same answer — the button in the worktree
   bar, the cross-worktree attention queue, ⌘K's "Suggested" section, and each
   row of the overview. Because none of them decides independently, they can
   never disagree.

   The priority order, highest first:

     A service crashed    → Restart <service>   nothing else works until it's back
     An agent is waiting  → Answer agent        a human is blocking a machine
     Setup never ran      → Run setup           the worktree isn't usable yet
     A service is starting→ (busy — wait)       acting again would double-start
     Behind origin        → Pull n commits      don't boot stale code
     Services stopped     → Start services      the normal beginning of a session
     Agent working        → (busy — watch)
     Ahead + uncommitted  → Review changes      the natural end of a session
     All healthy          → Open :port          convenience, not obligation
*/
import type { ComponentType } from "react";
import { Browser, Bolt, Cube, Doc, Play, Pull, Restart, Spinner, Sparkle } from "../icons";
import type { LaneSession, Notice } from "../store";
import type { RepoNode, ServiceNode, WorktreeNode } from "../types";
import { isLive } from "../types";

export type NextKind = "primary" | "urgent" | "crash" | "busy" | "calm";
export type NextId =
  | "restart"
  | "answer"
  | "setup"
  | "starting"
  | "pull"
  | "start"
  | "startrest"
  | "watch"
  | "review"
  | "open"
  | "agent";

export interface NextAction {
  id: NextId;
  kind: NextKind;
  icon: ComponentType<{ size?: number }>;
  /** imperative, names the specific action — never "OK" or "Continue" */
  label: string;
  /** a lowercase fragment, never repeating the button */
  why: string;
  /** shown as a key hint when the action is bound to ⏎ */
  key?: string;
  svcKey?: string;
  port?: number;
  sessionId?: string;
}

/** The CSS modifier for a NextAction kind. Recovery is constructive, so a
    crash still carries the accent — red marks the PROBLEM, never the fix. */
export function nextClass(kind: NextKind): string {
  if (kind === "urgent") return "cx-next cx-next--urgent";
  if (kind === "busy") return "cx-next cx-next--busy";
  if (kind === "calm") return "cx-next cx-next--calm";
  return "cx-next"; // primary + crash both use the accent fill
}

export type AgentState = "busy" | "waiting" | "idle";

/** What an agent session is doing.

    A stopped session is idle. A running one is whatever the backend's PTY
    detector last reported — defaulting to "busy" until the first
    `terminal:state` arrives, so a freshly launched agent is never announced as
    needing a human before it has printed anything. */
export function agentState(s: LaneSession): AgentState {
  if (!s.running) return "idle";
  return s.activity ?? "busy";
}

/** Does this worktree need provisioning before it is usable?

    True in exactly two cases, both of which a human must act on:
      - the repo declares provisioning and Canopy has no record of it running
      - the last recorded run failed, so the worktree is half-provisioned

    Deliberately false when the repo declares nothing to provision (there is
    no action to offer) and for the main checkout (it is the source the
    worktrees are seeded *from*, not a thing Canopy provisions). */
export function needsSetup(wt: WorktreeNode): boolean {
  if (wt.isMain || !wt.setupConfigured) return false;
  return wt.setup === null || !wt.setup.ok;
}

/** Why the setup action is being offered — a half-provisioned worktree is a
    materially different situation from one that was never touched. */
function setupWhy(wt: WorktreeNode): string {
  return wt.setup === null ? "never provisioned" : "the last run failed";
}

export function nextAction(wt: WorktreeNode, sessions: LaneSession[]): NextAction {
  const agents = sessions.filter((s) => s.kind === "agent");
  const crashed = wt.services.find((s) => s.status === "error");
  const waiting = agents.find((s) => agentState(s) === "waiting");
  const busy = agents.find((s) => agentState(s) === "busy");
  // `stopping` is equally in-flight: treating it as idle lets a worktree
  // advertise "everything healthy" mid-shutdown, and lets ⏎ start it again
  const starting = wt.services.find((s) => s.status === "starting" || s.status === "stopping");
  const stopped = wt.services.filter((s) => s.status === "stopped");
  const web = wt.services.find((s) => s.kind === "web" && s.status === "running" && s.port);
  const git = wt.git;

  if (crashed)
    return {
      id: "restart",
      kind: "crash",
      icon: Restart,
      label: `Restart ${crashed.name}`,
      why: crashed.port ? `port ${crashed.port} is down` : "the process exited",
      key: "⏎",
      svcKey: crashed.svcKey,
    };

  if (waiting)
    return {
      id: "answer",
      kind: "urgent",
      icon: Sparkle,
      label: "Answer agent",
      why: `${waiting.title} needs a decision`,
      key: "⏎",
      sessionId: waiting.id,
    };

  if (needsSetup(wt))
    return { id: "setup", kind: "primary", icon: Cube, label: "Run setup", why: setupWhy(wt), key: "⏎" };

  if (starting)
    return {
      id: "starting",
      kind: "busy",
      icon: Spinner,
      label: starting.status === "stopping" ? `Stopping ${starting.name}…` : `Starting ${starting.name}…`,
      why: starting.status === "stopping" ? "waiting for it to exit" : starting.port ? "waiting for the port" : "waiting for the process",
    };

  if (git && git.behind > 0)
    return {
      id: "pull",
      kind: "primary",
      icon: Pull,
      label: `Pull ${git.behind} commit${git.behind === 1 ? "" : "s"}`,
      why: "behind origin — pull first",
      key: "⏎",
    };

  if (stopped.length && stopped.length === wt.services.length)
    return {
      id: "start",
      kind: "primary",
      icon: Play,
      label: "Start services",
      why: `${wt.services.length} stopped`,
      key: "⏎",
    };

  if (stopped.length)
    return {
      id: "startrest",
      kind: "primary",
      icon: Play,
      label: `Start ${stopped[0].name}`,
      why: `${stopped.length} of ${wt.services.length} stopped`,
      key: "⏎",
      svcKey: stopped[0].svcKey,
    };

  if (busy)
    return { id: "watch", kind: "busy", icon: Spinner, label: "Agent working…", why: `${busy.title} is editing files` };

  if (git && git.dirty && git.ahead > 0)
    return {
      id: "review",
      kind: "primary",
      icon: Doc,
      label: "Review changes",
      why: `${git.ahead} ahead · uncommitted work`,
      key: "⏎",
    };

  if (web && web.port)
    return {
      id: "open",
      kind: "calm",
      icon: Browser,
      label: `Open :${web.port}`,
      why: "everything healthy",
      key: "⏎",
      port: web.port,
    };

  return { id: "agent", kind: "calm", icon: Sparkle, label: "Start agent", why: "everything healthy", key: "⏎" };
}

/* ── the attention queue ───────────────────────────────────────────
   Everything that needs a human, across every worktree, ranked. This is what
   makes "the next action" true globally and not just inside whichever
   worktree happens to be selected. */

export type AttnKind = "crash" | "wait" | "todo" | "error" | "info";

export interface AttnItem {
  id: string;
  /** sort key — lower is more urgent */
  sev: number;
  kind: AttnKind;
  wtKey: string;
  /** present-tense statement of what is true */
  title: string;
  /** the worktree's branch, shown as the item's context */
  wt: string;
  /** the imperative the row offers */
  act: string;
  svcKey?: string;
  /** set on rows that came from a Notice — the id to dismiss it by */
  noticeId?: string;
  /** the copyable error text / log tail a failed background op carries */
  detail?: string;
}

export function attentionItems(
  tree: RepoNode[],
  sessions: Record<string, LaneSession[]>,
  notices: Notice[] = [],
): AttnItem[] {
  const out: AttnItem[] = [];
  /* A backgrounded op that FAILED ranks with a crash — it is the same kind of
     news (something you asked for is not running) and it has nowhere else to
     be seen. A completion is the opposite: it ranks last, below every real
     demand, because it asks nothing of you. */
  for (const n of notices)
    out.push({
      id: n.id,
      sev: n.kind === "error" ? 0 : 9,
      kind: n.kind === "error" ? "error" : "info",
      wtKey: n.wtKey,
      title: n.title,
      wt: n.wt,
      act: n.kind === "error" ? "View" : "Dismiss",
      noticeId: n.id,
      detail: n.detail,
    });
  for (const repo of tree) {
    for (const wt of repo.worktrees) {
      for (const s of wt.services) {
        if (s.status !== "error") continue;
        out.push({
          id: `${wt.wtKey}::${s.svcKey}`,
          sev: 0,
          kind: "crash",
          wtKey: wt.wtKey,
          title: `${s.name} crashed`,
          wt: wt.branch,
          act: "Restart",
          svcKey: s.svcKey,
        });
      }
      for (const s of sessions[wt.wtKey] ?? []) {
        if (s.kind !== "agent" || agentState(s) !== "waiting") continue;
        out.push({
          id: `${wt.wtKey}::${s.id}`,
          sev: 1,
          kind: "wait",
          wtKey: wt.wtKey,
          title: "Agent waiting for a decision",
          wt: wt.branch,
          act: "Answer",
        });
      }
      if (needsSetup(wt))
        out.push({
          id: `${wt.wtKey}::setup`,
          sev: 2,
          kind: "todo",
          wtKey: wt.wtKey,
          title: wt.setup === null ? "Setup never run" : "Setup failed",
          wt: wt.branch,
          act: "Run setup",
        });
    }
  }
  return out.sort((a, b) => a.sev - b.sev);
}

/* ── shared derivations ── */

/** Sidebar / overview status dot. Error outranks everything; a worktree with
    no services reads as idle, not as healthy. */
export function wtDot(wt: WorktreeNode): "run" | "part" | "err" | "off" {
  const ss = wt.services.map((s) => s.status);
  if (ss.includes("error")) return "err";
  if (!ss.length) return "off";
  if (ss.every((s) => s === "running")) return "run";
  if (ss.some(isLive)) return "part";
  return "off";
}

export const dotClass = (d: ReturnType<typeof wtDot>): string =>
  d === "run"
    ? "cx-dot cx-dot--running"
    : d === "part"
      ? "cx-dot cx-dot--partial"
      : d === "err"
        ? "cx-dot cx-dot--error"
        : "cx-dot";

export const svcDotClass = (s: ServiceNode): string =>
  s.status === "running"
    ? "cx-dot cx-dot--running"
    : s.status === "starting"
      ? "cx-dot cx-dot--starting"
      : s.status === "error"
        ? "cx-dot cx-dot--error"
        : "cx-dot";

export { Bolt };
