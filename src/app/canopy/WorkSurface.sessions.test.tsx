import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import WorkSurface from "./WorkSurface";
import { nextTermId, useStore } from "../../store";
import type { WorktreeNode } from "../../types";

vi.mock("../TerminalPane", () => ({ default: ({ termId }: { termId: string }) => <div data-testid={termId}>{termId}</div> }));
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
