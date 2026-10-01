// #43 end to end: a half-filled row blocks the save, is named, and is marked.
//
// The unit tests in incomplete.test.ts pin which rows count as incomplete and
// how they are phrased. This one proves the shell actually refuses the save
// and puts the offending row on screen.
//
// "Add agent" seeds the row with a name and no command — which is precisely
// the shape the issue reports as vanishing on save.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "./SettingsView";
import { useStore } from "../../store";

const toasts: string[] = [];
beforeEach(() => {
  toasts.length = 0;
  vi.spyOn(useStore.getState(), "showToast").mockImplementation((m: string) => { toasts.push(m); });
});

const save = (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Meta>}s{/Meta}");

// "Canopy" is also the platform nav group heading, so the repo has to be
// picked from inside the menu rather than by page-wide text.
async function pickRepo(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByTitle("Switch repository"));
  const menu = document.querySelector(".varmenu") as HTMLElement;
  await user.click(within(menu).getByText(name));
}

async function addHalfFilledAgent() {
  const user = userEvent.setup();
  const view = render(<SettingsView onClose={() => {}} />);
  await user.click((await screen.findAllByText("Agents"))[0]);
  await user.click(await screen.findByText(/Add agent/i));
  return { user, ...view };
}

describe("saving with an incomplete row", () => {
  it("refuses the save and names the row instead of dropping it", async () => {
    const { user } = await addHalfFilledAgent();
    await save(user);
    expect(toasts[toasts.length - 1]).toBe('Nothing saved — the agent "New agent" in ToolJet needs a command.');
  });

  it("marks the offending row in the editor", async () => {
    const { user, container } = await addHalfFilledAgent();
    await save(user);

    const marked = container.querySelector(".obj.incomplete");
    expect(marked).not.toBeNull();
    expect(within(marked as HTMLElement).getByText("needs a command")).toBeInTheDocument();
  });

  it("clears the mark as soon as the row is edited again", async () => {
    const { user, container } = await addHalfFilledAgent();
    await save(user);
    expect(container.querySelector(".obj.incomplete")).not.toBeNull();

    await user.type(screen.getByPlaceholderText("claude"), "c");
    expect(container.querySelector(".obj.incomplete")).toBeNull();
  });

  it("saves once the missing field is filled in", async () => {
    const { user } = await addHalfFilledAgent();
    await user.type(screen.getByPlaceholderText("claude"), "codex");
    await save(user);
    expect(toasts[toasts.length - 1]).not.toMatch(/Nothing saved/);
  });
});

describe("clearing the marks", () => {
  // Discard reloads settings from the backend; leaving the marks behind left
  // a red row with no unsaved change to explain it, and nothing to clear it.
  it("Discard clears the marks along with the edits", async () => {
    const { user, container } = await addHalfFilledAgent();
    await save(user);
    expect(container.querySelector(".obj.incomplete")).not.toBeNull();

    await user.click(await screen.findByText("Discard"));
    expect(container.querySelector(".obj.incomplete")).toBeNull();
  });
});

describe("scoping the marks to their repo", () => {
  // A row key is kind + index and carries no repo id, while the pre-save scan
  // runs over every repo. A single flat map therefore marked the OTHER repo's
  // row at the same index — its first service, which is perfectly valid.
  it("does not mark another repo's row at the same index", async () => {
    const user = userEvent.setup();
    const { container } = render(<SettingsView onClose={() => {}} />);

    // switch to Canopy, which has no services, and add an empty one
    await pickRepo(user, "Canopy");
    await user.click((await screen.findAllByText("Services"))[0]);
    await user.click(await screen.findByText(/Add service/i));
    await save(user);

    // the save refused and jumped to Canopy's brand new service:0
    expect(container.querySelector(".obj.incomplete")).not.toBeNull();

    // ToolJet's service:0 is "Frontend", which is complete — it must be clean
    await pickRepo(user, "ToolJet");
    expect(container.querySelector(".obj.incomplete")).toBeNull();
    expect(screen.getByText("Frontend")).toBeInTheDocument();
  });

  it("names the repository in the message once more than one is configured", async () => {
    const user = userEvent.setup();
    render(<SettingsView onClose={() => {}} />);
    await pickRepo(user, "Canopy");
    await user.click((await screen.findAllByText("Services"))[0]);
    await user.click(await screen.findByText(/Add service/i));
    await save(user);

    expect(toasts[toasts.length - 1]).toContain("in Canopy");
  });
});
