import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect,it,vi} from 'vitest';
import NoticeModal from './NoticeModal';
import {useStore,type Notice} from '../../store';
const notice={id:'failed-job',kind:'error',title:'Restore failed',wt:'checkout',wtKey:'/repo/checkout',detail:'invalid archive\nrestore aborted',ts:1} as Notice;
it('shows the operation target and full output and dismisses only the selected notice',async()=>{
 const user=userEvent.setup(),dismiss=vi.fn(),close=vi.fn();useStore.setState({dismissNotice:dismiss});render(<NoticeModal notice={notice} onClose={close}/>);
 expect(screen.getByText('/repo/checkout')).toBeInTheDocument();expect(screen.getByText(/invalid archive/)).toHaveTextContent('restore aborted');await user.click(screen.getByRole('button',{name:'Dismiss'}));expect(dismiss).toHaveBeenCalledWith('failed-job');expect(close).toHaveBeenCalledTimes(1);
});
it('disables copying when no operation detail was reported',()=>{render(<NoticeModal notice={{...notice,detail:''}} onClose={vi.fn()}/>);expect(screen.getByRole('button',{name:'Copy details'})).toBeDisabled();expect(screen.getByText('No further detail was reported.')).toBeInTheDocument();});
