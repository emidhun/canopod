import { render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const terminal = vi.hoisted(() => ({ dispose:vi.fn(),write:vi.fn(),show:vi.fn(),hide:vi.fn() }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols=80; rows=24; options={};
  open() {} loadAddon() {} reset() {}
  write = terminal.write;
  dispose = terminal.dispose;
  registerLinkProvider() { return {dispose:vi.fn()}; }
  onData() { return {dispose:vi.fn()}; }
}}));
vi.mock("@xterm/addon-fit", () => ({FitAddon:class { fit() {} }}));
vi.mock("@xterm/addon-web-links", () => ({WebLinksAddon:class {}}));
vi.mock("./terminalRenderer", () => ({terminalRenderer:() => ({show:terminal.show,hide:terminal.hide})}));
vi.mock("../ipc", () => ({
  hasBackend:() => true, errText:String,
  ipc:{getSettings:vi.fn(async()=>({})), terminalOpen:vi.fn(async()=>{}), terminalResize:vi.fn(async()=>{}), terminalGetBuffer:vi.fn(async()=>({buffer:btoa("retained output"),seq:15}))},
  on:{terminalData:vi.fn(async()=>vi.fn()),terminalExit:vi.fn(async()=>vi.fn())},
}));
import TerminalPane from "./TerminalPane";
import { ipc } from "../ipc";
it("toggles rendering without recreating a retained terminal or reopening its PTY", async () => {
  vi.stubGlobal("ResizeObserver", class {observe() {} disconnect() {}});
  const pane = render(<TerminalPane termId="shell" cwd="/repo" hidden readOnly/>);
  await waitFor(()=>expect(terminal.write).toHaveBeenCalled());
  expect(terminal.show).not.toHaveBeenCalled();
  pane.rerender(<TerminalPane termId="shell" cwd="/repo" readOnly/>);
  expect(terminal.show).toHaveBeenCalledTimes(1);
  pane.rerender(<TerminalPane termId="shell" cwd="/repo" hidden readOnly/>);
  expect(terminal.hide).toHaveBeenCalled();
  expect(terminal.dispose).not.toHaveBeenCalled();
  expect(ipc.terminalOpen).not.toHaveBeenCalled();
  expect(ipc.terminalGetBuffer).toHaveBeenCalledTimes(1);
  pane.unmount(); expect(terminal.dispose).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
});
