import type { RepoNode, WorktreeNode } from "../types";

export function addedWorktrees(before: RepoNode[], after: RepoNode[]): WorktreeNode[] {
  const known = new Set(before.flatMap((repo) => repo.worktrees.map((worktree) => worktree.wtKey)));
  return after.flatMap((repo) => repo.worktrees.filter((worktree) => !known.has(worktree.wtKey)));
}

export function syncMessage(added: WorktreeNode[]): string {
  if (added.length === 0) return "Worktrees are already in sync";
  if (added.length === 1) return `Synced external worktree — ${added[0].branch}`;
  return `Synced ${added.length} external worktrees`;
}
