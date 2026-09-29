// First run — one adaptive screen, not five steps. Ported from the redesign
// handoff (Canopy Onboarding.html / cxo-onboard.jsx, revised).
//
// The shipped wizard walked Repository → Stack → Services → Commands → Review.
// Two of those didn't earn a screen: "Stack" asked you to confirm something
// already read from the repo's manifests, and "Review" restated the screens
// before it. Meanwhile the real value — detect_repo mapping package.json
// scripts to services — sat behind step 3. So now: an empty state that finally
// exists (with the worktree value proposition drawn out), one adaptive add
// screen (detection runs as you type; the stack is a chip; services are
// inline-editable; the derivation is shown, not asserted), honest provisioning
// narration over the real IPC calls, and a "ready" screen that ends on the
// next action.
//
// Adaptations from the design demo:
// • The light/dark theme toggle is omitted — the app ships dark only; there is
//   no light theme to switch to (tokens.css has no light values yet).
// • Env template values use ${WT_SERVER_PORT} / ${WT_DB_NAME}, the variables the
//   Rust setup runner actually interpolates (state.rs:142, setup.rs). The
//   handoff names ${WT_SERVICE_PORT} / ${INT_DB_NAME} are NOT substituted by the
//   backend and would land in .env as dead literals.
import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "../styles/onboarding.css";
import { errText, hasBackend, ipc, type SetupTask, type ProvisionEntry, type RepoCfg, type RepoDetection, type ServiceCfg } from "../ipc";
import { useStore } from "../store";
import { Bolt, Browser, Check, ChevRight, Chevron, Cube, Doc, Download, Fork, Plus, Server, Spinner, Trash } from "../icons";

/* the one folder glyph the shared set doesn't carry */
const Folder = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
  </svg>
);

const STACKS = [
  { id: "node", mono: "JS", name: "Node.js", desc: "package.json" },
  { id: "next", mono: "N", name: "Next.js", desc: "next.config" },
  { id: "nest", mono: "Ne", name: "NestJS", desc: "nest-cli.json" },
  { id: "rails", mono: "Rb", name: "Rails", desc: "Gemfile" },
  { id: "django", mono: "Dj", name: "Django", desc: "manage.py" },
  { id: "go", mono: "Go", name: "Go", desc: "go.mod" },
  { id: "rust", mono: "Rs", name: "Rust", desc: "Cargo.toml" },
  { id: "other", mono: "…", name: "Other", desc: "configure manually" },
];

type Kind = "web" | "server" | "worker";
interface WizSvc {
  id: string;
  on: boolean;
  name: string;
  kind: Kind;
  dir: string;
  dirEdited?: boolean;
  script?: string;
  cmd: string;
  port: string;
}
interface Cfg {
  resetDb: string;
  migrate: string;
  worktreeDir: string;
  env: { id: string; on: boolean; key: string; value: string }[];
  setup: { id: string; on: boolean; cmd: string }[];
}

let _uid = 0;
const uid = (p: string) => p + ++_uid;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const slug = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// Mirror the backend's port-variable name-slug (state.rs): each non-alphanumeric
// char → "_", uppercased, trimmed. A service named "Server dev" → WT_SERVER_DEV_PORT.
const envSlug = (v: string) => [...v].map((c) => (/[A-Za-z0-9]/.test(c) ? c.toUpperCase() : "_")).join("").replace(/^_+|_+$/g, "");
const KIND_IC: Record<Kind, typeof Server> = { web: Browser, server: Server, worker: Cube };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Map detected package.json scripts + stack into service/command suggestions.
 * Port-derivation and env-template names mirror the Rust setup runner. */
function derive(det: RepoDetection): { services: WizSvc[]; cfg: Cfg } {
  const scripts = det.scripts ?? [];
  const find = (re: RegExp) => scripts.find((s) => re.test(s.name));
  const dirOf = (command: string) => command.match(/--prefix\s+(\S+)/)?.[1] ?? "";

  const services: WizSvc[] = [];
  let portBase = 3000;
  for (const { name, command } of scripts) {
    const n = name.toLowerCase();
    const isSvc = /^(start|dev|serve|develop|web|server|api|client|frontend|backend)(:dev|:watch)?$/.test(n) || /:dev$/.test(n);
    if (!isSvc) continue;
    const web = /front|web|client|ui|vite|next|--port|webpack (serve|dev)/.test(n + " " + command);
    services.push({
      id: uid("s"),
      on: services.filter((x) => x.on).length < 2,
      name: cap(name.replace(/[:_-]/g, " ")),
      kind: web ? "web" : "server",
      dir: dirOf(command),
      dirEdited: true,
      script: name,
      cmd: command,
      port: String((portBase += services.length ? 10 : 0)),
    });
  }
  if (!services.length) {
    services.push({ id: uid("s"), on: true, name: "Dev", kind: "server", dir: "", dirEdited: true, cmd: "npm run dev", port: "3000" });
  }
  const build = find(/^(build|compile|plugins?:build)$/i);
  if (build) {
    services.push({ id: uid("s"), on: false, name: cap(build.name.replace(/[:_-]/g, " ")), kind: "worker", dir: dirOf(build.command), dirEdited: true, script: build.name, cmd: build.command, port: "" });
  }

  const reset = find(/^(db:reset|reset:db|resetdb)$/i);
  const migrate = find(/^(db:migrate|migrate|migration:run)$/i);
  const create = find(/^(db:create|createdb)$/i);

  const setup: Cfg["setup"] = [{ id: uid("u"), on: true, cmd: "npm install" }];
  if (create && migrate) setup.push({ id: uid("u"), on: true, cmd: `npm run ${create.name} && npm run ${migrate.name}` });
  else if (create) setup.push({ id: uid("u"), on: true, cmd: `npm run ${create.name}` });
  else if (migrate) setup.push({ id: uid("u"), on: true, cmd: `npm run ${migrate.name}` });

  // The backend exposes each service's port as WT_<NAME-SLUG>_PORT (and by id).
  // Point the default PORT env at the primary service's real variable so it
  // actually resolves — a hardcoded ${WT_SERVER_PORT} only worked when a service
  // happened to be named exactly "Server".
  const primary = services.find((s) => s.on && s.kind === "server") ?? services.find((s) => s.on && s.port) ?? services[0];
  const portVar = primary ? `\${WT_${envSlug(primary.name)}_PORT}` : "${WT_SERVER_PORT}";

  const cfg: Cfg = {
    resetDb: reset ? `npm run ${reset.name}` : "",
    migrate: migrate ? `npm run ${migrate.name}` : "",
    worktreeDir: det.top ? `${det.top}/.worktrees` : "",
    env: [
      { id: uid("e"), on: true, key: "PORT", value: portVar },
      { id: uid("e"), on: true, key: "PG_DB", value: "${WT_DB_NAME}" },
    ],
    setup,
  };
  return { services, cfg };
}

/* the on/off control is a checkbox — a value you're setting, not a live switch */
function Chk({ on, onClick, label }: { on: boolean; onClick: () => void; label?: string }) {
  return (
    <button className={"cbx" + (on ? " on" : "")} role="checkbox" aria-checked={on} aria-label={label || "Include"} onClick={onClick}>
      {on ? <Check size={11} /> : null}
    </button>
  );
}

/* ── the stack: a chip, not a step ────────────────────────────────── */
function StackChip({ value, detected, onPick }: { value: string; detected?: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const d = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", d);
    return () => document.removeEventListener("mousedown", d);
  }, [open]);
  const s = STACKS.find((x) => x.id === value) || STACKS[7];
  return (
    <span className="stackwrap" ref={ref}>
      <button className="stackchip" onClick={() => setOpen((o) => !o)} title="Change the detected stack">
        <span className="mn">{s.mono}</span>
        {s.name}
        <Chevron size={10} />
      </button>
      {open && (
        <div className="stackmenu" role="listbox">
          {STACKS.map((x) => (
            <button key={x.id} className={"smi" + (x.id === value ? " on" : "")} role="option" aria-selected={x.id === value} onClick={() => { onPick(x.id); setOpen(false); }}>
              <span className="mn">{x.mono}</span>
              <span className="nm">{x.name}</span>
              {x.id === detected ? <span className="det">detected</span> : <span className="ds">{x.desc}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/* ── A · empty state — the ask on the left, the case for worktrees on the right ── */
const HILITES: [typeof Fork, string, string][] = [
  [Fork, "Leave work where it stands", "Each branch keeps its own checkout, so a review never costs you the thing you were halfway through."],
  [Server, "Ports that don't fight", "Canopy assigns each worktree its own ports and database, so branches run side by side."],
  [Bolt, "Ready when you get there", "Checkout, install, migrate and run happen together, so you come back to a working app."],
];

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="hero">
      <div className="heroL">
        <div className="heromark"><span className="fk"><Fork size={19} /></span>Canopy</div>
        <h1>No repositories yet</h1>
        <p>Canopy runs each branch as its own worktree — separate checkout, separate services, separate database. Point it at a repo and it reads your scripts to work out what to run.</p>
        <div className="emptyacts">
          <button className="btn pri lg" onClick={onAdd}><Plus size={13} />Add a repository</button>
        </div>
        <p className="herohint">Or drop a git repository anywhere in this window.</p>
      </div>

      <div className="heroR">
        <div className="cmp">
          <div className="cmp-card was">
            <div className="cmp-h"><b>git checkout</b><span>one working copy</span></div>
            <div className="cmp-row live"><span className="fd"><Folder size={12} /></span><span className="bd"><span className="b">main</span><span className="p">~/canopy</span></span><span className="s">:3000</span></div>
            <div className="cmp-row off"><span className="fd" /><span className="bd"><span className="b">feat/wt-components-v2</span><span className="p">no checkout</span></span><span className="s">stashed</span></div>
            <div className="cmp-row off"><span className="fd" /><span className="bd"><span className="b">fix/deduplicate-queries</span><span className="p">no checkout</span></span><span className="s">waiting</span></div>
            <p className="cmp-n">Switching means stashing, checking out, reinstalling, restarting.</p>
          </div>
          <div className="cmp-card is">
            <div className="cmp-h"><b>git worktree</b><span>three, at once</span></div>
            <div className="cmp-row live"><span className="fd"><Folder size={12} /></span><span className="bd"><span className="b">main</span><span className="p">~/canopy</span></span><span className="s">:3000</span></div>
            <div className="cmp-row live"><span className="fd"><Folder size={12} /></span><span className="bd"><span className="b">feat/wt-components-v2</span><span className="p">.worktrees/feat-wt-components-v2</span></span><span className="s">:3010</span></div>
            <div className="cmp-row live"><span className="fd"><Folder size={12} /></span><span className="bd"><span className="b">fix/deduplicate-queries</span><span className="p">.worktrees/fix-deduplicate-queries</span></span><span className="s">:3020</span></div>
            <p className="cmp-n">Every branch stays checked out, installed and running. Switching is switching windows.</p>
          </div>
        </div>
        <div className="hilites">
          {HILITES.map(([Ic, t, d]) => (
            <div className="hi" key={t}>
              <span className="t"><Ic size={13} /></span>
              <span className="bd"><h3>{t}</h3><p>{d}</p></span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── B · one adaptive add screen ──────────────────────────────────── */
type Phase = "idle" | "detecting" | "scanning" | "ready";
function AddScreen({
  det,
  detErr,
  phase,
  path,
  over,
  stack,
  services,
  cfg,
  onPath,
  onBrowse,
  onStack,
  setServices,
  setCfg,
  flash,
  onSkip,
  onDone,
}: {
  det: RepoDetection | null;
  detErr: string | null;
  phase: Phase;
  path: string;
  over: boolean;
  stack: string;
  services: WizSvc[];
  cfg: Cfg;
  onPath: (v: string) => void;
  onBrowse: () => void;
  onStack: (id: string) => void;
  setServices: React.Dispatch<React.SetStateAction<WizSvc[]>>;
  setCfg: React.Dispatch<React.SetStateAction<Cfg>>;
  flash: (m: string) => void;
  onSkip: () => void;
  onDone: () => void;
}) {
  const [edit, setEdit] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const on = services.filter((s) => s.on);
  const hits = new Set<string>();
  services.forEach((s) => s.on && s.script && hits.add(s.script));
  [cfg.resetDb, cfg.migrate].forEach((c) => {
    const m = c.match(/npm run (\S+)/);
    if (m) hits.add(m[1]);
  });
  const patch = (id: string, p: Partial<WizSvc>) => setServices((ss) => ss.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const dropSvc = (id: string) => {
    setServices((ss) => ss.filter((s) => s.id !== id));
    setEdit(null);
  };
  const envOn = cfg.env.filter((e) => e.on).length;
  const setupOn = cfg.setup.filter((u) => u.on).length;

  /* Import an existing .worktreemanager.json — reuses the FileReader path
     Settings uses, so it round-trips with what provisioning writes out. */
  const triggerImport = () => {
    if (!hasBackend()) return flash("Import needs the desktop app");
    fileRef.current?.click();
  };
  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const parsed = JSON.parse(String(r.result)) as { provision?: unknown; setup?: unknown; migrate?: unknown };
        const prov = Array.isArray(parsed.provision) ? (parsed.provision as Record<string, unknown>[]) : [];
        const dotenv = prov.find((p) => p.format === "dotenv") ?? prov[0];
        setCfg((c) => {
          const next = { ...c };
          if (dotenv && dotenv.keys && typeof dotenv.keys === "object") {
            next.env = Object.entries(dotenv.keys as Record<string, unknown>).map(([k, v]) => ({ id: uid("e"), on: true, key: k, value: String(v) }));
          }
          if (Array.isArray(parsed.setup)) {
            next.setup = (parsed.setup as unknown[]).filter((x) => typeof x === "string").map((cmd) => ({ id: uid("u"), on: true, cmd: cmd as string }));
          }
          if (Array.isArray(parsed.migrate) && typeof parsed.migrate[0] === "string") next.migrate = parsed.migrate[0] as string;
          return next;
        });
        flash(`Imported ${f.name}`);
      } catch {
        flash(`Couldn't parse ${f.name} — invalid JSON`);
      }
    };
    r.readAsText(f);
  };

  return (
    <>
      <div className="obody">
        <div className="obinner">
          <div className="ohead">
            <h1>Add a repository</h1>
            <p>Canopy verifies the repo, reads its scripts, and proposes what to run per worktree. Everything here is editable later in Settings.</p>
          </div>

          {/* the drop target doubles as the path field */}
          <div className={"drop" + (over ? " over" : "") + (path ? " filled" : "")}>
            <div className="droprow">
              <span className="ic"><Folder size={14} /></span>
              <input
                className="inp mono"
                style={{ flex: 1 }}
                value={path}
                spellCheck={false}
                placeholder="~/code/my-app  ·  or drop a folder here"
                onChange={(e) => onPath(e.target.value)}
              />
              <button className="btn" onClick={onBrowse}><Folder size={12} />Browse…</button>
            </div>
            {!path && <div className="drophint">Drop a git repository, or <b>paste its path</b>.</div>}
          </div>

          {phase === "detecting" && (
            <div className="detect">
              <div className="scanning" style={{ borderTop: 0 }}>
                <span className="sp2 spin"><Spinner size={16} /></span>
                Verifying the repository…
              </div>
            </div>
          )}

          {detErr && phase === "idle" && path.trim() !== "" && (
            <div className="detect">
              <div className="scanning" style={{ borderTop: 0, color: "var(--red-text)" }}>{detErr}</div>
            </div>
          )}

          {(phase === "scanning" || phase === "ready") && det && (
            <div className="detect">
              <div className="dtop">
                <span className="badge"><Fork size={17} /></span>
                <span className="info">
                  <h3>{det.name}</h3>
                  <span className="meta">
                    <span><span className="k">path</span> {det.top}</span>
                    {det.branch && <span><span className="k">branch</span> {det.branch}</span>}
                  </span>
                </span>
                {/* was step 2 of 5; now a chip, already answered */}
                <StackChip value={stack} detected={det.stack} onPick={onStack} />
                <span className="okchip"><Check size={11} />Git repo</span>
              </div>

              {phase === "scanning" ? (
                <div className="scanning">
                  <span className="sp2 spin"><Spinner size={16} /></span>
                  Reading package.json and workspaces…
                </div>
              ) : (
                <>
                  <div className="dsec">
                    <div className="slab">
                      Services Canopy will run
                      <span className="n">{on.length} of {services.length} on</span>
                      <span className="ln" />
                      <button
                        className="btn sm gh"
                        onClick={() => {
                          const id = uid("s");
                          setServices((ss) => ss.concat([{ id, on: true, name: "", kind: "server", dir: "", script: undefined, cmd: "", port: "" }]));
                          setEdit(id);
                        }}
                      >
                        <Plus size={10} />Add service
                      </button>
                    </div>
                    {services.map((s) => {
                      const Ic = KIND_IC[s.kind];
                      const open = edit === s.id;
                      return (
                        <div className={"svcitem" + (open ? " open" : "")} key={s.id}>
                          <div className={"svcrow " + (s.on ? "on" : "off")}>
                            <span className="kic"><Ic size={13} /></span>
                            <button className="bd asbtn" onClick={() => setEdit(open ? null : s.id)} title={open ? "Done editing" : "Edit this service"}>
                              <span className="r1">
                                <span className="nm">{s.name || "Unnamed service"}</span>
                                <span className="tag">{s.kind}</span>
                                <span className="cv"><ChevRight size={11} /></span>
                              </span>
                              <span className="cmd">
                                <b>from</b> {s.script ? '"' + s.script + '"' : "manual"}
                                {s.dir ? <> · <b>in</b> {s.dir}</> : null} · {s.cmd || "no command yet"}
                              </span>
                            </button>
                            {s.on ? (
                              <input className="inp mono pin" value={s.port} placeholder="—" spellCheck={false} onChange={(e) => patch(s.id, { port: e.target.value })} />
                            ) : (
                              <span className={"port" + (s.port ? "" : " none")}>{s.port ? ":" + s.port : "no port"}</span>
                            )}
                            <Chk on={s.on} label={`Run ${s.name || "service"}`} onClick={() => patch(s.id, { on: !s.on })} />
                          </div>
                          {open && (
                            <div className="svcedit">
                              <label className="fld">
                                <span>Name</span>
                                <input
                                  className="inp"
                                  autoFocus
                                  value={s.name}
                                  placeholder="Frontend dev"
                                  onChange={(e) => patch(s.id, s.dirEdited ? { name: e.target.value } : { name: e.target.value, dir: slug(e.target.value) })}
                                />
                              </label>
                              <label className="fld">
                                <span>Kind</span>
                                <select className="inp sel" value={s.kind} onChange={(e) => patch(s.id, { kind: e.target.value as Kind })}>
                                  <option value="web">web</option>
                                  <option value="server">server</option>
                                  <option value="worker">worker</option>
                                </select>
                              </label>
                              <label className="fld">
                                <span>Directory</span>
                                <input className="inp mono" value={s.dir} placeholder="repo root" onChange={(e) => patch(s.id, { dir: e.target.value, dirEdited: true })} />
                              </label>
                              <label className="fld">
                                <span>Port</span>
                                <input className="inp mono" value={s.port} placeholder="none" onChange={(e) => patch(s.id, { port: e.target.value })} />
                              </label>
                              <label className="fld wide">
                                <span>Command</span>
                                <input className="inp mono" value={s.cmd} placeholder="npm run dev" onChange={(e) => patch(s.id, { cmd: e.target.value, script: undefined })} />
                              </label>
                              <div className="svcedit-f">
                                <button className="btn sm bad" onClick={() => dropSvc(s.id)}><Trash size={11} />Remove</button>
                                <span className="sp" />
                                <button className="btn sm" onClick={() => setEdit(null)}>Done</button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <div className="hint">Ports are a base — each worktree gets <code>base + index × 10</code>, so five branches never collide.</div>
                  </div>

                  {/* the derivation, shown rather than asserted */}
                  {det.scripts.length > 0 && (
                    <div className="dsec">
                      <div className="slab">Where that came from<span className="ln" /></div>
                      <div className="peek">
                        <div className="bar"><Doc size={11} />package.json — scripts</div>
                        <div className="bd">
                          <div className="ln"><span className="pun">{"{"}</span></div>
                          {det.scripts.map((s, i) => (
                            <div className="ln" key={s.name}>
                              {"  "}
                              <span className={"key" + (hits.has(s.name) ? " hit" : "")}>"{s.name}"</span>
                              <span className="pun">: </span>
                              <span className="str">"{s.command}"</span>
                              <span className="pun">{i < det.scripts.length - 1 ? "," : ""}</span>
                            </div>
                          ))}
                          <div className="ln"><span className="pun">{"}"}</span></div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* pre-filled correctly, so collapsed — was a whole step */}
                  <details className="adv">
                    <summary>
                      <span className="cv"><ChevRight size={11} /></span>
                      Provisioning and setup
                      <span className="n">{envOn} env keys · {setupOn} setup steps · db commands found</span>
                    </summary>
                    <div className="advb">
                      <div className="impline">
                        <span>Already have a config? Import it instead of re-entering it.</span>
                        <button className="btn sm" onClick={triggerImport}><Download size={11} />Import .worktreemanager.json</button>
                        <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={onImportFile} />
                      </div>
                      <div className="slab" style={{ marginTop: 4 }}>Env written into each worktree's .env<span className="ln" /></div>
                      <div className="kv">
                        {cfg.env.map((e) => (
                          <div key={e.id} style={{ display: "contents" }}>
                            <input
                              className="inp mono"
                              value={e.key}
                              spellCheck={false}
                              style={{ opacity: e.on ? 1 : 0.5 }}
                              onChange={(ev) => setCfg((c) => ({ ...c, env: c.env.map((x) => (x.id === e.id ? { ...x, key: ev.target.value } : x)) }))}
                            />
                            <span className="eq">=</span>
                            <input
                              className="inp mono"
                              value={e.value}
                              spellCheck={false}
                              style={{ opacity: e.on ? 1 : 0.5 }}
                              onChange={(ev) => setCfg((c) => ({ ...c, env: c.env.map((x) => (x.id === e.id ? { ...x, value: ev.target.value } : x)) }))}
                            />
                            <Chk on={e.on} label={`Write ${e.key || "env key"}`} onClick={() => setCfg((c) => ({ ...c, env: c.env.map((x) => (x.id === e.id ? { ...x, on: !x.on } : x)) }))} />
                          </div>
                        ))}
                      </div>

                      <div className="slab" style={{ marginTop: 13 }}>
                        Setup, run in order on create
                        <span className="ln" />
                        <button
                          className="btn sm gh"
                          onClick={() => setCfg((c) => ({ ...c, setup: c.setup.concat([{ id: uid("u"), on: true, cmd: "" }]) }))}
                        >
                          <Plus size={10} />Add step
                        </button>
                      </div>
                      {cfg.setup.map((u, i) => (
                        <div className="stepline" key={u.id}>
                          <span className="n2">{i + 1}</span>
                          <input
                            className="inp mono"
                            style={{ flex: 1, opacity: u.on ? 1 : 0.5 }}
                            value={u.cmd}
                            placeholder="npm install"
                            spellCheck={false}
                            onChange={(ev) => setCfg((c) => ({ ...c, setup: c.setup.map((x) => (x.id === u.id ? { ...x, cmd: ev.target.value } : x)) }))}
                          />
                          <button className="ico bad" title="Remove step" onClick={() => setCfg((c) => ({ ...c, setup: c.setup.filter((x) => x.id !== u.id) }))}>
                            <Trash size={11} />
                          </button>
                          <Chk on={u.on} label={`Run step ${i + 1}`} onClick={() => setCfg((c) => ({ ...c, setup: c.setup.map((x) => (x.id === u.id ? { ...x, on: !x.on } : x)) }))} />
                        </div>
                      ))}

                      <div className="slab" style={{ marginTop: 13 }}>Database<span className="n">from db:* scripts</span><span className="ln" /></div>
                      <div className="kv">
                        <span style={{ font: "var(--fs-small) var(--sans)", color: "var(--text-tertiary)" }}>Migrate</span>
                        <span />
                        <input className="inp mono" value={cfg.migrate} spellCheck={false} onChange={(e) => setCfg((c) => ({ ...c, migrate: e.target.value }))} />
                        <span />
                        <span style={{ font: "var(--fs-small) var(--sans)", color: "var(--text-tertiary)" }}>Reset</span>
                        <span />
                        <input className="inp mono" value={cfg.resetDb} spellCheck={false} onChange={(e) => setCfg((c) => ({ ...c, resetDb: e.target.value }))} />
                        <span />
                        <span style={{ font: "var(--fs-small) var(--sans)", color: "var(--text-tertiary)" }}>Worktrees in</span>
                        <span />
                        <input className="inp mono" value={cfg.worktreeDir} spellCheck={false} onChange={(e) => setCfg((c) => ({ ...c, worktreeDir: e.target.value }))} />
                        <span />
                      </div>
                    </div>
                  </details>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* one action. no step dots, because there are no steps to count. */}
      <div className="ofoot">
        <button className="ob-skip" onClick={onSkip}>Skip for now</button>
        <span className="sp" />
        {phase === "ready" && det && (
          <span className="sum">
            <b>{det.name}</b> · {on.length} {on.length === 1 ? "service" : "services"} · {setupOn} setup steps
          </span>
        )}
        <button className="btn pri" disabled={phase !== "ready"} onClick={onDone}>
          <Check size={12} />Add repository<span className="k">⌘⏎</span>
        </button>
      </div>
    </>
  );
}

/* ── C · provisioning — narrates the real work ────────────────────── */
interface RunStep {
  t: string;
  run: () => Promise<string>;
}
function Provisioning({ name, steps, onDone, onError, onCancel }: { name: string; steps: RunStep[]; onDone: () => void; onError: (msg: string) => void; onCancel: () => void }) {
  const [n, setN] = useState(0);
  const [metas, setMetas] = useState<string[]>([]);
  const cancelled = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      for (let i = 0; i < steps.length; i++) {
        if (cancelled.current) return;
        try {
          const [meta] = await Promise.all([steps[i].run(), delay(460)]);
          if (!alive || cancelled.current) return;
          setMetas((xs) => {
            const c = [...xs];
            c[i] = meta;
            return c;
          });
          setN(i + 1);
        } catch (e) {
          if (alive && !cancelled.current) onError(String(e));
          return;
        }
      }
      if (alive && !cancelled.current) {
        await delay(300);
        if (alive && !cancelled.current) onDone();
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="runwrap">
      <div className="runcard">
        <h2>Setting up {name}</h2>
        <p>Nothing is cloned or installed yet — that happens per worktree.</p>
        {steps.map((s, i) => (
          <div className={"stp " + (i < n ? "done" : i === n ? "act" : "pend")} key={s.t}>
            <span className="bl">{i < n ? "✓" : i === n ? <span className="spin"><Spinner size={11} /></span> : "○"}</span>
            <span className="tx">{s.t}</span>
            {i < n && metas[i] && <span className="mt">{metas[i]}</span>}
          </div>
        ))}
        <div className="runcancel">
          <button
            className="btn"
            onClick={() => {
              cancelled.current = true;
              onCancel();
            }}
          >
            Cancel setup
          </button>
          <span>Nothing is cloned or installed — you can start over.</span>
        </div>
      </div>
    </div>
  );
}

/* ── D · ready — ends on the next action, not a dead end ──────────── */
function Ready({ det, services, cfg, onCreate, onGoToCanopy, onRestart }: { det: RepoDetection; services: WizSvc[]; cfg: Cfg; onCreate: () => void; onGoToCanopy: () => void; onRestart: () => void }) {
  const on = services.filter((s) => s.on);
  const svcSummary = on.map((s) => (s.port ? `${s.name} :${s.port}` : s.name)).join(" · ") || "none";
  const envOn = cfg.env.filter((e) => e.on).length;
  const setupOn = cfg.setup.filter((u) => u.on).length;
  return (
    <div className="runwrap">
      <div className="emptycard">
        <div className="donering"><Check size={26} /></div>
        <h1>{det.name} is ready</h1>
        <p>Canopy is watching this repo. Create a worktree to check out a branch with its own services, ports and database.</p>
        <div className="doneacts">
          <button className="btn pri lg" onClick={onCreate}><Plus size={13} />Create first worktree<span className="k">⌘N</span></button>
          <button className="btn lg" onClick={onGoToCanopy}>Go to Canopy</button>
        </div>
        <div className="donefacts">
          <div className="df"><div className="l">Services</div><div className="v">{svcSummary}</div></div>
          <div className="df"><div className="l">Worktrees in</div><div className="v">{cfg.worktreeDir || "—"}</div></div>
          <div className="df"><div className="l">On create</div><div className="v">{envOn} env keys · {setupOn} setup steps</div></div>
          <div className="df"><div className="l">Database</div><div className="v">one per worktree · <em>${"{WT_DB_NAME}"}</em></div></div>
        </div>
        <div className="hint" style={{ textAlign: "center", marginTop: 16 }}>
          Change any of this in Settings → <span style={{ color: "var(--text-secondary)" }}>{det.name}</span>.{" "}
          <a onClick={(e) => { e.preventDefault(); onRestart(); }}>Replay this flow</a>
        </div>
      </div>
    </div>
  );
}

/* ── shell ────────────────────────────────────────────────────────── */
type View = "empty" | "add" | "run" | "done";

export default function Onboarding({
  onClose,
  onCreateWorktree,
  /** "add" opens straight on the add-repository screen — the sidebar's
      repository menu, ⇧⌘N and the palette all arrive that way, from an app
      that already has repositories. Defaults to the first-run empty state. */
  initialView = "empty",
}: {
  onClose: () => void;
  onCreateWorktree: () => void;
  initialView?: "empty" | "add";
}) {
  const showToast = useStore((s) => s.showToast);
  const select = useStore((s) => s.select);

  const [view, setView] = useState<View>(initialView);
  // Entering at "add" means there is nothing behind this screen: the empty
  // state's "No repositories yet" would be a lie, so leaving cancels instead
  // of stepping back to it.
  const enteredAtAdd = initialView === "add";
  // …and if the request arrives while the first-run empty state is already up
  // (0 repos, then ⇧⌘N), jump to the add screen rather than ignoring it — the
  // initial useState value is only read once. Only from "empty": a request
  // landing mid-provision must not yank the run or done screen away.
  useEffect(() => {
    if (initialView === "add") setView((v) => (v === "empty" ? "add" : v));
  }, [initialView]);
  const [path, setPath] = useState("");
  const [det, setDet] = useState<RepoDetection | null>(null);
  const [detErr, setDetErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [over, setOver] = useState(false);
  const [stack, setStack] = useState("node");
  const [services, setServices] = useState<WizSvc[]>([]);
  const [cfg, setCfg] = useState<Cfg>({ resetDb: "", migrate: "", worktreeDir: "", env: [], setup: [] });
  const [runSteps, setRunSteps] = useState<RunStep[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  const detectSeq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flash = (m: string) => {
    setToast(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  };

  useEffect(() => () => {
    clearTimeout(debounce.current);
    clearTimeout(toastTimer.current);
  }, []);

  /* Detection runs as you type — the shipped version waited for blur, so a
     pasted path did nothing until you clicked away. */
  async function detect(p: string) {
    const trimmed = p.trim();
    if (!trimmed) {
      setPhase("idle");
      setDet(null);
      setDetErr(null);
      return;
    }
    if (!hasBackend()) {
      setDetErr("Detection needs the desktop app");
      setPhase("idle");
      return;
    }
    const seq = ++detectSeq.current;
    setPhase("detecting");
    setDetErr(null);
    try {
      const d = await ipc.detectRepo(trimmed);
      if (seq !== detectSeq.current) return; // a newer keystroke superseded this
      setDet(d);
      setStack(d.stack || "other");
      const { services: sv, cfg: cf } = derive(d);
      setServices(sv);
      setCfg(cf);
      setPhase("scanning");
      setTimeout(() => {
        if (seq === detectSeq.current) setPhase("ready");
      }, 650);
    } catch (e) {
      if (seq !== detectSeq.current) return;
      setDet(null);
      setDetErr(errText(e));
      setPhase("idle");
    }
  }

  function onPath(v: string) {
    setPath(v);
    setDet(null);
    setDetErr(null);
    clearTimeout(debounce.current);
    ++detectSeq.current;
    if (!v.trim()) {
      setPhase("idle");
      return;
    }
    setPhase("detecting");
    debounce.current = setTimeout(() => detect(v), 450);
  }

  async function browse() {
    if (!hasBackend()) return flash("Browse needs the desktop app");
    const picked = await openDialog({ directory: true, multiple: false, title: "Choose a git repository" });
    if (typeof picked === "string") {
      setView("add");
      setPath(picked);
      detect(picked);
    }
  }

  /* real OS folder drop → the same path field (Tauri v2 webview drag-drop).
     Active on the empty state too, so "drop anywhere in this window" is true.
     Degrades silently: typing and Browse still work if the event never fires. */
  useEffect(() => {
    if ((view !== "add" && view !== "empty") || !hasBackend()) return;
    let un: (() => void) | undefined;
    let webview: ReturnType<typeof getCurrentWebview>;
    try {
      webview = getCurrentWebview();
    } catch {
      return;
    }
    webview
      .onDragDropEvent((event) => {
        const pl = event.payload;
        if (pl.type === "over" || pl.type === "enter") setOver(true);
        else if (pl.type === "leave") setOver(false);
        else if (pl.type === "drop") {
          setOver(false);
          const p = pl.paths?.[0];
          if (p) {
            setView("add");
            setPath(p);
            detect(p);
          }
        }
      })
      .then((f) => {
        un = f;
      })
      .catch(() => {});
    return () => {
      un?.();
      setOver(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  /* Build the provisioning steps, each wired to a real IPC call so the
     narration reports what actually happened, not a canned script. */
  function startProvision() {
    if (!det) return;
    const on = services.filter((s) => s.on);
    const envPairs = cfg.env.filter((e) => e.on && e.key.trim()).map((e) => [e.key, e.value] as [string, string]);
    // Onboarding writes plain tasks: no working directory, all enabled —
    // exactly the shape a bare string in the config file parses to.
    const setupCmds: SetupTask[] = cfg.setup
      .filter((u) => u.on && u.cmd.trim())
      .map((u) => ({ cmd: u.cmd, cwd: "", enabled: true }));

    const svcCfg = (): ServiceCfg[] =>
      on.map((s) => ({
        id: slug(s.name) || "service",
        name: s.name,
        kind: s.kind,
        command: s.cmd,
        cwd: s.dir.trim(),
        basePort: s.port.trim() ? parseInt(s.port, 10) || null : null,
        env: {},
        // Onboarding can't know a repo's readiness path, and guessing one
        // would hold every service in "starting" until it timed out.
        health: "",
      }));

    if (!hasBackend()) {
      const ports = on.map((s) => s.port).filter(Boolean);
      setRunSteps([
        { t: `Registering ${det.name}`, run: async () => "" },
        { t: `Saving ${on.length} ${on.length === 1 ? "service" : "services"}`, run: async () => (ports.length ? `ports ${ports.join(", ")}` : "") },
        { t: "Writing .worktreemanager.json", run: async () => `${envPairs.length} env ${envPairs.length === 1 ? "key" : "keys"}` },
        { t: "Reading branches", run: async () => "preview" },
      ]);
      setView("run");
      return;
    }

    const ctx: { repo: RepoCfg | null } = { repo: null };
    const steps: RunStep[] = [
      {
        t: `Registering ${det.name}`,
        run: async () => {
          await ipc.addRepo(det.top).catch((e) => {
            if (!String(e).toLowerCase().includes("already")) throw e;
          });
          const settings = await ipc.getSettings();
          const repo = settings.repos.find((r) => r.path === det.top);
          if (!repo) throw new Error("repo not found after add");
          ctx.repo = repo;
          return "";
        },
      },
      {
        t: `Saving ${on.length} ${on.length === 1 ? "service" : "services"}`,
        run: async () => {
          const settings = await ipc.getSettings();
          const repo = settings.repos.find((r) => r.path === det.top);
          if (!repo) throw new Error("repo not found");
          repo.services = svcCfg();
          repo.resetDb = cfg.resetDb;
          repo.migrateDb = cfg.migrate;
          if (cfg.worktreeDir.trim()) repo.worktreeDir = cfg.worktreeDir.trim();
          await ipc.saveSettings(settings);
          ctx.repo = repo;
          const ports = on.map((s) => s.port.trim()).filter(Boolean);
          return ports.length ? `ports ${ports.join(", ")}` : "";
        },
      },
      {
        t: "Writing .worktreemanager.json",
        run: async () => {
          if (!ctx.repo) throw new Error("repo not resolved");
          const provision: ProvisionEntry[] = envPairs.length ? [{ path: ".env", format: "dotenv", from: "", interpolate: false, keys: envPairs }] : [];
          await ipc.saveRepoConfig(ctx.repo.id, provision, setupCmds);
          return `${envPairs.length} env ${envPairs.length === 1 ? "key" : "keys"} · ${setupCmds.length} setup`;
        },
      },
      {
        t: "Reading branches",
        run: async () => {
          if (!ctx.repo) return "";
          try {
            const b = await ipc.listBranches(ctx.repo.id);
            const n = b.local.length + b.remote.length;
            return `${n} ${n === 1 ? "branch" : "branches"}`;
          } catch {
            return "";
          }
        },
      },
    ];
    setRunSteps(steps);
    setView("run");
  }

  function goToCanopy() {
    if (det) select(det.top);
    onClose();
  }

  function restart() {
    // "Add another" returns to where this run started: the hero claims "No
    // repositories yet", which is false once you've just added one from an app
    // that already had some
    setView(enteredAtAdd ? "add" : "empty");
    setPath("");
    setDet(null);
    setDetErr(null);
    setPhase("idle");
    setServices([]);
    setCfg({ resetDb: "", migrate: "", worktreeDir: "", env: [], setup: [] });
  }

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "n" && view === "empty") {
        e.preventDefault();
        setView("add");
      } else if (mod && e.key === "Enter" && view === "add" && phase === "ready") {
        e.preventDefault();
        startProvision();
      } else if (e.key === "Escape" && (view === "empty" || view === "add")) {
        e.preventDefault();
        if (view === "empty" || enteredAtAdd) onClose();
        else setView("empty");
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  });

  const title = view === "empty" || view === "done" ? "Canopy" : "Canopy — Add repository";

  return (
    <div className="ob-root">
      <div className="ob-tb" data-tauri-drag-region>
        <div className="ob-tb-title" data-tauri-drag-region>
          <span className="fork"><Fork size={15} /></span>
          {title}
        </div>
        <span className="sp" data-tauri-drag-region />
        {view === "empty" && <button className="ob-skip" onClick={onClose}>Skip setup</button>}
        {view === "add" && (
          <button className="ob-skip" onClick={() => (enteredAtAdd ? onClose() : setView("empty"))}>
            {enteredAtAdd ? "Cancel" : "Back"}
          </button>
        )}
      </div>

      {view === "empty" && <EmptyState onAdd={() => setView("add")} />}
      {view === "add" && (
        <AddScreen
          det={det}
          detErr={detErr}
          phase={phase}
          path={path}
          over={over}
          stack={stack}
          services={services}
          cfg={cfg}
          onPath={onPath}
          onBrowse={browse}
          onStack={setStack}
          setServices={setServices}
          setCfg={setCfg}
          flash={flash}
          onSkip={() => setView("empty")}
          onDone={startProvision}
        />
      )}
      {view === "run" && (
        <Provisioning
          name={det?.name ?? "repository"}
          steps={runSteps}
          onDone={() => setView("done")}
          onError={(msg) => {
            showToast(`Couldn't add repo — ${msg}`);
            setView("add");
          }}
          onCancel={() => setView("add")}
        />
      )}
      {view === "done" && det && (
        <Ready
          det={det}
          services={services}
          cfg={cfg}
          onCreate={() => {
            onClose();
            onCreateWorktree();
          }}
          onGoToCanopy={goToCanopy}
          onRestart={restart}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
