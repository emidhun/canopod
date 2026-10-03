/* Setup runner — the provisioning stream as a step list rather than a spinner.

   Steps come from the worktree:op buffer the store already folds; the backend
   emits ordered "{label} [k/n]: cmd" markers. "Run in background" simply closes the
   dialog: the run is backend-owned and keeps going either way, which is why
   the button says what it does rather than "Hide". */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Cube, Play, Spinner } from "../../icons";
import { errText, hasBackend, ipc } from "../../ipc";
import { useStore } from "../../store";
import Modal, { Hint, Spacer, usePrimaryAction } from "./Modal";

/** setup.rs emits `{label} [2/5]: pnpm install` — the operation label comes
    first, so the marker is matched anywhere in the line rather than anchored. */
const STEP = /\[(\d+)\/(\d+)\]:\s*(.*)$/;

/** Provisioning carries no [k/n] marker — it is not one of the numbered setup
    tasks. `run_setup` announces it with this line and reports its count as
    StepResult{index:0}, which is why it is step 0 everywhere below. */
const PROVISION = /^provisioning \d+ file/;

const EMPTY_RESULTS: Record<number, string> = {};

export default function SetupRunnerModal({
  wtKey,
  branch,
  onClose,
  onStartServices,
}: {
  /* A key and a label, not a WorktreeNode: during creation the worktree is not
     in the tree yet — the backend rescans only once setup has finished — and
     this dialog has to be able to watch that run. */
  wtKey: string;
  branch: string;
  onClose: () => void;
  onStartServices: () => void;
}) {
  const op = useStore((s) => s.ops[wtKey]);
  const results = op?.results ?? EMPTY_RESULTS;
  const showToast = useStore((s) => s.showToast);
  const startedAt = useRef(Date.now());
  const [failed, setFailed] = useState(false);
  /** true when we joined a run already in progress rather than starting one */
  const [attached, setAttached] = useState(false);

  useEffect(() => {
    if (!hasBackend()) {
      showToast("Setup runs in the desktop app");
      return;
    }
    // Reopening after "Run in background" must ATTACH to the run in flight.
    // The backend has no per-worktree guard, so invoking again would provision
    // concurrently — two `pnpm install`s in one directory.
    if (useStore.getState().ops[wtKey]?.running) {
      setAttached(true);
      return;
    }
    ipc.runWorktreeSetup(wtKey).catch((e) => {
      setFailed(true);
      showToast(`Setup failed — ${errText(e)}`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wtKey]);

  /* Rebuild the step list from the op buffer. Every marker seen is a step;
     the highest marker is the one in flight, everything before it is done. */
  const { steps, current, total, output, provisioning } = useMemo(() => {
    const seen: { n: number; cmd: string }[] = [];
    // every non-marker line belongs to the step whose marker last appeared, so
    // a step can show its own output rather than the whole run's
    const output: Record<number, string[]> = {};
    let total = 0;
    // -1 until something claims the output: on create, the git and submodule
    // lines arrive before provisioning does, and they are not its output.
    let at = -1;
    let provisioning = false;
    for (const l of op?.lines ?? []) {
      if (PROVISION.test(l.text)) {
        provisioning = true;
        at = 0;
        continue; // the row's label and count already say this
      }
      const m = STEP.exec(l.text);
      if (m) {
        total = Number(m[2]);
        const n = Number(m[1]);
        at = n;
        if (!seen.some((s) => s.n === n)) seen.push({ n, cmd: m[3] });
        continue;
      }
      (output[at] ??= []).push(l.text);
    }
    seen.sort((a, b) => a.n - b.n);
    return { steps: seen, current: seen.length ? seen[seen.length - 1].n : 0, total, output, provisioning };
  }, [op]);

  /* A step is expanded on request, and nothing expands itself. The failed one
     used to open automatically, which printed its output directly above the
     red block printing the same output again — the identical npm log twice,
     with two copy buttons. The red block is the failure view; a step's
     disclosure is there for the steps that did NOT fail. */
  const [openStep, setOpenStep] = useState<number | null>(null);

  // Optimistic for DISPLAY: before the first worktree:op event there is
  // nothing to show but "running".
  const running = op?.running ?? true;
  // Authoritative for DISMISSAL. Defaulting `busy` to true refused Escape and
  // scrim-dismiss before any event arrived — and if the run never started
  // (no backend, or the backend never emitted), the dialog could not be
  // closed by keyboard at all.
  const inFlight = op?.running === true;
  const errored = failed || (op?.lines ?? []).some((l) => l.lv === "err");
  /* Success is read from the operation buffer, not from `failed`.

     `failed` is set only when OUR invoke rejects, and the create handoff mounts
     this dialog on a run it did not start — so a failed install left `failed`
     false, `running` false and steps on screen, which read as success: the
     dialog said "Setup failed" and "Provisioned and ready." at once, and
     offered Start services (and its ⏎) for a worktree that has none.

     Nor does finishing require a numbered step. A repo whose setup tasks are
     all disabled runs to completion without ever emitting a [k/n] marker, and
     requiring one left the dialog saying "starting…" for a run that had
     already ended. */
  const done = !!op && !running && !errored;
  const elapsed = ((Date.now() - startedAt.current) / 1000).toFixed(1);
  /* Rendered from the moment the line appears, not from its count: a run that
     dies while writing .env used to show no provisioning step at all, leaving
     the file list with nothing to belong to. */
  const provState = !provisioning ? null : results[0] ? "done" : errored ? "failed" : "active";

  const copyLog = (lines: string[], what: string) => {
    const text = lines.join("\n");
    if (!text.trim()) { showToast("Nothing captured for that step"); return; }
    /* Count the lines that land on the clipboard, not the events that carried
       them: a failure arrives as ONE event holding the command, the headline
       and sixty-four lines of stderr, so counting events reported "4 lines"
       for a log that pastes as ninety. */
    const n = text.split("\n").length;
    navigator.clipboard
      ?.writeText(text)
      .then(() => showToast(`Copied the ${what} — ${n} line${n === 1 ? "" : "s"}`))
      .catch(() => showToast("Copy failed"));
  };

  // the ⏎ the Start-services button advertises. This dialog has no text
  // fields, so a bare ⏎ has nothing to take it from.
  usePrimaryAction("enter", done, () => {
    onStartServices();
    onClose();
  });

  return (
    <Modal
      icon={Cube}
      title={errored ? "Setup failed" : done ? "Setup complete" : "Running setup"}
      sub={branch}
      busy={inFlight && !errored}
      onClose={onClose}
      foot={
        <>
          <Hint icon={done ? Check : errored ? undefined : Spinner}>
            {errored
              ? "The failing step is shown above"
              : done
                ? (attached ? "Finished" : `Took ${elapsed}s`)
                : total
                  ? `Step ${Math.min(current, total)} of ${total}`
                  : "starting…"}
          </Hint>
          <Spacer />
          {running && !errored && (
            <button className="cx-btn cx-btn--ghost" onClick={onClose}>
              Run in background
            </button>
          )}
          {done ? (
            <button
              className="cx-btn cx-btn--primary"
              onClick={() => {
                onStartServices();
                onClose();
              }}
            >
              <Play size={12} />
              Start services
              <span className="cx-k">⏎</span>
            </button>
          ) : (
            <button className="cx-btn" onClick={onClose}>
              {errored ? "Close" : "Cancel"}
            </button>
          )}
        </>
      }
    >
      {steps.length === 0 && !errored && !provState && (
        <div className="cxm-prog" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
          <span className="cxm-prog__ic">
            <Spinner size={13} />
          </span>
          <div className="cxm-prog__lines">preparing…</div>
        </div>
      )}

      {provState &&
        (() => {
          const lines = output[0] ?? [];
          const open = openStep === 0;
          return (
            <Step
              state={provState}
              text="provision files"
              meta={results[0]}
              lines={lines}
              open={open}
              onToggle={() => setOpenStep(open ? null : 0)}
              onCopy={() => copyLog(lines, "provisioning output")}
            />
          );
        })()}

      {steps.map((s) => {
        const state = s.n < current ? "done" : s.n === current && running ? "active" : errored && s.n === current ? "failed" : "done";
        const lines = output[s.n] ?? [];
        const open = openStep === s.n;
        return (
          <Step
            key={s.n}
            state={state}
            text={s.cmd}
            meta={results[s.n]}
            lines={lines}
            open={open}
            onToggle={() => setOpenStep(open ? null : s.n)}
            onCopy={() => copyLog(lines, `step ${s.n}`)}
          />
        );
      })}

      {/* The failure view: the one place the log is printed, and the one place
          it is copied from. The tail ENDS with the failure — the backend sends
          the headline and the stderr tail as a single event — so the useful
          part is what you land on; the block scrolls rather than stretching
          the dialog past it. Copy takes the whole buffer, not the tail: the
          lines that explain a failure are routinely above the ones that
          announce it. */}
      {errored && (
        <div className="cx-alert cx-alert--error" style={{ marginTop: "var(--sp-modal-head)" }}>
          <div>
            <b>Setup did not finish.</b>
            <pre>{(op?.lines ?? []).slice(-4).map((l) => l.text).join("\n")}</pre>
            <button
              className="cx-btn cx-btn--sm"
              onClick={() => copyLog((op?.lines ?? []).map((l) => l.text), "setup log")}
            >
              Copy log
            </button>
          </div>
        </div>
      )}

      {done && (
        <div className="cx-alert cx-alert--ok" style={{ marginTop: "var(--sp-modal-head)", marginBottom: 0 }}>
          <span className="cx-alert__ic">
            <Check size={13} />
          </span>
          <div>Provisioned and ready.</div>
        </div>
      )}
    </Modal>
  );
}

/* One row of the step list.

   Provisioning and the numbered tasks both render through this. They used to
   be written out separately, and drifted: when steps grew a disclosure the
   bullet, label and count moved into `.cx-step__head` — the element that is
   `display:flex` — and the provisioning row, still writing them straight into
   the `display:block` wrapper, lost its alignment. */
function Step({
  state,
  text,
  meta,
  lines,
  open,
  onToggle,
  onCopy,
}: {
  state: "done" | "active" | "failed";
  text: string;
  meta?: string;
  lines: string[];
  open: boolean;
  onToggle: () => void;
  onCopy: () => void;
}) {
  const expandable = lines.length > 0;
  return (
    <div className={`cx-step cx-step--${state}${open ? " cx-step--open" : ""}`}>
      <div
        className="cx-step__head"
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        title={expandable ? (open ? "Hide this step's output" : "Show this step's output") : undefined}
        onClick={expandable ? onToggle : undefined}
        onKeyDown={
          expandable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle();
                }
              }
            : undefined
        }
      >
        <span className="cx-step__bullet">{state === "done" ? "✓" : state === "failed" ? "✕" : <Spinner size={10} />}</span>
        <span className="cx-step__text">{text}</span>
        {/* Only steps whose output matched a known pattern have metadata; the
            rest render with the bullet alone. */}
        {meta && <span className="cx-step__meta">{meta}</span>}
        {expandable && <span className="cx-step__chev">{open ? "▾" : "▸"}</span>}
      </div>
      {open && expandable && (
        <div className="cx-step__body">
          <pre>{lines.join("\n")}</pre>
          <button
            className="cx-btn cx-btn--sm cx-btn--ghost"
            onClick={(e) => {
              e.stopPropagation();
              onCopy();
            }}
          >
            Copy this step's output
          </button>
        </div>
      )}
    </div>
  );
}
