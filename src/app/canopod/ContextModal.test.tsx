import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import ContextModal from './ContextModal';
import { readWtContext } from '../WorktreeContext';
import type { RepoNode, WorktreeNode } from '../../types';
const wt = { wtKey:'/context-test',path:'/repo/context-test',branch:'checkout',dbName:'checkout_db',services:[] } as unknown as WorktreeNode;
const repo = { repoId:'repo',name:'Repo',path:'/repo',worktrees:[wt] } as RepoNode;
it('persists the task in the exact worktree across write/preview and reopening', async () => {
  const user = userEvent.setup(); const { unmount } = render(<ContextModal wt={wt} repo={repo} onClose={vi.fn()} onStartAgent={vi.fn()} />);
  const title = screen.getByPlaceholderText('What is this worktree for?'); await waitFor(() => expect(title).toHaveFocus());
  await user.type(title,'Fix checkout'); await user.type(screen.getAllByRole('textbox')[1],'Require a shipping address');
  await user.click(screen.getByRole('button', { name:'Preview' })); expect(screen.getByText('Require a shipping address')).toBeInTheDocument();
  expect(readWtContext(wt.wtKey)).toMatchObject({title:'Fix checkout',body:'Require a shipping address'}); expect(readWtContext('/other').title).toBe('');
  unmount(); render(<ContextModal wt={wt} repo={repo} onClose={vi.fn()} onStartAgent={vi.fn()} />); expect(screen.getByPlaceholderText('What is this worktree for?')).toHaveValue('Fix checkout');
});
it('starts the agent from the context dialog and closes exactly once', async () => {
  const user = userEvent.setup(), close=vi.fn(), start=vi.fn(); render(<ContextModal wt={wt} repo={repo} onClose={close} onStartAgent={start} />);
  await user.click(screen.getByRole('button', { name:/Start agent/ })); expect(start).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
});
