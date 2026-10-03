/* Remove worktree — the destructive dialog.

   Warnings say what is lost, concretely: the count, then the actual file list.
   Never "This action cannot be undone." The primary is armed only once the
   branch name is typed back, because the cost here is unrecoverable work in
   private submodule clones, not just a directory. */
import { useEffect, useState } from "react";
import { errText, hasBackend, ipc } from "../ipc";
import { backgroundOp, useStore } from "../store";
import type { WorktreeNode } from "../types";
import { Alert, Info, Spinner, Trash } from "../icons";
import Modal, { Hint, Spacer } from "./canopod/Modal";

/** git::dirty_report truncates `status --porcelain` with .take(10), so a
    result of exactly this length is a floor rather than a total. */
const DIRTY_CAP = 10;

export default function RemoveWorktreeModal({ wt, onClose }: { wt: WorktreeNode; onClose: () => void }) {
  const removeWorktrees = useStore((s) => s.removeWorktrees);
  const [report, setReport] = useState<{ dirty: boolean; details: string[]; total: number } | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [dropDb, setDropDb] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasBackend()) {
      setReport({ dirty: false, details: [], total: 0 });
      return;
    }
    // Fail CLOSED. Treating a failed probe as "clean" would let the dialog
    // assert nothing is uncommitted and arm a destructive delete on the
    // strength of an error.
    ipc
      .worktreeDirtyReport(wt.wtKey)
      .then((r) => {
        setReport(r);
        setProbeError(null);
      })
      .catch((e) => {
        setReport(null);
        setProbeError(errText(e));
      });
  }, [wt.wtKey]);

  const ahead = wt.git?.ahead ?? 0;

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await removeWorktrees([wt.wtKey], deleteBranch, dropDb);
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  /* Teardown (dropping the database, deleting a large tree) can take a while.
     Dismissing hands the job to the background: the sidebar row shows it going,
     and the outcome — including a failure — reports into "Needs you". */
  function runInBackground() {
    backgroundOp(wt.wtKey);
    onClose();
  }

  return (
    <Modal
      icon={Trash}
      danger
      title="Remove worktree"
      sub={wt.branch}
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <Hint icon={Info}>
            {busy ? "Removal keeps running if you close this" : "The branch itself is kept unless you tick it"}
          </Hint>
          <Spacer />
          <button className="cx-btn cx-btn--ghost" onClick={busy ? runInBackground : onClose}>
            {busy ? "Run in background" : "Cancel"}
          </button>
          <button className="cx-btn cx-btn--danger" onClick={remove} disabled={busy || !report || !!probeError}>
            {busy ? (
              <>
                <Spinner size={12} />
                Removing…
              </>
            ) : (
              <>
                <Trash size={12} />
                Remove worktree
              </>
            )}
          </button>
        </>
      }
    >
      {probeError ? (
        <div className="cx-alert cx-alert--error">
          <span className="cx-alert__ic">
            <Alert size={13} />
          </span>
          <div>
            <b>Could not check for uncommitted changes.</b>
            <pre>{probeError}</pre>
            Removal is disabled until this succeeds — deleting without knowing what is here could lose work.
          </div>
        </div>
      ) : !report ? (
        <div className="cxm-prog" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
          <span className="cxm-prog__ic">
            <Spinner size={13} />
          </span>
          <div className="cxm-prog__lines">checking for uncommitted changes…</div>
        </div>
      ) : report.dirty ? (
        <div className="cx-alert cx-alert--error">
          <span className="cx-alert__ic">
            <Alert size={13} />
          </span>
          <div>
            <b>
              {report.details.length >= DIRTY_CAP
                ? `At least ${DIRTY_CAP} uncommitted changes will be lost.`
                : `${report.details.length} uncommitted change${report.details.length === 1 ? "" : "s"} will be lost.`}
            </b>
            <pre>{report.details.join("\n")}</pre>
            {report.details.length >= DIRTY_CAP && (
              <span style={{ color: "var(--red-text-soft)" }}>Showing the first {DIRTY_CAP}; there may be more.</span>
            )}
          </div>
        </div>
      ) : (
        <div className="cx-alert cx-alert--ok">
          <span className="cx-alert__ic">
            <Info size={13} />
          </span>
          <div>Clean — nothing uncommitted in the worktree or its submodules.</div>
        </div>
      )}

      <p
        style={{
          fontSize: "var(--fs-body)",
          color: "var(--text-secondary)",
          lineHeight: "var(--lh-body)",
          margin: "0 0 var(--sp-modal-head)",
        }}
      >
        Deletes <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-small)" }}>{wt.path}</span> and its private
        submodule checkouts. Unpushed commits inside submodules cannot be recovered.
      </p>

      {wt.dbName && (
        <label className="cxm-chk">
          <input type="checkbox" checked={dropDb} onChange={(e) => setDropDb(e.target.checked)} disabled={busy} />
          <span className="cxm-chk__tx">
            <b>Drop database</b>
            <span className="mono">{wt.dbName}</span>
          </span>
        </label>
      )}

      <label className="cxm-chk">
        <input
          type="checkbox"
          checked={deleteBranch}
          onChange={(e) => setDeleteBranch(e.target.checked)}
          disabled={busy}
        />
        <span className="cxm-chk__tx">
          <b>Also delete the branch</b>
          <span>
            {ahead > 0
              ? `${ahead} commit${ahead === 1 ? "" : "s"} not on origin — they would be lost too.`
              : `${wt.branch} is kept unless you tick this.`}
          </span>
        </span>
      </label>

      {error && (
        <div className="cx-alert cx-alert--error" style={{ marginTop: "var(--sp-modal-head)" }}>
          <span className="cx-alert__ic">
            <Alert size={13} />
          </span>
          <div>{error}</div>
        </div>
      )}
    </Modal>
  );
}
