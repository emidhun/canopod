// #89 — the keybinding registry. The handler dispatches off it and the
// Shortcuts page renders from it, so they cannot drift; these pin the rules
// that make remapping safe.
import { describe, expect, it } from "vitest";
import { KEY_ACTIONS, conflicts, displayBinding, normalizeBinding, resolveBindings } from "./keys";
import type { Settings } from "../ipc";

const settings = (keybindings: Record<string, string>) => ({ keybindings } as unknown as Settings);
const ev = (o: Partial<KeyboardEvent>) =>
  ({ key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o }) as KeyboardEvent;

describe("normalizeBinding", () => {
  // one stored binding has to be correct on macOS and everywhere else; storing
  // "Meta+k" would mean a config that works on one machine and not another
  it("folds Cmd and Ctrl into one Mod", () => {
    expect(normalizeBinding(ev({ key: "k", metaKey: true }))).toBe("Mod+k");
    expect(normalizeBinding(ev({ key: "k", ctrlKey: true }))).toBe("Mod+k");
  });

  it("orders modifiers consistently, whatever order they arrive in", () => {
    expect(normalizeBinding(ev({ key: "n", metaKey: true, shiftKey: true }))).toBe("Mod+Shift+n");
    expect(normalizeBinding(ev({ key: "n", shiftKey: true, metaKey: true }))).toBe("Mod+Shift+n");
  });

  it("lowercases single characters but keeps named keys intact", () => {
    expect(normalizeBinding(ev({ key: "K", metaKey: true }))).toBe("Mod+k");
    expect(normalizeBinding(ev({ key: "Enter" }))).toBe("Enter");
  });
});

describe("resolveBindings", () => {
  it("returns the shipped defaults when nothing is overridden", () => {
    const b = resolveBindings(null);
    expect(b.palette).toBe("Mod+k");
    expect(Object.keys(b).length).toBe(KEY_ACTIONS.length);
  });

  it("applies an override", () => {
    expect(resolveBindings(settings({ palette: "Mod+j" })).palette).toBe("Mod+j");
  });

  // losing Escape would leave modals and the palette with no keyboard
  // dismissal at all, so a hand-edited config cannot take it
  it("refuses to remap a fixed action", () => {
    expect(resolveBindings(settings({ dismiss: "Mod+q" })).dismiss).toBe("Escape");
  });

  it("ignores an override for an action this build no longer has", () => {
    const b = resolveBindings(settings({ "no-such-action": "Mod+z" }));
    expect(b["no-such-action"]).toBeUndefined();
  });

  it("ignores a blank override rather than unbinding the action", () => {
    expect(resolveBindings(settings({ palette: "   " })).palette).toBe("Mod+k");
  });
});

describe("conflicts", () => {
  it("finds nothing in the shipped defaults", () => {
    expect(conflicts(resolveBindings(null)).size).toBe(0);
  });

  // surfaced rather than prevented: two bindings can legitimately collide
  // while someone is halfway through swapping them
  it("names both sides of a clash", () => {
    const c = conflicts(resolveBindings(settings({ overview: "Mod+k" })));
    expect(c.has("overview")).toBe(true);
    expect(c.has("palette")).toBe(true);
  });
});

describe("displayBinding", () => {
  it("writes mac glyphs on a mac", () => {
    expect(displayBinding("Mod+Shift+n", true)).toBe("⌘ ⇧ N");
    expect(displayBinding("Enter", true)).toBe("⏎");
  });

  it("writes words elsewhere", () => {
    expect(displayBinding("Mod+Shift+n", false)).toBe("Ctrl+Shift+N");
  });
});

describe("the registry", () => {
  it("has no duplicate ids", () => {
    const ids = KEY_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // the page is a reference, so an entry with no listener is worse than a gap
  it("covers the shortcuts the app grew after the registry was written", () => {
    for (const id of ["settings", "add-repo", "sync-submodules"]) {
      expect(KEY_ACTIONS.some((a) => a.id === id)).toBe(true);
    }
  });
});
