import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import SettingsView from "./SettingsView";
import { ipc, type RepoConfigFile } from "../../ipc";
import { MOCK } from "./mocks";

vi.mock("../../ipc", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../ipc")>()), hasBackend: () => true }));

beforeEach(() => vi.restoreAllMocks());

it("keeps a Files edit when the initial config read resolves late", async () => {
  let resolve!: (config: RepoConfigFile) => void;
  vi.spyOn(ipc, "getSettings").mockResolvedValue({ ...MOCK, repos: [MOCK.repos[0]] });
  vi.spyOn(ipc, "getRepoConfig").mockReturnValue(new Promise((done) => { resolve = done; }));
  const user = userEvent.setup();
  render(<SettingsView onClose={() => {}} />);
  await user.click((await screen.findAllByText("Files"))[0]);
  await user.click(screen.getByText("Add file"));
  const field = screen.getByPlaceholderText(".env or config/app.json");
  await user.type(field, "my.env");
  await act(async () => resolve({ provision: [], setup: [], teardown: [], migrate: [], setupPolicy: { continueOnFailure: false, timeoutSecs: 0 } }));
  expect(field).toHaveValue("my.env");
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
