import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach,expect,it,vi} from 'vitest';
import NewWorktreeModal from './NewWorktreeModal';
import * as bridge from '../ipc';
import {useStore} from '../store';
import {MOCK} from './settings/mocks';
import type {RepoNode} from '../types';
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async()=>()=>{})}));
const repo={repoId:'tooljet',name:'ToolJet',path:'/repo',worktrees:[]} as RepoNode;
beforeEach(()=>{vi.spyOn(bridge,'hasBackend').mockReturnValue(true);vi.spyOn(bridge.ipc,'listBranches').mockResolvedValue({local:['main'],remote:[],tags:[]});vi.spyOn(bridge.ipc,'getSettings').mockResolvedValue(MOCK);vi.spyOn(bridge.ipc,'previewWorktree').mockResolvedValue({path:'/repo/.worktrees/checkout',slug:'checkout',pathExists:false,ports:[],dbName:null} as Awaited<ReturnType<typeof bridge.ipc.previewWorktree>>);useStore.setState({tree:[repo],createWorktree:vi.fn(async()=>'/repo/.worktrees/checkout'),select:vi.fn()});});
it('requires a valid branch name and creates in the selected repository',async()=>{
 const user=userEvent.setup(),close=vi.fn();render(<NewWorktreeModal repoId="tooljet" onClose={close} onSetupStarted={vi.fn()}/>);const name=screen.getByPlaceholderText('feat/my-branch');await waitFor(()=>expect(screen.getByRole('combobox')).toHaveFocus());
 expect(screen.getByRole('button',{name:/Create worktree/})).toBeDisabled();await user.type(name,'checkout');await user.click(screen.getByRole('button',{name:/Create worktree/}));await waitFor(()=>expect(useStore.getState().createWorktree).toHaveBeenCalledWith(expect.objectContaining({repoId:'tooljet',branch:'checkout',base:'main',createBranch:true})));expect(close).toHaveBeenCalledTimes(1);
});
it('retains the branch name and failure detail when creation fails',async()=>{
 useStore.setState({createWorktree:vi.fn(async()=>{throw new Error('checkout creation failed');})});const user=userEvent.setup(),close=vi.fn();render(<NewWorktreeModal repoId="tooljet" onClose={close} onSetupStarted={vi.fn()}/>);const name=screen.getByPlaceholderText('feat/my-branch');await waitFor(()=>expect(screen.getByRole('combobox')).toHaveFocus());await user.type(name,'checkout');await user.click(screen.getByRole('button',{name:/Create worktree/}));await screen.findByText('checkout creation failed');expect(name).toHaveValue('checkout');expect(close).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:/Create worktree/})).toBeEnabled();
});
