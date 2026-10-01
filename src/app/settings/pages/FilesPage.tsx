// Provisioned files — what gets seeded or templated into a new worktree.
import { useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { errText, hasBackend, type ProvisionFormat } from "../../../ipc";
import { Braces, ChevRight, Copy, Doc, Finder, Plus, Trash, X } from "../../../icons";
import { uid, type FileCardT } from "../provision";
import { Toggle, Adv, Soon, InsertVar } from "../primitives";
import type { PageProps } from "../types";

/* ══════════════════════════ real: Files ════════════════════════════════ */
export const FMTS: ProvisionFormat[] = ["dotenv", "json", "yaml", "text"];

/** Store only contained paths. The backend performs the final symlink-aware check. */
export function repoRelative(picked: string, repoPath: string | undefined): string {
  const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = normalize(repoPath || "");
  const path = normalize(picked);
  const windows = /^[a-z]:\//i.test(root) || root.startsWith("//");
  const compare = (p: string) => windows ? p.toLowerCase() : p;
  if (!root || !compare(path).startsWith(compare(root) + "/")) {
    throw new Error("Choose a file inside the repository");
  }
  const relative = path.slice(root.length + 1);
  if (relative.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error("Choose a file inside the repository");
  }
  return relative;
}

/** Guess the format from the file the user picked, so choosing `config.json`
    does not silently keep the dotenv parser. */
export function formatOf(path: string): ProvisionFormat | null {
  const f = path.toLowerCase();
  if (/\.ya?ml$/.test(f)) return "yaml";
  if (f.endsWith(".json")) return "json";
  if (/(^|\/)\.env(\.|$)/.test(f)) return "dotenv";
  return null;
}

export default function FilesPage({ repo, cards, setCards, extras, setExtras, markDirty, flash }: PageProps) {
  const [selId, setSelId] = useState<string | null>(cards[0]?.id ?? null);
  const sel = cards.find((c) => c.id === selId) || cards[0] || null;
  const keyRef = useRef<number | null>(null);
  const patch = (p: Partial<FileCardT>) => { if (!sel) return; setCards(cards.map((c) => (c.id === sel.id ? { ...c, ...p } : c))); markDirty("files"); };
  const setKey = (i: number, which: 0 | 1, val: string) => sel && patch({ keys: sel.keys.map((k, j) => (j === i ? (which ? { ...k, v: val } : { ...k, k: val }) : k)) });
  const insert = (tok: string) => {
    const i = keyRef.current;
    if (i == null || !sel) { flash("Select a value field first, then insert"); return; }
    patch({ keys: sel.keys.map((k, j) => (j === i ? { ...k, v: (k.v || "") + tok } : k)) });
  };
  /* Both file fields are pickable. Typing `ee/.env` from memory is how you end
     up provisioning a path that does not exist — and on macOS a dotfile cannot
     be reached by the picker at all unless it starts inside the repo, which is
     why the dialog opens there. */
  const browse = async (which: "path" | "from") => {
    if (!sel) return;
    if (!hasBackend()) { flash("Choosing a file needs the desktop app"); return; }
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        defaultPath: repo?.path || undefined,
        title: which === "path" ? "Choose the file to provision" : "Choose the source file",
      });
      if (typeof picked !== "string") return;
      const rel = repoRelative(picked, repo?.path);
      const fmt = which === "path" ? formatOf(rel) : null;
      patch(which === "path" ? { path: rel, ...(fmt ? { format: fmt } : {}) } : { from: rel });
    } catch (e) {
      flash(`Could not open the file picker — ${errText(e)}`);
    }
  };
  return (
    <>
      <div className="sec">
        <div className="slab">Provisioned files<span className="n">{cards.length} configured</span></div>
        <div className="objs">
          {cards.map((f) => (
            <div className={"obj" + (sel && f.id === sel.id ? " open" : "")} key={f.id}>
              <button className="ohead" onClick={() => setSelId(f.id)}>
                <span className="cv" style={{ transform: sel && f.id === sel.id ? "rotate(90deg)" : "none" }}><ChevRight size={11} /></span>
                <Doc size={12} />
                <span className="mono">{f.path || "new file"}</span>
                <span className="gr" />
                <span className="tag">{f.format}</span>
                <span className="port">{f.keys.length} {f.keys.length === 1 ? "key" : "keys"}</span>
                <span className="oacts">
                  <span className="ico" title="Duplicate" onClick={(e) => { e.stopPropagation(); const n = { ...f, id: uid("f"), path: f.path + ".copy", keys: f.keys.map((k) => ({ ...k, id: uid("k") })) }; setCards(cards.concat([n])); markDirty("files"); }}><Copy size={11} /></span>
                  <span className="ico bad" title="Remove" onClick={(e) => { e.stopPropagation(); const rest = cards.filter((x) => x.id !== f.id); setCards(rest); if (sel?.id === f.id) setSelId(rest[0]?.id ?? null); markDirty("files"); }}><Trash size={11} /></span>
                </span>
              </button>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => { const n: FileCardT = { id: uid("f"), path: "", format: "dotenv", from: "", interpolate: false, keys: [] }; setCards(cards.concat([n])); setSelId(n.id); markDirty("files"); }}><Plus size={11} />Add file</button>
          <span className="hint" style={{ marginTop: 0 }}>Any path, any format. Env overrides take precedence.</span>
        </div>
      </div>

      {sel && (
        <div className="sec">
          <div className="slab"><Braces size={11} />Editing <span className="tokchip" style={{ fontFamily: "var(--mono)", letterSpacing: 0, textTransform: "none", fontSize: "var(--fs-small)" }}>{sel.path || "new file"}</span></div>
          <div className="steps">
            <div className={"stp" + (sel.path ? " done" : "")}><span className="num">1</span><span className="st"><b>File</b><span>path and format</span></span></div>
            <div className="sbody">
              <div className="row">
                <input className="inp mono gr" value={sel.path} placeholder=".env or config/app.json" onChange={(e) => patch({ path: e.target.value })} />
                <button className="ico" title="Browse for the file to provision" onClick={() => browse("path")}><Finder size={12} /></button>
                <select className="inp" value={sel.format} onChange={(e) => patch({ format: e.target.value as ProvisionFormat })}>
                  {FMTS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div className="hint">Relative to each worktree's root. Browsing inside the repository stores the path relative to it.</div>
            </div>

            <div className={"stp" + (sel.from ? " done" : "")}><span className="num">2</span><span className="st"><b>Source</b><span>where to copy from</span></span></div>
            <div className="sbody">
              <div className="row">
                <input className="inp mono gr" value={sel.from} placeholder="same path in the repo root" onChange={(e) => patch({ from: e.target.value })} />
                <button className="ico" title="Browse for a source file" onClick={() => browse("from")}><Finder size={12} /></button>
              </div>
              <div className="hint">Leave empty to read the same path from the repo root.</div>
            </div>

            <div className="stp done"><span className="num">3</span><span className="st"><b>Strategy</b><span>how it is applied</span></span></div>
            <div className="sbody">
              {/* the backend derives strategy from the format (keyed → upsert,
                  text → copy + interpolate); an independent mode isn't stored yet */}
              <div className="strat">
                {([["seed", "Seed if missing", "create only when the file does not exist"], ["upsert", "Upsert keys", "add or update named keys, leave the rest alone"], ["replace", "Copy + interpolate", "overwrite the whole file from source"]] as [string, string, string][]).map(([v, t, d]) => {
                  const cur = sel.format === "text" ? "replace" : "upsert";
                  return (
                    <label key={v} className={cur === v ? "on" : ""}>
                      <input type="radio" name={"mode-" + sel.id} checked={cur === v} disabled readOnly />
                      <b>{t}</b><span>{d}</span>
                    </label>
                  );
                })}
              </div>
              <div className="hint">Derived from the format for now — an independent strategy isn't stored yet.</div>
            </div>

            <div className={"stp" + ((sel.format === "text" ? sel.interpolate : sel.keys.length) ? " done" : "")}>
              <span className="num">4</span><span className="st"><b>Values</b><span>{sel.format === "text" ? "interpolate the copy" : "keys to set (upsert)"}</span></span>
            </div>
            <div className="sbody">
              {sel.format === "text" ? (
                <div className="tglrow" style={{ borderTop: 0, paddingTop: 0 }}>
                  <span className="tt"><b>Interpolate template variables</b><span>Replace <code>${"{VARIABLE}"}</code> tokens while copying the file.</span></span>
                  <Toggle on={sel.interpolate} onClick={() => patch({ interpolate: !sel.interpolate })} />
                </div>
              ) : (
                <>
                  <div className="row" style={{ marginBottom: 7 }}>
                    <span className="lb">{sel.keys.length} {sel.keys.length === 1 ? "key" : "keys"}</span>
                    <span style={{ flex: 1 }} />
                    <InsertVar onPick={insert} />
                  </div>
                  {sel.keys.length === 0 ? (
                    <div className="empty"><p>No keys yet. The file is provisioned as-is.</p>
                      <button className="btn sm" onClick={() => patch({ keys: [{ id: uid("k"), k: "", v: "" }] })}><Plus size={10} />Add key</button></div>
                  ) : (
                    <div className="kvg">
                      <span className="kvhead">Key</span><span /><span className="kvhead">Value</span><span />
                      {sel.keys.map((k, i) => (
                        <div key={k.id} style={{ display: "contents" }}>
                          <input className="inp mono" value={k.k} placeholder="KEY" onChange={(e) => setKey(i, 0, e.target.value)} />
                          <span className="eq">=</span>
                          <input className="inp mono" value={k.v} placeholder="value or ${VARIABLE}" onFocus={() => { keyRef.current = i; }} onChange={(e) => setKey(i, 1, e.target.value)} />
                          <button className="ico bad" title="Remove key" onClick={() => patch({ keys: sel.keys.filter((_, j) => j !== i) })}><X size={11} /></button>
                        </div>
                      ))}
                    </div>
                  )}
                  {sel.keys.length > 0 && (
                    <button className="btn sm gh" style={{ marginTop: 7 }} onClick={() => patch({ keys: sel.keys.concat([{ id: uid("k"), k: "", v: "" }]) })}><Plus size={10} />Add key</button>
                  )}
                </>
              )}
            </div>
          </div>
          <Adv n="not wired yet">
            <Soon>The on-conflict policy, when-to-apply trigger and file mode aren't stored yet — keys are upserted on create and reset.</Soon>
            <div className="soonwrap fgrid">
              <span className="lb">On conflict</span><select className="inp" disabled><option>Keep existing value</option></select>
              <span className="lb">Apply on</span><select className="inp" disabled><option>Create and reset</option></select>
              <span className="lb">File mode</span><input className="inp mono" disabled defaultValue="0644" style={{ width: 90 }} />
            </div>
          </Adv>
        </div>
      )}
      <div className="sec">
        <div className="slab">Lifecycle commands</div>
        {(["migrate", "teardown"] as const).map((kind) => (
          <label key={kind} className="row">
            <span className="lb">{kind === "migrate" ? "Migrate" : "Teardown"}</span>
            <textarea className="inp mono gr" aria-label={`${kind} commands`} value={extras[kind].join("\n")}
              placeholder="One command per line" onChange={(e) => { setExtras({ ...extras, [kind]: e.target.value.split("\n") }); markDirty("files"); }} />
          </label>
        ))}
        <div className="hint">Migrate runs on request. Teardown runs when removing a worktree with database cleanup enabled.</div>
      </div>
    </>
  );
}
