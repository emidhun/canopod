import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach,expect,it,vi} from 'vitest';
import WorktreeView from './WorktreeView';
import SidebarNav from './SidebarNav';
import {TopBar,AttentionPop} from './TopBar';
import type {AttnItem} from '../nextAction';
import {useStore} from '../../store';
import {Play} from '../../icons';
import type {RepoNode,WorktreeNode} from '../../types';
import type {NextAction} from '../nextAction';
vi.mock('./ServiceRail',()=>({default:()=>null}));vi.mock('./WorkSurface',()=>({default:()=>null}));
const wt={wtKey:'/repo/checkout',path:'/repo/checkout',branch:'checkout',services:[],isMain:false,pinned:false,dbName:null,git:{dirty:true,ahead:7,behind:2,lastCommitTs:0,lastCommitMsg:'latest'}} as unknown as WorktreeNode;
const repo={repoId:'repo',name:'Repo',path:'/repo',worktrees:[wt]} as RepoNode;
beforeEach(()=>useStore.setState({tree:[repo],query:'',sessions:{},activeTerm:{},creating:{},removing:{}}));
it('exposes one accessible dirty-review action in the worktree header and removes it when clean',async()=>{
 const user=userEvent.setup(),dirty=vi.fn();const props={wt,na:{icon:Play,label:'Start',kind:'primary',why:'Stopped'} as unknown as NextAction,onNext:vi.fn(),panes:['logs'] as 'logs'[],setPanes:vi.fn(),launch:{agents:[],startAgent:vi.fn(),startShell:vi.fn()},sideHidden:false,onShowSide:vi.fn(),onRemove:vi.fn(),onDatabase:vi.fn(),onSetup:vi.fn(),onOpenService:vi.fn(),onEditContext:vi.fn(),onDirty:dirty};
 const {rerender}=render(<WorktreeView {...props}/>);expect(screen.getAllByRole('button',{name:'Review uncommitted changes'})).toHaveLength(1);await user.click(screen.getByRole('button',{name:'Review uncommitted changes'}));expect(dirty).toHaveBeenCalledTimes(1);
 rerender(<WorktreeView {...props} wt={{...wt,git:{...wt.git!,dirty:false}}}/>);expect(screen.queryByRole('button',{name:'Review uncommitted changes'})).not.toBeInTheDocument();
});
it('keeps sidebar status about services rather than duplicating Git dirty state',async()=>{
 const user=userEvent.setup(),select=vi.fn();render(<SidebarNav hidden={false} view="wt" selKey={wt.wtKey} attn={[]} onSelect={select} onOverview={vi.fn()} onToggle={vi.fn()} onNew={vi.fn()} onOpenTerminal={vi.fn()} onRemoveMany={vi.fn()}/>);
 expect(screen.getAllByTitle('Services stopped')).toHaveLength(1);expect(screen.queryByTitle(/uncommitted/i)).not.toBeInTheDocument();await user.click(screen.getByRole('button',{name:'checkout'}));expect(select).toHaveBeenCalledWith(wt.wtKey);
});
it('labels global counters and routes each action to its intended workspace action',async()=>{
 const user=userEvent.setup(),overview=vi.fn(),settings=vi.fn(),palette=vi.fn();render(<TopBar repo={repo} wt={wt} attn={[]} running={6} agents={1} onPalette={palette} onAttn={vi.fn()} onOverview={overview} onRefresh={vi.fn()} onSettings={settings}/>);
 await user.click(screen.getByRole('button',{name:/6\s*services running/}));expect(overview).toHaveBeenCalledTimes(1);expect(screen.getByRole('button',{name:/1\s*agent/})).toBeInTheDocument();await user.click(screen.getByRole('button',{name:'Settings'}));expect(settings).toHaveBeenCalledTimes(1);await user.click(screen.getByRole('button',{name:/Search or run command/}));expect(palette).toHaveBeenCalledTimes(1);
});

it('clears saved notifications while retaining live attention items', async () => {
 const user=userEvent.setup(),dismiss=vi.fn(),pick=vi.fn();
 const notice:AttnItem={id:'notice',noticeId:'saved-notice',sev:0,kind:'error',wtKey:wt.wtKey,wt:'checkout',title:'Restore failed',act:'Details'};
 const completed:AttnItem={...notice,id:'complete',noticeId:'saved-complete',kind:'info',title:'Setup completed'};
 const crash:AttnItem={id:'crash',sev:0,kind:'crash',wtKey:wt.wtKey,wt:'checkout',title:'Server crashed',act:'Restart',svcKey:'server'};
 const wait:AttnItem={...crash,id:'wait',kind:'wait',title:'Agent waiting',act:'Answer'};
 const props={onDismiss:dismiss,onPick:pick,onClose:vi.fn()};
 const {rerender}=render(<AttentionPop {...props} items={[notice,completed,crash,wait]}/>);
 await user.click(screen.getByRole('button',{name:'Clear notifications'}));
 expect(dismiss.mock.calls.map(([item])=>item.id)).toEqual(['notice','complete']);
 expect(pick).not.toHaveBeenCalled();
 rerender(<AttentionPop {...props} items={[crash,wait]}/>);
 expect(screen.queryByRole('button',{name:'Clear notifications'})).not.toBeInTheDocument();
 expect(screen.getByText('Server crashed')).toBeInTheDocument();
 expect(screen.getByText('Agent waiting')).toBeInTheDocument();
});
it('offers no clear action when there are no notifications', () => {
 render(<AttentionPop items={[]} onDismiss={vi.fn()} onPick={vi.fn()} onClose={vi.fn()}/>);
 expect(screen.queryByRole('button',{name:'Clear notifications'})).not.toBeInTheDocument();
 expect(screen.getByText(/Nothing needs you/)).toBeInTheDocument();
});
it('offers individual and bulk dismissal for setup reminders', async () => {
 const user=userEvent.setup(),dismiss=vi.fn();
 const reminder:AttnItem={id:'setup',sev:2,kind:'todo',wtKey:wt.wtKey,wt:'checkout',title:'Setup never run',act:'Run setup'};
 render(<AttentionPop items={[reminder]} onDismiss={dismiss} onPick={vi.fn()} onClose={vi.fn()}/>);
 await user.click(screen.getByRole('button',{name:'Dismiss Setup never run'}));
 expect(dismiss).toHaveBeenLastCalledWith(reminder);
 dismiss.mockClear();
 await user.click(screen.getByRole('button',{name:'Clear notifications'}));
 expect(dismiss).toHaveBeenCalledExactlyOnceWith(reminder);
});
it('hides dismissed setup reminders without changing setup and resurfaces a changed outcome', async () => {
 const {attentionItems}=await import('../nextAction');
 const pending={...wt,setupConfigured:true,setup:null};
 const tree=[{...repo,worktrees:[pending]}];
 const reminder=attentionItems(tree,{}).find(a=>a.kind==='todo')!;
 expect(reminder).toBeDefined();
 const dismissed={[reminder.id]:reminder.title};
 expect(attentionItems(tree,{},[],dismissed).some(a=>a.kind==='todo')).toBe(false);
 expect(pending.setup).toBeNull();
 const failed=[{...repo,worktrees:[{...pending,setup:{ok:false,ranAt:1,source:"marker" as const}}]}];
 expect(attentionItems(failed,{},[],dismissed).find(a=>a.kind==='todo')?.title).toBe('Setup failed');
});
