/* New worktree — the creation dialog.

   Two modes: a new branch off a base, or checking out one that exists. The
   "You'll get" panel is the reassurance — it answers "where will this land?"
   while the name is still editable. The agent handoff is optional and
   collapsed, because most worktrees don't need one, but when it's filled in
   it seeds .canopod/context.md and later becomes the PR body. */
import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { errText, hasBackend, ipc, type Branches, type OpEvent, type WorktreePreview } from "../ipc";
import { backgroundOp, useStore } from "../store";
import { Alert, ChevRight, Fork, Info, Plus, Refresh, Spinner } from "../icons";
import Modal, { Hint, Spacer, usePrimaryAction } from "./canopod/Modal";
import RefPick from "./canopod/RefPick";
import { seedWtContext } from "./WorktreeContext";

/** Slug preview for the NO-BACKEND dev build only. With a backend, every value
    in the "You'll get" panel comes from `preview_worktree`, which shares its
    derivation with `create_worktree` — so this approximation can never be what
    a real user reads. Mirrors `sanitize_branch`: alphanumerics, `-` and `.`
    survive, everything else becomes `_`, case preserved. */
const sanitizeBranch = (b: string) => b.replace(/[^\p{L}\p{N}.-]/gu, "_");

/* The first line that belongs to the setup phase rather than to creating the
   worktree. Creating is this dialog's job — fetching, `git worktree add`,
   submodules, provisioning — and it ends here. The setup commands are a
   different thing with a different shape: a numbered step list with per-step
   output, which the setup runner already renders properly and this dialog can
   only show as an anonymous four-line tail.

   It matches a numbered step and nothing else, because a numbered step is the
   only line that promises a step list to hand over to. "setup — skipped
   (disabled): …" is not one: a repo whose tasks are ALL disabled emits those
   and then finishes, and handing that over opened a runner with no step to
   show. Nor is "setup skipped — Run setup when you're ready", which means no
   commands will run at all. */
const SETUP_PHASE = /^setup \[/;
export const isSetupStart = (detail: string) => SETUP_PHASE.test(detail);

/** What a `create` event means to the dialog that is creating a worktree. */
export type CreateOpAction = "ignore" | "append" | "handoff";

/* Whose create is this?

   A create left running in the background emits on the same channel, so "this
   dialog is busy" is not enough to claim an event: start A in the background,
   then create B, and A's first setup marker would close B's dialog and open a
   runner labelled with B's branch whose Start services targets A.

   `destination` is derived by the same backend function `create_worktree`
   uses, so where we have it the match is exact. Where we don't — the repo's
   settings could not be read — two concurrent creates are indistinguishable,
   so the stream stays in this dialog rather than being handed to a runner that
   might be watching the wrong worktree. */
export function createOpAction(
  ev: { wtKey: string; detail: string },
  ctx: { destination: string | null; busy: boolean },
): CreateOpAction {
  if (ctx.destination && ev.wtKey !== ctx.destination) return "ignore";
  if (!isSetupStart(ev.detail)) return "append";
  return ctx.busy && ctx.destination ? "handoff" : "append";
}

export default function NewWorktreeModal({
  repoId,
  onClose,
  onSetupStarted,
}: {
  repoId: string;
  onClose: () => void;
  /** hand this creation's provisioning stream over to the setup runner */
  onSetupStarted: (wtKey: string, branch: string) => void;
}) {
  const tree = useStore((s) => s.tree);
  const select = useStore((s) => s.select);
  const showToast = useStore((s) => s.showToast);
  const createWorktree = useStore((s) => s.createWorktree);

  const repos = tree.map((r) => ({ id: r.repoId, name: r.name }));
  const [repo, setRepo] = useState(repoId || repos[0]?.id || "");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [existing, setExisting] = useState("");
  const [existingKind, setExistingKind] = useState<"local" | "remote" | "tags" | "new">("local");
  const [branches, setBranches] = useState<Branches | null>(null);
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pr, setPr] = useState("");
  const [prDescription, setPrDescription] = useState("");
  const [issue, setIssue] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  /** the repo's configured worktree dir; blank means `${repo.path}/.worktrees` */
  const [worktreeDir, setWorktreeDir] = useState<string | null>(null);
  /** what creating this branch would actually produce (backend-derived) */
  const [preview, setPreview] = useState<WorktreePreview | null>(null);

  const activeRepo = tree.find((r) => r.repoId === repo);
  // git refuses to check the same branch out twice; show them, disabled
  const inUse = useMemo(() => new Set((activeRepo?.worktrees ?? []).map((w) => w.branch)), [activeRepo]);

  useEffect(() => {
    if (!hasBackend() || !repo) {
      setBranches({ local: [], remote: [], tags: [] });
      return;
    }
    // refs are repo-scoped: carrying a base/branch across a repo switch lets
    // Create submit something that doesn't exist in the selected repository
    setBranches(null);
    setBase("");
    setExisting("");
    setExistingKind("local");
    // The repo's configured default base wins when it still exists; falling
    // back to `main` keeps the previous behaviour for repos that have none.
    Promise.all([ipc.listBranches(repo), ipc.getSettings().catch(() => null)])
      .then(([b, st]) => {
        setBranches(b);
        const configured = st?.repos.find((r) => r.id === repo)?.defaultBase?.trim();
        setBase(
          configured && b.local.includes(configured)
            ? configured
            : b.local.includes("main")
              ? "main"
              : (b.local[0] ?? ""),
        );
      })
      .catch(() => setBranches({ local: [], remote: [], tags: [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  // read the repo's worktreeDir so the destination shown is the real one
  useEffect(() => {
    if (!hasBackend() || !repo) return;
    let alive = true;
    ipc
      .getSettings()
      .then((st) => alive && setWorktreeDir(st.repos.find((r) => r.id === repo)?.worktreeDir ?? ""))
      .catch(() => alive && setWorktreeDir(null));
    return () => {
      alive = false;
    };
  }, [repo]);

  /* The listener is installed once, so it must not close over `branch`,
     `busy` or `destination` — a ref is re-pointed on every render instead. */
  const onOp = useRef<(ev: { wtKey: string; detail: string }) => void>(() => {});
  const handedOff = useRef(false);
  useEffect(() => {
    onOp.current = (ev) => {
      switch (createOpAction(ev, { destination, busy })) {
        case "ignore":
          return;
        case "append":
          return setProgress((p) => [...p.slice(-30), ev.detail]);
        case "handoff":
          if (handedOff.current) return;
          handedOff.current = true;
          // The dialog stops watching, exactly as "Run in background" does — so
          // the outcome is still reported as a notice if the runner is closed too.
          backgroundOp(opKey);
          onSetupStarted(ev.wtKey, branch);
          onClose();
      }
    };
  });

  useEffect(() => {
    if (!hasBackend()) return;
    let un: (() => void) | undefined;
    listen<OpEvent>("worktree:op", (e) => {
      if (e.payload.op !== "create") return;
      onOp.current(e.payload);
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  async function fetchAll() {
    if (!hasBackend() || fetching) return;
    setFetching(true);
    setError(null);
    try {
      const b = await ipc.fetchBranches(repo);
      setBranches(b);
      showToast(`Fetched — ${b.local.length} local, ${b.remote.length} remote, ${b.tags.length} tags`);
    } catch (e) {
      setError(`Fetch failed — ${errText(e)}`);
    } finally {
      setFetching(false);
    }
  }

  const picked = mode === "new" ? name.trim() : existing;
  const ok = !!picked;

  /* What create_worktree will actually be asked for. `git worktree add <path>
     origin/foo` checks out the remote-tracking ref DETACHED, so a remote pick
     has to become a real local branch tracking it — reuse the local one if it
     already exists, otherwise create it. Derived once, because the destination
     panel and the create call must agree on the branch NAME (they didn't for
     remote picks, which land under the local name, not `origin/…`). */
  const payload = useMemo(() => {
    const localOf = (ref: string) => ref.replace(/^[^/]+\//, "");
    if (mode === "new") return { branch: picked, base: base || undefined, createBranch: true };
    if (existingKind === "tags")
      // checking out a tag → create a local branch named after it
      return { branch: existing, base: `refs/tags/${existing}`, createBranch: true };
    if (existingKind === "remote")
      return {
        branch: localOf(existing),
        base: existing,
        createBranch: !branches?.local.includes(localOf(existing)),
      };
    return { branch: existing, base: undefined, createBranch: false };
  }, [mode, picked, base, existing, existingKind, branches]);

  const branch = payload.branch;

  /* Ask the backend what this branch would produce. Debounced because it runs
     on every keystroke of the name field; the command allocates nothing, so a
     superseded request costs only its own work. It is keyed on the RESOLVED
     branch — a remote pick lands under its local name, and previewing
     `origin/foo` would promise a path creation never uses. */
  useEffect(() => {
    if (!hasBackend() || !repo || !branch) {
      setPreview(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      ipc
        .previewWorktree(repo, branch)
        .then((p) => alive && setPreview(p))
        .catch(() => alive && setPreview(null));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [repo, branch]);
  // Mirror create_worktree's resolution: empty → `<repo>/.worktrees`, a relative
  // dir is taken relative to the repo, an absolute dir is used verbatim.
  const worktreeRoot = (() => {
    if (!activeRepo) return "";
    const d = (worktreeDir ?? "").trim();
    if (!d) return `${activeRepo.path}/.worktrees`;
    return d.startsWith("/") ? d : `${activeRepo.path}/${d}`;
  })();
  const destination =
    preview?.path ?? (ok && worktreeDir !== null && activeRepo ? `${worktreeRoot}/${sanitizeBranch(branch)}` : null);
  const clashingPorts = (preview?.ports ?? []).filter((p) => p.takenBy);
  /* The key the in-progress row and the failure notice are filed under. It is
     the destination when we can predict it — that is what worktree:op events
     are keyed by, so the row can show live steps. When the repo's settings
     could not be read we still create; the row just has no step detail. */
  const opKey = destination ?? `${repo}::${branch}`;


  async function create() {
    if (!ok) return;
    setBusy(true);
    setProgress([]);
    setError(null);
    try {
      const wtPath = await createWorktree({
        repoId: repo,
        repoName: activeRepo?.name ?? "",
        wtPath: opKey,
        ...payload,
        // seed the human handoff keyed by the REAL path — the runtime details
        // are read back from the authoritative tree afterwards. Runs whether or
        // not this dialog is still open, so a backgrounded create still gets it.
        onCreated: (path) => seedWtContext(path, { title: branch, pr, prDescription, issue, issueDescription }),
      });
      select(wtPath);
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  /* Dismiss the dialog and let the create finish on its own. The job is
     backend-owned and runs to completion either way; what changes is where it
     reports — the sidebar shows an in-progress row, and the outcome lands in
     "Needs you" instead of in a dialog that is no longer on screen. */
  function runInBackground() {
    backgroundOp(opKey);
    onClose();
  }

  // the ⌘⏎ the Create button has always advertised
  usePrimaryAction("mod-enter", ok && !busy, create);

  return (
    <Modal
      icon={Fork}
      title="New worktree"
      sub={activeRepo?.name}
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <Hint icon={Info}>
            {busy ? "Setup keeps running if you close this" : "Ports and database are derived automatically"}
          </Hint>
          <Spacer />
          {busy ? (
            <button className="cx-btn cx-btn--ghost" onClick={runInBackground}>
              Run in background
            </button>
          ) : (
            <button className="cx-btn cx-btn--ghost" onClick={onClose}>
              Cancel
            </button>
          )}
          <button className="cx-btn cx-btn--primary" onClick={create} disabled={busy || !ok}>
            {busy ? (
              <>
                <Spinner size={12} />
                Creating…
              </>
            ) : (
              <>
                <Plus size={12} />
                Create worktree
                <span className="cx-k">⌘⏎</span>
              </>
            )}
          </button>
        </>
      }
    >
      <div className="cxm-fld">
        <div className="cxm-flab">
          <Fork size={11} />
          Repository &amp; branch
          <button
            className="cx-btn cx-btn--ghost cxm-opt"
            style={{ height: "var(--h-session)", padding: "0 var(--sp-3)", fontSize: "var(--fs-micro)" }}
            onClick={fetchAll}
            disabled={busy || fetching}
          >
            {fetching ? <Spinner size={10} /> : <Refresh size={10} />}
            Fetch all
          </button>
        </div>

        <div className="cxm-grid2" style={{ marginBottom: "var(--sp-row)" }}>
          <select className="cx-input" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={busy}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <div className="cx-seg">
            <button className={mode === "new" ? "is-on" : ""} onClick={() => setMode("new")} disabled={busy}>
              New branch
            </button>
            <button className={mode === "existing" ? "is-on" : ""} onClick={() => setMode("existing")} disabled={busy}>
              Existing
            </button>
          </div>
        </div>

        {mode === "new" ? (
          <>
            <div className="cxm-sfld">
              <div className="cxm-flab cxm-flab--f">Branch name</div>
              <input
                className="cx-input cx-input--mono"
                placeholder="feat/my-branch"
                value={name}
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="cxm-sfld">
              <div className="cxm-flab cxm-flab--f">Created from</div>
              <RefPick
                value={base}
                branches={branches}
                placeholder="search a base branch or tag…"
                onPick={(n) => setBase(n)}
              />
            </div>
          </>
        ) : (
          <div className="cxm-sfld">
            <div className="cxm-flab cxm-flab--f">Branch to check out</div>
            <RefPick
              value={existing}
              branches={branches}
              placeholder="search branches and tags…"
              inUse={inUse}
              onPick={(n, k) => {
                setExisting(n);
                setExistingKind(k);
              }}
            />
          </div>
        )}
      </div>

      <div className="cxm-fld">
        <div className="cxm-flab">You'll get</div>
        <dl className="cx-kv">
          <dt>Path</dt>
          <dd title={destination ?? undefined}>{destination ?? "—"}</dd>
          <dt>Ports</dt>
          <dd>
            {preview?.ports.length ? (
              preview.ports.map((p, i) => (
                <span key={p.serviceId} className={p.takenBy ? "cx-kv__bad" : undefined} title={p.takenBy ? `Port ${p.port} is already used by ${p.takenBy}` : undefined}>
                  {i > 0 && " · "}
                  {p.name.toLowerCase()} <b>{p.port}</b>
                </span>
              ))
            ) : preview ? (
              /* the repo declares no service with a base port — there is
                 nothing to assign, which is different from "not known yet" */
              <span title="No service in this repo declares a base port">none</span>
            ) : (
              "—"
            )}
          </dd>
          <dt>Database</dt>
          <dd title={preview && !preview.dbName ? "This repo's provisioning never references ${WT_DB_NAME}" : undefined}>
            {preview ? (preview.dbName ?? "none") : "—"}
          </dd>
        </dl>
        {preview?.pathExists && (
          <Hint icon={Alert}>That path already exists — creation will be refused. Pick another branch name.</Hint>
        )}
        {clashingPorts.length > 0 && (
          <Hint icon={Alert}>
            {clashingPorts.length === 1
              ? `Port ${clashingPorts[0].port} is already used by ${clashingPorts[0].takenBy} — change it after creating.`
              : `${clashingPorts.length} derived ports are already in use — change them after creating.`}
          </Hint>
        )}
      </div>

      <details className="cxm-disc">
        <summary>
          <span className="cv">
            <ChevRight size={11} />
          </span>
          Agent handoff
          <span className="sub">optional PR / issue context</span>
        </summary>
        <div className="cxm-disc__body">
          <div className="cxm-fld">
            <div className="cxm-flab cxm-flab--f">Pull request</div>
            <input
              className="cx-input"
              placeholder="https://github.com/org/repo/pull/123"
              value={pr}
              onChange={(e) => setPr(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="cxm-fld">
            <div className="cxm-flab cxm-flab--f">What it changes</div>
            <textarea
              className="cx-input"
              placeholder="Seeds the agent, and later becomes the PR body"
              value={prDescription}
              onChange={(e) => setPrDescription(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="cxm-fld">
            <div className="cxm-flab cxm-flab--f">Issue</div>
            <input
              className="cx-input"
              placeholder="https://github.com/org/repo/issues/42"
              value={issue}
              onChange={(e) => setIssue(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="cxm-fld">
            <div className="cxm-flab cxm-flab--f">Problem</div>
            <textarea
              className="cx-input"
              value={issueDescription}
              onChange={(e) => setIssueDescription(e.target.value)}
              disabled={busy}
            />
          </div>
        </div>
      </details>

      {busy && (
        <div className="cxm-prog">
          <span className="cxm-prog__ic">
            <Spinner size={13} />
          </span>
          <div className="cxm-prog__lines">
            {progress.length ? progress.slice(-4).map((l, i) => <div key={i}>{l}</div>) : <div>creating…</div>}
          </div>
        </div>
      )}

      {error && (
        <div className="cx-alert cx-alert--error" style={{ marginTop: "var(--sp-modal-head)" }}>
          <span className="cx-alert__ic">
            <Alert size={13} />
          </span>
          <div>{error}</div>
        </div>
      )}
    </Modal>
  );
}
