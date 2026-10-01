// Typed IPC surface — invoke wrappers + event payloads, mirroring src-tauri.
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { GitMeta, LogLine, RepoNode, SubmoduleStatus, SvcStatus } from "./types";

/** Window-scoped listen: registers with THIS window as the event target, so
 * the backend can `emit_filter` high-volume events (terminal:data,
 * service:log, service:stats) to only the windows that consume them. A
 * broadcast `emit` still reaches window-scoped listeners. */
const listen = <T,>(event: string, cb: (e: { payload: T }) => void): Promise<UnlistenFn> =>
  getCurrentWebviewWindow().listen<T>(event, cb);

export interface ServiceCfg {
  id: string;
  name: string;
  kind: string;
  command: string;
  cwd: string;
  basePort: number | null;
  env: Record<string, string>;
  /** readiness probe path (e.g. /api/health). Empty = none, and the service
      counts as running the moment its process is alive. */
  health: string;
}

export interface CustomCmd {
  label: string;
  command: string;
  /** heading this command sits under in the rail's Commands menu; empty =
      ungrouped, which is where every existing command starts */
  group: string;
}

/** A coding-agent launcher available for one repository. The command is run
 * inside the selected worktree; when enabled, Canopy appends its structured
 * handoff as the command's first prompt argument. */
export interface AgentCfg {
  id: string;
  name: string;
  command: string;
  promptOnLaunch: boolean;
  /** extra literal snippets (one per line) that mean this agent is blocked on
      a human, on top of the built-in prompt shapes */
  waitingPatterns: string;
}

export interface RepoCfg {
  id: string;
  name: string;
  path: string;
  worktreeDir: string;
  resetDb: string;
  migrateDb: string;
  services: ServiceCfg[];
  customCommands: CustomCmd[];
  /** agent-lane CLI (empty = built-in default) */
  agentCommand: string;
  /** selectable coding-agent launchers; `agentCommand` remains as legacy data */
  agents: AgentCfg[];
  /** branch new worktrees are created from by default; empty = the modal's own default */
  defaultBase: string;
  worktreeDefaults: WorktreeDefaults;
  agentContext: AgentContextCfg;
  /** most agent sessions at once in this repo; 0 = no limit */
  maxParallelAgents: number;
  /** minutes an agent may sit idle before Canopy closes it; 0 = never */
  agentIdleTimeoutMin: number;
}

/** What create_worktree does after `git worktree add`, per repository. */
export interface WorktreeDefaults {
  runSetup: boolean;
  startServices: boolean;
  /** off makes ${WT_DB_NAME} resolve to the main checkout's PG_DB, so the
      worktree shares that database instead of getting one of its own */
  isolatedDatabase: boolean;
}

/** What Canopy puts in the handoff every agent receives. */
export interface AgentContextCfg {
  worktreeContext: boolean;
  runtimeFacts: boolean;
  /** opt-in: the one part that can carry arbitrary process output — including
      a value read from a .env — into a prompt sent to a third-party CLI */
  failingLogs: boolean;
}

export interface Settings {
  revision?: string;
  version: number;
  editor: { command: string };
  terminal: string;
  repos: RepoCfg[];
  showSwitchBranch: boolean;
  /** worktrees pinned to the top of the sidebar, by wtKey */
  pinnedWorktrees: string[];
  security: SecurityCfg;
  embeddedTerminal: TermCfg;
  /** opt-in experiment flags by id; unknown ids are ignored */
  experiments: Record<string, boolean>;
  notifications: NotifyCfg;
  /** keybinding overrides: action id → binding ("Mod+k"). See app/keys.ts. */
  keybindings: Record<string, string>;
  updates: { autoCheck: boolean };
  crashReports: { enabled: boolean };
}
export interface SecurityCfg {
  /** render secret-looking values as bullets in the preview and in streamed
      setup output */
  maskSecrets: boolean;
  /** export key names but not their values */
  maskInExports: boolean;
  sshKey: string;
  credentialHelper: string;
}

/** Embedded-shell configuration. Every field has an "unset" value meaning
    *keep the built-in behaviour* (empty string, or 0), so the renderer's
    defaults live in one place instead of being duplicated as magic numbers. */
export interface TermCfg {
  program: string;
  args: string;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  /** block | underline | bar; empty = block */
  cursor: string;
  cursorBlink: boolean;
  bell: boolean;
  cwdWorktree: boolean;
  inheritEnv: boolean;
}

/** An experiment this build actually ships. Nothing is listed that the app
    does not honour — a flag nothing reads is "coming soon" with extra steps. */
export interface Experiment {
  id: string;
  label: string;
  hint: string;
}

export interface Diagnostics {
  appVersion: string;
  os: string;
  arch: string;
  repos: number;
  worktrees: number;
  services: number;
  runningServices: number;
  terminalSessions: number;
  configDir: string;
  logDir: string;
  crashReports: number;
}

export interface ClearedCaches {
  serviceLogs: number;
  bytes: number;
}

/** Which backend events raise an OS notification. Every one of these also
    appears in the in-app attention queue; a notification is for when Canopy is
    in the tray and you're looking at something else. */
export interface NotifyCfg {
  serviceCrash: boolean;
  agentWaiting: boolean;
  setupDone: boolean;
  branchMoved: boolean;
  sound: boolean;
  /** count | dot | off */
  badge: string;
}

/** Result of an update check. Canopy reports what exists; it never downloads
    or installs (release signing isn't set up — see updates.rs). */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  url: string | null;
  /** why the last check produced nothing — shown verbatim */
  error: string | null;
  checkedAt: number;

}

export type ProvisionFormat = "dotenv" | "json" | "yaml" | "text";

/** One file seeded + templated into every new worktree (Files-to-provision). */
export interface ProvisionEntry {
  path: string;
  format: ProvisionFormat;
  from: string;
  interpolate: boolean;
  /** ordered [key, value-template] pairs (ignored for `text`) */
  keys: [string, string][];
}

/** The repo's `.worktreemanager.json` as exchanged with Settings. `teardown` /
 * `migrate` are edited on the Files page. */
export interface RepoConfigFile {
  provision: ProvisionEntry[];
  setup: SetupTask[];
  setupPolicy: SetupPolicy;
  teardown: string[];
  migrate: string[];
}

/** One setup task. A bare string in the config file parses to an enabled task
    in the worktree root, so existing configs are unchanged. */
export interface SetupTask {
  cmd: string;
  /** relative to the worktree root; empty = the root */
  cwd: string;
  /** a disabled task is skipped but stays in the file */
  enabled: boolean;
}

export interface SetupPolicy {
  continueOnFailure: boolean;
  /** per-task ceiling in seconds; 0 = the built-in one hour */
  timeoutSecs: number;
}

/** One resolved environment variable of a service.

    `spawn` is what Canopy puts in the child's environment; `dotenv` is what
    setup provisioned into a .env the process loads itself. Spawn wins on a
    collision, because a dotenv loader does not overwrite an already-set
    process variable. */
export interface EnvEntry {
  key: string;
  /** masked when the key looks secret, or a URL carried credentials */
  value: string;
  source: "spawn" | "dotenv";
  masked: boolean;
}

/** One service's derived port in the create preview. */
export interface PreviewPort {
  serviceId: string;
  name: string;
  port: number;
  /** branch of the worktree already holding this port, if any */
  takenBy: string | null;
}

export interface WorktreePreview {
  path: string;
  slug: string;
  /** null when the repo's provisioning never references ${WT_DB_NAME}, i.e. no
      isolated database would be created */
  dbName: string | null;
  ports: PreviewPort[];
  /** the derived path already exists, so creation would be refused */
  pathExists: boolean;
}

export interface Branches {
  local: string[];
  remote: string[];
  tags: string[];
}

/** A worktree whose folder was deleted outside Canopy (git-prunable). */
export interface PrunableWorktree {
  repoId: string;
  repoName: string;
  path: string;
  branch: string;
}

/** One vanished worktree the user chose to reconcile in the Sync-prune prompt.
    `dbName` is recovered by the frontend from its pre-Sync snapshot. */
export interface PruneItem {
  repoId: string;
  branch: string;
  deleteBranch: boolean;
  dropDb: boolean;
  dbName: string | null;
}

/** One row of `git status --porcelain`, resolved by the backend so the modal
    can group and annotate it without re-parsing. */
export interface StatusEntry {
  /** the two-character XY porcelain code (" M", "MM", "??", "UU", …) */
  code: string;
  /** path relative to the worktree root (the NEW name for a rename) */
  path: string;
  /** the pre-rename path for R/C entries */
  from?: string | null;
  /** this path is a submodule */
  sub: boolean;
  /** for a dirty submodule, how many paths changed inside it */
  subFiles?: number | null;
}

export interface RepoDetection {
  top: string;
  name: string;
  branch: string;
  origin: string;
  stack: string;
  packageManager: string;
  hasConfig: boolean;
  scripts: { name: string; command: string }[];
}

export interface McpStatus {
  allowWorktreeWrite: boolean;
  allowServiceControl: boolean;
  allowConfiguration: boolean;
  executionError: string | null;
  enabled: boolean;
  error: string | null;
  repoIds: string[];
  permissions: string[];
  endpoint: string;
  transport: string;
}
export interface McpConnection { endpoint: string; token: string }

export const ipc = {
  mcpAgentTarget: (client: string) => invoke<string>("mcp_agent_target", { client }),
  mcpConnectAgent: (client: string) => invoke<string>("mcp_connect_agent", { client }),
  mcpStatus: () => invoke<McpStatus>("mcp_status"),
  mcpConfigure: (enabled: boolean, repoIds?: string[], allowWorktreeWrite?: boolean, allowServiceControl?: boolean, allowConfiguration?: boolean) => invoke<McpStatus>("mcp_configure", { enabled, repoIds: repoIds ?? null, allowWorktreeWrite: allowWorktreeWrite ?? null, allowServiceControl: allowServiceControl ?? null, allowConfiguration: allowConfiguration ?? null }),
  mcpRotateToken: () => invoke<McpStatus>("mcp_rotate_token"),
  mcpConnection: () => invoke<McpConnection>("mcp_connection"),
  getTree: () => invoke<RepoNode[]>("get_tree"),
  refresh: (wtKey?: string) => invoke<void>("refresh", { wtKey: wtKey ?? null }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (newSettings: Settings) => invoke<Settings>("save_settings", { newSettings }),
  addRepo: (path: string) => invoke<RepoCfg>("add_repo", { path }),
  detectRepo: (path: string) => invoke<RepoDetection>("detect_repo", { path }),
  removeRepo: (repoId: string) => invoke<void>("remove_repo", { repoId }),
  gitPull: (wtKey: string) => invoke<string>("git_pull", { wtKey }),
  submoduleStatus: (wtKey: string) => invoke<SubmoduleStatus[]>("submodule_status", { wtKey }),
  pullSubmodule: (wtKey: string, path: string) => invoke<string>("pull_submodule", { wtKey, path }),
  switchSubmoduleBranch: (wtKey: string, path: string, branch: string) =>
    invoke<void>("switch_submodule_branch", { wtKey, path, branch }),
  listSubmoduleBranches: (wtKey: string, path: string) => invoke<Branches>("list_submodule_branches", { wtKey, path }),
  fetchSubmodules: (wtKey: string) => invoke<number>("fetch_submodules", { wtKey }),
  syncSubmodules: (wtKey: string) => invoke<string>("sync_submodules", { wtKey }),
  switchWorktreeBranch: (wtKey: string, branch: string, create: boolean, base?: string) =>
    invoke<void>("switch_worktree_branch", { wtKey, branch, create, base: base ?? null }),
  listBranches: (repoId: string) => invoke<Branches>("list_branches", { repoId }),
  fetchBranches: (repoId: string) => invoke<Branches>("fetch_branches", { repoId }),
  getRepoConfig: (repoId: string) => invoke<RepoConfigFile>("get_repo_config", { repoId }),
  saveRepoConfig: (repoId: string, provision: ProvisionEntry[], setup: SetupTask[], setupPolicy?: SetupPolicy, extras?: { teardown: string[]; migrate: string[] }) =>
    invoke<void>("save_repo_config", { repoId, provision, setup, setupPolicy: setupPolicy ?? null, teardown: extras?.teardown, migrate: extras?.migrate }),
  saveTextFile: (path: string, contents: string) => invoke<void>("save_text_file", { path, contents }),

  getLogs: (svcKey: string) => invoke<LogLine[]>("get_logs", { svcKey }),

  // embedded terminals (agent lane). `id` is opaque (e.g. `${wtKey}::shell`);
  // `data` on read events is base64 of the raw PTY bytes.
  terminalStoreImage: (id: string, data: number[]) => invoke<string>("terminal_store_image", { id, data }),
  terminalOpen: (id: string, cwd: string, cols: number, rows: number, command?: string) =>
    invoke<void>("terminal_open", { id, cwd, cols, rows, command: command ?? null }),
  terminalWrite: (id: string, data: string) => invoke<void>("terminal_write", { id, data }),
  terminalResize: (id: string, cols: number, rows: number) => invoke<void>("terminal_resize", { id, cols, rows }),
  terminalGetBuffer: (id: string) => invoke<TerminalSnapshot | null>("terminal_get_buffer", { id }),
  terminalClose: (id: string) => invoke<void>("terminal_close", { id }),
  /** write .canopy/context.md (creates the dir + a self-ignoring .gitignore, never clobbering it) */
  writeWorktreeContext: (wtPath: string, contents: string) =>
    invoke<void>("write_worktree_context", { wtPath, contents }),
  resolveAgentCommand: (wtKey: string) => invoke<string>("resolve_agent_command", { wtKey }),

  /** every variable the service runs with, ordered spawn-first and masked */
  serviceEnv: (svcKey: string) => invoke<EnvEntry[]>("service_env", { svcKey }),
  serviceStart: (svcKey: string) => invoke<void>("service_start", { svcKey }),
  serviceStop: (svcKey: string) => invoke<void>("service_stop", { svcKey }),
  serviceRestart: (svcKey: string) => invoke<void>("service_restart", { svcKey }),
  worktreeStartAll: (wtKey: string) => invoke<void>("worktree_start_all", { wtKey }),
  worktreeStopAll: (wtKey: string) => invoke<void>("worktree_stop_all", { wtKey }),
  resetDb: (wtKey: string) => invoke<void>("reset_db", { wtKey }),

  openInEditor: (wtKey: string) => invoke<void>("open_in_editor", { wtKey }),
  openFileInEditor: (wtKey: string, path: string) => invoke<void>("open_file_in_editor", { wtKey, path }),
  revealInFinder: (wtKey: string) => invoke<void>("reveal_in_finder", { wtKey }),
  revealRepo: (repoId: string) => invoke<void>("reveal_repo", { repoId }),
  openTerminal: (wtKey: string) => invoke<void>("open_terminal", { wtKey }),
  openPort: (port: number) => invoke<void>("open_port", { port }),
  showMainWindow: () => invoke<void>("show_main_window"),
  quitApp: () => invoke<void>("quit_app"),

  listDatabases: (wtKey: string) => invoke<string[]>("list_databases", { wtKey }),
  currentDatabase: (wtKey: string) => invoke<string | null>("current_database", { wtKey }),
  snapshotDatabase: (wtKey: string, name: string) => invoke<void>("snapshot_database", { wtKey, name }),
  exportDatabase: (wtKey: string, filePath: string) => invoke<void>("export_database", { wtKey, filePath }),
  restoreDatabase: (wtKey: string, filePath: string, options?: { target: string; mode: "replace" | "create"; activate: boolean }) => invoke<void>("restore_database", { wtKey, filePath, options: options ?? null }),
  switchDatabase: (wtKey: string, dbName: string) => invoke<void>("switch_database", { wtKey, dbName }),
  setServicePort: (svcKey: string, port: number) => invoke<void>("set_service_port", { svcKey, port }),
  runMigration: (wtKey: string) => invoke<void>("run_migration", { wtKey }),
  runCustomCommand: (wtKey: string, command: string) => invoke<void>("run_custom_command", { wtKey, command }),

  /** what creating this branch would produce — allocates nothing, shares its
      derivation with `create_worktree` */
  previewWorktree: (repoId: string, branch: string) =>
    invoke<WorktreePreview>("preview_worktree", { repoId, branch }),
  createWorktree: (args: { repoId: string; branch: string; base?: string; createBranch: boolean }) =>
    invoke<string>("create_worktree", { ...args, base: args.base ?? null }),
  /** `dryRun` reports exactly what would run — same order, same working
      directories, same skips — and executes nothing */
  runWorktreeSetup: (wtKey: string, dryRun = false) => invoke<void>("run_worktree_setup", { wtKey, dryRun }),
  worktreeDirtyReport: (wtKey: string) => invoke<{ dirty: boolean; details: string[]; total: number }>("worktree_dirty_report", { wtKey }),
  worktreeStatus: (wtKey: string) => invoke<StatusEntry[]>("worktree_status", { wtKey }),
  worktreeCommit: (wtKey: string, message: string, addUntracked: boolean) =>
    invoke<void>("worktree_commit", { wtKey, message, addUntracked }),
  worktreeStash: (wtKey: string, name: string | null, includeUntracked: boolean) =>
    invoke<string>("worktree_stash", { wtKey, name, includeUntracked }),
  worktreeDiscard: (wtKey: string, cleanUntracked: boolean) =>
    invoke<void>("worktree_discard", { wtKey, cleanUntracked }),
  removeWorktree: (wtKey: string, deleteBranch: boolean, dropDb: boolean) =>
    invoke<void>("remove_worktree", { wtKey, deleteBranch, dropDb }),
  removeWorktrees: (wtKeys: string[], deleteBranch: boolean, dropDb: boolean) =>
    invoke<void>("remove_worktrees", { wtKeys, deleteBranch, dropDb }),
  listPrunableWorktrees: () => invoke<PrunableWorktree[]>("list_prunable_worktrees"),
  pruneWorktrees: (items: PruneItem[]) => invoke<void>("prune_worktrees", { items }),

  /** every measurement held so far — instant, from cache */
  getDiskUsage: () => invoke<Record<string, DiskUsage>>("get_disk_usage"),
  /** queue worktrees for measurement; resolves immediately, results arrive as
      `worktree:disk`. Fresh figures are skipped unless `force`. */
  scanDiskUsage: (wtKeys: string[], force = false) => invoke<void>("scan_disk_usage", { wtKeys, force }),
  setWorktreePinned: (wtKey: string, pinned: boolean) => invoke<void>("set_worktree_pinned", { wtKey, pinned }),

  /** returns [structured, markdown] — the second is what goes on the clipboard */
  gatherDiagnostics: () => invoke<[Diagnostics, string]>("gather_diagnostics"),
  listExperiments: () => invoke<Experiment[]>("list_experiments"),
  openLogDir: () => invoke<void>("open_log_dir"),
  clearCaches: () => invoke<ClearedCaches>("clear_caches"),
  resetSettings: () => invoke<Settings>("reset_settings"),

  checkForUpdate: () => invoke<UpdateStatus>("check_for_update"),
  crashReportCount: () => invoke<number>("crash_report_count"),
  openCrashReports: () => invoke<void>("open_crash_reports"),

};

/** A worktree's on-disk footprint: everything under its root, `node_modules`
    and build output included — that is what removing it actually frees. */
export interface DiskUsage {
  bytes: number;
  /** unix seconds */
  scannedAt: number;
  /** the walk hit a budget and stopped early, so `bytes` is a floor */
  partial: boolean;
}

export interface GitEvent extends GitMeta {
  wtKey: string;
}
export interface StatusEvent {
  svcKey: string;
  status: SvcStatus;
  startedAt?: number;
  exitCode?: number;
}
export interface LogEvent {
  svcKey: string;
  lines: LogLine[];
}
export interface StatsEvent {
  entries: { svcKey: string; cpu: number; memMb: number; uptimeSec: number }[];
}
export interface ResetEvent {
  wtKey: string;
  state: "started" | "done" | "error";
  message?: string;
}
export interface OpEvent {
  wtKey: string;
  op: string;
  state: "progress" | "done" | "error";
  detail: string;
  /** 1-based step this event belongs to; 0 = the provisioning phase, which
      runs before the numbered commands. Only present on result events. */
  step?: number;
  /** short quantity the step produced ("1,842 packages"). Absent whenever the
      command's output matched no known pattern. */
  result?: string;
}
export interface TerminalDataEvent {
  id: string;
  /** base64 of raw PTY bytes */
  data: string;
  /** cumulative byte cursor after this chunk */
  seq: number;
}
export interface TerminalExitEvent {
  id: string;
}
/** A live agent PTY is either working or blocked on a human. "idle" is the
    absence of a running session, which the store derives from `running` — the
    backend never reports it, because nothing can observe it. */
export interface TerminalStateEvent {
  id: string;
  state: "busy" | "waiting";
}

export interface DiskEvent extends DiskUsage {
  wtKey: string;
}
/** Scrollback snapshot + the cursor it ends at (race-free rehydrate). */
export interface TerminalSnapshot {
  buffer: string;
  seq: number;
}

export const on = {
  treeChanged: (cb: (tree: RepoNode[]) => void): Promise<UnlistenFn> =>
    listen<RepoNode[]>("tree:changed", (e) => cb(e.payload)),
  worktreeGit: (cb: (e: GitEvent) => void): Promise<UnlistenFn> =>
    listen<GitEvent>("worktree:git", (e) => cb(e.payload)),
  serviceStatus: (cb: (e: StatusEvent) => void): Promise<UnlistenFn> =>
    listen<StatusEvent>("service:status", (e) => cb(e.payload)),
  serviceLog: (cb: (e: LogEvent) => void): Promise<UnlistenFn> =>
    listen<LogEvent>("service:log", (e) => cb(e.payload)),
  serviceStats: (cb: (e: StatsEvent) => void): Promise<UnlistenFn> =>
    listen<StatsEvent>("service:stats", (e) => cb(e.payload)),
  resetStatus: (cb: (e: ResetEvent) => void): Promise<UnlistenFn> =>
    listen<ResetEvent>("reset:status", (e) => cb(e.payload)),
  worktreeOp: (cb: (e: OpEvent) => void): Promise<UnlistenFn> =>
    listen<OpEvent>("worktree:op", (e) => cb(e.payload)),
  terminalData: (cb: (e: TerminalDataEvent) => void): Promise<UnlistenFn> =>
    listen<TerminalDataEvent>("terminal:data", (e) => cb(e.payload)),
  terminalExit: (cb: (e: TerminalExitEvent) => void): Promise<UnlistenFn> =>
    listen<TerminalExitEvent>("terminal:exit", (e) => cb(e.payload)),
  terminalState: (cb: (e: TerminalStateEvent) => void): Promise<UnlistenFn> =>
    listen<TerminalStateEvent>("terminal:state", (e) => cb(e.payload)),
  worktreeDisk: (cb: (e: DiskEvent) => void): Promise<UnlistenFn> =>
    listen<DiskEvent>("worktree:disk", (e) => cb(e.payload)),
};

/** Structured backend error — every command rejects with `{ code, message }`. */
export interface BackendError {
  code:
    | "git"
    | "db"
    | "setup"
    | "process"
    | "terminal"
    | "config"
    | "not_found"
    | "invalid_input"
    | "conflict"
    | "internal";
  message: string;
}

/** Human-readable message from any rejection (structured backend error, plain
 * string from a plugin, or an Error). Use instead of `String(e)`. */
export function errText(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.message === "string") return o.message;
  }
  return String(e);
}

/** The backend error code, when the rejection carries one. */
export function errCode(e: unknown): BackendError["code"] | null {
  if (e && typeof e === "object" && typeof (e as Record<string, unknown>).code === "string") {
    return (e as BackendError).code;
  }
  return null;
}

/** True when running inside the Tauri webview (false in a plain browser tab). */
export const hasBackend = () => "__TAURI_INTERNALS__" in window;
