/* Where creating a worktree ends and setting it up begins.

   The create dialog reports its own work — fetching, `git worktree add`,
   submodules, provisioning — as a four-line tail. The setup commands are a
   different shape entirely: a numbered step list with per-step output and a
   copyable failure, which the setup runner already renders and this tail can
   only flatten. So the first setup-phase line hands the stream over.

   Getting this predicate wrong is not cosmetic. Too eager and the dialog
   disappears while the worktree is still being checked out; too lax and the
   npm log lands back in the tail this change exists to empty. */
import { describe, expect, it } from "vitest";
import { createOpAction, isSetupStart } from "./NewWorktreeModal";

describe("the create/setup boundary", () => {
  it("hands over on the first line of the setup phase", () => {
    for (const line of [
      "setup [1/5]: npm --prefix frontend install --no-audit --no-fund",
      "setup [parallel]: running 3 tasks at once",
    ]) {
      expect(isSetupStart(line), line).toBe(true);
    }
  });

  it("keeps everything creation does for itself", () => {
    for (const line of [
      "creating worktree for Enhance/override-codemirror-autocomplete-default-filter…",
      "fetching origin…",
      "git worktree add /Users/m/CE/ToolJet/.worktrees/appbuilder_sprint-10",
      "initializing 2 submodule(s)…",
      "submodule frontend/ee (sharing objects)",
      "provisioning 2 file(s)",
      "  → cypress-tests/cypress.env.json (json)",
      "starting services…",
      "worktree ready",
      // command output, which only ever arrives after the handoff
      "npm WARN ERESOLVE overriding peer dependency",
    ]) {
      expect(isSetupStart(line), line).toBe(false);
    }
  });

  it("does not hand over when nothing will execute", () => {
    // run_setup is off for this repo: no commands at all
    expect(isSetupStart("setup skipped — Run setup when you're ready")).toBe(false);
    // and a repo whose every task is disabled emits only these, then finishes —
    // handing that over opens a runner with no step it can ever show
    expect(isSetupStart("setup — skipped (disabled): pnpm db:migrate")).toBe(false);
  });
});

/* Whose create is this? A create left running in the background emits on the
   same channel, so "this dialog is busy" does not make an event its own. */
describe("claiming a create event", () => {
  const MINE = "/r/.worktrees/current";
  const ctx = { destination: MINE, busy: true };

  it("hands over its own setup", () => {
    expect(createOpAction({ wtKey: MINE, detail: "setup [1/5]: npm install" }, ctx)).toBe("handoff");
  });

  it("reports its own creation inline", () => {
    expect(createOpAction({ wtKey: MINE, detail: "provisioning 2 file(s)" }, ctx)).toBe("append");
  });

  it("ignores a create running in the background", () => {
    // start A in the background, then create B: A's first setup marker used to
    // close B's dialog and open a runner labelled with B's branch that would
    // have started A's services
    const other = { wtKey: "/r/.worktrees/other", detail: "setup [1/5]: npm install" };
    expect(createOpAction(other, ctx)).toBe("ignore");
    expect(createOpAction({ ...other, detail: "fetching origin…" }, ctx)).toBe("ignore");
  });

  it("keeps the stream when it cannot tell two creates apart", () => {
    // the repo's settings could not be read, so there is no predicted path to
    // match on — report inline rather than hand a runner the wrong worktree
    const blind = { destination: null, busy: true };
    expect(createOpAction({ wtKey: MINE, detail: "setup [1/5]: npm install" }, blind)).toBe("append");
    expect(createOpAction({ wtKey: MINE, detail: "fetching origin…" }, blind)).toBe("append");
  });

  it("does not hand over before this dialog has started creating", () => {
    expect(createOpAction({ wtKey: MINE, detail: "setup [1/5]: npm install" }, { ...ctx, busy: false })).toBe("append");
  });
});
