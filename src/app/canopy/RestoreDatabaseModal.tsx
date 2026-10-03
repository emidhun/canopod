import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Database, Spinner } from "../../icons";
import { errText, hasBackend, ipc } from "../../ipc";
import { opTail, useStore } from "../../store";
import type { WorktreeNode } from "../../types";
import Modal, { Hint, Spacer } from "./Modal";

export default function RestoreDatabaseModal({ wt, onClose }: { wt: WorktreeNode; onClose: () => void }) {
  const demo = import.meta.env.DEV && !hasBackend() && ["database", "restore"].includes(new URLSearchParams(window.location.search).get("review") || "");
  const [loading, setLoading] = useState(!demo);
  const [loadError, setLoadError] = useState("");
  const [loadRevision, setLoadRevision] = useState(0);
  const [databases, setDatabases] = useState<string[]>([]);
  const [target, setTarget] = useState(wt.dbName ?? (demo ? "checkout_dev" : ""));
  const [fresh, setFresh] = useState(demo ? "checkout_restored" : "");
  const [mode, setMode] = useState<"replace" | "create">(demo && new URLSearchParams(window.location.search).get("restore-mode") === "replace" ? "replace" : "create");
  const [file, setFile] = useState(demo ? "/sample-data/checkout-seed.sql" : "");
  const [activate, setActivate] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = mode === "create" ? fresh.trim() : target;
  useEffect(() => {
    let alive = true;
    setConfirmed(false);
    if (demo) { setDatabases([wt.dbName || "checkout_dev", "checkout_snapshot"]); setLoading(false); return; }
    setLoading(true); setLoadError("");
    ipc.listDatabases(wt.wtKey).then((names) => {
      if (alive) setDatabases(names.filter((n) => !["postgres", "template0", "template1"].includes(n)));
    }).catch((e) => { if (alive) setLoadError(errText(e)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [wt.wtKey, demo, loadRevision]);
  const nameValid = !!name && new TextEncoder().encode(name).length <= 63 && !/[\x00-\x1f\x7f]/.test(name) && !["postgres", "template0", "template1"].includes(name);
  const valid = !loading && !loadError && !!file && nameValid && (mode === "create" ? !databases.includes(name) : databases.includes(name) && confirmed);
  async function restore() {
    if (!valid || busy) return;
    setBusy(true); setError("");
    try {
      if (demo) { useStore.getState().showToast("Demo restore preview — no database changed"); onClose(); return; }
      await ipc.restoreDatabase(wt.wtKey, file, { target: name, mode, activate });
      useStore.getState().showToast(`Restored ${name}${activate ? " — now used by this worktree" : ""}`);
      onClose();
    } catch (e) {
      setError(errText(e));
      useStore.getState().notify({ kind: "error", title: "Database restore failed", wt: wt.branch, wtKey: wt.wtKey, detail: [errText(e), opTail(wt.wtKey)].filter(Boolean).join("\n\n") });
    } finally { setBusy(false); }
  }
  return <Modal icon={Database} title="Restore database" sub={wt.branch} danger={mode === "replace"} onClose={onClose} busy={busy} foot={<>
    <Hint>Running worktree services stop during restore and restart afterward.</Hint><Spacer />
    <button className="cx-btn cx-btn--ghost" onClick={onClose}>{busy ? "Run in background" : "Cancel"}</button>
    <button className={"cx-btn " + (mode === "replace" ? "cx-btn--danger" : "cx-btn--primary")} disabled={!valid || busy} onClick={restore}>{busy ? <><Spinner size={12} />Restoring…</> : mode === "replace" ? "Replace and restore" : "Create and restore"}</button>
  </>}>
    {demo && <div className="changes-demo">Demo data · no database commands run</div>}
    <dl className="cxm-destination"><dt>Worktree</dt><dd>{wt.branch}</dd><dt>Current database</dt><dd>{wt.dbName || (demo ? "checkout_dev" : "Not configured")}</dd></dl>
    {loading && <div role="status" className="cxm-fhint">Loading databases…</div>}
    {loadError && <div role="alert" className="cx-alert cx-alert--error"><div>Could not load databases. {loadError}<button className="cx-btn" onClick={() => setLoadRevision(r => r + 1)}>Retry</button></div></div>}
    <fieldset disabled={busy} className="cx-restore-fields">
      <div className="cxm-fld">
        <label className="cxm-flab" htmlFor="restore-file">Dump file</label>
        <button id="restore-file" className="cx-btn cx-btn--ghost" onClick={async () => {
          try {
            if (demo) { setFile("/sample-data/checkout-seed.sql"); return; }
            const path = await open({ title: "Choose a database dump", multiple: false, filters: [{ name: "Database dump", extensions: ["dump", "backup", "sql", "tar"] }] });
            if (typeof path === "string") setFile(path);
          } catch (e) { setError(errText(e)); }
        }} title={file || undefined}>{file ? file.split(/[\\/]/).pop() : "Choose dump file…"}</button>
        <div className="cxm-fhint">PostgreSQL SQL or archive dump (.sql, .dump, .backup, .tar).</div>
      </div>
      <div className="cxm-fld">
        <label className="cxm-flab" htmlFor="restore-mode">Destination</label>
        <select id="restore-mode" className="cx-input" value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setConfirmed(false); }}>
          <option value="create">Create a fresh database</option>
          <option value="replace">Replace an existing database</option>
        </select>
      </div>
      <div className="cxm-fld">
        <label className="cxm-flab" htmlFor="restore-target">{mode === "create" ? "New database name" : "Database to replace"}</label>
        {mode === "create" ? <input id="restore-target" className="cx-input cx-input--mono" value={fresh} onChange={(e) => setFresh(e.target.value)} spellCheck={false} /> :
          <select id="restore-target" className="cx-input" value={target} onChange={(e) => { setTarget(e.target.value); setConfirmed(false); }}><option value="">Select database…</option>{databases.map((d) => <option key={d}>{d}</option>)}</select>}
        {mode === "create" && !loading && databases.includes(name) && <div className="cx-alert cx-alert--error">That database already exists. Choose a new name.</div>}
      </div>
      {mode === "create" && name && !nameValid && <div role="alert" className="cx-alert cx-alert--error">Use a non-maintenance database name of at most 63 bytes, without control characters.</div>}
      {mode === "replace" && <div className="cxm-fld"><div className="cx-alert cx-alert--error" role="alert"><div><b>{target || "The selected database"} will be dropped and recreated.</b> Existing data is deleted before importing the dump. If restore fails, the original data is not recovered. No backup is created automatically.</div></div><label className="cxm-ack"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I understand that {target || "the selected database"} will be replaced and its current data lost.</label></div>}
      <div className="cxm-fld"><label><input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} /> Use this database for the worktree after a successful restore</label></div>
    </fieldset>
    {error && <div role="alert" className="cx-alert cx-alert--error">{error}</div>}
  </Modal>;
}
