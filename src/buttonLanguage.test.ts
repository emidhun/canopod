/* The `btn` family belongs to two roots, and nowhere else.

   `.btn` gets its background and colour only from `.cxset-root .btn`
   (settings) and `.ob-root .btn` (onboarding); the `gh`, `pri` and `danger`
   modifiers are defined under those roots too. Used anywhere else the button
   inherits nothing and falls through to the browser's default chrome — a pale
   slab with dark text, in a dark app.

   That is a real bug twice over: the overview's Measure button rendered as a
   grey block in every row of the Size column, and the setup runner's two copy
   buttons did the same inside a dark modal. Neither tsc nor a render test can
   see it, because the markup is valid and the class simply matches no rule.

   The rest of the app speaks `cx-btn` (canopy-components.css) or `btn-sm`
   (terminal.css), both of which stand on their own. */
import { describe, expect, it } from "vitest";

/** Every source file, read at transform time — no node types needed, and the
    glob cannot silently stop matching the way a hand-walked path can. */
const FILES = import.meta.glob("./**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Where the `btn` family is actually defined, and so may be used. */
const ROOTS = ["./app/settings/", "./onboarding/"];

/** Every class token written into a className literal, with its line. */
function classTokens(src: string): { token: string; line: number }[] {
  const out: { token: string; line: number }[] = [];
  src.split("\n").forEach((text, i) => {
    for (const m of text.matchAll(/className=\{?["'`]([^"'`]*)["'`]/g)) {
      for (const token of m[1].split(/\s+/)) if (token) out.push({ token, line: i + 1 });
    }
  });
  return out;
}

describe("the button language", () => {
  it("keeps the settings `btn` family inside the roots that style it", () => {
    const files = Object.keys(FILES).filter(
      (f) => !/\.(test|spec)\.tsx?$/.test(f) && !ROOTS.some((r) => f.startsWith(r)),
    );
    // a guard that scanned nothing would pass forever
    expect(files.length).toBeGreaterThan(20);

    const stray = files.flatMap((f) =>
      classTokens(FILES[f])
        .filter((t) => t.token === "btn")
        .map((t) => `${f.replace("./", "src/")}:${t.line}`),
    );
    expect(stray, "use cx-btn (canopy-components.css) outside the settings and onboarding roots").toEqual([]);
  });
});
