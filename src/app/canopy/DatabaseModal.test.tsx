import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import DatabaseModal from "./DatabaseModal";
import { useStore } from "../../store";

it("requires destination acknowledgment before invoking database reset", async () => {
  const wt = useStore.getState().tree.flatMap((r) => r.worktrees).find((w) => w.dbName);
  expect(wt).toBeDefined();
  const reset = vi.fn();
  const original = useStore.getState().resetDb;
  useStore.setState({ resetDb: reset });
  try {
    const user = userEvent.setup();
    render(<DatabaseModal wt={wt!} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Reset database/ }));
    expect(reset).not.toHaveBeenCalled();
    expect(screen.getAllByText(wt!.dbName!).length).toBeGreaterThan(0);
    const confirm = screen.getByRole("button", { name: "Reset database" });
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(confirm).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(reset).not.toHaveBeenCalled();
  } finally { useStore.setState({ resetDb: original }); }
});

it('keeps database actions disabled on a read failure and allows retry',async()=>{
 const bridge=await import('../../ipc');vi.spyOn(bridge,'hasBackend').mockReturnValue(true);vi.spyOn(bridge.ipc,'listDatabases').mockRejectedValueOnce(new Error('database offline')).mockResolvedValue(['checkout_db']);vi.spyOn(bridge.ipc,'currentDatabase').mockResolvedValue('checkout_db');
 const wt={wtKey:'/test',branch:'checkout',dbName:'checkout_db',services:[]} as unknown as import('../../types').WorktreeNode;
 const user=userEvent.setup();render(<DatabaseModal wt={wt} onClose={vi.fn()}/>);
 expect(screen.getByRole('button',{name:/Run migration/})).toBeDisabled();await screen.findByRole('alert');expect(screen.getByRole('button',{name:/Run migration/})).toBeDisabled();
 await user.click(screen.getByRole('button',{name:'Retry'}));await waitFor(()=>expect(screen.getByRole('button',{name:/Run migration/})).toBeEnabled());
});
it('does not expose current-database operations without a configured database',()=>{
 const wt={wtKey:'/no-db',branch:'checkout',dbName:null,services:[]} as unknown as import('../../types').WorktreeNode;render(<DatabaseModal wt={wt} onClose={vi.fn()}/>);
 expect(screen.getByRole('button',{name:/Run migration/})).toBeDisabled();expect(screen.getByRole('button',{name:/Save snapshot/})).toBeDisabled();expect(screen.getByRole('button',{name:/Reset database/})).toBeDisabled();expect(screen.getByRole('button',{name:/Restore from/})).toBeEnabled();
});
