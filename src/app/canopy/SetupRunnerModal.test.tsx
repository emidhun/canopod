// #60 — the setup runner's step list: a result per step, each step's own
// output on request, and a failure you can copy rather than retype.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SetupRunnerModal from "./SetupRunnerModal";
import { useStore } from "../../store";
import { ipc } from "../../ipc";

const WT = { wtKey: "/r1/.worktrees/fix-a", branch: "fix-a" };

const toasts: string[] = [];
const writeText = vi.fn((_text: string) => Promise.resolve());

beforeEach(() => {
  toasts.length = 0;
  writeText.mockClear();
  useStore.setState({
    showToast: (m: string) => { toasts.push(m); },
    ops: {
      [WT.wtKey]: {
        running: false,
        results: { 1: "1,842 packages" },
        lines: [
          { text: "setup [1/2]: pnpm install", lv: "out" },
          { text: "added 1842 packages in 41s", lv: "out" },
          { text: "setup [2/2]: pnpm db:migrate", lv: "out" },
          { text: "QueryFailedError: relation does not exist", lv: "err" },
          { text: "  at PostgresQueryRunner.query", lv: "err" },
        ],
      },
    },
  } as never);
});

const open = () => render(<SetupRunnerModal wtKey={WT.wtKey} branch={WT.branch} onClose={() => {}} onStartServices={() => {}} />);

/** Replace the op buffer for one test. `lv` defaults to plain output. */
const setLines = (lines: { text: string; lv?: string }[], extra: Record<string, unknown> = {}) =>
  useStore.setState({
    showToast: (m: string) => { toasts.push(m); },
    ops: {
      [WT.wtKey]: { running: false, results: {}, lines: lines.map((l) => ({ lv: "out", ...l })), ...extra },
    },
  } as never);

const PROVISION_LINES = [
  { text: "provisioning 2 file(s)" },
  { text: "  \u2192 .env (dotenv)" },
  { text: "  \u2192 cypress-tests/cypress.env.json (json)" },
];

/* userEvent.setup() installs its own navigator.clipboard, so ours has to be
   defined after it — and defined rather than assigned, since it is a getter. */
function userWithClipboard() {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return user;
}

describe("the setup runner", () => {
  it("shows a result beside the step that produced one", async () => {
    open();
    expect(await screen.findByText("1,842 packages")).toBeInTheDocument();
  });

  it("expands a step to its own output, not the whole run", async () => {
    const user = userEvent.setup();
    open();
    const step = (await screen.findByText("pnpm install")).closest(".cx-step") as HTMLElement;
    await user.click(within(step).getByRole("button"));
    expect(within(step).getByText(/added 1842 packages/)).toBeInTheDocument();
    // the other step's output stays where it belongs
    expect(within(step).queryByText(/QueryFailedError/)).toBeNull();
  });

  /* The failed step used to open itself, printing its output directly above
     the red block printing the same output again — the identical npm log
     twice, with two copy buttons. The red block is the failure view. */
  it("leaves the failed step collapsed, and prints the failure once", async () => {
    const user = userEvent.setup();
    open();
    const failed = (await screen.findByText("pnpm db:migrate")).closest(".cx-step") as HTMLElement;
    expect(within(failed).queryByText(/QueryFailedError/)).toBeNull();

    const alert = document.querySelector(".cx-alert--error") as HTMLElement;
    expect(within(alert).getByText(/QueryFailedError/)).toBeInTheDocument();

    // still openable for anyone who wants it beside the step
    await user.click(within(failed).getByRole("button"));
    expect(within(failed).getByText(/QueryFailedError/)).toBeInTheDocument();
  });

  it("counts the lines it copied, not the events that carried them", async () => {
    const user = userWithClipboard();
    // a failure arrives as ONE event holding the command, the headline and the
    // stderr tail — counting events reported "2 lines" for a four-line paste
    setLines([
      { text: "setup [1/1]: pnpm build" },
      { text: "setup step failed: pnpm build\nError: cannot find module\n  at Object.<anonymous>", lv: "err" },
    ]);
    open();
    await user.click(await screen.findByRole("button", { name: /copy log/i }));
    expect(writeText.mock.calls[0][0].split("\n")).toHaveLength(4);
    expect(toasts[toasts.length - 1]).toMatch(/Copied the setup log — 4 lines/);
  });

  it("copies the whole buffered log on failure, not just the visible tail", async () => {
    const user = userWithClipboard();
    open();
    await user.click(await screen.findByRole("button", { name: /copy log/i }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0];
    // the first line is above the four-line preview, and is the one that explains it
    expect(copied).toContain("setup [1/2]: pnpm install");
    expect(copied).toContain("QueryFailedError");
    expect(toasts[toasts.length - 1]).toMatch(/Copied the setup log — 5 lines/);
  });

  it("reports the run's real total, not the count of whatever ran last", async () => {
    setLines([{ text: "setup [1/5]: pnpm install" }, { text: "added 1842 packages" }], { running: true });
    open();
    expect(await screen.findByText("Step 1 of 5")).toBeInTheDocument();
  });

  it("copies one step's output on its own", async () => {
    const user = userWithClipboard();
    open();
    const step = (await screen.findByText("pnpm install")).closest(".cx-step") as HTMLElement;
    await user.click(within(step).getByRole("button"));
    await user.click(within(step).getByRole("button", { name: /copy this step/i }));
    expect(writeText.mock.calls[0][0]).toBe("added 1842 packages in 41s");
  });
});

/* Provisioning is step 0 — announced as a plain line, counted as
   StepResult{index:0}. It renders through the same component as the numbered
   tasks: kept apart, the two drifted, and this row was left outside the flex
   head that aligns every other one. */
describe("the provisioning step", () => {
  it("is laid out like every other step", async () => {
    setLines([...PROVISION_LINES, { text: "setup [1/1]: pnpm install" }], { results: { 0: "2 files" } });
    open();
    const row = (await screen.findByText("provision files")).closest(".cx-step") as HTMLElement;
    // .cx-step is display:block; .cx-step__head is the flex row that aligns
    // the bullet, the label and the count.
    const head = row.querySelector(".cx-step__head") as HTMLElement;
    expect(head).not.toBeNull();
    expect(within(head).getByText("provision files")).toBeInTheDocument();
    expect(within(head).getByText("2 files")).toBeInTheDocument();
    expect(head.querySelector(".cx-step__bullet")?.textContent).toBe("\u2713");
  });

  it("expands to the files it wrote, and nothing that came before it", async () => {
    const user = userEvent.setup();
    setLines(
      // on create, the git work is streamed into the same buffer first
      [{ text: "fetching origin\u2026" }, { text: "submodule frontend/ee (sharing objects)" }, ...PROVISION_LINES, { text: "setup [1/1]: pnpm install" }],
      { results: { 0: "2 files" } },
    );
    open();
    const row = (await screen.findByText("provision files")).closest(".cx-step") as HTMLElement;
    await user.click(within(row).getByRole("button"));
    expect(within(row).getByText(/\.env \(dotenv\)/)).toBeInTheDocument();
    expect(within(row).getByText(/cypress\.env\.json \(json\)/)).toBeInTheDocument();
    expect(within(row).queryByText(/sharing objects/)).toBeNull();
  });

  it("shows while it is still running, before any count arrives", async () => {
    setLines(PROVISION_LINES, { running: true });
    open();
    const row = (await screen.findByText("provision files")).closest(".cx-step") as HTMLElement;
    expect(row.className).toContain("cx-step--active");
  });

  it("is the failed step when the run dies inside it", async () => {
    setLines([
      ...PROVISION_LINES.slice(0, 2),
      { text: "provision .env failed: permission denied", lv: "err" },
    ]);
    open();
    const row = (await screen.findByText("provision files")).closest(".cx-step") as HTMLElement;
    expect(row.className).toContain("cx-step--failed");
    // collapsed like any other: the red block below prints the error and copies it
    expect(within(row).queryByText(/permission denied/)).toBeNull();
  });
});

/* The create dialog hands its run over the moment the setup commands start,
   so this dialog now opens on top of a run it did not start. Invoking again
   would provision concurrently — two `npm install`s in one directory — and
   the backend has no per-worktree guard to catch it. */
describe("attaching to a run already in flight", () => {
  it("watches it rather than starting a second one", async () => {
    const run = vi.spyOn(ipc, "runWorktreeSetup").mockResolvedValue(undefined as never);
    // the effect only reaches the guard when there is a backend to invoke
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    setLines([{ text: "setup [1/5]: npm install" }], { running: true });
    open();
    expect(await screen.findByText("npm install")).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it("starts one when nothing is running", async () => {
    const run = vi.spyOn(ipc, "runWorktreeSetup").mockResolvedValue(undefined as never);
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    setLines([], { running: false });
    open();
    await screen.findByText("preparing\u2026");
    expect(run).toHaveBeenCalledWith(WT.wtKey);
  });
});

/* Attached runs — the create handoff mounts this dialog on a run it did not
   start, so `failed` (set only when OUR invoke rejects) is never set. Anything
   that asks "did this succeed?" has to read the operation buffer instead. */
describe("a run this dialog only watched", () => {
  const attachTo = (lines: { text: string; lv?: string }[]) => {
    setLines(lines, { running: true });
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    open();
  };
  const then = (lines: { text: string; lv?: string }[], running: boolean) =>
    act(() => {
      setLines(lines, { running });
    });

  it("does not call a failed setup complete", async () => {
    attachTo([{ text: "setup [1/1]: npm install" }]);
    then(
      [
        { text: "setup [1/1]: npm install" },
        { text: "npm ERR! code 1" },
        { text: "worktree created, but setup step failed: npm install", lv: "err" },
      ],
      false,
    );
    expect(await screen.findByText("Setup failed")).toBeInTheDocument();
    expect(screen.queryByText("Provisioned and ready.")).toBeNull();
    expect(screen.queryByRole("button", { name: /start services/i })).toBeNull();
  });

  it("completes a run whose every task was disabled", async () => {
    // nothing executes, so no [k/n] marker ever arrives — but the run still ends
    attachTo([{ text: "provisioning 1 file(s)" }, { text: "setup — skipped (disabled): pnpm db:migrate" }]);
    then(
      [
        { text: "provisioning 1 file(s)" },
        { text: "setup — skipped (disabled): pnpm db:migrate" },
        { text: "worktree ready", lv: "ok" },
      ],
      false,
    );
    expect(await screen.findByText("Setup complete")).toBeInTheDocument();
    expect(screen.getByText("Provisioned and ready.")).toBeInTheDocument();
  });
});
