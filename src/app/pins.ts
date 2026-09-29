/* Worktree pinning — what keeps the two or three worktrees you actually live
   in above a long tail of branches.

   The pin set lives in `Settings` (see settings.rs) and is denormalized onto
   every `WorktreeNode` as `pinned`, so this module is a thin read of the tree
   plus one command. That fixes the three things localStorage got wrong: the
   popover window shares the state, pins travel with the config file like every
   other preference, and removing a worktree prunes its entry. */
import { hasBackend, ipc } from "../ipc";
import { useStore } from "../store";
import type { WorktreeNode } from "../types";

export function isPinned(wt: WorktreeNode): boolean {
  return wt.pinned;
}

/** Flip a worktree's pin. The backend persists and republishes the tree, so
    there is no local state to reconcile — every window re-renders from the
    same `tree:changed`. */
export function togglePin(wt: WorktreeNode) {
  if (!hasBackend()) {
    // no-backend dev build: keep the interaction alive against the mock tree
    useStore.setState((st) => ({
      tree: st.tree.map((r) => ({
        ...r,
        worktrees: r.worktrees.map((w) => (w.wtKey === wt.wtKey ? { ...w, pinned: !w.pinned } : w)),
      })),
    }));
    return;
  }
  ipc.setWorktreePinned(wt.wtKey, !wt.pinned).catch(() => {});
}
