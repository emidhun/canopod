/* Switch branch, in place — the cheap alternative to a new worktree.

   The point of this dialog is the subtitle: switching reuses the dependencies
   already installed here, so it costs ~0s where a new worktree costs a full
   provision. The warning is equally specific — uncommitted work carries over
   rather than being stashed, which is occasionally what you want and
   occasionally a nasty surprise. */
import { useEffect, useMemo, useState } from "react";
import { errText, hasBackend, ipc, type Branches } from "../ipc";
import { useStore } from "../store";
import type { RepoNode, WorktreeNode } from "../types";
import { Alert, Fork, Plus, Search, Spinner, Swap } from "../icons";
import Modal, { Hint, Spacer } from "./canopod/Modal";

export default function SwitchBranchModal({
  repo,
  wt,
  onClose,
}: {
  repo: RepoNode;
  wt: WorktreeNode;
  onClose: () => void;
}) {
  const showToast = useStore((s) => s.showToast);
  const current = wt.branch;

  const [branches, setBranches] = useState<Branches | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // branches checked out in OTHER worktrees of this repo (git blocks re-checkout)
  const inUse = useMemo(
    () => new Set(repo.worktrees.filter((w) => w.wtKey !== wt.wtKey).map((w) => w.branch)),
    [repo.worktrees, wt.wtKey],
  );

  useEffect(() => {
    if (!hasBackend()) {
      setBranches({ local: [], remote: [], tags: [] });
      return;
    }
    ipc
      .listBranches(repo.repoId)
      .then(setBranches)
      .catch(() => setBranches({ local: [], remote: [], tags: [] }));
  }, [repo.repoId]);

  const t = q.trim();
  const groups = useMemo(() => {
    if (!branches) return [];
    const match = (n: string) => !t || n.toLowerCase().includes(t.toLowerCase());
    return [
      { k: "local" as const, label: "Local", items: branches.local.filter(match) },
      { k: "remote" as const, label: "Remote", items: branches.remote.filter(match) },
    ].filter((g) => g.items.length);
  }, [branches, t]);

  const known = useMemo(
    () => new Set([...(branches?.local ?? []), ...(branches?.remote ?? []), ...(branches?.tags ?? [])]),
    [branches],
  );
  const canCreate = !!t && !known.has(t) && !t.startsWith("origin/");

  /** `git checkout origin/foo` detaches HEAD. Switching to a remote row means
      the local short name: reuse it if present, else create it from the remote. */
  async function goRef(ref: string, kind: "local" | "remote" | "new") {
    if (kind === "remote") {
      const local = ref.replace(/^[^/]+\//, "");
      return go(local, !(branches?.local ?? []).includes(local), ref);
    }
    return go(ref, kind === "new");
  }

  async function go(name: string, create: boolean, from?: string) {
    setBusy(true);
    setError(null);
    try {
      if (!hasBackend()) {
        showToast("Switching branch needs the desktop app");
        return;
      }
      await ipc.switchWorktreeBranch(wt.wtKey, name, create, create ? (from ?? current) : undefined);
      showToast(`Switched to ${name} — dependencies reused`);
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      icon={Swap}
      title="Switch branch"
      sub={`on ${current} · reuses dependencies, ~0s setup`}
      narrow
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <Hint icon={Alert} tone="warn">
            Uncommitted changes carry over
          </Hint>
          <Spacer />
          <button className="cx-btn cx-btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </>
      }
    >
      <div className="cxm-pick-f" style={{ marginBottom: "var(--sp-row)" }}>
        <Search size={12} />
        <input
          autoFocus
          value={q}
          spellCheck={false}
          placeholder="Switch to a branch, or type a new name…"
          onChange={(e) => setQ(e.target.value)}
          disabled={busy}
        />
      </div>

      <div style={{ maxHeight: 260, overflowY: "auto", margin: "0 calc(var(--sp-xs) * -1)" }}>
        {!branches && <div className="cxm-pick-e">Loading branches…</div>}

        {canCreate && (
          <button className="cxm-pick-i cxm-pick-i--new" onClick={() => goRef(t, "new")} disabled={busy}>
            <span className="ic">
              <Plus size={12} />
            </span>
            <span className="nm">
              Create branch <b style={{ fontWeight: 600 }}>{t}</b>
            </span>
            <span className="cx-tag">off {current}</span>
          </button>
        )}

        {groups.map((g) => (
          <div key={g.k}>
            <div className="cxm-pick-g">{g.label}</div>
            {g.items.map((n) => {
              const short = g.k === "remote" ? n.replace(/^[^/]+\//, "") : n;
              const isCur = short === current;
              const taken = inUse.has(short) && !isCur;
              return (
                <button
                  key={g.k + n}
                  className={"cxm-pick-i" + (isCur ? " is-on" : "")}
                  disabled={isCur || taken || busy}
                  title={taken ? `${n} is checked out in another worktree` : undefined}
                  onClick={() => goRef(n, g.k)}
                >
                  <span className="ic">
                    <Fork size={12} />
                  </span>
                  <span className="nm">{n}</span>
                  {isCur && <span className="cx-tag">current</span>}
                  {taken && <span className="cx-tag cx-tag--warn">in use</span>}
                </button>
              );
            })}
          </div>
        ))}

        {branches && !groups.length && !canCreate && <div className="cxm-pick-e">No branches match “{q}”.</div>}
      </div>

      {busy && (
        <div className="cxm-prog">
          <span className="cxm-prog__ic">
            <Spinner size={13} />
          </span>
          <div className="cxm-prog__lines">switching…</div>
        </div>
      )}

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
