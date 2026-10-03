import {act,renderHook,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {useLaneLaunch} from './laneLaunch';
import {useStore} from '../../store';
import * as bridge from '../../ipc';
import {MOCK} from '../settings/mocks';
import type {RepoNode,WorktreeNode} from '../../types';
const wt={wtKey:'/repo/checkout',path:'/repo/checkout',branch:'checkout',services:[],dbName:null} as unknown as WorktreeNode;
const repo={repoId:'tooljet',name:'ToolJet',path:'/repo',worktrees:[wt]} as RepoNode;
beforeEach(()=>{vi.spyOn(bridge,'hasBackend').mockReturnValue(true);vi.spyOn(bridge.ipc,'getSettings').mockResolvedValue(MOCK);vi.spyOn(bridge.ipc,'writeWorktreeContext').mockResolvedValue();useStore.setState({sessions:{},activeTerm:{},showToast:vi.fn()});});
it('creates uniquely named agents and shells in the exact worktree',async()=>{
 const {result}=renderHook(()=>useLaneLaunch(repo,wt));await waitFor(()=>expect(result.current.agents).toHaveLength(2));
 await act(async()=>{await result.current.startAgent();await result.current.startAgent();result.current.startShell();result.current.startShell();});
 expect(useStore.getState().sessions[wt.wtKey].map(s=>s.title)).toEqual(['Claude Code','Claude Code 2','Shell','Shell 2']);expect(bridge.ipc.writeWorktreeContext).toHaveBeenCalledWith(wt.path,expect.stringContaining('checkout'));expect(useStore.getState().sessions[wt.wtKey][0].command).toMatch(/^claude /);
});
it('uses an explicitly selected profile and honors prompt opt-out',async()=>{
 const {result}=renderHook(()=>useLaneLaunch(repo,wt));await waitFor(()=>expect(result.current.agents).toHaveLength(2));
 const profile={...MOCK.repos[0].agents[1],promptOnLaunch:false};await act(async()=>result.current.startAgent({profile}));expect(useStore.getState().sessions[wt.wtKey][0]).toMatchObject({title:'Codex',command:'codex',agentId:profile.id});
});
it('blocks launches when the repository agent limit is reached',async()=>{
 vi.mocked(bridge.ipc.getSettings).mockResolvedValue({...MOCK,repos:[{...MOCK.repos[0],maxParallelAgents:1}]});const {result}=renderHook(()=>useLaneLaunch(repo,wt));await waitFor(()=>expect(result.current.agents).toHaveLength(2));await act(async()=>{await result.current.startAgent();await result.current.startAgent();});expect(useStore.getState().sessions[wt.wtKey]).toHaveLength(1);expect(useStore.getState().showToast).toHaveBeenCalledWith(expect.stringContaining('1 of 1 agents already running'));
});
it('does not create an agent session when writing its context fails',async()=>{
 vi.mocked(bridge.ipc.writeWorktreeContext).mockRejectedValue(new Error('context is read-only'));const {result}=renderHook(()=>useLaneLaunch(repo,wt));await waitFor(()=>expect(result.current.agents).toHaveLength(2));await act(async()=>result.current.startAgent());expect(useStore.getState().sessions[wt.wtKey]).toBeUndefined();expect(useStore.getState().showToast).toHaveBeenCalledWith(expect.stringContaining('context is read-only'));
});
