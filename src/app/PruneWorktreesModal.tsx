/* Sync-prune — reconcile worktrees whose folders were deleted outside Canopod.

   Reached from the Sync button when the rescan finds git-prunable worktrees.
   Pruning removes their stale git registration; per-item you can also delete the
   branch and drop the orphaned database. The folder (and any uncommitted work)
   is already gone, so there's nothing left to warn about losing. */
import { useState } from "react";
import { errText, hasBackend, ipc, type PrunableWorktree, type PruneItem } from "../ipc";
import { useStore } from "../store";
import { Alert, Info, Spinner, Trash } from "../icons";
import Modal, { Hint, Spacer } from "./canopod/Modal";

type Item = PrunableWorktree & { dbName: string | null };
type Opt = { branch: boolean; db: boolean };

export default function PruneWorktreesModal({ items, onClose }: { items: Item[]; onClose: () => void }) {
  const showToast = useStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // per-item choices: drop the db by default (it's orphaned), keep the branch
  const [opts, setOpts] = useState<Record<string, Opt>>(() =>
    Object.fromEntries(items.map((i) => [i.path, { branch: false, db: !!i.dbName }])),
  );

  const set = (path: string, patch: Partial<Opt>) => setOpts((o) => ({ ...o, [path]: { ...o[path], ...patch } }));

  async function prune() {
    setBusy(true);
    setError(null);
    try {
      if (!hasBackend()) {
        showToast("Pruning needs the desktop app");
        return;
      }
      const payload: PruneItem[] = items.map((i) => ({
        repoId: i.repoId,
        branch: i.branch,
        deleteBranch: opts[i.path].branch,
        dropDb: opts[i.path].db && !!i.dbName,
        dbName: i.dbName,
      }));
      await ipc.pruneWorktrees(payload);
      showToast(`Pruned ${items.length} missing worktree${items.length === 1 ? "" : "s"}`);
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      icon={Trash}
      danger
      title={`${items.length} missing worktree${items.length === 1 ? "" : "s"}`}
      sub="folders deleted on disk"
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <Hint icon={Info}>Pruning only removes git's stale entry unless you tick more</Hint>
          <Spacer />
          <button className="cx-btn cx-btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="cx-btn cx-btn--danger" onClick={prune} disabled={busy}>
            {busy ? (
              <>
                <Spinner size={12} />
                Pruning…
              </>
            ) : (
              <>
                <Trash size={12} />
                Prune {items.length}
              </>
            )}
          </button>
        </>
      }
    >
      <p style={{ fontSize: "var(--fs-body)", color: "var(--text-secondary)", lineHeight: "var(--lh-body)", margin: "0 0 var(--sp-modal-head)" }}>
        These worktrees' folders are gone from disk. Canopod will drop their git registration. Choose per worktree whether to also delete
        its branch or drop its leftover database.
      </p>

      <div className="cxm-flist">
        {items.map((i) => (
          <div className="cxm-frow" key={i.path}>
            <span className="cxm-pth">
              <i>{i.repoName}</i> · {i.branch}
            </span>
            <label className="cxm-popt">
              <input type="checkbox" checked={opts[i.path].branch} disabled={busy} onChange={(e) => set(i.path, { branch: e.target.checked })} />
              branch
            </label>
            {i.dbName ? (
              <label className="cxm-popt" title={i.dbName}>
                <input type="checkbox" checked={opts[i.path].db} disabled={busy} onChange={(e) => set(i.path, { db: e.target.checked })} />
                db
              </label>
            ) : (
              <span className="cxm-popt cxm-popt--none" title="No database recorded for this worktree">
                no db
              </span>
            )}
          </div>
        ))}
      </div>

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
