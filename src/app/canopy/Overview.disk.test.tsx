// #55 — the Size column measures on request, never on open.
//
// A recursive walk of a few node_modules trees is hundreds of thousands of
// stat calls. Opening the overview is not a request to pay that for every
// worktree at once, so the column offers the walk instead of starting it.
// These tests exist so it can't quietly regress to scanning on mount.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Overview from "./Overview";
import { useStore } from "../../store";
import type { RepoNode } from "../../types";

const TREE: RepoNode[] = [{
  repoId: "r1", name: "ToolJet", path: "/r1", branch: "main",
  worktrees: [{
    wtKey: "/r1/.worktrees/fix-a", repoId: "r1", name: "fix-a", branch: "fix-a",
    path: "/r1/.worktrees/fix-a", isMain: false, services: [], ahead: 0, behind: 0,
    dirty: false, dbName: null, submodules: [],
  }],
} as unknown as RepoNode];

const scanDisk = vi.fn();

beforeEach(() => {
  scanDisk.mockClear();
  useStore.setState({ tree: TREE, disk: {}, sessions: {}, stats: {}, scanDisk });
});

const open = () => render(
  <Overview attn={[]} onSelect={() => {}} onOpenTerminal={() => {}} onRunNext={() => {}} sideHidden={false} onShowSide={() => {}} />,
);

describe("the Size column", () => {
  it("measures nothing when the overview opens", () => {
    open();
    expect(scanDisk).not.toHaveBeenCalled();
  });

  it("offers the walk instead of starting it", async () => {
    open();
    expect(await screen.findByRole("button", { name: /measure/i })).toBeInTheDocument();
  });

  it("measures only the row that was clicked", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: /measure/i }));
    expect(scanDisk).toHaveBeenCalledTimes(1);
    expect(scanDisk).toHaveBeenCalledWith(["/r1/.worktrees/fix-a"]);
  });

  it("shows a figure already in the cache without asking for a new walk", async () => {
    useStore.setState({ disk: { "/r1/.worktrees/fix-a": { bytes: 1.4 * 1024 ** 3, scannedAt: 1_700_000_000, partial: false } } });
    open();
    expect(await screen.findByText("1.4 GB")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /measure/i })).toBeNull();
    expect(scanDisk).not.toHaveBeenCalled();
  });

  it("marks a truncated walk as a lower bound rather than a figure", async () => {
    useStore.setState({ disk: { "/r1/.worktrees/fix-a": { bytes: 1.4 * 1024 ** 3, scannedAt: 1_700_000_000, partial: true } } });
    open();
    expect(await screen.findByText(/≥/)).toBeInTheDocument();
  });
});
