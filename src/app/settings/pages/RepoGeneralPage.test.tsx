import {render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect,it,vi} from 'vitest';
import RepoGeneralPage from './RepoGeneralPage';
import {MOCK} from '../mocks';
import type {PageProps} from '../types';
it('requires the explicit repository confirmation and keeps cancellation side-effect free',async()=>{
 const user=userEvent.setup(),remove=vi.fn();render(<RepoGeneralPage {...({repo:MOCK.repos[0],onRemoveRepo:remove} as unknown as PageProps)}/>);
 await user.click(screen.getByText('Danger zone'));await user.click(screen.getByRole('button',{name:'Remove repository'}));expect(remove).not.toHaveBeenCalled();const modal=screen.getByRole('dialog',{name:'Remove repository'});expect(modal).toHaveTextContent('ToolJet');expect(modal).toHaveTextContent('not touched');await user.click(within(modal).getByRole('button',{name:'Cancel'}));expect(remove).not.toHaveBeenCalled();
 await user.click(screen.getByRole('button',{name:'Remove repository'}));await user.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Remove repository'}));expect(remove).toHaveBeenCalledTimes(1);
});
