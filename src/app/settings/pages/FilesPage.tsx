// Provisioned files — what gets seeded or templated into a new worktree.
import { useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { errText, hasBackend, type ProvisionFormat } from "../../../ipc";
import { Copy, Doc, Finder, Plus, Trash, X } from "../../../icons";
import { uid, type FileCardT } from "../provision";
import { Toggle, InsertVar } from "../primitives";
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
  const keyRef = useRef<{ file: string; key: string } | null>(null);
  const patch = (p: Partial<FileCardT>) => { if (!sel) return; setCards(cards.map((c) => (c.id === sel.id ? { ...c, ...p } : c))); markDirty("files"); };
  const setKey = (i: number, which: 0 | 1, val: string) => sel && patch({ keys: sel.keys.map((k, j) => (j === i ? (which ? { ...k, v: val } : { ...k, k: val }) : k)) });
  const insert = (tok: string) => {
    const target = keyRef.current;
    if (!target || !sel || target.file !== sel.id || !sel.keys.some((k) => k.id === target.key)) { flash("Select a value field first, then insert"); return; }
    patch({ keys: sel.keys.map((k) => (k.id === target.key ? { ...k, v: (k.v || "") + tok } : k)) });
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
    <div className="files-page">
      <div className="files-layout">
        <section className="files-list" aria-label="Provisioned files">
          <div className="files-toolbar"><h3>Provisioned files</h3><span className="hint">{cards.length} configured</span></div>
          {cards.length === 0 && <p className="hint">Add a file to copy or configure in each worktree.</p>}
          {cards.map((f) => (
            <div className={"file-item" + (sel?.id === f.id ? " selected" : "")} key={f.id}>
              <button className="file-select" aria-pressed={sel?.id === f.id} onClick={() => { setSelId(f.id); keyRef.current = null; }}>
                <Doc size={14} /><span><b>{f.path || "New file"}</b><small>{f.format} · {f.format === "text" ? "Copy file" : `${f.keys.length} keys`}</small></span>
              </button>
              <div className="file-actions">
                <button className="ico" aria-label={`Duplicate ${f.path || "new file"}`} onClick={() => { const n = { ...f, id: uid("f"), path: f.path + ".copy", keys: f.keys.map((k) => ({ ...k, id: uid("k") })) }; setCards(cards.concat([n])); setSelId(n.id); keyRef.current = null; markDirty("files"); }}><Copy size={12} /></button>
                <button className="ico bad" aria-label={`Remove ${f.path || "new file"}`} onClick={() => { const rest = cards.filter((x) => x.id !== f.id); setCards(rest); if (sel?.id === f.id) setSelId(rest[0]?.id ?? null); keyRef.current = null; markDirty("files"); }}><Trash size={12} /></button>
              </div>
            </div>
          ))}
          <button className="btn" onClick={() => { const n: FileCardT = { id: uid("f"), path: "", format: "dotenv", from: "", interpolate: false, keys: [] }; setCards(cards.concat([n])); setSelId(n.id); keyRef.current = null; markDirty("files"); }}><Plus size={12} />Add file</button>
        </section>

        {sel && <section className="file-editor" aria-label="File configuration">
          <h3>{sel.path || "New file"}</h3>
          <div className="file-fields">
            <label htmlFor="provision-path">Destination path</label>
            <div className="row"><input id="provision-path" className="inp mono gr" value={sel.path} placeholder=".env or config/app.json" onChange={(e) => patch({ path: e.target.value })} /><button className="ico" aria-label="Browse destination file" onClick={() => browse("path")}><Finder size={14} /></button></div>
            <label htmlFor="provision-format">Format</label>
            <select id="provision-format" className="inp" value={sel.format} onChange={(e) => patch({ format: e.target.value as ProvisionFormat })}>{FMTS.map((f) => <option key={f} value={f}>{f}</option>)}</select>
            <label htmlFor="provision-source">Source template</label>
            <div className="row"><input id="provision-source" className="inp mono gr" value={sel.from} placeholder="Same path in the repository root" onChange={(e) => patch({ from: e.target.value })} /><button className="ico" aria-label="Browse source template" onClick={() => browse("from")}><Finder size={14} /></button></div>
          </div>
          <p className="hint">Paths are relative to the worktree root. An empty source uses the same path in the repository.</p>
          <div className="file-behavior"><b>{sel.format === "text" ? "Copy source file" : "Add or update keys"}</b><span className="hint">{sel.format === "text" ? "Copies the source to the destination. Template interpolation is optional." : "Named values override matching keys; other keys are preserved."}</span></div>
          {sel.format === "text" ? <div className="tglrow"><span className="tt"><b>Interpolate template variables</b><span>Replace variable tokens while copying.</span></span><Toggle label="Interpolate template variables" on={sel.interpolate} onClick={() => patch({ interpolate: !sel.interpolate })} /></div> : <>
            <div className="files-toolbar"><h3>Values <span className="hint">{sel.keys.length} keys</span></h3><InsertVar onPick={insert} /></div>
            {sel.keys.length === 0 && <p className="hint">No overrides. The file is provisioned as-is.</p>}
            <div className="file-values">{sel.keys.map((k, i) => <div className="file-value-row" key={k.id}>
              <label><span className="kvhead">Key</span><input className="inp mono" value={k.k} placeholder="KEY" onChange={(e) => setKey(i, 0, e.target.value)} /></label>
              <label><span className="kvhead">Value</span><input className="inp mono" value={k.v} placeholder="value or ${VARIABLE}" onFocus={() => { keyRef.current = { file: sel.id, key: k.id }; }} onChange={(e) => setKey(i, 1, e.target.value)} /></label>
              <button className="ico bad" aria-label={`Remove key ${k.k || i + 1}`} onClick={() => { keyRef.current = null; patch({ keys: sel.keys.filter((_, j) => j !== i) }); }}><X size={12} /></button>
            </div>)}</div>
            <button className="btn sm gh" onClick={() => patch({ keys: sel.keys.concat([{ id: uid("k"), k: "", v: "" }]) })}><Plus size={12} />Add key</button>
          </>}
          <details className="adv"><summary>Provisioning behavior</summary><p className="hint">Applied on create and reset. Separate conflict policies and file permissions are not configurable yet.</p></details>
        </section>}
      </div>
      <section className="files-lifecycle"><h3>Lifecycle commands</h3><p className="hint">Migrate runs on request. Teardown runs when removing a worktree with database cleanup enabled.</p><div className="files-lifecycle-grid">
        {(["migrate", "teardown"] as const).map((kind) => <label key={kind}><span>{kind === "migrate" ? "Migrate" : "Teardown"}</span><textarea className="inp mono" aria-label={`${kind} commands`} rows={3} value={extras[kind].join("\n")} placeholder="One command per line" onChange={(e) => { setExtras({ ...extras, [kind]: e.target.value.split("\n") }); markDirty("files"); }} /></label>)}
      </div></section>
    </div>
  );
}
