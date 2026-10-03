import { useState } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import WorkSurface from "./WorkSurface";
import { nextTermId, useStore } from "../../store";
import type { WorktreeNode } from "../../types";

vi.mock("../TerminalPane", () => ({ default: ({ termId, readOnly }: { termId: string; readOnly: boolean }) => <div data-testid={termId} data-readonly={String(readOnly)}>{termId}</div> }));
const wt = { wtKey: "/repo", path: "/repo", branch: "main", services: [] } as unknown as WorktreeNode;
beforeEach(() => useStore.setState({ sessions: {}, activeTerm: {}, detachedTerms: new Set() }));

it.each(["shell", "agent"] as const)("shows each new %s session without replacing or obscuring another", async (kind) => {
  const user = userEvent.setup();
  const ids = [nextTermId(wt.wtKey, kind), nextTermId(wt.wtKey, kind)];
  ids.forEach((id, i) => useStore.getState().openSession({ id, wtKey: wt.wtKey, kind, title: `Session ${i + 1}` }));
  render(<WorkSurface wt={wt} panes={[kind]} setPanes={() => {}} filter="" onFilter={() => {}} na={null} onNext={() => {}} onRestart={() => {}} launch={{ agents: [], startAgent: async () => {}, startShell: () => {} }} onEditContext={() => {}} />);
  const second = screen.getByRole("tabpanel", { name: "Session 2" });
  expect(within(second).getByTestId(ids[1])).toBeInTheDocument();
  expect(second).toHaveClass("term-body");
  const first = screen.getAllByRole("tabpanel", { hidden: true }).find((p) => p.getAttribute("aria-label") === "Session 1")!;
  expect(first).toHaveClass("hidden");
  const firstRenderer = within(first).getByTestId(ids[0]);
  await user.click(screen.getByText("Session 1"));
  expect(screen.getByRole("tabpanel", { name: "Session 1" })).not.toHaveClass("hidden");
  expect(firstRenderer).toBeInTheDocument();
  expect(second).toHaveClass("hidden");
});

const profile = { id: "claude", name: "Claude", command: "claude", promptOnLaunch: true, waitingPatterns: "" };
function Workspace({ launch }: { launch: import("./laneLaunch").LaneLaunch }) {
  const [panes, setPanes] = useState<import("./WorkSurface").PaneKind[]>(["shell"]);
  return <WorkSurface wt={wt} panes={panes} setPanes={setPanes} filter="all" onFilter={() => {}} na={null} onNext={() => {}} onRestart={() => {}} launch={launch} onEditContext={() => {}} />;
}

it("keeps mixed sessions mounted and selected when switching to logs or toggling companion logs", async () => {
  const user = userEvent.setup();
  const agent = nextTermId(wt.wtKey, "agent"), shell = nextTermId(wt.wtKey, "shell");
  useStore.getState().openSession({ id: agent, wtKey: wt.wtKey, kind: "agent", title: "Claude" });
  useStore.getState().openSession({ id: shell, wtKey: wt.wtKey, kind: "shell", title: "Shell" });
  render(<Workspace launch={{ agents: [profile], startAgent: vi.fn(), startShell: vi.fn() }} />);
  await user.click(screen.getByRole("button", { name: /Claude.*Running/ }));
  const renderer = screen.getByTestId(agent);
  await user.click(screen.getByRole("button", { name: "Logs alongside" }));
  await user.click(screen.getByRole("button", { name: "Logs" }));
  expect(renderer).toBeInTheDocument();
  expect(renderer.closest('[role="tabpanel"]')).toHaveAttribute("aria-hidden", "true");
  await user.click(screen.getByRole("button", { name: "Terminal" }));
  expect(screen.getByRole("tabpanel", { name: "Claude" })).toContainElement(renderer);
  expect(screen.getByRole("button", { name: "Logs alongside" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: /Shell.*Running/ })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Add session" })).toHaveLength(1);
});

it("starts a single agent profile directly from empty state and the shared add menu", async () => {
  const user = userEvent.setup(), startAgent = vi.fn(), startShell = vi.fn();
  render(<Workspace launch={{ agents: [profile], startAgent, startShell }} />);
  await user.click(screen.getByRole("button", { name: "Start agent" }));
  expect(startAgent).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Add session" }));
  await user.click(screen.getByRole("menuitem", { name: "Start agent" }));
  expect(startAgent).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Add session" }));
  await user.click(screen.getByRole("menuitem", { name: "Open terminal" }));
  expect(startShell).toHaveBeenCalledTimes(1);
});

it("offers configured profiles when more than one agent is available", async () => {
  const user = userEvent.setup(), startAgent = vi.fn();
  const codex = { ...profile, id: "codex", name: "Codex", command: "codex" };
  render(<Workspace launch={{ agents: [profile, codex], startAgent, startShell: vi.fn() }} />);
  await user.click(screen.getByRole("button", { name: "Add session" }));
  await user.click(screen.getByRole("menuitem", { name: "Start agent" }));
  expect(startAgent).not.toHaveBeenCalled();
  await user.click(screen.getByRole("menuitem", { name: "Codex" }));
  expect(startAgent).toHaveBeenCalledWith({ profile: codex });
});

it("retains ended output as read-only, restarts that session, and closes only the chosen session", async () => {
  const user = userEvent.setup(), id = nextTermId(wt.wtKey, "agent");
  useStore.getState().openSession({ id, wtKey: wt.wtKey, kind: "agent", title: "Claude" });
  useStore.setState({ sessions: { [wt.wtKey]: useStore.getState().sessions[wt.wtKey].map(s => ({ ...s, running: false })) } });
  render(<Workspace launch={{ agents: [profile], startAgent: vi.fn(), startShell: vi.fn() }} />);
  expect(screen.getByTestId(id)).toHaveAttribute('data-readonly','true');
  await user.click(screen.getByRole('button', { name: 'Restart' }));
  expect(screen.getByTestId(id)).toHaveAttribute('data-readonly','false');
  expect(useStore.getState().sessions[wt.wtKey][0].gen).toBe(1);
  await user.click(screen.getByRole('button', { name: 'Close Claude' }));
  expect(screen.queryByTestId(id)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Start agent' })).toBeInTheDocument();
});
it("reattaches a detached session without launching a replacement", async () => {
  const user = userEvent.setup(), id = nextTermId(wt.wtKey, "shell"), startShell = vi.fn();
  useStore.getState().openSession({ id, wtKey: wt.wtKey, kind: "shell", title: "Shell" });
  useStore.setState({ detachedTerms: new Set([id]) });
  render(<Workspace launch={{ agents: [profile], startAgent: vi.fn(), startShell }} />);
  expect(screen.queryByTestId(id)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Bring back' }));
  expect(screen.getByTestId(id)).toBeInTheDocument(); expect(startShell).not.toHaveBeenCalled(); expect(useStore.getState().detachedTerms.has(id)).toBe(false);
});
it("resizes with the keyboard, clamps at both limits, and keeps the width after toggling logs", async () => {
  const user = userEvent.setup(); render(<Workspace launch={{ agents: [profile], startAgent: vi.fn(), startShell: vi.fn() }} />);
  await user.click(screen.getByRole('button', { name: 'Logs alongside' }));
  const divider = screen.getByRole('separator'); divider.focus();
  await user.keyboard('{ArrowRight}'); expect(divider).toHaveAttribute('aria-valuenow','62');
  await user.keyboard('{ArrowRight>20/}'); expect(divider).toHaveAttribute('aria-valuenow','75');
  await user.keyboard('{ArrowLeft>30/}'); expect(divider).toHaveAttribute('aria-valuenow','35');
  await user.click(screen.getByRole('button', { name: 'Logs alongside' })); await user.click(screen.getByRole('button', { name: 'Logs alongside' }));
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow','35');
});
it("shows agent task context only for an agent and does not expose sessions from another worktree", async () => {
  const user = userEvent.setup(), agent = nextTermId(wt.wtKey, "agent"), shell = nextTermId(wt.wtKey, "shell");
  useStore.getState().openSession({ id: 'foreign', wtKey: '/other', kind: 'agent', title: 'Other agent' });
  useStore.getState().openSession({ id: agent, wtKey: wt.wtKey, kind: 'agent', title: 'Claude' });
  useStore.getState().openSession({ id: shell, wtKey: wt.wtKey, kind: 'shell', title: 'Shell' });
  render(<Workspace launch={{ agents: [profile], startAgent: vi.fn(), startShell: vi.fn() }} />);
  expect(screen.queryByTestId('foreign')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: /Task context/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /Claude.*Running/ })); expect(screen.getByRole('button', { name: /Task context/ })).toBeInTheDocument();
  act(() => useStore.getState().closeSession(agent)); expect(screen.getByRole('tabpanel', { name: 'Shell' })).toBeInTheDocument();
});
