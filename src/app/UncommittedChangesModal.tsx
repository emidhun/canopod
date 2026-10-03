/* Uncommitted changes — the header dirty indicator opens this.

   One modal, three answers to one question ("what happens to this work?"),
   selected by a mode segment — so the footer still ends the same way as every
   other dialog: a ghost dismiss plus ONE button that names the action. The file
   list is INFORMATION, not selection: it annotates itself per mode to preview
   exactly what the chosen git invocation will touch. */
import { useEffect, useMemo, useState } from "react";
import { errText, hasBackend, ipc, type StatusEntry } from "../ipc";
import { useStore } from "../store";
import type { WorktreeNode } from "../types";
import { Alert, Check, Folder, Git, Info, Search, Spinner, Trash } from "../icons";
import Modal, { Hint, Spacer } from "./canopy/Modal";

type Mode = "commit" | "stash" | "discard";

const demoChanges = (): StatusEntry[] => [
  { code: " M", path: "src/components/CheckoutDrawer.tsx", sub: false },
  { code: "MM", path: "src/styles/checkout.css", sub: false },
  { code: " D", path: "src/components/LegacyCheckout.tsx", sub: false },
  { code: "R ", path: "src/hooks/useCheckout.ts", from: "src/hooks/useCart.ts", sub: false },
  ...["src/components/PaymentSummary.tsx", "src/components/checkout/ShippingAddress.tsx", "tests/checkout.spec.ts", "docs/checkout-flow.md"].map(path => ({ code: "??", path, sub: false })),
];

const isConf = (f: StatusEntry) => f.code.includes("U") || f.code === "AA" || f.code === "DD";
const isUntr = (f: StatusEntry) => f.code === "??";
/** the path is gone from disk — a deletion that isn't the source half of a
    rename/copy. Nothing to open in the editor. */
const isGone = (f: StatusEntry) => f.code.includes("D") && !f.code.startsWith("R") && !f.code.startsWith("C");
const nbsp = (s: string) => s.replace(/ /g, " ");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Roll a status list up into the counts the modal reasons about. */
function summarise(files: StatusEntry[]) {
  let m = 0,
    a = 0,
    d = 0,
    r = 0,
    u = 0,
    x = 0;
  for (const f of files) {
    if (isConf(f)) x++;
    else if (isUntr(f)) u++;
    else if (f.code.includes("R")) r++;
    else if (f.code.includes("D")) d++;
    else if (f.code.includes("A")) a++;
    else m++;
  }
  const bits: string[] = [];
  if (m) bits.push(`${m} modified`);
  if (a) bits.push(`${a} added`);
  if (d) bits.push(`${d} deleted`);
  if (r) bits.push(`${r} renamed`);
  if (u) bits.push(`${u} untracked`);
  if (x) bits.push(`${x} conflicted`);
  return { m, a, d, r, u, x, line: bits.join(" · ") };
}

/* One row of `git status --porcelain`, annotated for the CURRENT mode. Clicking
   a row opens that path in the configured editor — except a deletion, which no
   longer exists on disk, so its row is inert. */
function FileRow({
  f,
  mode,
  addUntracked,
  cleanUntracked,
  onOpen,
}: {
  f: StatusEntry;
  mode: Mode;
  addUntracked: boolean;
  cleanUntracked: boolean;
  onOpen: (f: StatusEntry) => void;
}) {
  const openable = !isGone(f);
  const conf = isConf(f);
  const untr = isUntr(f);
  let tag: string | null = null;
  let tagCls = "cxm-tg";
  let gone = false;
  if (conf) {
    tag = "conflict";
    tagCls = "cxm-tg cxm-tg--bad";
  } else if (f.sub) {
    tag = mode === "commit" ? `commit inside ${f.path}` : "submodule";
    tagCls = "cxm-tg cxm-tg--warn";
  } else if (untr) {
    if (mode === "commit") {
      tag = addUntracked ? "will be added" : "not committed";
      tagCls = addUntracked ? "cxm-tg" : "cxm-tg cxm-tg--dim";
    } else if (mode === "stash") {
      tag = addUntracked ? "stashed" : "left in place";
      tagCls = addUntracked ? "cxm-tg" : "cxm-tg cxm-tg--dim";
    } else {
      tag = cleanUntracked ? "deleted" : "kept";
      tagCls = cleanUntracked ? "cxm-tg cxm-tg--bad" : "cxm-tg cxm-tg--dim";
      gone = cleanUntracked;
    }
  } else if (f.code === "MM") {
    tag = "staged + edited";
  }
  const base = f.path.replace(/\/$/, "").split("/").pop() || f.path;
  const fromBase = f.from?.replace(/\/$/, "").split("/").pop();
  const fullPath = f.from ? `${f.from} → ${f.path}` : f.path;
  const note = f.sub ? (f.subFiles != null ? `modified content · ${plural(f.subFiles, "file")} inside` : "modified content") : null;
  const cls = "cxm-frow" + (openable ? " cxm-frow--open" : "") + (conf ? " cxm-frow--conf" : "") + (gone ? " cxm-frow--gone" : "");
  const inner = (
    <>
      <span className="cxm-cd">{nbsp(f.code)}</span>
      <span className="cxm-pth">
        {f.from && (
          <>
            <i>{fromBase}</i> <span className="cxm-arw">→</span>{" "}
          </>
        )}
        {base}
        {note && <span className="cxm-nt"> — {note}</span>}
      </span>
      {tag && !untr && <span className={tagCls}>{tag}</span>}
    </>
  );
  if (!openable) return <div className={cls} title={fullPath}>{inner}</div>;
  return (
    <button type="button" className={cls} title={fullPath} aria-label={`Open ${f.path} in editor`} onClick={() => onOpen(f)}>
      {inner}
    </button>
  );
}

function FileList({
  files,
  mode,
  addUntracked,
  cleanUntracked,
  onOpen,
}: {
  files: StatusEntry[];
  mode: Mode;
  addUntracked: boolean;
  cleanUntracked: boolean;
  onOpen: (f: StatusEntry) => void;
}) {
  const [q, setQ] = useState("");
  const filterable = true;
  const t = q.trim().toLowerCase();
  const shown = t ? files.filter((f) => f.path.toLowerCase().includes(t)) : files;
  const groups = [
    { k: "conflicts", label: "Conflicts", items: shown.filter(isConf) },
    { k: "tracked", label: "Tracked changes", items: shown.filter((f) => !isConf(f) && !isUntr(f) && !f.sub) },
    { k: "untracked", label: "Untracked", items: shown.filter((f) => !isConf(f) && isUntr(f)) },
    { k: "subs", label: "Submodules", items: shown.filter((f) => !isConf(f) && f.sub) },
  ].filter((g) => g.items.length);
  const { line } = summarise(files);
  return (
    <div className="cxm-fld">
      <div className="cxm-flab">
        Changed files<span className="cxm-opt">{line}</span>
      </div>
      {filterable && (
        <div className="cxm-pick-f" style={{ marginBottom: "var(--sp-2)" }}>
          <Search size={12} />
          <input aria-label="Filter changed files" value={q} spellCheck={false} placeholder={`Filter ${files.length} paths…`} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div className="cxm-flist">
        {groups.map((g) => (
          <div key={g.k}>
            <div className="cxm-gsec">
              {g.label}
              {g.k === "untracked" && <span className="changes-group-note">{mode === "discard" ? (cleanUntracked ? "Will be deleted" : "Kept") : (addUntracked ? "Included" : "Excluded")}</span>}
              <span className="cxm-gsec__n">{g.items.length}</span>
            </div>
            {g.items.map((f, i) => (
              <FileRow key={g.k + i} f={f} mode={mode} addUntracked={addUntracked} cleanUntracked={cleanUntracked} onOpen={onOpen} />
            ))}
          </div>
        ))}
        {!groups.length && <div className="cxm-pick-e">No paths match “{q}”.</div>}
      </div>
      <div className="cxm-fhint">
        {t ? (
          <>
            Showing {shown.length} of {files.length} paths matching <span className="mono">{q}</span> — the action still applies to all{" "}
            {files.length}.
          </>
        ) : (
          <>
            Click a file to open it in your editor.
          </>
        )}
      </div>
    </div>
  );
}

export default function UncommittedChangesModal({ wt, onClose }: { wt: WorktreeNode; onClose: () => void }) {
  const showToast = useStore((s) => s.showToast);
  const demo = import.meta.env.DEV && !hasBackend() && new URLSearchParams(window.location.search).get("changes-demo") === "1";
  const [files, setFiles] = useState<StatusEntry[] | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>(() => {
    const requested = demo ? new URLSearchParams(window.location.search).get("changes-mode") : null;
    return requested === "stash" || requested === "discard" ? requested : "commit";
  });
  const [msg, setMsg] = useState("");
  const [stashName, setStashName] = useState("");
  const [withUntracked, setWithUntracked] = useState(false);
  const [cleanUntracked, setCleanUntracked] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the full status. Fail CLOSED, exactly like RemoveWorktreeModal: a
  // failed probe is an error the actions stay disabled on, never "clean".
  useEffect(() => {
    if (!hasBackend()) {
      setFiles(demo ? demoChanges() : []);
      return;
    }
    ipc
      .worktreeStatus(wt.wtKey)
      .then((f) => {
        setFiles(f);
        setProbeError(null);
      })
      .catch((e) => {
        setFiles(null);
        setProbeError(errText(e));
      });
  }, [wt.wtKey, demo]);

  const ahead = wt.git?.ahead ?? 0;
  const list = files ?? [];
  const { u: untracked, x: conflicts } = useMemo(() => summarise(list), [list]);
  const subOnly = list.length > 0 && list.every((f) => f.sub);
  const subName = list.find((f) => f.sub)?.path ?? "the submodule";
  const tracked = list.length - untracked;
  const scope =
    mode === "discard" ? tracked + (cleanUntracked ? untracked : 0) : tracked + (withUntracked ? untracked : 0);

  const subject = msg.split("\n")[0];
  // subOnly blocks every mode: a commit/stash/discard in the parent cannot
  // reach into a submodule's working tree. Conflicts block only commit/stash —
  // discarding is the documented way out of an unwanted merge.
  const blocked = subOnly
    ? `Nothing here to ${mode} — the change is inside ${subName}`
    : conflicts > 0 && mode !== "discard"
      ? `Resolve ${plural(conflicts, "conflict")} before you can ${mode}`
      : null;
  const armed = mode === "discard" && cleanUntracked ? confirm.trim() === "discard" : true;
  const ready = !probeError && !blocked && armed && scope > 0 && (mode !== "commit" || !!subject.trim());

  const cmd =
    mode === "commit"
      ? (withUntracked ? "git add -A  ·  " : "") + `git commit -a -m "${subject.trim() || "…"}"`
      : mode === "stash"
        ? "git stash push" + (withUntracked ? " -u" : "") + (stashName.trim() ? ` -m "${stashName.trim()}"` : "")
        : "git restore --source=HEAD --staged --worktree -- ." + (cleanUntracked ? "  ·  git clean -fd" : "");

  function openFile(f: StatusEntry) {
    if (!hasBackend()) {
      showToast("Opening a file needs the desktop app");
      return;
    }
    ipc.openFileInEditor(wt.wtKey, f.path).catch((e) => showToast(`Could not open ${f.path} — ${errText(e)}`));
  }

  async function run() {
    if (!ready || !hasBackend()) {
      if (!hasBackend()) showToast("This needs the desktop app");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "commit") {
        await ipc.worktreeCommit(wt.wtKey, msg, withUntracked);
        showToast(`Committed ${plural(scope, "file")} to ${wt.branch}`);
      } else if (mode === "stash") {
        await ipc.worktreeStash(wt.wtKey, stashName.trim() || null, withUntracked);
        showToast(`Stashed ${plural(scope, "file")}${stashName.trim() ? ` as ${stashName.trim()}` : ""}`);
      } else {
        await ipc.worktreeDiscard(wt.wtKey, cleanUntracked);
        showToast(`Discarded changes in ${plural(scope, "file")}`);
      }
      onClose();
    } catch (e) {
      // a failing pre-commit hook lands here; the message the user typed is
      // still in state, so retry keeps it
      setError(errText(e));
      setBusy(false);
    }
  }

  // ⌘⏎ / Ctrl+⏎ submits when ready — the label promises it. Plain Enter in the
  // message textarea still inserts a newline.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && ready && !busy) {
        // capture + stop so an app-level ⌘⏎ shortcut behind the scrim can't also fire
        e.preventDefault();
        e.stopPropagation();
        run();
      }
    };
    document.addEventListener("keydown", k, true);
    return () => document.removeEventListener("keydown", k, true);
  });

  // ── fail-closed: could not read status ──
  if (probeError) {
    return (
      <Modal
        icon={Git}
        title="Uncommitted changes"
        sub={wt.branch}
        onClose={onClose}
        foot={
          <>
            <Hint icon={Info}>Actions are disabled until the status can be read</Hint>
            <Spacer />
            <button className="cx-btn cx-btn--ghost" onClick={onClose}>
              Close
            </button>
          </>
        }
      >
        <div className="cx-alert cx-alert--error">
          <span className="cx-alert__ic">
            <Alert size={13} />
          </span>
          <div>
            <b>Could not read the working-tree status.</b>
            <pre>{probeError}</pre>
          </div>
        </div>
      </Modal>
    );
  }

  // ── loading ──
  if (files === null) {
    return (
      <Modal icon={Git} title="Uncommitted changes" sub={wt.branch} busy onClose={onClose}>
        <div className="cxm-prog" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
          <span className="cxm-prog__ic">
            <Spinner size={13} />
          </span>
          <div className="cxm-prog__lines">reading status…</div>
        </div>
      </Modal>
    );
  }

  // ── clean (unreachable from the chip, kept so the empty case is designed) ──
  if (!files.length) {
    return (
      <Modal
        icon={Check}
        title="No uncommitted changes"
        sub={`${wt.branch} · working tree clean`}
        narrow
        onClose={onClose}
        foot={
          <>
            <Hint icon={Info}>The status-bar chip is not clickable when the tree is clean</Hint>
            <Spacer />
            <button className="cx-btn cx-btn--ghost" onClick={onClose}>
              Close
            </button>
          </>
        }
      >
        <p style={{ fontSize: "var(--fs-body)", color: "var(--text-secondary)", lineHeight: "var(--lh-body)", margin: 0 }}>
          Everything in <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-small)" }}>{wt.branch}</span> is committed.
          {ahead > 0 && (
            <>
              {" "}
              <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-small)" }}>↑{ahead}</span> commit{ahead === 1 ? "" : "s"}{" "}
              still ahead of origin — push from the status bar.
            </>
          )}
        </p>
      </Modal>
    );
  }

  const primaryLabel =
    mode === "commit" ? `Commit ${plural(scope, "file")}` : mode === "stash" ? `Stash ${plural(scope, "file")}` : `Discard ${plural(scope, "file")}`;

  const footPrimary =
    mode === "discard" ? (
      <button className="cx-btn cx-btn--danger" disabled={busy || !ready} onClick={run}>
        {busy ? (
          <>
            <Spinner size={12} />
            Discarding…
          </>
        ) : (
          <>
            <Trash size={12} />
            {primaryLabel}
          </>
        )}
      </button>
    ) : (
      <button className="cx-btn cx-btn--primary" disabled={busy || !ready} onClick={run}>
        {busy ? (
          <>
            <Spinner size={12} />
            {mode === "commit" ? "Committing…" : "Stashing…"}
          </>
        ) : (
          <>
            {mode === "commit" ? <Git size={12} /> : <Folder size={12} />}
            {primaryLabel}
            <span className="cx-k">⌘⏎</span>
          </>
        )}
      </button>
    );

  return (
    <Modal
      icon={Git}
      danger={mode === "discard"}
      wide
      busy={busy}
      onClose={onClose}
      title="Uncommitted changes"
      sub={wt.branch}
      foot={
        <>
          <span className="cx-modal__hint">
            {blocked ? (
              <>
                <Alert size={11} />
                <span style={{ color: "var(--state-attention)" }}>{blocked}</span>
              </>
            ) : mode === "discard" ? (
              <>
                <Alert size={11} />
                <span style={{ color: "var(--red-text)" }}>Nothing is written to the reflog — this cannot be undone</span>
              </>
            ) : mode === "stash" ? (
              <>
                <Info size={11} />
                <span>Files go back to their last commit; the stash keeps them</span>
              </>
            ) : (
              <>
                <Info size={11} />
                <span>Commits to {wt.branch} locally — does not push</span>
              </>
            )}
          </span>
          <Spacer />
          <button className="cx-btn cx-btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {footPrimary}
        </>
      }
    >
      {demo && <div className="changes-demo">Demo data · actions do not change files</div>}
      <div className="cx-seg changes-tabs" role="group" aria-label="Change action">
        <button className={mode === "commit" ? "is-on" : ""} aria-pressed={mode === "commit"} onClick={() => setMode("commit")} disabled={busy}>
          Commit
        </button>
        <button className={mode === "stash" ? "is-on" : ""} aria-pressed={mode === "stash"} onClick={() => setMode("stash")} disabled={busy}>
          Stash
        </button>
        <button className={mode === "discard" ? "is-on" : ""} aria-pressed={mode === "discard"} onClick={() => setMode("discard")} disabled={busy}>
          Discard
        </button>
      </div>

      <div className="changes-summary">{files.length} changed <span>·</span> {scope} included</div>
      <div className="changes-layout">
        <div className="changes-files"><FileList files={files} mode={mode} addUntracked={withUntracked} cleanUntracked={cleanUntracked} onOpen={openFile} /></div>
        <div className="changes-action">
      {conflicts > 0 && (
        <div className="cx-alert cx-alert--error">
          <span className="cx-alert__ic">
            <Alert size={13} />
          </span>
          <div>
            <b>
              {plural(conflicts, "file")} still {conflicts === 1 ? "has" : "have"} merge conflicts.
            </b>{" "}
            Git will refuse a commit or a stash until the markers are gone. Discarding is the way out if you don't want the merge.
          </div>
        </div>
      )}

      {subOnly && (
        <div className="cx-alert cx-alert--warn">
          <span className="cx-alert__ic">
            <Alert size={13} />
          </span>
          <div>
            <b>
              The change is inside <span className="mono">{subName}</span>, not here.
            </b>{" "}
            A commit, stash or discard in {wt.branch} does not reach into a submodule's working tree — commit it in{" "}
            <span className="mono">{subName}</span> first (from the status-bar pull menu).
          </div>
        </div>
      )}

      {error && (
        <div className="cx-alert cx-alert--error">
          <span className="cx-alert__ic">
            <Alert size={13} />
          </span>
          <div>
            <b>git {mode} failed.</b>
            <pre>{error}</pre>
            Nothing changed. Fix it, or retry — anything you typed above is kept.
          </div>
        </div>
      )}

      {mode === "commit" && (
        <div className="cxm-fld">
          <label htmlFor="changes-message" className="cxm-flab cxm-flab--f">
            Commit message
            <span className="cxm-opt" style={{ color: subject.length > 72 ? "var(--state-attention)" : undefined }}>
              {subject.length} / 72 in the subject
            </span>
          </label>
          <textarea
            id="changes-message"
            className="cx-input cx-input--mono"
            style={{ minHeight: 104, lineHeight: "var(--lh-body)" }}
            value={msg}
            spellCheck={false}
            disabled={busy}
            placeholder={"Summarise the change\n\nFirst line is the subject; leave a blank line before any detail."}
            onChange={(e) => setMsg(e.target.value)}
          />
          {untracked > 0 && (
            <label className="cxm-chk" style={{ marginTop: "var(--sp-3)" }}>
              <input type="checkbox" checked={withUntracked} disabled={busy} onChange={(e) => setWithUntracked(e.target.checked)} />
              <span className="cxm-chk__tx">
                <b>Also add {plural(untracked, "untracked file")}</b>
                <span>
                  Off by default: <span className="mono">git commit -a</span> only picks up files git already tracks.
                </span>
              </span>
            </label>
          )}
        </div>
      )}

      {mode === "stash" && (
        <div className="cxm-fld">
          <label htmlFor="changes-stash" className="cxm-flab cxm-flab--f">
            Stash name<span className="cxm-opt">optional</span>
          </label>
          <input
            className="cx-input cx-input--mono"
            id="changes-stash"
            value={stashName}
            spellCheck={false}
            disabled={busy}
            placeholder={`WIP on ${wt.branch}`}
            onChange={(e) => setStashName(e.target.value)}
          />
          <div className="cxm-fhint">
            Restore it later with <span className="mono">git stash pop</span>. Canopy has no stash list yet, so name it if you plan to
            keep more than one.
          </div>
          {untracked > 0 && (
            <label className="cxm-chk" style={{ marginTop: "var(--sp-3)" }}>
              <input type="checkbox" checked={withUntracked} disabled={busy} onChange={(e) => setWithUntracked(e.target.checked)} />
              <span className="cxm-chk__tx">
                <b>Include {plural(untracked, "untracked file")}</b>
                <span>
                  Adds <span className="mono">-u</span>. Untracked files are moved into the stash instead of being left in the worktree.
                </span>
              </span>
            </label>
          )}
        </div>
      )}

      {mode === "discard" && (
        <div className="cxm-fld">
          <div className="cx-alert cx-alert--error" style={{ marginBottom: "var(--sp-3)" }}>
            <span className="cx-alert__ic">
              <Alert size={13} />
            </span>
            <div>
              <b>
                {plural(tracked, "tracked file")} go back to {tracked === 1 ? "its" : "their"} last committed version.
              </b>{" "}
              Those edits are not in any commit, so there is nothing to recover them from — no reflog entry, no stash.
            </div>
          </div>
          {untracked > 0 && (
            <label className="cxm-chk">
              <input
                type="checkbox"
                checked={cleanUntracked}
                disabled={busy}
                onChange={(e) => {
                  setCleanUntracked(e.target.checked);
                  setConfirm("");
                }}
              />
              <span className="cxm-chk__tx">
                <b style={{ color: cleanUntracked ? "var(--red-text)" : undefined }}>
                  Also delete {plural(untracked, "untracked file")} from disk
                </b>
                <span>
                  Adds <span className="mono">git clean -fd</span>. Git has never had a copy of these files — they are gone from the
                  machine, not just from git. Leave it off and they stay exactly where they are.
                </span>
              </span>
            </label>
          )}
          {cleanUntracked && (
            <div className="cxm-fld" style={{ marginTop: "var(--sp-3)" }}>
              <div className="cxm-flab cxm-flab--f">
                Type{" "}
                <span style={{ fontFamily: "var(--mono)", textTransform: "none", letterSpacing: 0, color: "var(--red-text)" }}>
                  discard
                </span>{" "}
                to confirm
              </div>
              <input
                className="cx-input cx-input--mono"
                aria-label="Type discard to confirm"
                value={confirm}
                spellCheck={false}
                placeholder="discard"
                disabled={busy}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          )}
        </div>
      )}

      <details className="changes-command"><summary>Command preview</summary><code>{cmd}</code></details>
      </div></div>

      {busy && (
        <div className="cxm-prog">
          <span className="cxm-prog__ic">
            <Spinner size={13} />
          </span>
          <div className="cxm-prog__lines">
            <div>{cmd}</div>
            <div>
              {mode === "commit"
                ? "running pre-commit hooks…"
                : mode === "stash"
                  ? "writing stash entry…"
                  : `restoring ${plural(scope, "path")}…`}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
