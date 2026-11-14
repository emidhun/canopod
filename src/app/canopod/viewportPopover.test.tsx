import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { popoverPosition } from "./viewportPopover";
import RefPick from "./RefPick";
import Modal from "./Modal";

const rect = (top: number, bottom: number, left = 20, width = 300) => ({ top, bottom, left, width } as DOMRect);
it("flips near the bottom and clamps both axes on small windows", () => {
  expect(popoverPosition(rect(500, 532), 300, 196, 800, 600)).toEqual({top:300,left:20,width:300,maxHeight:196});
  expect(popoverPosition(rect(20, 52), 300, 196, 800, 600).top).toBe(56);
  const small = popoverPosition(rect(40, 72, 280), 400, 196, 320, 120);
  expect(small).toEqual({top:76,left:4,width:312,maxHeight:40});
  expect(small.top + small.maxHeight).toBeLessThanOrEqual(116);
});
it("opens in the top layer, selects a ref, and closes Escape before the modal", () => {
  const show = vi.fn(function(this: HTMLElement) { this.style.display = "block"; }), hide = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable:true, value:show });
  Object.defineProperty(HTMLElement.prototype, "hidePopover", { configurable:true, value:hide });
  const pick = vi.fn(), close = vi.fn();
  render(<Modal title="New" onClose={close}><RefPick value="main" branches={{local:["main","feature"],remote:[],tags:[]}} onPick={pick}/></Modal>);
  const input = screen.getByRole("textbox");
  fireEvent.click(input);
  expect(show).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(input, {key:"Escape"});
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByText("feature")).not.toBeInTheDocument();
  fireEvent.click(input);
  fireEvent.click(screen.getByRole("button", {name:"feature"}));
  expect(pick).toHaveBeenCalledWith("feature", "local");
  expect(screen.queryByRole("button", {name:"feature"})).not.toBeInTheDocument();
  fireEvent.keyDown(input, {key:"Escape"});
  expect(close).toHaveBeenCalledTimes(1);
});
