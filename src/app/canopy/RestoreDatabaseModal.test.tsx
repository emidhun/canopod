import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "../../ipc";
import type { WorktreeNode } from "../../types";
import RestoreDatabaseModal from "./RestoreDatabaseModal";
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "/tmp/input.dump") }));
const wt = { wtKey: "/repo", path: "/repo", branch: "main", dbName: "app_old", services: [] } as unknown as WorktreeNode;
beforeEach(() => { vi.spyOn(ipc, "listDatabases").mockResolvedValue(["postgres", "app_old", "other"]); vi.spyOn(ipc, "restoreDatabase").mockResolvedValue(); });
it("restores into a newly named database with explicit activation", async () => {
  const user = userEvent.setup(); const close = vi.fn();
  render(<RestoreDatabaseModal wt={wt} onClose={close} />);
  await waitFor(() => expect(screen.getByLabelText('Destination')).toHaveFocus());
  await user.click(screen.getByText("Choose dump file…"));
  await user.type(screen.getByLabelText("New database name"), "app_new");
  await user.click(screen.getByRole("button", { name: "Create and restore" }));
  await waitFor(() => expect(ipc.restoreDatabase).toHaveBeenCalledWith("/repo", "/tmp/input.dump", { target: "app_new", mode: "create", activate: true }));
  expect(close).toHaveBeenCalled();
});
it("requires confirmation for the selected existing database and resets it on selection change", async () => {
  const user = userEvent.setup(); render(<RestoreDatabaseModal wt={wt} onClose={() => {}} />);
  await user.click(screen.getByText("Choose dump file…"));
  await user.selectOptions(screen.getByLabelText("Destination"), "replace");
  const submit = screen.getByRole("button", { name: "Replace and restore" });
  expect(submit).toBeDisabled();
  await user.click(screen.getByLabelText(/I understand/));
  await user.selectOptions(screen.getByLabelText("Database to replace"), "other");
  expect(submit).toBeDisabled();
  await user.click(screen.getByLabelText(/I understand/));
  await user.click(screen.getByLabelText(/Use this database/));
  await user.click(submit);
  await waitFor(() => expect(ipc.restoreDatabase).toHaveBeenCalledWith("/repo", "/tmp/input.dump", { target: "other", mode: "replace", activate: false }));
});
it("does not restore after file selection is cancelled or into an existing new name", async () => {
  vi.mocked(open).mockResolvedValueOnce(null);
  const user = userEvent.setup(); render(<RestoreDatabaseModal wt={wt} onClose={() => {}} />);
  await user.click(screen.getByText("Choose dump file…"));
  await user.type(screen.getByLabelText("New database name"), "other");
  expect(screen.getByRole("button", { name: "Create and restore" })).toBeDisabled();
  expect(ipc.restoreDatabase).not.toHaveBeenCalled();
});

it("disables restore until the database list loads and lets a failed load retry", async () => {
  vi.mocked(ipc.listDatabases).mockRejectedValueOnce(new Error("Connection failed"));
  const user = userEvent.setup(); render(<RestoreDatabaseModal wt={wt} onClose={() => {}} />);
  expect(screen.getByRole("button", { name: "Create and restore" })).toBeDisabled();
  await screen.findByText(/Connection failed/);
  await user.click(screen.getByText("Choose dump file…"));
  await user.type(screen.getByLabelText("New database name"), "fresh_db");
  expect(screen.getByRole("button", { name: "Create and restore" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create and restore" })).toBeEnabled());
  expect(ipc.restoreDatabase).not.toHaveBeenCalled();
});

it.each(['postgres', 'template0', 'template1', 'a'.repeat(64), 'é'.repeat(32)])("rejects reserved or oversized destination %s", async name => {
  const user = userEvent.setup(); render(<RestoreDatabaseModal wt={wt} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('Destination')).toHaveFocus()); await user.click(screen.getByText('Choose dump file…')); await user.type(screen.getByLabelText('New database name'), name);
  expect(screen.getByRole('button', { name: 'Create and restore' })).toBeDisabled(); expect(ipc.restoreDatabase).not.toHaveBeenCalled();
});
it("shows only the dump filename while retaining its full path as a tooltip", async () => {
  vi.mocked(open).mockResolvedValueOnce('/tmp/seeds/checkout.backup');
  const user = userEvent.setup(); render(<RestoreDatabaseModal wt={wt} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('Destination')).toHaveFocus()); await user.click(screen.getByText('Choose dump file…')); expect(screen.getByLabelText('Dump file')).toHaveAttribute('title','/tmp/seeds/checkout.backup');
});
it("keeps the destination and dump available after restore fails", async () => {
  vi.mocked(ipc.restoreDatabase).mockRejectedValueOnce(new Error('invalid dump'));
  const user = userEvent.setup(), close = vi.fn(); render(<RestoreDatabaseModal wt={wt} onClose={close} />);
  await waitFor(() => expect(screen.getByLabelText('Destination')).toHaveFocus()); await user.click(screen.getByText('Choose dump file…')); await user.type(screen.getByLabelText('New database name'), 'new_target');
  await user.click(screen.getByRole('button', { name: 'Create and restore' })); await screen.findByText('invalid dump');
  expect(close).not.toHaveBeenCalled(); expect(screen.getByLabelText('New database name')).toHaveValue('new_target'); expect(screen.getByLabelText('Dump file')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create and restore' })).toBeEnabled();
});
