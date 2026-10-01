/* Database tools — the searchable switcher plus the real action set.

   Snapshots are a NAME prompt defaulting to {db}_snap_<timestamp>, not a
   managed list, and restore reads a dump from disk — that is what the backend
   actually does, so that is what the dialog offers. Confirmations are past
   tense and unremarkable: "Snapshot … created", "Now using tj_main". */
import { useEffect, useState } from "react";
import { Database, Download, Info, Refresh, Restart, Pull, Spinner } from "../../icons";
import { errText, hasBackend, ipc } from "../../ipc";
import { opTail, useStore } from "../../store";
import type { WorktreeNode } from "../../types";
import RestoreDatabaseModal from "./RestoreDatabaseModal";
import Modal, { Hint, Spacer, usePrimaryAction } from "./Modal";

/** Which long-running database job is in flight. Only one runs at a time —
    they all take the worktree's op lease in the backend, so offering a second
    would only produce a "busy" error. */
type Job = "migrate" | "reset" | "snapshot" | "export" | "restore" | null;

/** Names a job in a failure notice, where "reset failed" has to make sense
    with the dialog long gone. */
const JOB_LABEL: Record<Exclude<Job, null>, string> = {
  migrate: "Migration failed",
  reset: "Database reset failed",
  snapshot: "Snapshot failed",
  export: "Database export failed",
  restore: "Database restore failed",
};

const snapDefault = (db: string) => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${db}_snap_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};

export default function DatabaseModal({ wt, onClose }: { wt: WorktreeNode; onClose: () => void }) {
  const showToast = useStore((s) => s.showToast);
  const resetDb = useStore((s) => s.resetDb);
  // reset is fire-and-forget over reset:status events, so its progress lives in
  // the store — the dialog reads it rather than keeping a second copy
  const resetting = useStore((s) => !!s.resetting[wt.wtKey]);
  const notify = useStore((s) => s.notify);
  const [dbs, setDbs] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(wt.dbName);
  const [q, setQ] = useState("");
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [snap, setSnap] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [job, setJob] = useState<Job>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasBackend()) return;
    ipc.listDatabases(wt.wtKey).then(setDbs).catch(() => {});
    ipc.currentDatabase(wt.wtKey).then(setCurrent).catch(() => {});
  }, [wt.wtKey]);

  const busy = switching || job !== null || resetting;
  const list = dbs.filter((d) => d.toLowerCase().includes(q.toLowerCase()));

  /** Run one database job with a spinner on its own row, and keep the dialog
      open until it finishes — these take seconds to minutes, and closing on
      "started" made every one of them look instantaneous. */
  const run = async (which: Exclude<Job, null>, work: () => Promise<void>, ok: string) => {
    if (busy) return;
    setJob(which);
    setError(null);
    try {
      await work();
      showToast(ok);
      onClose();
    } catch (e) {
      setError(errText(e));
      // The footer offers "Run in background" while this runs, so the dialog
      // may well be gone by now — and then setError writes to nothing and the
      // failure is silent. Same contract as a backgrounded create or remove:
      // the outcome goes to the attention queue, with the log that explains it.
      notify({
        kind: "error",
        title: JOB_LABEL[which],
        wt: wt.branch,
        wtKey: wt.wtKey,
        detail: [errText(e), opTail(wt.wtKey)].filter(Boolean).join("\n\n"),
      });
    } finally {
      setJob((j) => (j === which ? null : j));
    }
  };

  const switchTo = async (name: string) => {
    if (name === current || !hasBackend() || busy) return;
    setSwitching(true);
    try {
      await ipc.switchDatabase(wt.wtKey, name);
      setCurrent(name);
      showToast(`Now using ${name}`);
    } catch (e) {
      showToast(errText(e));
    } finally {
      setSwitching(false);
    }
  };

  const createSnapshot = async () => {
    const name = (snap ?? "").trim();
    if (!name || busy) return;
    setJob("snapshot");
    try {
      if (hasBackend()) await ipc.snapshotDatabase(wt.wtKey, name);
      showToast(`Snapshot ${name} created`);
      setSnap(null);
    } catch (e) {
      showToast(errText(e));
    } finally {
      setJob(null);
    }
  };

  /* The snapshot step is a single named field, so ⏎ commits it — the ordinary
     behaviour of a name prompt. The main view deliberately has no ⏎: its only
     field is the database search, and running a migration from a search box
     would be a nasty surprise. */
  usePrimaryAction("enter", snap !== null && !!snap.trim() && !busy, createSnapshot);

  if (restoreOpen) return <RestoreDatabaseModal wt={wt} onClose={onClose} />;

  /* ── the snapshot name prompt is its own step, not a separate dialog ── */
  if (snap !== null) {
    return (
      <Modal
        icon={Database}
        title="Save snapshot"
        sub={current ?? undefined}
        narrow
        onClose={() => setSnap(null)}
        foot={
          <>
            <Spacer />
            {/* the snapshot is backend-owned and can take a while; dismissing
                lets it finish rather than holding the dialog hostage */}
            <button className="cx-btn cx-btn--ghost" onClick={() => setSnap(null)}>
              {busy ? "Run in background" : "Cancel"}
            </button>
            <button
              className="cx-btn cx-btn--primary"
              disabled={!snap.trim() || busy}
              onClick={createSnapshot}
            >
              {job === "snapshot" ? (
                <>
                  <Spinner size={12} />
                  Creating…
                </>
              ) : (
                <>
                  Create
                  <span className="cx-k">⏎</span>
                </>
              )}
            </button>
          </>
        }
      >
        <div className="cxm-fld">
          <div className="cxm-flab cxm-flab--f">Snapshot name</div>
          <input
            className="cx-input cx-input--mono"
            value={snap}
            autoFocus
            spellCheck={false}
            onChange={(e) => setSnap(e.target.value)}
          />
          <div className="cxm-fhint">Copies {current} as it is right now. Restore it later from the actions list.</div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      icon={Database}
      title="Database"
      sub={current ? `${current} · isolated to this worktree` : "not configured"}
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <Hint icon={Info}>
            {busy ? "This runs in the worktree — it can take a while" : "Each worktree gets its own database"}
          </Hint>
          <Spacer />
          <button className="cx-btn cx-btn--ghost" onClick={onClose}>
            {busy ? "Run in background" : "Close"}
          </button>
          <button
            className="cx-btn cx-btn--primary"
            disabled={busy}
            onClick={() =>
              run("migrate", async () => {
                if (hasBackend()) await ipc.runMigration(wt.wtKey);
              }, "Migration complete")
            }
          >
            {job === "migrate" ? (
              <>
                <Spinner size={12} />
                Migrating…
              </>
            ) : (
              <>
                <Restart size={12} />
                Run migration
              </>
            )}
          </button>
        </>
      }
    >
      <div className="cxm-fld">
        <div className="cxm-flab">
          <Database size={11} />
          Switch database
        </div>
        <div className="cxm-pick-f" style={{ marginBottom: "var(--sp-tight)" }}>
          <input placeholder="Search databases…" value={q} spellCheck={false} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="cxm-dbl">
          {list.length === 0 ? (
            <div className="cxm-pick-e">{dbs.length ? `No databases match “${q}”.` : "No databases found."}</div>
          ) : (
            list.map((d) => (
              <button key={d} className={"cxm-dbo" + (d === current ? " is-on" : "")} onClick={() => switchTo(d)}>
                <span className="ic">
                  <Database size={11} />
                </span>
                {d}
                {d === current && <span className="cx-tag" style={{ marginLeft: "auto" }}>current</span>}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="cxm-fld">
        <div className="cxm-flab">Actions</div>
        <button className="cxm-act" disabled={busy} onClick={() => setSnap(snapDefault(current ?? "db"))}>
          <span className="ic">
            <Pull size={13} />
          </span>
          Save snapshot…
          <span className="sub">{current}_snap_…</span>
        </button>
        <button
          className="cxm-act"
          disabled={busy}
          onClick={async () => {
            if (!hasBackend()) return showToast("Export needs the desktop app");
            const { save } = await import("@tauri-apps/plugin-dialog");
            const path = await save({ defaultPath: `${current}.dump`, title: "Export database" });
            if (!path) return;
            run("export", () => ipc.exportDatabase(wt.wtKey, path), `Exported ${current}`);
          }}
        >
          <span className="ic">{job === "export" ? <Spinner size={12} /> : <Download size={12} />}</span>
          {job === "export" ? "Exporting…" : "Export to file…"}
          <span className="sub">{current}.dump</span>
        </button>
        <button
          className="cxm-act"
          disabled={busy}
          onClick={async () => {
            if (!hasBackend()) return showToast("Restore needs the desktop app");
            setRestoreOpen(true);
          }}
        >
          <span className="ic">{job === "restore" ? <Spinner size={12} /> : <Refresh size={12} />}</span>
          {job === "restore" ? "Restoring…" : "Restore from file…"}
          <span className="sub">.dump · .backup · .sql</span>
        </button>
        <button
          className="cxm-act cxm-act--danger"
          disabled={busy}
          onClick={() =>
            run(
              "reset",
              async () => {
                // reset_db awaits the drop + re-seed, so the invoke IS the
                // progress signal.
                if (hasBackend()) return ipc.resetDb(wt.wtKey);
                // Browser-only: the mock reports through the same `resetting`
                // flag, so wait for it to clear rather than claiming success
                // the instant the call returns.
                resetDb(wt.wtKey);
                await new Promise<void>((resolve) => {
                  const un = useStore.subscribe((s) => {
                    if (!s.resetting[wt.wtKey]) {
                      un();
                      resolve();
                    }
                  });
                });
              },
              "Database reset",
            )
          }
        >
          <span className="ic">{resetting || job === "reset" ? <Spinner size={12} /> : <Restart size={12} />}</span>
          {resetting || job === "reset" ? "Resetting…" : "Reset database"}
          <span className="sub">drops and re-seeds</span>
        </button>
      </div>

      {error && (
        <div className="cx-alert cx-alert--error" style={{ marginTop: "var(--sp-modal-head)" }}>
          <div>{error}</div>
        </div>
      )}
    </Modal>
  );
}
