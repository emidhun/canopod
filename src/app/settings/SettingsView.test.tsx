// Smoke tests for the Settings shell after the per-page split.
//
// These do not test any page's behaviour — they prove the shell still wires
// every page up: each nav entry renders its panel without throwing, which is
// exactly what a compile-only check cannot tell you.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import SettingsView from "./SettingsView";
import { MOCK } from "./mocks";

// No Tauri in jsdom, so hasBackend() is false and the shell loads MOCK.
const open = () => render(<SettingsView onClose={() => {}} />);

describe("SettingsView shell", () => {
  // "General" is deliberately ambiguous — the platform page and the repo page
  // are both called that, which is why the nav uses the repo picker as a scope
  // divider rather than renaming either one.
  it("renders the platform pages in the nav", async () => {
    open();
    for (const label of ["General", "Terminal", "Notifications", "Shortcuts", "Advanced"]) {
      expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
    }
  });

  it("opens on General", async () => {
    open();
    expect(await screen.findByText("How Canopy looks and what it does on launch.")).toBeInTheDocument();
  });

  it("renders every page without throwing", async () => {
    const user = userEvent.setup();
    open();
    // blurbs are unique per page, so they identify the rendered panel
    const pages: [string, string][] = [
      ["MCP", "Connect agents to Canopy and choose which repositories they can access."],
      ["Terminal", "The shell Canopy opens inside a worktree, and what it inherits."],
      ["Notifications", "Canopy only interrupts you for things that need a decision."],
      ["Shortcuts", "Every command is reachable from the keyboard."],
      ["Advanced", "Diagnostics, experiments and reset."],
      ["Services", "Long-running processes Canopy starts per worktree. Ports derive from the worktree index so they never collide."],
      ["Agents", "Which agent CLIs are available, and what context they inherit."],
      ["Commands", "Named scripts you can launch in any worktree from the + menu."],
      ["Files", "Files seeded or templated into every new worktree — any path, any format."],
      ["Setup", "Commands run in order the first time a worktree is created."],
      ["Security", "How secrets are handled in provisioned files and exports."],
    ];
    for (const [nav, blurb] of pages) {
      await user.click((await screen.findAllByText(nav))[0]);
      expect(await screen.findByText(blurb)).toBeInTheDocument();
    }
  });
});

it("checks for releases and reminds about GitHub without silently installing", () => {
  expect(MOCK.updates).toEqual({ autoCheck: true, autoInstall: false, starReminder: true });
});
