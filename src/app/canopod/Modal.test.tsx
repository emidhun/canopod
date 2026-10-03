import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import Modal, { usePrimaryAction } from "./Modal";

it("focuses the first field, preserves typing focus across updates, and restores the opener", async () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const { rerender, unmount } = render(<Modal title="Edit task" onClose={vi.fn()}><input aria-label="Task" /><input aria-label="Other" /></Modal>);
  await waitFor(() => expect(screen.getByLabelText("Task")).toHaveFocus());
  screen.getByLabelText("Other").focus();
  rerender(<Modal title="Edit task" onClose={vi.fn()}><input aria-label="Task" /><input aria-label="Other" /></Modal>);
  expect(screen.getByLabelText("Other")).toHaveFocus(); unmount(); expect(opener).toHaveFocus(); opener.remove();
});
it("blocks Escape and backdrop dismissal while busy and uses the latest close callback", () => {
  const first = vi.fn(), latest = vi.fn();
  const { container, rerender } = render(<Modal title="Operation" busy onClose={first}><p>Output</p></Modal>);
  fireEvent.keyDown(document, { key: 'Escape' }); fireEvent.mouseDown(container.querySelector('.cx-scrim')!);
  expect(first).not.toHaveBeenCalled();
  rerender(<Modal title="Operation" onClose={latest}><p>Output</p></Modal>);
  fireEvent.keyDown(document, { key: 'Escape' }); expect(latest).toHaveBeenCalledTimes(1);
});
it("traps Tab at both boundaries and leaves Escape to an inner popup", () => {
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
  const close = vi.fn(); render(<Modal title="Edit" onClose={close}><input aria-label="Name" /><button data-esc-claim>Last</button></Modal>);
  const first = screen.getByRole('button', { name: 'Close' }), last = screen.getByText('Last');
  last.focus(); fireEvent.keyDown(document, { key: 'Tab' }); expect(first).toHaveFocus();
  first.focus(); fireEvent.keyDown(document, { key: 'Tab', shiftKey: true }); expect(last).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' }); expect(close).not.toHaveBeenCalled();
});
function Primary({ enabled, run }: { enabled: boolean; run: () => void }) {
  usePrimaryAction('enter', enabled, run);
  return <><input aria-label="Name" /><textarea aria-label="Description" /><button>Cancel</button></>;
}
it("does not submit disabled actions, textarea newlines, or a focused secondary button", async () => {
  const user = userEvent.setup(), run = vi.fn(); const { rerender } = render(<Primary enabled={false} run={run} />);
  screen.getByLabelText('Name').focus(); await user.keyboard('{Enter}'); expect(run).not.toHaveBeenCalled();
  rerender(<Primary enabled run={run} />);
  screen.getByLabelText('Description').focus(); await user.keyboard('{Enter}'); expect(run).not.toHaveBeenCalled();
  screen.getByText('Cancel').focus(); await user.keyboard('{Enter}'); expect(run).not.toHaveBeenCalled();
  screen.getByLabelText('Name').focus(); await user.keyboard('{Enter}'); expect(run).toHaveBeenCalledTimes(1);
});
