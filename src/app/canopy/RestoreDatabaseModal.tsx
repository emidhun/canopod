import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Database, Spinner } from "../../icons";
import { errText, ipc } from "../../ipc";
import { opTail, useStore } from "../../store";
import type { WorktreeNode } from "../../types";
import Modal, { Spacer } from "./Modal";

export default function RestoreDatabaseModal({ wt, onClose }: { wt: WorktreeNode; onClose: () => void }) {
  const [databases, setDatabases] = useState<string[]>([]);
  const [target, setTarget] = useState(wt.dbName ?? "");
  const [fresh, setFresh] = useState("");
  const [mode, setMode] = useState<"replace" | "create">("create");
  const [file, setFile] = useState("");
  const [activate, setActivate] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = mode === "create" ? fresh.trim() : target;
  useEffect(() => {
    let alive = true;
    ipc.listDatabases(wt.wtKey).then((names) => {
      if (alive) setDatabases(names.filter((n) => !["postgres", "template0", "template1"].includes(n)));
    }).catch((e) => { if (alive) setError(errText(e)); });
    return () => { alive = false; };
  }, [wt.wtKey]);
  const valid = !!file && !!name && (mode === "create" ? !databases.includes(name) : databases.includes(name) && confirmed);
  async function restore() {
    if (!valid || busy) return;
    setBusy(true); setError("");
    try {
      await ipc.restoreDatabase(wt.wtKey, file, { target: name, mode, activate });
      useStore.getState().showToast(`Restored ${name}${activate ? " — now used by this worktree" : ""}`);
      onClose();
    } catch (e) {
      setError(errText(e));
      useStore.getState().notify({ kind: "error", title: "Database restore failed", wt: wt.branch, wtKey: wt.wtKey, detail: [errText(e), opTail(wt.wtKey)].filter(Boolean).join("\n\n") });
    } finally { setBusy(false); }
  }
  return <Modal icon={Database} title="Restore database" sub={wt.branch} onClose={onClose} busy={busy} foot={<>
    <Spacer />
    <button className="cx-btn cx-btn--ghost" onClick={onClose}>{busy ? "Run in background" : "Cancel"}</button>
    <button className="cx-btn cx-btn--primary" disabled={!valid || busy} onClick={restore}>{busy ? <><Spinner size={12} />Restoring…</> : mode === "replace" ? "Empty and restore" : "Create and restore"}</button>
  </>}>
    <fieldset disabled={busy} className="cx-restore-fields">
      <div className="cxm-fld">
        <label className="cxm-flab" htmlFor="restore-file">Dump file</label>
        <button id="restore-file" className="cx-btn cx-btn--ghost" onClick={async () => {
          try {
            const path = await open({ title: "Choose a database dump", multiple: false, filters: [{ name: "Database dump", extensions: ["dump", "backup", "sql", "tar"] }] });
            if (typeof path === "string") setFile(path);
          } catch (e) { setError(errText(e)); }
        }}>{file || "Choose dump file…"}</button>
      </div>
      <div className="cxm-fld">
        <label className="cxm-flab" htmlFor="restore-mode">Destination</label>
        <select id="restore-mode" className="cx-input" value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setConfirmed(false); }}>
          <option value="create">Create a fresh database</option>
          <option value="replace">Empty an existing database</option>
        </select>
      </div>
      <div className="cxm-fld">
        <label className="cxm-flab" htmlFor="restore-target">{mode === "create" ? "New database name" : "Database to empty"}</label>
        {mode === "create" ? <input id="restore-target" className="cx-input cx-input--mono" value={fresh} onChange={(e) => setFresh(e.target.value)} spellCheck={false} /> :
          <select id="restore-target" className="cx-input" value={target} onChange={(e) => { setTarget(e.target.value); setConfirmed(false); }}><option value="">Select database…</option>{databases.map((d) => <option key={d}>{d}</option>)}</select>}
        {mode === "create" && databases.includes(name) && <div className="cx-alert cx-alert--error">That database already exists. Choose a new name.</div>}
      </div>
      {mode === "replace" && <div className="cxm-fld"><label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I understand that all data in {target || "the selected database"} will be deleted before restore.</label></div>}
      <div className="cxm-fld"><label><input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} /> Use this database for the worktree after a successful restore</label></div>
    </fieldset>
    {error && <div role="alert" className="cx-alert cx-alert--error">{error}</div>}
  </Modal>;
}
