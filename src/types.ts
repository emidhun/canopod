export type SvcStatus = "stopped" | "starting" | "running" | "stopping" | "error";
export type SvcKind = "web" | "server" | "worker";

export interface ServiceNode {
  svcKey: string;
  serviceId: string;
  name: string;
  kind: SvcKind;
  /** the port actually used — an override if set, else the derived one */
  port: number | null;
  /** base port + index × 10, ignoring any override. Lets the detail modal say
      whether the current value is derived or overridden, and gives Esc
      something meaningful to revert to. */
  derivedPort: number | null;
  status: SvcStatus;
}

export interface GitMeta {
  ahead: number;
  behind: number;
  dirty: boolean;
  lastCommitTs: number;
  lastCommitMsg: string;
}

/** How Canopy knows a worktree was provisioned. `marker` is the durable
    `.canopy/setup.json` record; `inferred` means there was no marker but every
    declared provisioned file is present — the back-compat path for worktrees
    created before the marker existed. */
export type SetupSource = "marker" | "inferred";

export interface SetupState {
  /** unix seconds of the recorded run; null when inferred */
  ranAt: number | null;
  /** did that run succeed */
  ok: boolean;
  source: SetupSource;
}

export interface WorktreeNode {
  wtKey: string;
  branch: string;
  path: string;
  isMain: boolean;
  git: GitMeta | null;
  dbName: string | null;
  /** provisioning record; null = never provisioned as far as Canopy can tell */
  setup: SetupState | null;
  /** does the owning repo declare anything to provision or run? */
  setupConfigured: boolean;
  /** pinned to the top of the sidebar (persisted in Settings, denormalized
      here so every window gets it from the tree it already subscribes to) */
  pinned: boolean;
  services: ServiceNode[];
}

export interface RepoNode {
  repoId: string;
  name: string;
  path: string;
  worktrees: WorktreeNode[];
}

export interface SubmoduleStatus {
  name: string;
  path: string; // relative to worktree root
  branch: string | null; // null when detached
  sha: string; // short HEAD sha
  dirty: boolean;
  ahead: boolean; // moved ahead of the pinned commit
  status: "clean" | "attention" | "detached";
}

export type LogLevel = "info" | "ok" | "warn" | "err";

export interface LogLine {
  t: string;
  lv: LogLevel;
  text: string;
}

export interface SvcStats {
  cpu: number;
  memMb: number;
  uptimeSec: number;
}

export const isLive = (s: SvcStatus) => s === "running" || s === "starting";

export function aggStatus(wt: WorktreeNode): SvcStatus {
  const ss = wt.services.map((s) => s.status);
  if (ss.some((s) => s === "starting")) return "starting";
  if (ss.some((s) => s === "stopping")) return "stopping";
  if (ss.some((s) => s === "error")) return "error";
  if (ss.some((s) => s === "running")) return "running";
  return "stopped";
}

/* sidebar dot: green = all running, amber = partial, faint = stopped */
export function sidebarDot(wt: WorktreeNode): "run" | "part" | "off" {
  const ss = wt.services.map((s) => s.status);
  if (ss.length && ss.every((s) => s === "running")) return "run";
  if (ss.some((s) => isLive(s))) return "part";
  return "off";
}

export function fmtUptime(sec: number | undefined): string {
  if (sec == null || sec < 0) return "—";
  if (sec < 60) return `${Math.floor(sec)}s`;
  const m = Math.floor(sec / 60);
  const r = Math.floor(sec % 60);
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtRelTime(ts: number): string {
  const diff = Math.max(0, Date.now() / 1000 - ts);
  if (diff < 60) return "just now";
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
