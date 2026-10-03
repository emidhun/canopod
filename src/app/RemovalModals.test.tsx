import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import * as bridge from '../ipc';
import { useStore } from '../store';
import type { WorktreeNode } from '../types';
import RemoveWorktreeModal from './RemoveWorktreeModal';
import RemoveWorktreesModal from './RemoveWorktreesModal';
import PruneWorktreesModal from './PruneWorktreesModal';
const one = { wtKey: '/repo/one', branch: 'one', services: [], dbName: 'one_db', git: { ahead: 0 } } as unknown as WorktreeNode;
const two = { ...one, wtKey: '/repo/two', branch: 'two', dbName: null };
const clean = { dirty: false, details: [], total: 0 };
beforeEach(() => { vi.spyOn(bridge, 'hasBackend').mockReturnValue(true); vi.spyOn(bridge.ipc, 'worktreeDirtyReport').mockResolvedValue(clean); useStore.setState({ removeWorktrees: vi.fn(async () => {}) }); });
it('single removal waits for a successful status probe and fails closed on error', async () => {
  let reject!: (e: Error) => void; vi.mocked(bridge.ipc.worktreeDirtyReport).mockReturnValue(new Promise((_, no) => { reject = no; }));
  render(<RemoveWorktreeModal wt={one} onClose={vi.fn()} />);
  expect(screen.getByRole('button', { name: /^Remove/ })).toBeDisabled();
  await act(async () => reject(new Error('cannot read status')));
  expect(screen.getByRole('button', { name: /^Remove/ })).toBeDisabled(); expect(useStore.getState().removeWorktrees).not.toHaveBeenCalled();
});
it('bulk removal never claims clean or arms removal before all probes complete', async () => {
  let resolve!: (report: typeof clean) => void; vi.mocked(bridge.ipc.worktreeDirtyReport).mockResolvedValueOnce(clean).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  render(<RemoveWorktreesModal wts={[one,two]} onClose={vi.fn()} />);
  expect(screen.queryByText('all clean')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Remove 2 worktrees' })).toBeDisabled();
  await act(async () => resolve(clean)); expect(screen.getByText('all clean')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Remove 2 worktrees' })).toBeEnabled();
});
it('bulk removal blocks a failed check, allows retry, and invokes only the displayed targets and options', async () => {
  vi.mocked(bridge.ipc.worktreeDirtyReport).mockRejectedValueOnce(new Error('permission denied'));
  const user = userEvent.setup(), close = vi.fn(); render(<RemoveWorktreesModal wts={[one,two]} onClose={close} />);
  await screen.findByRole('alert'); expect(screen.queryByText('all clean')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Remove 2 worktrees' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Retry checks' })); await waitFor(() => expect(screen.getByRole('button', { name: 'Remove 2 worktrees' })).toBeEnabled());
  await user.click(screen.getByRole('checkbox', { name: /Drop databases/ })); await user.click(screen.getByRole('checkbox', { name: /Also delete the branches/ }));
  await user.click(screen.getByRole('button', { name: 'Remove 2 worktrees' }));
  await waitFor(() => expect(useStore.getState().removeWorktrees).toHaveBeenCalledWith(['/repo/one','/repo/two'], true, false)); expect(close).toHaveBeenCalledTimes(1);
});
it('pruning preserves per-item branch and database choices and retains failure details', async () => {
  const prune = vi.spyOn(bridge.ipc,'pruneWorktrees').mockRejectedValueOnce(new Error('database unavailable'));
  const user = userEvent.setup(), close = vi.fn();
  render(<PruneWorktreesModal items={[{ repoId:'repo',repoName:'Repo',path:'/gone/one',branch:'one',dbName:'one_db' },{ repoId:'repo',repoName:'Repo',path:'/gone/two',branch:'two',dbName:null }]} onClose={close} />);
  await user.click(screen.getAllByRole('checkbox', { name:'branch' })[1]); await user.click(screen.getByRole('checkbox', { name:'db' }));
  await user.click(screen.getByRole('button', { name:'Prune 2' })); await screen.findByText('database unavailable');
  expect(prune).toHaveBeenCalledWith([{repoId:'repo',branch:'one',deleteBranch:false,dropDb:false,dbName:'one_db'},{repoId:'repo',branch:'two',deleteBranch:true,dropDb:false,dbName:null}]); expect(close).not.toHaveBeenCalled();
});
