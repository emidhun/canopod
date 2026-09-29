// Tests for the pure helpers that back the Settings editors.
//
// Most of these started as characterization tests taken off the pre-split
// SettingsView.tsx and still pin that behaviour exactly. The cleanRepo cases
// are the exception: id backfilling is a deliberate change (#43 review), so
// those assert the new contract, not the old one.
import { describe, expect, it } from "vitest";
import type { ProvisionEntry, RepoCfg, SetupTask } from "../../ipc";
import {
  buildConfig,
  cleanRepo,
  ensureIds,
  envToStr,
  fromCards,
  hlLine,
  migrateAgents,
  strToEnv,
  looksSecret,
  maskValue,
  parseSetup,
  taskJson,
  DEFAULT_POLICY,
  toCards,
  uid,
  type FileCardT,
} from "./provision";

const card = (over: Partial<FileCardT> = {}): FileCardT => ({
  id: "f-1", path: ".env", format: "dotenv", from: "", interpolate: false, keys: [], ...over,
});

const task = (cmd: string, over: Partial<SetupTask> = {}): SetupTask => ({ cmd, cwd: "", enabled: true, ...over });

describe("toCards / fromCards", () => {
  it("round-trips a dotenv entry's path, format, from and keys", () => {
    const entries: ProvisionEntry[] = [
      { path: ".env", format: "dotenv", from: ".env.example", interpolate: false, keys: [["PG_DB", "${INT_DB_NAME}"]] },
    ];
    const out = fromCards(toCards(entries));
    expect(out).toEqual([
      { path: ".env", format: "dotenv", from: ".env.example", interpolate: false, keys: [["PG_DB", "${INT_DB_NAME}"]] },
    ]);
  });

  it("gives every card and key a distinct id so React keys stay stable", () => {
    const cards = toCards([
      { path: "a", format: "dotenv", from: "", interpolate: false, keys: [["K", "1"], ["J", "2"]] },
      { path: "b", format: "dotenv", from: "", interpolate: false, keys: [["K", "1"]] },
    ]);
    const ids = [...cards.map((c) => c.id), ...cards.flatMap((c) => c.keys.map((k) => k.id))];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("tolerates an entry with no keys array", () => {
    const cards = toCards([{ path: "x", format: "text" } as unknown as ProvisionEntry]);
    expect(cards[0].keys).toEqual([]);
    expect(cards[0].from).toBe("");
  });

  it("drops cards with a blank path", () => {
    expect(fromCards([card({ path: "   " })])).toEqual([]);
  });

  it("trims path and from", () => {
    expect(fromCards([card({ path: "  .env  ", from: "  src.env  " })])).toEqual([
      { path: ".env", format: "dotenv", from: "src.env", interpolate: false, keys: [] },
    ]);
  });

  it("drops keys whose name is blank", () => {
    const out = fromCards([card({ keys: [{ id: "k1", k: "A", v: "1" }, { id: "k2", k: "   ", v: "2" }] })]);
    expect(out[0].keys).toEqual([["A", "1"]]);
  });

  it("a text card carries interpolate and never carries keys", () => {
    const out = fromCards([card({ format: "text", interpolate: true, keys: [{ id: "k1", k: "A", v: "1" }] })]);
    expect(out[0]).toMatchObject({ format: "text", interpolate: true, keys: [] });
  });

  it("a non-text card never carries interpolate", () => {
    const out = fromCards([card({ format: "json", interpolate: true })]);
    expect(out[0].interpolate).toBe(false);
  });
});

describe("buildConfig", () => {
  it("stamps the schema url and filters blank setup tasks", () => {
    const cfg = buildConfig([], [task("npm ci"), task("   "), task("npm run build")], [], []);
    expect(cfg.$schema).toBe("canopy://worktree-manager/v1");
    expect(cfg.setup).toEqual(["npm ci", "npm run build"]);
  });

  it("omits teardown and migrate when they are empty", () => {
    const cfg = buildConfig([], [], [], []);
    expect(cfg).not.toHaveProperty("teardown");
    expect(cfg).not.toHaveProperty("migrate");
  });

  it("includes teardown and migrate when present", () => {
    const cfg = buildConfig([], [], ["npm run db:drop"], ["npm run db:migrate"]);
    expect(cfg.teardown).toEqual(["npm run db:drop"]);
    expect(cfg.migrate).toEqual(["npm run db:migrate"]);
  });

  it("writes mode:upsert and a keys object for a dotenv entry", () => {
    const cfg = buildConfig([card({ keys: [{ id: "k", k: "PORT", v: "3000" }] })], [], [], []);
    expect((cfg.provision as unknown[])[0]).toEqual({
      path: ".env", format: "dotenv", mode: "upsert", keys: { PORT: "3000" },
    });
  });

  it("writes interpolate instead of keys for a text entry, and omits a blank from", () => {
    const cfg = buildConfig([card({ path: "cfg.toml", format: "text", interpolate: true })], [], [], []);
    expect((cfg.provision as unknown[])[0]).toEqual({ path: "cfg.toml", format: "text", interpolate: true });
  });
});

describe("envToStr / strToEnv", () => {
  it("round-trips KEY=VALUE pairs", () => {
    expect(strToEnv(envToStr({ A: "1", B: "two" }))).toEqual({ A: "1", B: "two" });
  });

  it("treats a bare line as a key with an empty value", () => {
    expect(strToEnv("LONE")).toEqual({ LONE: "" });
  });

  it("keeps '=' inside the value", () => {
    expect(strToEnv("URL=postgres://x?a=b")).toEqual({ URL: "postgres://x?a=b" });
  });

  it("ignores blank lines, and trims the whole line before splitting on '='", () => {
    expect(strToEnv("  A=1  \n\n\n  B=2 ")).toEqual({ A: "1", B: "2" });
  });

  it("renders an undefined env as an empty string", () => {
    expect(envToStr(undefined as unknown as Record<string, string>)).toBe("");
  });
});

describe("migrateAgents", () => {
  const base = { id: "r", name: "R", path: "/r", worktreeDir: ".worktrees", resetDb: "", migrateDb: "", services: [], customCommands: [] };

  it("promotes a legacy agentCommand into a single agent row", () => {
    const out = migrateAgents({ ...base, agentCommand: "claude", agents: [] } as unknown as RepoCfg);
    expect(out.agents).toHaveLength(1);
    expect(out.agents[0]).toMatchObject({ name: "Agent", command: "claude", promptOnLaunch: true, waitingPatterns: "" });
  });

  it("leaves an existing agent list alone", () => {
    const agents = [{ id: "a", name: "Claude", command: "claude", promptOnLaunch: false, waitingPatterns: "" }];
    const out = migrateAgents({ ...base, agentCommand: "codex", agents } as unknown as RepoCfg);
    expect(out.agents).toEqual(agents);
  });

  it("normalises a missing agents array to empty", () => {
    const out = migrateAgents({ ...base, agentCommand: "  " } as unknown as RepoCfg);
    expect(out.agents).toEqual([]);
  });
});

describe("hlLine", () => {
  it("escapes markup before wrapping tokens", () => {
    expect(hlLine('"k": "<script>"')).not.toContain("<script>");
    expect(hlLine('"k": "<script>"')).toContain("&lt;script&gt;");
  });

  it("wraps keys, string values and numbers in their own spans", () => {
    const out = hlLine('"port": 3000');
    expect(out).toContain('<span class="jk">"port"</span>');
    expect(out).toContain('<span class="jn">3000</span>');
    expect(hlLine('"name": "canopy"')).toContain('<span class="jv">"canopy"</span>');
  });
});

describe("cleanRepo", () => {
  const repo = (over: Partial<RepoCfg>): RepoCfg => ({
    id: "r", name: "R", path: "/r", worktreeDir: ".worktrees", resetDb: "", migrateDb: "",
    services: [], customCommands: [], agentCommand: "", agents: [], ...over,
  } as RepoCfg);

  it("drops only services with no command — an id is never a reason to lose a row", () => {
    const { repo: out } = cleanRepo(ensureIds(repo({ services: [
      { id: "ok", name: "Web", kind: "web", command: "npm start", cwd: "", basePort: null, env: {}, health: "" },
      { id: "", name: "Half", kind: "web", command: "npm start", cwd: "", basePort: null, env: {}, health: "" },
      { id: "nocmd", name: "Half", kind: "web", command: "  ", cwd: "", basePort: null, env: {}, health: "" },
    ] })));
    expect(out.services).toHaveLength(2);
    expect(out.services[0].id).toBe("ok");
    expect(out.services.map((s) => s.name)).toEqual(["Web", "Half"]);
  });

  it("drops custom commands missing a label or a command", () => {
    const { repo: out } = cleanRepo(repo({ customCommands: [
      { label: "Lint", command: "npm run lint", group: "" },
      { label: "", command: "npm test", group: "" },
    ] }));
    expect(out.customCommands.map((c) => c.label)).toEqual(["Lint"]);
  });

  it("drops agents missing a name or command", () => {
    const { repo: out } = cleanRepo(repo({ agents: [
      { id: "a1", name: "Claude", command: "claude", promptOnLaunch: true, waitingPatterns: "" },
      { id: "a2", name: "Nameless", command: "", promptOnLaunch: true, waitingPatterns: "" },
    ] }));
    expect(out.agents.map((a) => a.id)).toEqual(["a1"]);
  });

  it("mirrors the surviving first agent's command into the legacy agentCommand", () => {
    const { repo: out } = cleanRepo(repo({
      agentCommand: "stale",
      agents: [{ id: "a1", name: "Claude", command: "claude", promptOnLaunch: true, waitingPatterns: "" }],
    }));
    expect(out.agentCommand).toBe("claude");
  });

  it("empties agentCommand when no agent survives", () => {
    const { repo: out } = cleanRepo(repo({ agentCommand: "stale", agents: [] }));
    expect(out.agentCommand).toBe("");
  });

  it("reports what it dropped, so the caller can tell the user (#43)", () => {
    const { dropped } = cleanRepo(repo({
      services: [{ id: "s1", name: "Half", kind: "web", command: "", cwd: "", basePort: null, env: {}, health: "" }],
      customCommands: [{ label: "", command: "npm test", group: "" }],
      agents: [{ id: "a", name: "Named", command: "", promptOnLaunch: true, waitingPatterns: "" }],
    }));
    // the id-less service keeps its row (backfilled); only the truly
    // unsaveable rows count as dropped
    expect(dropped).toEqual({ services: 1, customCommands: 1, agents: 1 });
  });

  it("reports nothing dropped when every row is complete", () => {
    const { dropped } = cleanRepo(repo({
      services: [{ id: "web", name: "Web", kind: "web", command: "npm start", cwd: "", basePort: null, env: {}, health: "" }],
    }));
    expect(dropped).toEqual({ services: 0, customCommands: 0, agents: 0 });
  });
});

describe("ensureIds", () => {
  const repo = (over: Partial<RepoCfg>): RepoCfg => ({
    id: "r", name: "R", path: "/r", worktreeDir: ".worktrees", resetDb: "", migrateDb: "",
    services: [], customCommands: [], agentCommand: "", agents: [], ...over,
  } as RepoCfg);

  it("leaves existing ids alone", () => {
    const out = ensureIds(repo({
      services: [{ id: "fe", name: "Web", kind: "web", command: "x", cwd: "", basePort: null, env: {}, health: "" }],
      agents: [{ id: "a1", name: "Claude", command: "claude", promptOnLaunch: true, waitingPatterns: "" }],
    }));
    expect(out.services[0].id).toBe("fe");
    expect(out.agents[0].id).toBe("a1");
  });

  it("gives a blank id a fresh one rather than dropping the row", () => {
    const out = ensureIds(repo({
      services: [{ id: "", name: "Web", kind: "web", command: "x", cwd: "", basePort: null, env: {}, health: "" }],
      agents: [{ id: "  ", name: "Claude", command: "claude", promptOnLaunch: true, waitingPatterns: "" }],
    }));
    expect(out.services[0].id).toBeTruthy();
    expect(out.agents[0].id).toBeTruthy();
  });

  // service identity is `{wt_path}::{service_id}` — two services sharing an id
  // collapse onto one key, and log routing, port overrides and start/stop all
  // target the wrong process
  it("never mints an id that another row already holds", () => {
    const out = ensureIds(repo({ services: [
      { id: "svc-1", name: "A", kind: "web", command: "x", cwd: "", basePort: null, env: {}, health: "" },
      { id: "", name: "B", kind: "web", command: "x", cwd: "", basePort: null, env: {}, health: "" },
      { id: "", name: "C", kind: "web", command: "x", cwd: "", basePort: null, env: {}, health: "" },
    ] }));
    const ids = out.services.map((s) => s.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("svc-1");
  });

  it("is idempotent — a second pass changes nothing", () => {
    const once = ensureIds(repo({
      services: [{ id: "", name: "Web", kind: "web", command: "x", cwd: "", basePort: null, env: {}, health: "" }],
    }));
    expect(ensureIds(once)).toEqual(once);
  });
});

describe("uid", () => {
  // ids generated here are PERSISTED, and the counter resets on every page
  // load — without a per-session token, a fresh `svc-1` would collide with a
  // `svc-1` already in settings.json
  it("does not repeat the bare counter shape across sessions", () => {
    expect(uid("svc")).not.toMatch(/^svc-\d+$/);
  });

  it("never repeats within a session", () => {
    const ids = Array.from({ length: 50 }, () => uid("svc"));
    expect(new Set(ids).size).toBe(50);
  });
});

// #87 / PR #116 — setup entries are "a bare string OR an object". The whole
// design rests on a plain task surviving a round-trip as a bare string: without
// that, setting one option on one task rewrites every line of a file that lives
// in the user's repo and goes through code review.
describe("setup tasks", () => {
  it("writes a plain task back as a bare string", () => {
    expect(taskJson(task("npm ci"))).toBe("npm ci");
  });

  it("writes an object only once a task carries a cwd or is disabled", () => {
    expect(taskJson(task("npm run db:migrate", { cwd: "server" })))
      .toEqual({ cmd: "npm run db:migrate", cwd: "server" });
    expect(taskJson(task("npm run build:plugins", { enabled: false })))
      .toEqual({ cmd: "npm run build:plugins", enabled: false });
    expect(taskJson(task("x", { cwd: "server", enabled: false })))
      .toEqual({ cmd: "x", cwd: "server", enabled: false });
  });

  it("round-trips a legacy all-strings config untouched", () => {
    const legacy = ["pnpm install", "pnpm db:migrate"];
    const cfg = buildConfig([], parseSetup(legacy), [], []);
    expect(cfg.setup).toEqual(legacy);
  });

  it("parses either shape on the way in", () => {
    expect(parseSetup(["a", { cmd: "b", cwd: "server" }, { cmd: "c", enabled: false }])).toEqual([
      { cmd: "a", cwd: "", enabled: true },
      { cmd: "b", cwd: "server", enabled: true },
      { cmd: "c", cwd: "", enabled: false },
    ]);
  });

  // an entry that is neither shape would otherwise coerce to an empty command
  // and run `sh -c ""`, which passes and hides the broken config
  it("skips an entry that is neither a string nor an object with cmd", () => {
    expect(parseSetup(["ok", { cwd: "server" }, 42, null, {}])).toEqual([{ cmd: "ok", cwd: "", enabled: true }]);
  });

  it("returns nothing for a non-array", () => {
    expect(parseSetup(undefined)).toEqual([]);
    expect(parseSetup("pnpm install")).toEqual([]);
  });

  it("omits setupPolicy while it matches the built-in behaviour", () => {
    expect(buildConfig([], [], [], [], DEFAULT_POLICY)).not.toHaveProperty("setupPolicy");
    expect(buildConfig([], [], [], [])).not.toHaveProperty("setupPolicy");
  });

  it("writes setupPolicy once it differs", () => {
    expect(buildConfig([], [], [], [], { continueOnFailure: true, timeoutSecs: 0 }).setupPolicy)
      .toEqual({ onFailure: "continue" });
    expect(buildConfig([], [], [], [], { continueOnFailure: false, timeoutSecs: 600 }).setupPolicy)
      .toEqual({ onFailure: "stop", timeoutSecs: 600 });
  });
});

// #82 — masking decides what LEAVES the app. It never changes what is saved,
// because a masked config written back to disk would provision the literal
// bullets into every worktree.
describe("secret masking", () => {
  it("recognises the shapes a credential key takes", () => {
    for (const k of ["GITHUB_TOKEN", "jwtSecret", "DB_PASSWORD", "db_passwd", "API_KEY", "apiKey", "PRIVATE_KEY", "CREDENTIAL_JSON", "SIGNING_KEY"]) {
      expect(looksSecret(k)).toBe(true);
    }
  });

  it("leaves ordinary keys alone", () => {
    for (const k of ["PORT", "NODE_ENV", "PG_DB", "LOG_LEVEL", "HOST"]) {
      expect(looksSecret(k)).toBe(false);
    }
  });

  it("masks a secret value", () => {
    expect(maskValue("DB_PASSWORD", "hunter2")).toBe("••••••••");
  });

  // the point of the preview is checking a template, so hiding the template
  // would make it useless — and a reference is the mechanism, not the secret
  it("never masks a template reference", () => {
    expect(maskValue("DB_PASSWORD", "${WT_DB_PASS}")).toBe("${WT_DB_PASS}");
  });

  it("leaves an empty value empty rather than inventing bullets", () => {
    expect(maskValue("API_KEY", "")).toBe("");
    expect(maskValue("API_KEY", "   ")).toBe("   ");
  });

  it("masks in buildConfig only when asked", () => {
    const withSecret = [card({ keys: [{ id: "k", k: "API_KEY", v: "abc123" }] })];
    const plain = buildConfig(withSecret, [], [], []) as { provision: { keys: Record<string, string> }[] };
    const masked = buildConfig(withSecret, [], [], [], undefined, true) as { provision: { keys: Record<string, string> }[] };
    expect(plain.provision[0].keys.API_KEY).toBe("abc123");
    expect(masked.provision[0].keys.API_KEY).toBe("••••••••");
  });
});
