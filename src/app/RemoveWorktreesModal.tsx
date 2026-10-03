/* Remove several worktrees at once — the bulk counterpart to
   RemoveWorktreeModal, reached from the sidebar's ⌘/⇧-click selection.

   Same contract: say what is lost, concretely (which of the selected worktrees
   have uncommitted changes), then one teal-red primary that names the action.
   No type-to-confirm — the list itself is the confirmation. */
import { useEffect, useMemo, useState } from "react";
import { errText, hasBackend, ipc } from "../ipc";
import { backgroundOp, useStore } from "../store";
import type { WorktreeNode } from "../types";
import { Alert, Info, Spinner, Trash } from "../icons";
import { clear as clearSelection } from "./multiselect";
import Modal, { Hint, Spacer } from "./canopod/Modal";

export default function RemoveWorktreesModal({ wts, onClose }: { wts: WorktreeNode[]; onClose: () => void }) {
  const removeWorktrees = useStore((s) => s.removeWorktrees);
  const [dropDb, setDropDb] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // wtKey → has uncommitted changes (undefined until the probe returns)
  const [probeErrors, setProbeErrors] = useState<Record<string, string>>({});
  const [probeRevision, setProbeRevision] = useState(0);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});

  const withDb = useMemo(() => wts.filter((w) => w.dbName).length, [wts]);
  const dirtyCount = wts.filter((w) => dirty[w.wtKey]).length;

  const checked = wts.length > 0 && wts.every(w => dirty[w.wtKey] !== undefined) && !Object.keys(probeErrors).length;
  useEffect(() => {
    setDirty({}); setProbeErrors({});
    if (!hasBackend()) { setDirty(Object.fromEntries(wts.map(w => [w.wtKey, false]))); return; }
    let alive = true;
    Promise.all(
      wts.map((w) =>
        ipc
          .worktreeDirtyReport(w.wtKey)
          .then((r) => ({ key: w.wtKey, dirty: r.dirty, error: "" }))
          .catch(e => ({ key: w.wtKey, dirty: undefined, error: errText(e) })),
      ),
    ).then((pairs) => {
      if (alive) {
        setDirty(Object.fromEntries(pairs.filter(p => p.dirty !== undefined).map(p => [p.key, p.dirty as boolean])));
        setProbeErrors(Object.fromEntries(pairs.filter(p => p.error).map(p => [p.key, p.error])));
      }
    });
    return () => {
      alive = false;
    };
  }, [wts, probeRevision]);

  async function remove() {
    if (!checked || busy) return;
    setBusy(true);
    setError(null);
    try {
      await removeWorktrees(
        wts.map((w) => w.wtKey),
        deleteBranch,
        dropDb,
      );
      clearSelection();
      onClose();
    } catch (e) {
      // batch is best-effort: some may have gone, some not. Surface the detail;
      // the tree already refreshed, so the sidebar reflects what actually left.
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  /* Removing several worktrees is the longest of these jobs. Dismissing hands
     it off: each row goes into its removing state, and the outcome reports into
     "Needs you" rather than into a dialog that has gone. */
  function runInBackground() {
    wts.forEach((w) => backgroundOp(w.wtKey));
    clearSelection();
    onClose();
  }

  return (
    <Modal
      icon={Trash}
      danger
      title={`Remove ${wts.length} worktrees`}
      sub={!checked ? (Object.keys(probeErrors).length ? "Could not check all worktrees" : "Checking worktrees…") : dirtyCount > 0 ? `${dirtyCount} with uncommitted changes` : "all clean"}
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <Hint icon={Info}>
            {busy ? "Removal keeps running if you close this" : "Branches are kept unless you tick it"}
          </Hint>
          <Spacer />
          <button className="cx-btn cx-btn--ghost" onClick={busy ? runInBackground : onClose}>
            {busy ? "Run in background" : "Cancel"}
          </button>
          <button className="cx-btn cx-btn--danger" onClick={remove} disabled={busy || !checked}>
            {busy ? (
              <>
                <Spinner size={12} />
                Removing…
              </>
            ) : (
              <>
                <Trash size={12} />
                Remove {wts.length} worktrees
              </>
            )}
          </button>
        </>
      }
    >
      {Object.keys(probeErrors).length > 0 && <div className="cx-alert cx-alert--error" role="alert"><div>Removal is disabled until every worktree can be checked.{Object.entries(probeErrors).map(([key, message]) => <p key={key}>{key}: {message}</p>)}<button className="cx-btn cx-btn--sm" onClick={() => setProbeRevision(v => v + 1)}>Retry checks</button></div></div>}
      {dirtyCount > 0 && (
        <div className="cx-alert cx-alert--error">
          <span className="cx-alert__ic">
            <Alert size={13} />
          </span>
          <div>
            <b>
              {dirtyCount} of these {dirtyCount === 1 ? "has" : "have"} uncommitted changes that will be lost.
            </b>{" "}
            Removal forces past a dirty tree; unpushed work in these worktrees and their submodules cannot be recovered.
          </div>
        </div>
      )}

      <div className="cxm-flist">
        {wts.map((w) => (
          <div className="cxm-frow" key={w.wtKey}>
            <span className="cxm-pth">
              <i>{w.branch}</i>
              {w.dbName && <span className="cxm-nt"> · {w.dbName}</span>}
            </span>
            {dirty[w.wtKey] && <span className="cxm-tg cxm-tg--warn">uncommitted</span>}
          </div>
        ))}
      </div>

      {withDb > 0 && (
        <label className="cxm-chk">
          <input type="checkbox" checked={dropDb} onChange={(e) => setDropDb(e.target.checked)} disabled={busy} />
          <span className="cxm-chk__tx">
            <b>Drop databases</b>
            <span>
              {withDb} of the {wts.length} have a database. Off leaves them on the server.
            </span>
          </span>
        </label>
      )}

      <label className="cxm-chk">
        <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} disabled={busy} />
        <span className="cxm-chk__tx">
          <b>Also delete the branches</b>
          <span>Deletes each worktree's local branch too. Unpushed commits on them would be lost.</span>
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
