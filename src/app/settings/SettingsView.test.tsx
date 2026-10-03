// Smoke tests for the Settings shell after the per-page split.
//
// These do not test any page's behaviour — they prove the shell still wires
// every page up: each nav entry renders its panel without throwing, which is
// exactly what a compile-only check cannot tell you.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ipcModule from "../../ipc";
import SettingsView from "./SettingsView";
import { MOCK } from "./mocks";

afterEach(() => window.history.replaceState({}, '', '/'));

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
    expect(await screen.findByText("How Canopod looks and what it does on launch.")).toBeInTheDocument();
  });

  it("renders every page without throwing", async () => {
    const user = userEvent.setup();
    open();
    // blurbs are unique per page, so they identify the rendered panel
    const pages: [string, string][] = [
      ["MCP", "Connect agents to Canopod and choose which repositories they can access."],
      ["Terminal", "The shell Canopod opens inside a worktree, and what it inherits."],
      ["Notifications", "Canopod only interrupts you for things that need a decision."],
      ["Shortcuts", "Every command is reachable from the keyboard."],
      ["Advanced", "Diagnostics, experiments and reset."],
      ["Services", "Long-running processes Canopod starts per worktree. Ports derive from the worktree index so they never collide."],
      ["Agents", "Which agent CLIs are available, and what context they inherit."],
      ["Commands", "Named scripts you can launch in any worktree from the + menu."],
      ["Files", "Files seeded or templated into every new worktree — any path, any format."],
      ["Setup", "Commands run in order the first time a worktree is created."],
      ["Security", "How secrets are handled in provisioned files and exports."],
    ];
    for (const [nav, blurb] of pages) {
      await user.click((await screen.findAllByText(nav))[0]);
      expect(await screen.findByText(blurb)).toBeInTheDocument();
      expect(document.querySelector("button button")).toBeNull();
    }
  });
});

it("checks for releases and reminds about GitHub without silently installing", () => {
  expect(MOCK.updates).toEqual({ autoCheck: true, autoInstall: false, starReminder: true });
});

it("keeps dirty settings until the user chooses an exit action", async () => {
  const user = userEvent.setup();
  let closed = false;
  render(<SettingsView onClose={() => { closed = true; }} />);
  const editor = await screen.findByDisplayValue("code");
  await user.type(editor, " --wait");
  await user.click(screen.getByRole("button", { name: "Back to workspace" }));
  expect(closed).toBe(false);
  expect(screen.getByRole("dialog", { name: "Save your changes?" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(editor).toHaveValue("code --wait");
  await user.click(screen.getByRole("button", { name: "Back to workspace" }));
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(closed).toBe(true);
});

it("shows a recoverable settings load failure", async () => {
  const backend = vi.spyOn(ipcModule, "hasBackend").mockReturnValue(true);
  vi.spyOn(ipcModule.ipc, "getSettings").mockRejectedValue(new Error("Backend unavailable"));
  try {
    const user = userEvent.setup();
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("Backend unavailable");
    backend.mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("How Canopod looks and what it does on launch.")).toBeInTheDocument();
  } finally { vi.restoreAllMocks(); }
});

it.each(['general', 'repo-general', 'mcp', 'terminal', 'notifications', 'shortcuts', 'security', 'advanced', 'services', 'agents', 'commands', 'files', 'setup'] as const)('keeps %s page controls named and interactive actions unnested', async page => {
  window.history.replaceState({}, '', `/?review=settings&page=${page}`);
  const { container } = render(<SettingsView onClose={() => {}} />);
  await screen.findByRole('button', { name: 'Back to workspace' });
  // Expand editor disclosures to include advanced content in the contract.
  const summaries = container.querySelectorAll<HTMLDetailsElement>('.pmain details'); summaries.forEach(d => { d.open = true; });
  const body = container.querySelector('.pmain')!;
  for (const control of body.querySelectorAll('input:not([type="hidden"]),select,textarea,button')) {
    if (control.matches('input[type="file"]')) continue;
    expect(control, `${page}: ${control.outerHTML}`).toHaveAccessibleName();
  }
  expect(body.querySelector('button button')).toBeNull();
});
it('keeps application drafts when switching pages and saves through the guarded exit', async () => {
  const user = userEvent.setup(), close = vi.fn(); render(<SettingsView onClose={close} />);
  await user.type(await screen.findByDisplayValue('code'), ' --wait');
  await user.click(screen.getAllByText('Notifications')[0]);
  await user.click(screen.getAllByText('General')[0]);
  expect(screen.getByDisplayValue('code --wait')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Back to workspace' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save and leave' }));
  expect(close).toHaveBeenCalledTimes(1);
});
it('names the repository dialog and returns keyboard focus to its trigger', async () => {
  const user = userEvent.setup(); render(<SettingsView onClose={() => {}} />);
  const trigger = await screen.findByTitle('Switch repository');
  await user.click(trigger);
  const dialog = screen.getByRole('dialog', {name:'Choose repository'});
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', {name:'Choose repository'})).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
