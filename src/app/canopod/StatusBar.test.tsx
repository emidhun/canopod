import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import StatusBar from './StatusBar';
import { useStore } from '../../store';
import type { WorktreeNode } from '../../types';
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'showPopover', {configurable:true,value:function(this:HTMLElement) {this.style.display='block';}});
});
const wt = { wtKey: '/repo', branch: 'checkout', services: [], git: { ahead: 7, behind: 2, dirty: true, lastCommitTs: 0, lastCommitMsg: 'latest' } } as unknown as WorktreeNode;
const props = { wt, view: 'wt' as const, attn: [], panes: ['shell'] as ('shell' | 'logs')[], onLayout: vi.fn(), onAttn: vi.fn(), worktreeCount: 1, repoCount: 1 };
it('keeps the labelled Pull action and separate submodule menu without duplicating dirty indicators', async () => {
  const user = userEvent.setup(), pull = vi.fn(); useStore.setState({ gitPull: pull, sessions: {}, activeTerm: {} });
  render(<StatusBar {...props} />); await user.click(screen.getByRole('button', { name: 'Pull' }));
  expect(pull).toHaveBeenCalledWith('/repo');
  expect(screen.queryByText('uncommitted')).not.toBeInTheDocument(); expect(screen.queryByText('↑7')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Pull individual submodules' }));
  expect(screen.getByText('Pull everything')).toBeInTheDocument();
});
it('offers exactly the supported layouts, marks the current layout and restores focus after selection', async () => {
  const user = userEvent.setup(), onLayout = vi.fn(); render(<StatusBar {...props} onLayout={onLayout} />);
  const trigger = screen.getByRole('button', { name: 'Workspace layout: Terminal' }); await user.click(trigger);
  const current = screen.getByRole('button', { name: 'Terminal' }); expect(current).toHaveAttribute('aria-pressed','true'); expect(current).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Terminal + Logs' })); expect(onLayout).toHaveBeenCalledWith('shell');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(trigger).toHaveFocus();
  await user.click(trigger); await user.keyboard('{Escape}'); expect(trigger).toHaveFocus(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
