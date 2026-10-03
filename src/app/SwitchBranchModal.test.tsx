import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach,expect,it,vi} from 'vitest';
import SwitchBranchModal from './SwitchBranchModal';
import * as bridge from '../ipc';
import type {RepoNode,WorktreeNode} from '../types';
const wt={wtKey:'/repo/main',branch:'main',services:[]} as unknown as WorktreeNode;
const repo={repoId:'repo',worktrees:[wt,{...wt,wtKey:'/repo/busy',branch:'busy'}]} as RepoNode;
beforeEach(()=>{vi.spyOn(bridge,'hasBackend').mockReturnValue(true);vi.spyOn(bridge.ipc,'listBranches').mockResolvedValue({local:['main','busy','available'],remote:['origin/new-feature'],tags:[]});vi.spyOn(bridge.ipc,'switchWorktreeBranch').mockResolvedValue();});
it('blocks the current and already checked-out branches and targets the selected worktree',async()=>{
 const user=userEvent.setup(),close=vi.fn();render(<SwitchBranchModal wt={wt} repo={repo} onClose={close}/>);expect(await screen.findByRole('button',{name:/main.*current/})).toBeDisabled();expect(screen.getByRole('button',{name:/busy.*in use/})).toBeDisabled();await user.click(screen.getByRole('button',{name:'available'}));await waitFor(()=>expect(bridge.ipc.switchWorktreeBranch).toHaveBeenCalledWith('/repo/main','available',false,undefined));expect(close).toHaveBeenCalledTimes(1);
});
it('creates a tracking branch from a remote ref and retains errors for retry',async()=>{
 vi.mocked(bridge.ipc.switchWorktreeBranch).mockRejectedValueOnce(new Error('checkout failed'));const user=userEvent.setup(),close=vi.fn();render(<SwitchBranchModal wt={wt} repo={repo} onClose={close}/>);await user.click(await screen.findByRole('button',{name:'origin/new-feature'}));await screen.findByText('checkout failed');expect(close).not.toHaveBeenCalled();expect(bridge.ipc.switchWorktreeBranch).toHaveBeenCalledWith('/repo/main','new-feature',true,'origin/new-feature');await user.click(screen.getByRole('button',{name:'origin/new-feature'}));await waitFor(()=>expect(close).toHaveBeenCalledTimes(1));
});
