import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import ServiceRail from "./ServiceRail";
import { useStore } from "../../store";
import type { ServiceNode, WorktreeNode } from "../../types";
vi.mock('./CommandButtons', () => ({ default: () => null }));
let width = 800;
beforeEach(() => { width = 800; vi.stubGlobal('ResizeObserver', class { constructor(private callback: ResizeObserverCallback) {} observe(target: Element) { this.callback([{ target, contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} }); });
const service = (name: string, status: ServiceNode['status'], port = 3000) => ({ name, status, port, svcKey: name }) as ServiceNode;
const tree = (services: ServiceNode[], dbName: string | null = 'checkout_database_with_a_long_name') => ({ wtKey: '/repo', services, dbName }) as WorktreeNode;
it("keeps detail, port and process actions independent and targets the clicked service", async () => {
  const user = userEvent.setup(), details = vi.fn(), openPort = vi.fn(), startService = vi.fn(), stopService = vi.fn();
  useStore.setState({ openPort, startService, stopService });
  render(<ServiceRail wt={tree([service('Frontend', 'running'), service('Server', 'stopped', 4000)])} onOpenService={details} onDatabase={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Open Frontend on port 3000' })); expect(openPort).toHaveBeenCalledWith(3000); expect(details).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Open Server on port 4000' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Start' })); expect(startService).toHaveBeenCalledWith('Server'); expect(details).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Stop' })); expect(stopService).toHaveBeenCalledWith('Frontend');
  await user.click(screen.getByRole('button', { name: 'Frontend details — running' })); expect(details).toHaveBeenCalledWith(expect.objectContaining({ svcKey: 'Frontend' }));
  expect(document.querySelector('button button')).toBeNull();
});
it("keeps extra services and the full database identity accessible through overflow", async () => {
  const user = userEvent.setup(), database = vi.fn(), restartService = vi.fn(); useStore.setState({ restartService });
  render(<ServiceRail wt={tree([service('Frontend','running'), service('Server','stopped'), service('Worker','error')])} onOpenService={vi.fn()} onDatabase={database} />);
  expect(screen.queryByText('Worker')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /More services and database/ }));
  expect(screen.getByRole('dialog', { name: 'Services and database' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Restart' })); expect(restartService).toHaveBeenCalledWith('Worker');
  expect(screen.getByText('checkout_database_with_a_long_name')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /Database tools/ })); expect(database).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it("reduces visible services at narrow widths and restores focus on Escape", async () => {
  width = 400; const user = userEvent.setup(); render(<ServiceRail wt={tree([service('Frontend','running'), service('Server','stopped')])} onOpenService={vi.fn()} onDatabase={vi.fn()} />);
  expect(screen.queryByText('Server')).not.toBeInTheDocument();
  const trigger = screen.getByRole('button', { name: /1 more services/ }); await user.click(trigger); await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it("does not offer process actions during transitions and explains the empty state", () => {
  const { rerender } = render(<ServiceRail wt={tree([service('Frontend','starting'), service('Server','stopping')], null)} onOpenService={vi.fn()} onDatabase={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /^(Start|Stop|Restart)$/ })).not.toBeInTheDocument();
  rerender(<ServiceRail wt={tree([],null)} onOpenService={vi.fn()} onDatabase={vi.fn()} />);
  expect(screen.getByText('No services configured for this worktree.')).toBeInTheDocument();
});
