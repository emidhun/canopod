import {act,render,screen,waitFor} from '@testing-library/react';
import {listen} from '@tauri-apps/api/event';
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

it('keeps long creation output inside the scrollable modal body and bounds retained lines',async()=>{
 useStore.setState({createWorktree:vi.fn(()=>new Promise<string>(()=>{}))});
 const user=userEvent.setup();render(<NewWorktreeModal repoId="tooljet" onClose={vi.fn()} onSetupStarted={vi.fn()}/>);
 await waitFor(()=>expect(screen.getByRole('combobox')).toHaveFocus());
 await user.type(screen.getByPlaceholderText('feat/my-branch'),'checkout');
 await user.click(screen.getByRole('button',{name:/Create worktree/}));
 const callback=vi.mocked(listen).mock.calls.find(([name])=>name==='worktree:op')![1];
 const path='/very-long/'+ 'directory'.repeat(100)+'/package.tgz';
 act(()=>{for(let i=0;i<10;i++) callback({payload:{op:'create',wtKey:'/repo/.worktrees/checkout',detail:`copy-${i} ${path}`}} as never);});
 const line=screen.getByText(`copy-9 ${path}`);
 expect(line.closest('.cx-modal__body')).not.toBeNull();
 expect(line.parentElement?.children).toHaveLength(4);
 expect(screen.queryByText(`copy-0 ${path}`)).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Close'})).toBeDisabled();
});
