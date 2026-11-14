import { beforeEach, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
const gpu = vi.hoisted(() => ({live:0,created:0,lose:[] as (() => void)[]}));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {
  live = true;
  constructor() { gpu.live++; gpu.created++; }
  onContextLoss(fn: () => void) { gpu.lose.push(fn); }
  dispose() { if (this.live) { this.live=false; gpu.live--; } }
}}));
import { terminalRenderer } from "./terminalRenderer";
beforeEach(() => {gpu.live=0;gpu.created=0;gpu.lose=[];});
it("keeps many hidden terminals context-free and reacquires only the visible pane", () => {
  const loadAddon = vi.fn();
  const term = {loadAddon} as unknown as Terminal;
  const panes = Array.from({length:32}, () => terminalRenderer(term));
  expect(gpu.created).toBe(0);
  panes[0].show(); panes[0].show();
  expect(gpu.live).toBe(1);
  for (let i=1;i<32;i++) { panes[i-1].hide(); panes[i].show(); expect(gpu.live).toBe(1); }
  panes[31].hide(); panes[0].show();
  expect(gpu.live).toBe(1);
  panes.forEach(p => p.hide());
  expect(gpu.live).toBe(0);
});
it("releases a lost context and falls back without repeatedly allocating", () => {
  const pane = terminalRenderer({loadAddon:vi.fn()} as unknown as Terminal);
  pane.show(); gpu.lose[0](); pane.show(); pane.hide();
  expect(gpu.live).toBe(0); expect(gpu.created).toBe(1);
});
it("releases a partially initialized addon if loading fails", () => {
  const pane = terminalRenderer({loadAddon:() => {throw new Error("GPU unavailable");}} as unknown as Terminal);
  expect(() => pane.show()).not.toThrow();
  expect(gpu.live).toBe(0);
});
