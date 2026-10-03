import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach,expect,it,vi} from 'vitest';
import WorktreeView from './WorktreeView';
import SidebarNav from './SidebarNav';
import {TopBar} from './TopBar';
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
