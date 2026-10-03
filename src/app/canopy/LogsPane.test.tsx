import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import LogsPane from "./LogsPane";
import { useStore } from "../../store";
import type { LogLine, WorktreeNode } from "../../types";

const wt = { wtKey: "/test", services: [{ svcKey: "test-server", name: "Server", status: "running" }] } as WorktreeNode;
const first: LogLine = { t: "10:00:00", lv: "info", text: "first" };
beforeEach(() => useStore.setState({ logs: { "test-server": [first] } }));

it("pauses only when scrolled away and counts incoming lines even when the log buffer stays the same size", async () => {
  const user = userEvent.setup();
  const { container } = render(<LogsPane wt={wt} filter="all" onFilter={() => {}} na={null} onNext={() => {}} onRestart={() => {}} />);
  const body = container.querySelector('.cxs-pbody')!;
  fireEvent.wheel(body, { deltaY: 10 });
  expect(screen.queryByRole("button", { name: "Return to latest" })).not.toBeInTheDocument();
  Object.defineProperties(body, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 }, scrollTop: { configurable: true, writable: true, value: 100 } });
  fireEvent.scroll(body);
  expect(screen.getByRole("button", { name: "Paused" })).toHaveAttribute("aria-pressed", "false");
  const second: LogLine = { t: "10:00:01", lv: "info", text: "second" };
  act(() => useStore.setState({ logs: { "test-server": [first, second] } }));
  expect(screen.getByRole("status")).toHaveTextContent("1 new line");
  act(() => useStore.setState({ logs: { "test-server": [second, { t: "10:00:02", lv: "err", text: "third" }] } }));
  expect(screen.getByRole("status")).toHaveTextContent("2 new lines");
  await user.click(screen.getByRole("button", { name: "Return to latest" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Follow" })).toHaveAttribute("aria-pressed", "true");
});

function FilteredLogs() {
  const [filter,setFilter] = useState('all');
  return <LogsPane wt={{ ...wt, services:[...wt.services,{...wt.services[0],svcKey:'test-front',name:'Frontend'}] }} filter={filter} onFilter={setFilter} na={null} onNext={() => {}} onRestart={() => {}} />;
}
it('combines source, levels and search filters and restores filter-trigger focus on Escape', async () => {
  useStore.setState({logs:{'test-server':[{t:'10:00',lv:'err',text:'checkout failed'},{t:'10:01',lv:'info',text:'checkout received'}],'test-front':[{t:'10:02',lv:'err',text:'frontend failed'}]}});
  const user=userEvent.setup();render(<FilteredLogs />);
  await user.click(screen.getByRole('button',{name:'Log source'}));await user.click(screen.getByRole('button',{name:'Server'}));
  expect(screen.queryByText('frontend failed')).not.toBeInTheDocument();
  const levels=screen.getByRole('button',{name:'Levels'});await user.click(levels);await user.click(screen.getByRole('button',{name:'Info'}));await user.keyboard('{Escape}');expect(levels).toHaveFocus();
  expect(screen.queryByText('checkout received')).not.toBeInTheDocument();await user.type(screen.getByLabelText('Search logs'),'missing');expect(screen.getByText('No lines match these filters.')).toBeInTheDocument();await user.clear(screen.getByLabelText('Search logs'));expect(screen.getByText('checkout failed')).toBeInTheDocument();
});
it('clears only this worktree’s logs and leaves another worktree untouched',async()=>{
  useStore.setState({logs:{'test-server':[first],foreign:[{...first,text:'keep this output'}]}});const user=userEvent.setup();render(<LogsPane wt={wt} filter="all" onFilter={()=>{}} na={null} onNext={()=>{}} onRestart={()=>{}}/>);await user.click(screen.getByRole('button',{name:'Clear'}));expect(useStore.getState().logs['test-server']).toEqual([]);expect(useStore.getState().logs.foreign).toHaveLength(1);
});
