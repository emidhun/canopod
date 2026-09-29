import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import SettingsView from "./SettingsView";
import { ipc, type RepoConfigFile } from "../../ipc";
import { MOCK } from "./mocks";

vi.mock("../../ipc", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../ipc")>()), hasBackend: () => true }));

beforeEach(() => vi.restoreAllMocks());

it("waits for the initial config before editing and preserves existing setup on save", async () => {
  let resolve!: (config: RepoConfigFile) => void;
  vi.spyOn(ipc, "getSettings").mockResolvedValue({ ...MOCK, repos: [MOCK.repos[0]] });
  vi.spyOn(ipc, "getRepoConfig").mockReturnValue(new Promise((done) => { resolve = done; }));
  vi.spyOn(ipc, "saveSettings").mockResolvedValue();
  const saveRepo = vi.spyOn(ipc, "saveRepoConfig").mockResolvedValue();
  const user = userEvent.setup();
  const { container } = render(<SettingsView onClose={() => {}} />);
  await user.click((await screen.findAllByText("Files"))[0]);
  expect(screen.queryByText("Add file")).not.toBeInTheDocument();
  // Import can mark this repo dirty independently of the gated editors.
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['{"provision":[]}'], "config.json", { type: "application/json" })] } });
  await screen.findByText("Discard");
  await user.keyboard("{Meta>}s{/Meta}");
  expect(saveRepo).not.toHaveBeenCalled();
  const setup = [{ cmd: "existing setup", cwd: "", enabled: true, continueOnFailure: false, timeoutSecs: 0 }];
  await act(async () => resolve({ provision: [], setup, teardown: ["keep teardown"], migrate: [], setupPolicy: { continueOnFailure: false, timeoutSecs: 0 } }));
  await user.type(screen.getByLabelText("migrate commands"), "new migration");
  await user.keyboard("{Meta>}s{/Meta}");
  await waitFor(() => expect(saveRepo).toHaveBeenCalledTimes(1));
  expect(saveRepo.mock.calls[0][2]).toEqual(setup);
  expect(saveRepo.mock.calls[0][4]?.teardown).toEqual(["keep teardown"]);
});

it("keeps a Files edit on the live page when a refresh resolves late", async () => {
  const initial = { provision: [], setup: [], teardown: [], migrate: [], setupPolicy: { continueOnFailure: false, timeoutSecs: 0 } };
  vi.spyOn(ipc, "getSettings").mockResolvedValue({ ...MOCK, repos: [MOCK.repos[0]] });
  const read = vi.spyOn(ipc, "getRepoConfig").mockResolvedValue(initial);
  const user = userEvent.setup();
  render(<SettingsView onClose={() => {}} />);
  await user.click((await screen.findAllByText("Files"))[0]);
  let resolve!: (config: RepoConfigFile) => void;
  read.mockReturnValue(new Promise((done) => { resolve = done; }));
  const { useStore } = await import("../../store");
  act(() => useStore.getState().bumpSettings());
  await user.click(screen.getByText("Add file"));
  await user.type(screen.getByPlaceholderText(".env or config/app.json"), "my.env");
  await act(async () => resolve(initial));
  expect(screen.getByDisplayValue("my.env")).toBeInTheDocument();
});

it("keeps edits made while a repo save is pending", async () => {
  vi.spyOn(ipc, "getSettings").mockResolvedValue({ ...MOCK, repos: [MOCK.repos[0]] });
  vi.spyOn(ipc, "getRepoConfig").mockResolvedValue({ provision: [], setup: [], teardown: [], migrate: [], setupPolicy: { continueOnFailure: false, timeoutSecs: 0 } });
  vi.spyOn(ipc, "saveSettings").mockResolvedValue();
  let saved!: () => void;
  const saveRepo = vi.spyOn(ipc, "saveRepoConfig").mockReturnValue(new Promise<void>((done) => { saved = done; }));
  const user = userEvent.setup();
  render(<SettingsView onClose={() => {}} />);
  await user.click((await screen.findAllByText("Files"))[0]);
  const field = screen.getByLabelText("migrate commands");
  await user.type(field, "first");
  await user.keyboard("{Meta>}s{/Meta}");
  await waitFor(() => expect(saveRepo).toHaveBeenCalledTimes(1));
  await user.type(field, "-new");
  await act(async () => saved());
  expect(field).toHaveValue("first-new");
  expect(screen.getByText("Discard")).toBeInTheDocument();
  saveRepo.mockResolvedValue();
  await user.keyboard("{Meta>}s{/Meta}");
  await waitFor(() => expect(saveRepo).toHaveBeenCalledTimes(2));
  expect(saveRepo.mock.calls[1][4]?.migrate).toEqual(["first-new"]);
});
