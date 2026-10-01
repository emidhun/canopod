import { describe, expect, it } from "vitest";
import type { RepoNode, WorktreeNode } from "../types";
import { addedWorktrees, syncMessage } from "./syncWorktrees";

const worktree = (wtKey: string, branch: string): WorktreeNode => ({
  wtKey,
  branch,
  path: wtKey,
  isMain: branch === "main",
  git: null,
  dbName: null,
  setup: null,
  setupConfigured: false,
  pinned: false,
  services: [],
});

const repo = (repoId: string, worktrees: WorktreeNode[]): RepoNode => ({
  repoId,
  name: repoId,
  path: `/${repoId}`,
  worktrees,
});

describe("worktree sync", () => {
  it("finds Git worktrees added outside Canopy across repositories", () => {
    const before = [repo("one", [worktree("/one", "main")]), repo("two", [worktree("/two", "main")])];
    const external = worktree("/one/.worktrees/agent-task", "agent-task");
    const another = worktree("/two/.worktrees/review", "review");

    expect(addedWorktrees(before, [repo("one", [before[0].worktrees[0], external]), repo("two", [before[1].worktrees[0], another])])).toEqual([external, another]);
  });

  it("does not report existing or removed worktrees as newly synced", () => {
    const main = worktree("/repo", "main");
    const old = worktree("/repo/.worktrees/old", "old");
    expect(addedWorktrees([repo("repo", [main, old])], [repo("repo", [main])])).toEqual([]);
  });

  it("describes empty, single and multiple discoveries", () => {
    expect(syncMessage([])).toBe("Worktrees are already in sync");
    expect(syncMessage([worktree("/repo/.worktrees/agent-task", "agent-task")])).toBe("Synced external worktree — agent-task");
    expect(syncMessage([worktree("/a", "a"), worktree("/b", "b")])).toBe("Synced 2 external worktrees");
  });
});
