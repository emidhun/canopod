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
  const demo = import.meta.env.DEV && !hasBackend() && new URLSearchParams(window.location.search).get("review") === "database";
  const showToast = useStore((s) => s.showToast);
  const resetDb = useStore((s) => s.resetDb);
  // reset is fire-and-forget over reset:status events, so its progress lives in
  // the store — the dialog reads it rather than keeping a second copy
  const resetting = useStore((s) => !!s.resetting[wt.wtKey]);
  const notify = useStore((s) => s.notify);
  const [dbs, setDbs] = useState<string[]>(import.meta.env.DEV && !hasBackend() && new URLSearchParams(window.location.search).get("review") === "database" ? [wt.dbName || "checkout_dev", "checkout_snapshot"] : []);
  const [loadingDatabases, setLoadingDatabases] = useState(hasBackend());
  const [databaseError, setDatabaseError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [current, setCurrent] = useState<string | null>(wt.dbName ?? (demo ? "checkout_dev" : null));
  const [q, setQ] = useState("");
  const [restoreOpen, setRestoreOpen] = useState(() => import.meta.env.DEV && !hasBackend() && new URLSearchParams(window.location.search).get("review") === "restore");
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetAcknowledged, setResetAcknowledged] = useState(false);
  const tree = useStore((s) => s.tree);
  const repo = tree.find((r) => r.worktrees.some((w) => w.wtKey === wt.wtKey));
  const [snap, setSnap] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [job, setJob] = useState<Job>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasBackend()) return;
    let active = true;
    setLoadingDatabases(true);
    setDatabaseError(null);
    setCurrent(null);
    Promise.all([ipc.listDatabases(wt.wtKey), ipc.currentDatabase(wt.wtKey)])
      .then(([names, destination]) => { if (active) { setDbs(names); setCurrent(destination); } })
      .catch((e) => { if (active) setDatabaseError(errText(e)); })
      .finally(() => { if (active) setLoadingDatabases(false); });
    return () => { active = false; };
  }, [wt.wtKey, loadRevision]);

  const busy = switching || job !== null || resetting;
  const list = dbs.filter((d) => d.toLowerCase().includes(q.toLowerCase()));

  /** Run one database job with a spinner on its own row, and keep the dialog
      open until it finishes — these take seconds to minutes, and closing on
      "started" made every one of them look instantaneous. */
  const run = async (which: Exclude<Job, null>, work: () => Promise<void>, ok: string) => {
    if (busy || loadingDatabases || databaseError) return;
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

  const performReset = () => {
    if (!resetAcknowledged || !current || busy) return;
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
            );
  };

  if (confirmReset) return <Modal danger icon={Database} title="Reset this database?" sub={wt.branch} busy={busy}
    onClose={() => setConfirmReset(false)} foot={<>
      <button className="cx-btn cx-btn--ghost" onClick={() => setConfirmReset(false)} disabled={busy || loadingDatabases || !!databaseError}>Cancel</button>
      <Spacer />
      <button className="cx-btn cx-btn--danger" disabled={!resetAcknowledged || !current || busy} onClick={performReset}>{busy ? "Resetting…" : "Reset database"}</button>
    </>}>
    <p>This runs the repository’s configured reset command. Existing data may be deleted and reseeded.</p>
    <dl className="cxm-destination"><dt>Repository</dt><dd>{repo?.name ?? "Current repository"}</dd><dt>Worktree</dt><dd>{wt.branch}</dd><dt>Database</dt><dd>{current ?? "Unknown — reset unavailable"}</dd></dl>
    <div className="cx-alert">Reset cannot be undone directly. Cancel and export a backup first if you need to preserve this data.</div>
    <label className="cxm-ack"><input type="checkbox" checked={resetAcknowledged} disabled={busy || loadingDatabases || !!databaseError} onChange={(e) => setResetAcknowledged(e.target.checked)} /><span>I understand this may delete contents of <strong>{current}</strong>.</span></label>
    {error && <div className="cx-alert cx-alert--error" role="alert">{error}</div>}
  </Modal>;

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
          <label className="cxm-flab cxm-flab--f" htmlFor="database-snapshot-name">Snapshot name</label>
          <input
            className="cx-input cx-input--mono"
            id="database-snapshot-name"
            value={snap}
            autoFocus
            spellCheck={false}
            onChange={(e) => setSnap(e.target.value)}
          />
          <div className="cxm-fhint">Copies {current} as it is right now. Choose the copy in “Switch database” to use it.</div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      icon={Database}
      title="Database"
      sub={wt.branch}
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <Hint icon={Info}>
            {busy ? "This runs in the worktree — it can take a while" : "Actions use this worktree’s configured database connection"}
          </Hint>
          <Spacer />
          <button className="cx-btn cx-btn--ghost" onClick={onClose}>
            {busy ? "Run in background" : "Close"}
          </button>
          <button
            className="cx-btn cx-btn--primary"
            disabled={busy || loadingDatabases || !!databaseError || !current}
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
      {demo && <div className="changes-demo">Demo data · no database commands run</div>}
      <dl className="cxm-destination"><dt>Current database</dt><dd>{current ?? "Not configured"}</dd><dt>Worktree</dt><dd>{wt.branch}</dd></dl>
      <div className="cxm-fld">
        <div className="cxm-flab">
          <Database size={11} />
          Switch database
        </div>
        <div className="cxm-pick-f" style={{ marginBottom: "var(--sp-tight)" }}>
          <input aria-label="Search databases" placeholder="Search databases…" value={q} spellCheck={false} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="cxm-dbl">
          {loadingDatabases ? <div className="cxm-pick-e" role="status">Loading databases…</div> : databaseError ? <div className="cx-alert cx-alert--error" role="alert">{databaseError}<button className="cx-btn" onClick={() => setLoadRevision((r) => r + 1)}>Retry</button></div> : list.length === 0 ? (
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
        <button className="cxm-act" disabled={busy || loadingDatabases || !!databaseError || !current} onClick={() => setSnap(snapDefault(current ?? "db"))}>
          <span className="ic">
            <Pull size={13} />
          </span>
          Save snapshot…
          <span className="sub">{current}_snap_…</span>
        </button>
        <button
          className="cxm-act"
          disabled={busy || loadingDatabases || !!databaseError || !current}
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
          disabled={busy || loadingDatabases || !!databaseError}
          onClick={async () => {
            if (!hasBackend() && !demo) return showToast("Restore needs the desktop app");
            setRestoreOpen(true);
          }}
        >
          <span className="ic">{job === "restore" ? <Spinner size={12} /> : <Refresh size={12} />}</span>
          {job === "restore" ? "Restoring…" : "Restore from file…"}
          <span className="sub">.dump · .backup · .sql</span>
        </button>
        <button
          className="cxm-act cxm-act--danger"
          disabled={busy || loadingDatabases || !!databaseError || !current}
          onClick={() => { setResetAcknowledged(false); setConfirmReset(true); }}
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
