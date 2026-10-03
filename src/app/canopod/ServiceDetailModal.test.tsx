import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import ServiceDetailModal from './ServiceDetailModal';
import { useStore } from '../../store';
import * as bridge from '../../ipc';
import type { RepoNode, WorktreeNode } from '../../types';
const wt = {wtKey:'/repo',branch:'checkout',services:[{svcKey:'server',name:'Server',status:'running',port:4000,derivedPort:4000}]} as WorktreeNode;
const repo = {repoId:'repo',name:'Repo',worktrees:[wt,{...wt,wtKey:'/other',branch:'other',services:[{...wt.services[0],svcKey:'other-server',port:4010}]}]} as RepoNode;
beforeEach(() => {useStore.setState({tree:[repo],stats:{},cpuHistory:{},exitCodes:{},logs:{},restartService:vi.fn(),stopService:vi.fn()});vi.spyOn(bridge,'hasBackend').mockReturnValue(true);vi.spyOn(bridge.ipc,'serviceEnv').mockResolvedValue([]);vi.spyOn(bridge.ipc,'setServicePort').mockResolvedValue();});
it.each(['80','65536','abc','4010'])('blocks invalid or conflicting port %s', async port => {
  const user=userEvent.setup();render(<ServiceDetailModal wt={wt} svcKey="server" onClose={vi.fn()} />);const field=screen.getByRole('textbox');await waitFor(()=>expect(field).toHaveFocus());await user.clear(field);await user.type(field,port);
  expect(screen.getByRole('button',{name:/Save & restart/})).toBeDisabled();expect(bridge.ipc.setServicePort).not.toHaveBeenCalled();
});
it('saves a valid port for this service and keeps the dialog open on failure', async()=>{
  vi.mocked(bridge.ipc.setServicePort).mockRejectedValueOnce(new Error('port busy'));
  const user=userEvent.setup(),close=vi.fn();render(<ServiceDetailModal wt={wt} svcKey="server" onClose={close} />);const field=screen.getByRole('textbox');await waitFor(()=>expect(field).toHaveFocus());await user.clear(field);await user.type(field,'4050');await user.click(screen.getByRole('button',{name:/Save & restart/}));
  await waitFor(()=>expect(bridge.ipc.setServicePort).toHaveBeenCalledWith('server',4050));expect(close).not.toHaveBeenCalled();expect(field).toHaveValue('4050');
  await user.click(screen.getByRole('button',{name:/Save & restart/}));await waitFor(()=>expect(close).toHaveBeenCalledTimes(1));
});
it('reflects a service crash while open and restarts the selected service',async()=>{
  const user=userEvent.setup();render(<ServiceDetailModal wt={wt} svcKey="server" onClose={vi.fn()} />);
  act(()=>useStore.setState({tree:[{...repo,worktrees:[{...wt,services:[{...wt.services[0],status:'error'}]}]}],exitCodes:{server:1},logs:{server:[{t:'10:00',lv:'err',text:'database connection failed'}]}}));
  expect(screen.getByText(/exited with code 1/)).toBeInTheDocument();expect(screen.getByText('database connection failed')).toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:/^Restart/}));expect(useStore.getState().restartService).toHaveBeenCalledWith('server');
});
