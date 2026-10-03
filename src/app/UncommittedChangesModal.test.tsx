import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import * as bridge from "../ipc";
import type { StatusEntry } from "../ipc";
import type { WorktreeNode } from "../types";
import UncommittedChangesModal from "./UncommittedChangesModal";
const wt = { wtKey: '/repo', branch: 'feature/checkout', git: { ahead: 0 }, services: [] } as unknown as WorktreeNode;
const files: StatusEntry[] = [
  { code: ' M', path: 'src/components/Checkout.tsx', sub: false },
  { code: ' D', path: 'src/old/Deleted.tsx', sub: false },
  { code: 'R ', path: 'src/New.tsx', from: 'src/Old.tsx', sub: false },
  { code: '??', path: 'tests/New.test.ts', sub: false },
];
beforeEach(() => {
  vi.spyOn(bridge, 'hasBackend').mockReturnValue(true);
  vi.spyOn(bridge.ipc, 'worktreeStatus').mockResolvedValue(files);
  vi.spyOn(bridge.ipc, 'worktreeCommit').mockResolvedValue();
  vi.spyOn(bridge.ipc, 'worktreeStash').mockResolvedValue('stash@{0}');
  vi.spyOn(bridge.ipc, 'worktreeDiscard').mockResolvedValue();
  vi.spyOn(bridge.ipc, 'openFileInEditor').mockResolvedValue();
});
const open = (close = vi.fn()) => render(<UncommittedChangesModal wt={wt} onClose={close} />);
it("shows filenames with full-path tooltips, preserves rename identity, and never opens deleted files", async () => {
  const user = userEvent.setup(); open();
  const row = await screen.findByRole('button', { name: 'Open src/components/Checkout.tsx in editor' });
  expect(row).toHaveTextContent('Checkout.tsx'); expect(row).not.toHaveTextContent('src/components/'); expect(row).toHaveAttribute('title', 'src/components/Checkout.tsx');
  expect(screen.getByTitle('src/Old.tsx → src/New.tsx')).toHaveTextContent('Old.tsx → New.tsx');
  expect(screen.queryByRole('button', { name: /Open.*Deleted/ })).not.toBeInTheDocument();
  await user.click(row); expect(bridge.ipc.openFileInEditor).toHaveBeenCalledWith('/repo', 'src/components/Checkout.tsx');
});
it("keeps filtering informational and updates included counts with the chosen action scope", async () => {
  const user = userEvent.setup(); open(); await screen.findByText(/4 changed/);
  expect(screen.getByText(/3 included/)).toBeInTheDocument();
  await user.type(screen.getByLabelText('Filter changed files'), 'checkout');
  expect(screen.getByText(/Showing 1 of 4/)).toHaveTextContent('action still applies to all 4');
  await user.click(screen.getByRole('checkbox', { name: /(?:Include|Also add) 1 untracked file/ }));
  expect(screen.getByText(/4 included/)).toBeInTheDocument();
  await user.type(screen.getByLabelText(/Commit message/), 'fix checkout');
  await user.click(screen.getByRole('button', { name: /Commit 4 files/ }));
  await waitFor(() => expect(bridge.ipc.worktreeCommit).toHaveBeenCalledWith('/repo', 'fix checkout', true));
});
it("uses the stash name and include-untracked setting without invoking commit", async () => {
  const user = userEvent.setup(); open(); await screen.findByText(/4 changed/);
  await user.click(screen.getByRole('button', { name: 'Stash' }));
  await user.type(screen.getByLabelText(/Stash name/), 'checkout WIP');
  await user.click(screen.getByRole('checkbox', { name: /(?:Include|Also add) 1 untracked file/ }));
  await user.click(screen.getByRole('button', { name: /Stash 4 files/ }));
  await waitFor(() => expect(bridge.ipc.worktreeStash).toHaveBeenCalledWith('/repo', 'checkout WIP', true));
  expect(bridge.ipc.worktreeCommit).not.toHaveBeenCalled();
});
it("requires typed confirmation before deleting untracked files and clears confirmation when scope changes", async () => {
  const user = userEvent.setup(); open(); await screen.findByText(/4 changed/);
  await user.click(screen.getByRole('button', { name: 'Discard' }));
  const clean = screen.getByRole('checkbox', { name: /Also delete/ }); await user.click(clean);
  const submit = screen.getByRole('button', { name: 'Discard 4 files' }); expect(submit).toBeDisabled();
  await user.type(screen.getByLabelText('Type discard to confirm'), 'discard'); expect(submit).toBeEnabled();
  await user.click(clean); await user.click(clean); expect(screen.getByLabelText('Type discard to confirm')).toHaveValue(''); expect(submit).toBeDisabled();
  await user.type(screen.getByLabelText('Type discard to confirm'), 'discard'); await user.click(submit);
  await waitFor(() => expect(bridge.ipc.worktreeDiscard).toHaveBeenCalledWith('/repo', true));
});
it.each(['commit', 'stash'])("blocks %s for unresolved conflicts and all operations for submodule-only changes", async mode => {
  vi.mocked(bridge.ipc.worktreeStatus).mockResolvedValueOnce([{ code: 'UU', path: 'conflicted.ts', sub: false }]);
  const user = userEvent.setup(); const { unmount } = open(); await screen.findByText(/1 changed/);
  if (mode === 'stash') await user.click(screen.getByRole('button', { name: 'Stash' }));
  expect(screen.getByRole('button', { name: new RegExp(`${mode === 'commit' ? 'Commit' : 'Stash'} 1 file`) })).toBeDisabled();
  unmount(); vi.mocked(bridge.ipc.worktreeStatus).mockResolvedValueOnce([{ code: ' M', path: 'modules/shared', sub: true }]);
  open(); await screen.findByText(/1 changed/);
  for (const label of ['Commit', 'Stash', 'Discard']) { await user.click(screen.getByRole('button', { name: label })); expect(screen.getByRole('button', { name: new RegExp(`${label} 1 file`) })).toBeDisabled(); }
});
it("retains the message after a failed commit and permits retry", async () => {
  vi.mocked(bridge.ipc.worktreeCommit).mockRejectedValueOnce(new Error('pre-commit hook failed'));
  const user = userEvent.setup(), close = vi.fn(); open(close); await screen.findByText(/4 changed/);
  await user.type(screen.getByLabelText(/Commit message/), 'fix checkout'); await user.click(screen.getByRole('button', { name: /Commit 3 files/ }));
  await screen.findByText('pre-commit hook failed'); expect(close).not.toHaveBeenCalled(); expect(screen.getByLabelText(/Commit message/)).toHaveValue('fix checkout');
  await user.click(screen.getByRole('button', { name: /Commit 3 files/ })); await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
});
it("fails closed when the working-tree status cannot be read", async () => {
  vi.mocked(bridge.ipc.worktreeStatus).mockRejectedValueOnce(new Error('status unavailable')); open();
  await screen.findByText('status unavailable'); expect(screen.queryByRole('button', { name: /^Commit/ })).not.toBeInTheDocument();
  expect(bridge.ipc.worktreeCommit).not.toHaveBeenCalled(); expect(bridge.ipc.worktreeDiscard).not.toHaveBeenCalled();
});
