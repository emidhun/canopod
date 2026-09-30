import { afterEach, expect, it, vi } from "vitest";
import { bindTerminalImages, quoteTerminalPath } from "./terminalImages";
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((f) => f()); document.body.replaceChildren(); });
function fixture(active = true) {
  const host = document.createElement("div"); document.body.append(host);
  const sink = { active: () => active, save: vi.fn(async (_: number[]) => "/tmp/screenshot.png"), paste: vi.fn(), error: vi.fn() };
  const input = bindTerminalImages(host, sink); cleanups.push(input.dispose);
  return { host, sink, input };
}
function paste(host: HTMLElement, files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files } });
  host.dispatchEvent(event); return event;
}
const png = () => ({ type: "image/png", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) as File;
it("persists pasted image bytes and pastes a quoted path without executing a command", async () => {
  const { host, sink } = fixture();
  expect(paste(host, [png()]).defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(sink.paste).toHaveBeenCalledWith("'/tmp/screenshot.png' "));
  expect(sink.save).toHaveBeenCalledWith([1, 2, 3]);
  expect(sink.paste.mock.calls[0][0]).not.toContain("\n");
});
it("leaves text paste alone and rejects oversized images before IPC", async () => {
  const { host, sink } = fixture();
  expect(paste(host, []).defaultPrevented).toBe(false);
  paste(host, [{ ...png(), size: 9 * 1024 * 1024 }]);
  await vi.waitFor(() => expect(sink.error).toHaveBeenCalled());
  expect(sink.save).not.toHaveBeenCalled();
});
it("does not insert into a closed or hidden terminal", async () => {
  const { host, sink, input } = fixture();
  let finish!: (path: string) => void;
  sink.save.mockImplementation(() => new Promise((r) => { finish = r; }));
  paste(host, [png()]);
  await vi.waitFor(() => expect(sink.save).toHaveBeenCalled());
  input.dispose(); finish("/tmp/late.png");
  await Promise.resolve(); await Promise.resolve();
  expect(sink.paste).not.toHaveBeenCalled();
  const hidden = fixture(false);
  paste(hidden.host, [png()]); hidden.input.dropPaths(["/tmp/a.png"]);
  expect(hidden.sink.save).not.toHaveBeenCalled(); expect(hidden.sink.paste).not.toHaveBeenCalled();
});
it("quotes native drops safely, rejects control characters, and preserves Windows paths", () => {
  const { input, sink } = fixture();
  input.dropPaths(["/tmp/a b.png", "/tmp/o'ne.png"]);
  expect(sink.paste).toHaveBeenCalledWith("'/tmp/a b.png' '/tmp/o'\"'\"'ne.png' ");
  expect(quoteTerminalPath("C:\\Users\\Me\\a.png")).toBe("'C:/Users/Me/a.png'");
  expect(() => quoteTerminalPath("/tmp/x\nrm -rf")).toThrow();
});

it("accepts an image exposed only as a clipboard item", async () => {
  const { host, sink } = fixture();
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [], items: [{ kind: "file", type: "image/png", getAsFile: png }] } });
  host.dispatchEvent(event);
  await vi.waitFor(() => expect(sink.save).toHaveBeenCalledWith([1, 2, 3]));
});
