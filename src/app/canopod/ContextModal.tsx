/* The context editor — what the agent is seeded with, and what later becomes
   the PR body. Write/Preview because the body is markdown and people paste
   issue text into it; the runtime strip below is what the agent inherits
   whether or not anything is typed here. */
import { useState } from "react";
import { Copy, Doc, Info, Link, Plus, Sparkle, X } from "../../icons";
import { useStore } from "../../store";
import type { RepoNode, WorktreeNode } from "../../types";
import { composeContextMd, mdRender, runtimeFor, useWtContext } from "../WorktreeContext";
import Modal, { Hint, Spacer, usePrimaryAction } from "./Modal";

export default function ContextModal({
  repo,
  wt,
  onClose,
  onStartAgent,
}: {
  repo: RepoNode;
  wt: WorktreeNode;
  onClose: () => void;
  onStartAgent: () => void;
}) {
  const showToast = useStore((s) => s.showToast);
  const [ctx, setCtx] = useWtContext(wt.wtKey);
  const [tab, setTab] = useState<"write" | "preview">("write");
  /** the inline add-a-link field; null when the affordance is at rest */
  const [draftLink, setDraftLink] = useState<string | null>(null);
  const runtime = runtimeFor(repo, wt);

  // the ⌘⏎ the Start-agent button advertises. Modifier-based, so it coexists
  // with the plain ⏎ that commits the inline add-a-link field.
  usePrimaryAction("mod-enter", true, () => {
    onStartAgent();
    onClose();
  });

  return (
    <Modal
      icon={Doc}
      title="Context"
      sub={wt.branch}
      wide
      onClose={onClose}
      foot={
        <>
          <Hint icon={Info}>Seeds the agent · becomes the PR body</Hint>
          <Spacer />
          <button
            className="cx-btn cx-btn--ghost"
            onClick={() => {
              navigator.clipboard?.writeText(composeContextMd(ctx, runtime)).then(
                () => showToast("Copied as PR body"),
                () => showToast("Could not copy to the clipboard"),
              );
            }}
          >
            <Copy size={11} />
            Copy as PR body
          </button>
          <button
            className="cx-btn cx-btn--primary"
            onClick={() => {
              onStartAgent();
              onClose();
            }}
          >
            <Sparkle size={12} />
            Start agent
            <span className="cx-k">⌘⏎</span>
          </button>
        </>
      }
    >
      <div className="cxm-fld">
        <div className="cxm-flab">
          Task
          <div className="cx-seg cxm-opt" style={{ padding: "var(--sp-1)" }}>
            <button className={tab === "write" ? "is-on" : ""} onClick={() => setTab("write")}>
              Write
            </button>
            <button className={tab === "preview" ? "is-on" : ""} onClick={() => setTab("preview")}>
              Preview
            </button>
          </div>
        </div>
        <input
          className="cx-input"
          style={{ fontSize: "var(--fs-md)", fontWeight: "var(--fw-semi)", marginBottom: "var(--sp-row)" }}
          value={ctx.title}
          onChange={(e) => setCtx({ ...ctx, title: e.target.value })}
          placeholder="What is this worktree for?"
        />
        {tab === "write" ? (
          <textarea
            className="cx-input cx-input--mono"
            style={{ minHeight: 150, lineHeight: 1.7 }}
            value={ctx.body}
            spellCheck={false}
            onChange={(e) => setCtx({ ...ctx, body: e.target.value })}
          />
        ) : (
          <div className="cxm-preview">{mdRender(ctx.body)}</div>
        )}
      </div>

      <div className="cxm-fld">
        <div className="cxm-flab">
          <Link size={11} />
          References
          <span className="cxm-opt">handed over from New worktree</span>
        </div>
        <div className="cxm-ctxref">
          <label>Pull request</label>
          <input
            className="cx-input"
            value={ctx.pr}
            spellCheck={false}
            placeholder="https://github.com/org/repo/pull/123"
            onChange={(e) => setCtx({ ...ctx, pr: e.target.value })}
          />
          <label>What it changes</label>
          <textarea
            className="cx-input"
            value={ctx.prDescription}
            onChange={(e) => setCtx({ ...ctx, prDescription: e.target.value })}
          />
          <label>Issue</label>
          <input
            className="cx-input"
            value={ctx.issue}
            spellCheck={false}
            placeholder="https://github.com/org/repo/issues/42"
            onChange={(e) => setCtx({ ...ctx, issue: e.target.value })}
          />
          <label>Problem</label>
          <textarea
            className="cx-input"
            value={ctx.issueDescription}
            onChange={(e) => setCtx({ ...ctx, issueDescription: e.target.value })}
          />
        </div>
      </div>

      <div className="cxm-fld">
        <div className="cxm-flab">Runtime the agent inherits</div>
        <div className="cxm-ctxrt">
          <span>
            branch <em>{runtime.branch}</em>
          </span>
          {runtime.ports.map((p) => (
            <span key={p.name}>
              {p.name.toLowerCase()} <em>:{p.port}</em>
            </span>
          ))}
          <span>
            db <em>{runtime.dbName ?? "none"}</em>
          </span>
        </div>
      </div>

      {/* Always rendered. Gating this on a non-empty list meant a fresh
          context could never gain its first link — the add affordance was
          hidden behind the thing it exists to create. */}
      <div className="cxm-fld">
        <div className="cxm-flab">
          <Link size={11} />
          Links
        </div>
        <div className="cxm-links">
          {ctx.links.map((l) => (
            <span key={l.label} className="cxm-brc" title={l.label}>
              <Link size={10} />
              <span className="n">{l.label}</span>
              <span
                className="x"
                role="button"
                tabIndex={0}
                title={`Remove ${l.label}`}
                onClick={() => setCtx({ ...ctx, links: ctx.links.filter((x) => x.label !== l.label) })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setCtx({ ...ctx, links: ctx.links.filter((x) => x.label !== l.label) });
                  }
                }}
              >
                <X size={9} />
              </span>
            </span>
          ))}

          {draftLink === null ? (
            <button className="cxm-brc cxm-brc--add" onClick={() => setDraftLink("")}>
              <Plus size={10} />
              <span className="n">Add link</span>
            </button>
          ) : (
            <input
              className="cx-input cxm-linkin"
              autoFocus
              value={draftLink}
              spellCheck={false}
              placeholder="Paste an issue or PR link, then ⏎"
              onChange={(e) => setDraftLink(e.target.value)}
              onBlur={() => setDraftLink(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setDraftLink(null);
                }
                if (e.key === "Enter") {
                  const v = draftLink.trim();
                  if (!v) return setDraftLink(null);
                  if (!ctx.links.some((l) => l.label === v))
                    setCtx({ ...ctx, links: [...ctx.links, { label: v, kind: "link" }] });
                  setDraftLink(null);
                }
              }}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
