// Pure helpers behind the Settings editors — the client-side provision model,
// the .worktreemanager.json builder, env <-> text conversion, the JSON preview
// highlighter, and the row cleaning the save step applies.
//
// These live apart from the page components so they can be tested directly and
// shared: SettingsView's save path and the Files/Setup pages both reach for
// them. Nothing here touches React, Tauri or the DOM.
import type { AgentContextCfg, AgentCfg, NotifyCfg, TermCfg, ProvisionEntry, ProvisionFormat, RepoCfg, SecurityCfg, ServiceCfg, SetupPolicy, SetupTask, WorktreeDefaults } from "../../ipc";

/* ── client-side provision model (stable ids for React keys) ──
   The counter resets on every page load, and service ids generated here are
   PERSISTED — so a bare `svc-1` would collide with a `svc-1` already in
   settings.json the next time the app starts. A per-session token makes that
   impossible without needing to know what is already taken. */
const SESSION = Math.random().toString(36).slice(2, 8);
let _uid = 0;
export const uid = (p: string) => `${p}-${SESSION}-${++_uid}`;

export type KeyRow = { id: string; k: string; v: string };
export type FileCardT = {
  id: string;
  path: string;
  format: ProvisionFormat;
  from: string;
  interpolate: boolean;
  keys: KeyRow[];
};

export function toCards(entries: ProvisionEntry[]): FileCardT[] {
  return entries.map((e) => ({
    id: uid("f"), path: e.path, format: e.format, from: e.from || "", interpolate: !!e.interpolate,
    keys: (e.keys || []).map(([k, v]) => ({ id: uid("k"), k, v })),
  }));
}

export function fromCards(cards: FileCardT[]): ProvisionEntry[] {
  return cards.filter((c) => c.path.trim()).map((c) => ({
    path: c.path.trim(), format: c.format, from: c.from.trim(),
    interpolate: c.format === "text" ? c.interpolate : false,
    keys: c.format === "text" ? [] : (c.keys.filter((k) => k.k.trim()).map((k) => [k.k, k.v]) as [string, string][]),
  }));
}

export const DEFAULT_POLICY: SetupPolicy = { continueOnFailure: false, timeoutSecs: 0 };

export const DEFAULT_WT_DEFAULTS: WorktreeDefaults = { runSetup: true, startServices: false, isolatedDatabase: true };

/* failingLogs is opt-in: it is the only part of the handoff that can carry
   arbitrary process output — a stack trace, a printed connection string, a
   value read from a .env — into a prompt handed to a third-party CLI. */
export const DEFAULT_AGENT_CONTEXT: AgentContextCfg = { worktreeContext: true, runtimeFacts: true, failingLogs: false };

/* Unset means "keep the built-in behaviour" for every field, so the renderer's
   real defaults stay in TerminalPane rather than being duplicated here. */
export const DEFAULT_TERM: TermCfg = {
  program: "", args: "", fontFamily: "", fontSize: 0, scrollback: 0,
  cursor: "block", cursorBlink: true, bell: false, cwdWorktree: true, inheritEnv: true,
};

/* Defaults follow one rule: notify when a human is BLOCKING something, never
   for progress you asked for and can watch. */
export const DEFAULT_NOTIFY: NotifyCfg = {
  serviceCrash: true, agentWaiting: true, setupDone: false, branchMoved: false, sound: false, badge: "count",
};

export const DEFAULT_SECURITY: SecurityCfg = { maskSecrets: true, maskInExports: false, sshKey: "", credentialHelper: "" };

/* Key fragments that mean "this value is a credential". Matched
   case-insensitively as substrings, so GITHUB_TOKEN, jwtSecret and DB_PASSWORD
   all hit. Kept in step with the same list in services.rs. */
const SECRET_HINTS = ["secret", "token", "password", "passwd", "apikey", "api_key", "private", "credential", "signing"];

export const looksSecret = (key: string) => {
  const k = key.toLowerCase();
  return SECRET_HINTS.some((h) => k.includes(h));
};

/** A provisioned value as it should be SHOWN. Template references like
    `${WT_DB_NAME}` are never masked — they are the mechanism, not a secret,
    and hiding them would make the preview useless for checking a template. */
export const maskValue = (key: string, value: string) =>
  looksSecret(key) && value.trim() && !value.includes("${") ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : value;

/** Serialize a setup task the way the backend does: a plain task stays a bare
    string, so turning one option on for one task doesn't rewrite every line. */
export const taskJson = (t: SetupTask): unknown =>
  t.cwd.trim() === "" && t.enabled
    ? t.cmd
    : { cmd: t.cmd, ...(t.cwd.trim() ? { cwd: t.cwd.trim() } : {}), ...(t.enabled ? {} : { enabled: false }) };

/** Normalise an imported config's setup array, which may use either shape. */
export function parseSetup(raw: unknown): SetupTask[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x: unknown): SetupTask[] =>
    typeof x === "string"
      ? [{ cmd: x, cwd: "", enabled: true }]
      : x && typeof x === "object" && typeof (x as { cmd?: unknown }).cmd === "string"
        ? [{
            cmd: String((x as { cmd: string }).cmd),
            cwd: String((x as { cwd?: string }).cwd ?? ""),
            enabled: (x as { enabled?: boolean }).enabled !== false,
          }]
        : [],
  );
}

export function buildConfig(cards: FileCardT[], setup: SetupTask[], teardown: string[], migrate: string[], policy?: SetupPolicy, mask = false) {
  const cfg: Record<string, unknown> = {
    $schema: "canopy://worktree-manager/v1",
    provision: cards.filter((c) => c.path.trim()).map((c) => {
      const o: Record<string, unknown> = { path: c.path.trim(), format: c.format };
      if (c.from.trim()) o.from = c.from.trim();
      if (c.format === "text") o.interpolate = c.interpolate;
      else { o.mode = "upsert"; o.keys = Object.fromEntries(c.keys.filter((k) => k.k.trim()).map((k) => [k.k, mask ? maskValue(k.k, k.v) : k.v])); }
      return o;
    }),
    setup: setup.filter((t) => t.cmd.trim()).map(taskJson),
  };
  if (policy && (policy.continueOnFailure || policy.timeoutSecs > 0)) {
    cfg.setupPolicy = {
      onFailure: policy.continueOnFailure ? "continue" : "stop",
      ...(policy.timeoutSecs > 0 ? { timeoutSecs: policy.timeoutSecs } : {}),
    };
  }
  if (teardown.length) cfg.teardown = teardown;
  if (migrate.length) cfg.migrate = migrate;
  return cfg;
}

/* ── empty rows ── */
let agentSeq = 0;
export const emptyAgent = (): AgentCfg => ({
  id: `agent-${Date.now().toString(36)}-${agentSeq++}`, name: "", command: "", promptOnLaunch: true, waitingPatterns: "",
});
export const emptyService = (): ServiceCfg => ({
  id: uid("svc"), name: "", kind: "worker", command: "", cwd: "", basePort: null, env: {}, health: "",
});

/* A repo saved before the agent list existed carries a single `agentCommand`;
   surface it as one row so the editor has something to show. */
export function migrateAgents(r: RepoCfg): RepoCfg {
  if (r.agents?.length || !r.agentCommand?.trim()) return { ...r, agents: r.agents ?? [] };
  return { ...r, agents: [{ ...emptyAgent(), name: "Agent", command: r.agentCommand.trim() }] };
}

/* ── env text <-> map ── */
export const envToStr = (env: Record<string, string>) =>
  Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join("\n");

export const strToEnv = (s: string): Record<string, string> =>
  Object.fromEntries(s.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf("=");
    return i < 0 ? [l, ""] : [l.slice(0, i), l.slice(i + 1)];
  }));

/* ── JSON preview highlight — escape first, then wrap tokens (values are
      escaped so this is safe to inject) ── */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function hlLine(line: string): string {
  let s = esc(line);
  s = s.replace(/"([^"]*)"(\s*:)/g, '<span class="jk">"$1"</span>$2');
  s = s.replace(/:\s*"([^"]*)"/g, (_m, v: string) => `: <span class="jv">"${v}"</span>`);
  s = s.replace(/:\s*(-?\d+(?:\.\d+)?)/g, ': <span class="jn">$1</span>');
  return s;
}

/* ── save-time row cleaning ──
   A half-filled service / command / agent row cannot be persisted, so it is
   dropped. The counts come back with it: dropping rows silently reads as data
   loss, so the caller has to be able to say what went missing (#43). */
export type DroppedRows = { services: number; customCommands: number; agents: number };

export function cleanRepo(r: RepoCfg): { repo: RepoCfg; dropped: DroppedRows } {
  // Ids are guaranteed present by ensureIds() at load, so nothing is dropped
  // for lacking one — only rows that carry no command (or no name, for an
  // agent) are unsaveable.
  const services = r.services.filter((s) => s.command.trim());
  const customCommands = (r.customCommands || []).filter((c) => c.label.trim() && c.command.trim());
  const agents = (r.agents || []).filter((a) => a.name.trim() && a.command.trim());
  return {
    repo: { ...r, services, customCommands, agents, agentCommand: agents[0]?.command ?? "" },
    dropped: {
      services: r.services.length - services.length,
      customCommands: (r.customCommands || []).length - customCommands.length,
      agents: (r.agents || []).length - agents.length,
    },
  };
}

/* A service or agent id is generated, never typed, and it is the key the rest
   of the app addresses the thing by — services are `{wt_path}::{service_id}`.
   A row that reaches us without one (a hand-edited settings.json, a partial
   write) gets a fresh id ONCE, here at load, rather than at save: minting it
   during save would hand out a new id on every save and orphan everything
   keyed by the old one — port overrides, persisted pgids, log files. */
export function ensureIds(r: RepoCfg): RepoCfg {
  return {
    ...r,
    services: r.services.map((s) => (s.id?.trim() ? s : { ...s, id: uid("svc") })),
    agents: (r.agents || []).map((a) => (a.id?.trim() ? a : { ...a, id: emptyAgent().id })),
  };
}

/** Everything a repo needs on the way in from disk, in one call. */
export const normalizeRepo = (r: RepoCfg): RepoCfg => ensureIds(migrateAgents(r));
