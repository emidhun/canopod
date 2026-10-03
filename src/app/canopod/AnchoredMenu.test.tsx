import { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import AnchoredMenu from "./AnchoredMenu";

function Menu() {
  const anchor = useRef<HTMLButtonElement>(null), [open, setOpen] = useState(false);
  return <><button ref={anchor} onClick={() => setOpen(v => !v)}>Open menu</button><button>Outside</button>{open && <AnchoredMenu anchor={anchor} onClose={() => setOpen(false)} width={220} label="Actions"><button role="menuitem">First</button><button role="menuitem" disabled>Unavailable</button><button role="menuitem">Last</button></AnchoredMenu>}</>;
}
it("portals the menu and navigates enabled items with arrows, Home and End", async () => {
  const user = userEvent.setup(); const { container } = render(<Menu />);
  await user.click(screen.getByRole("button", { name: "Open menu" }));
  expect(container).not.toContainElement(screen.getByRole("menu", { name: "Actions" }));
  await user.keyboard('{ArrowDown}'); expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
  await user.keyboard('{ArrowDown}'); expect(screen.getByRole("menuitem", { name: "Last" })).toHaveFocus();
  await user.keyboard('{ArrowDown}'); expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
  await user.keyboard('{End}'); expect(screen.getByRole("menuitem", { name: "Last" })).toHaveFocus();
  await user.keyboard('{Home}'); expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
  await user.keyboard('{Escape}'); expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open menu" })).toHaveFocus();
});
it("closes on outside clicks without dismissing clicks inside the menu", async () => {
  const user = userEvent.setup(); render(<Menu />);
  await user.click(screen.getByText("Open menu")); await user.click(screen.getByText("First"));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  await user.click(screen.getByText("Outside")); expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});
it("updates placement when the viewport resizes", async () => {
  const user = userEvent.setup(); render(<Menu />); await user.click(screen.getByText("Open menu"));
  const menu = screen.getByRole("menu");
  expect(menu.style.position).toBe("fixed");
  fireEvent(window, new Event('resize'));
  expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(4);
  expect(Number.parseFloat(menu.style.right)).toBeGreaterThanOrEqual(4);
});
it("focuses dialog controls and wraps Tab before returning focus on Escape", async () => {
  function Dialog() {
    const anchor = useRef<HTMLButtonElement>(null), [open, setOpen] = useState(false);
    return <><button ref={anchor} onClick={() => setOpen(true)}>Open dialog</button>{open && <AnchoredMenu anchor={anchor} role="dialog" label="Services" onClose={() => setOpen(false)}><button>Details</button><button>Database</button></AnchoredMenu>}</>;
  }
  const user = userEvent.setup(); render(<Dialog />);
  await user.click(screen.getByText("Open dialog"));
  expect(screen.getByText("Details")).toHaveFocus();
  await user.tab({shift:true}); expect(screen.getByText("Database")).toHaveFocus();
  await user.tab(); expect(screen.getByText("Details")).toHaveFocus();
  await user.keyboard('{Escape}'); expect(screen.getByText("Open dialog")).toHaveFocus();
});
