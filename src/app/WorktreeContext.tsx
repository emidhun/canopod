// Per-worktree context: a title + markdown body + links that seed the agent and
// later become the PR body. Persisted per worktree in localStorage (keyed by
// wtKey). Whether this should instead live as a committed `.canopy/context.md`
// that travels with the branch is an open product question — see the handoff.
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Chevron, Copy, Doc, File, Info, Link as LinkIcon, Plus, Sparkle } from "../icons";
import { errText, hasBackend, ipc } from "../ipc";
import type { RepoNode, WorktreeNode } from "../types";

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

async function openLink(url: string, onToast: (m: string) => void) {
  try {
    if (hasBackend()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
  } catch (e) {
    onToast(`Couldn't open link — ${errText(e)}`);
  }
}

async function copyPrBody(ctx: WtContext, onToast: (m: string) => void) {
  try {
    await navigator.clipboard.writeText(composeContextMd(ctx));
    onToast("Context copied as PR body");
  } catch (e) {
    onToast(`Couldn't copy — ${errText(e)}`);
  }
}

export interface WtContext {
  title: string;
  body: string;
  links: { label: string; kind: string }[];
  files: string[];
  pr: string;
  prDescription: string;
  issue: string;
  issueDescription: string;
}

const EMPTY: WtContext = { title: "", body: "", links: [], files: [], pr: "", prDescription: "", issue: "", issueDescription: "" };

export interface WorktreeRuntime {
  repo: string;
  branch: string;
  path: string;
  dbName: string | null;
  ports: { name: string; port: number }[];
}

export function runtimeFor(repo: RepoNode, wt: WorktreeNode): WorktreeRuntime {
  return {
    repo: repo.name,
    branch: wt.branch,
    path: wt.path,
    dbName: wt.dbName,
    ports: wt.services.flatMap((s) => (s.port == null ? [] : [{ name: s.name, port: s.port }])),
  };
}

function load(key: string): WtContext {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return EMPTY;
}

/** Read a worktree's context outside React. Launches use this rather than a
    hook snapshot: `useWtContext` is per-caller state, so an edit in the
    context editor would not be visible to a launcher holding its own copy. */
export function readWtContext(wtKey: string): WtContext {
  return load(`canopy.ctx.${wtKey}`);
}

/** Load/save a worktree's context, reloading when the selected worktree changes. */
export function useWtContext(wtKey: string): [WtContext, (c: WtContext) => void] {
  const key = `canopy.ctx.${wtKey}`;
  const [ctx, setCtx] = useState<WtContext>(() => load(key));
  useEffect(() => setCtx(load(key)), [key]);
  const update = (c: WtContext) => {
    setCtx(c);
    try {
      localStorage.setItem(key, JSON.stringify(c));
    } catch {
      /* ignore */
    }
  };
  return [ctx, update];
}

/** Seed a newly-created worktree before it is first opened in the lane. */
export function seedWtContext(wtKey: string, partial: Partial<WtContext>) {
  const next = { ...EMPTY, ...partial };
  try {
    localStorage.setItem(`canopy.ctx.${wtKey}`, JSON.stringify(next));
  } catch {
    /* local storage is an enhancement, not a creation dependency */
  }
}

export const isBlank = (c: WtContext) =>
  !c.title.trim() && !c.body.trim() && !c.pr.trim() && !c.prDescription.trim() && !c.issue.trim() && !c.issueDescription.trim() && c.links.length === 0 && c.files.length === 0;

/** Render the context as the markdown seed written to `.canopy/context.md`. */
/** Which sections of the handoff to include (Settings → Agents). Defaults
    reproduce what the handoff contained before this was configurable. */
export interface ContextParts {
  worktreeContext: boolean;
  runtimeFacts: boolean;
  failingLogs: boolean;
}
export const ALL_CONTEXT: ContextParts = { worktreeContext: true, runtimeFacts: true, failingLogs: false };

export function composeContextMd(
  c: WtContext,
  runtime?: WorktreeRuntime,
  parts: ContextParts = ALL_CONTEXT,
  failingLogs: string[] = [],
): string {
  // The title always survives: a handoff with no heading at all reads as a
  // truncation bug rather than a deliberate setting.
  let md = `# ${c.title.trim() || "Untitled"}\n`;
  if (parts.worktreeContext) {
    md += `\n${c.body.trim()}\n`;
    if (c.pr.trim() || c.prDescription.trim()) md += `\n## Pull request\n${c.pr.trim() ? `${c.pr.trim()}\n` : ""}${c.prDescription.trim()}\n`;
    if (c.issue.trim() || c.issueDescription.trim()) md += `\n## Issue\n${c.issue.trim() ? `${c.issue.trim()}\n` : ""}${c.issueDescription.trim()}\n`;
  }
  if (runtime && parts.runtimeFacts) {
    md += `\n## Worktree\n- Repository: ${runtime.repo}\n- Branch: ${runtime.branch}\n- Path: ${runtime.path}\n`;
    md += `- Database: ${runtime.dbName || "not configured"}\n`;
    md += runtime.ports.length ? `- Ports: ${runtime.ports.map((p) => `${p.name} :${p.port}`).join(", ")}\n` : "- Ports: none configured\n";
  }
  if (parts.failingLogs && failingLogs.length) {
    md += "\n## Recent failures\n```\n" + failingLogs.join("\n") + "\n```\n";
  }
  if (parts.worktreeContext) {
    if (c.files.length) md += "\n## Files\n" + c.files.map((f) => `- ${f}`).join("\n") + "\n";
    if (c.links.length) md += "\n## Links\n" + c.links.map((l) => `- ${l.label}`).join("\n") + "\n";
  }
  return md;
}

/** The compact message passed to an agent at launch; the complete handoff is
 * on disk so agents that support rich prompts can read it without truncation. */
export function composeAgentPrompt(c: WtContext, runtime: WorktreeRuntime): string {
  const focus = c.title.trim() || c.issueDescription.trim() || c.prDescription.trim() || c.body.trim() || "the assigned worktree task";
  return `Work on ${focus}. Read the complete Canopy handoff at ${runtime.path}/.canopy/context.md before making changes. Worktree: ${runtime.repo}/${runtime.branch}; database: ${runtime.dbName || "not configured"}; ports: ${runtime.ports.map((p) => `${p.name}:${p.port}`).join(", ") || "none"}.`;
}

/** Plain-text one-liner of the markdown body, for the lane summary preview. */
export function bodyPreview(body: string): string {
  return body
    .replace(/[#`\-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tiny markdown renderer: `## ` headings, `- ` bullets, inline `code`. */
export function mdRender(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let list: ReactNode[] | null = null;
  const inline = (s: string) =>
    s.split(/(`[^`]+`)/g).map((p, j) =>
      p.startsWith("`") && p.endsWith("`") && p.length > 1 ? (
        <code key={j}>{p.slice(1, -1)}</code>
      ) : (
        <Fragment key={j}>{p}</Fragment>
      ),
    );
  src.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      if (list) {
        out.push(<ul key={"u" + i}>{list}</ul>);
        list = null;
      }
      out.push(<h3 key={i}>{line.slice(3)}</h3>);
    } else if (line.startsWith("- ")) {
      (list = list || []).push(<li key={i}>{inline(line.slice(2))}</li>);
    } else if (line) {
      if (list) {
        out.push(<ul key={"u" + i}>{list}</ul>);
        list = null;
      }
      out.push(<p key={i}>{inline(line)}</p>);
    }
  });
  if (list) out.push(<ul key="ul-last">{list}</ul>);
  return out;
}

/** The full context editor, shown in a modal over the lane. */
export function ContextEditor({
  ctx,
  setCtx,
  runtime,
  wtKey,
  onClose,
  onSeed,
  onToast,
}: {
  ctx: WtContext;
  setCtx: (c: WtContext) => void;
  runtime: WorktreeRuntime;
  wtKey: string;
  onClose: () => void;
  onSeed: () => void;
  onToast: (m: string) => void;
}) {
  const [tab, setTab] = useState<"write" | "prev">("write");
  const resourceClick = (kind: "link" | "file", value: string, e: React.MouseEvent) => {
    if (!e.metaKey && !e.ctrlKey) return;
    e.preventDefault();
    if (kind === "link") {
      if (isUrl(value)) openLink(value, onToast);
      else onToast("That resource is not a browser link");
    } else if (hasBackend()) {
      ipc.openFileInEditor(wtKey, value).catch((err) => onToast(`Couldn't open file — ${errText(err)}`));
    } else onToast("Opening files needs the desktop app");
  };
  return (
    <div className="ctx-scrim" onMouseDown={onClose}>
      <div className="ctx-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ctx-card">
          <div className="ctx-head">
            <span className="cs-lbl">
              <Doc size={12} />
              Context
            </span>
            <span className="grow" />
            <div className="ctx-seg">
              <button className={tab === "write" ? "on" : ""} onClick={() => setTab("write")}>
                Write
              </button>
              <button className={tab === "prev" ? "on" : ""} onClick={() => setTab("prev")}>
                Preview
              </button>
            </div>
            <button className="ib" title="Collapse" onClick={onClose}>
              <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>
                <Chevron size={14} />
              </span>
            </button>
          </div>

          <input
            className="ctx-title-in"
            value={ctx.title}
            placeholder="What is this worktree for?"
            onChange={(e) => setCtx({ ...ctx, title: e.target.value })}
          />

          <div className="ctx-references">
            <label>Pull request</label>
            <input value={ctx.pr} placeholder="https://github.com/org/repo/pull/123" onChange={(e) => setCtx({ ...ctx, pr: e.target.value })} />
            <textarea value={ctx.prDescription} placeholder="What the PR changes / what to verify" onChange={(e) => setCtx({ ...ctx, prDescription: e.target.value })} />
            <label>Issue</label>
            <input value={ctx.issue} placeholder="https://github.com/org/repo/issues/123" onChange={(e) => setCtx({ ...ctx, issue: e.target.value })} />
            <textarea value={ctx.issueDescription} placeholder="Problem, acceptance criteria, and constraints" onChange={(e) => setCtx({ ...ctx, issueDescription: e.target.value })} />
          </div>

          {tab === "write" ? (
            <textarea
              className="ctx-md"
              value={ctx.body}
              spellCheck={false}
              placeholder={"## Problem\n…\n\n## Acceptance\n- …"}
              onChange={(e) => setCtx({ ...ctx, body: e.target.value })}
            />
          ) : (
            <div className="ctx-prev">{mdRender(ctx.body)}</div>
          )}

          <div className="ctx-links">
            {ctx.pr.trim() && <span className="ctx-link" title="Cmd/Ctrl-click to open in browser" onClick={(e) => resourceClick("link", ctx.pr, e)}><LinkIcon size={11} /> PR</span>}
            {ctx.issue.trim() && <span className="ctx-link" title="Cmd/Ctrl-click to open in browser" onClick={(e) => resourceClick("link", ctx.issue, e)}><LinkIcon size={11} /> Issue</span>}
            {ctx.files.map((file) => (
              <span className="ctx-link" key={file} title="Cmd/Ctrl-click to open in your selected editor" onClick={(e) => resourceClick("file", file, e)}>
                <File size={11} />{file}
              </span>
            ))}
            {ctx.links.map((l) => {
              return (
                <span
                  className="ctx-link"
                  key={l.label}
                  title="Cmd/Ctrl-click to open in browser"
                  onClick={(e) => resourceClick("link", l.label, e)}
                >
                  <span className="ic">
                    <LinkIcon size={11} />
                  </span>
                  {l.label}
                </span>
              );
            })}
            <span
              className="ctx-link add"
              onClick={() => {
                const label = window.prompt("Paste an issue or PR link (or a label)");
                if (label && label.trim()) {
                  const kind = /pull|\/pull\/|pr[\s#]/i.test(label) ? "pr" : "issue";
                  setCtx({ ...ctx, links: [...ctx.links, { label: label.trim(), kind }] });
                }
              }}
            >
              <Plus size={11} />
              Add link
            </span>
            <span className="ctx-link add" onClick={() => {
              const file = window.prompt("Relative path inside this worktree");
              if (file?.trim()) setCtx({ ...ctx, files: [...ctx.files, file.trim()] });
            }}>
              <Plus size={11} /> Add file
            </span>
          </div>

          <div className="ctx-runtime">
            <b>Worktree environment</b>
            <span>{runtime.branch}</span>
            <span>{runtime.dbName || "no database"}</span>
            {runtime.ports.map((p) => <span key={p.name}>{p.name} :{p.port}</span>)}
          </div>

          <div className="ctx-foot">
            <span className="hint">
              <Info size={12} />
              Seeds the agent · becomes the PR body
            </span>
            <span className="grow" />
            <button className="btn-sm" onClick={() => copyPrBody(ctx, onToast)}>
              <Copy size={12} />
              Use as PR body
            </button>
            <button className="btn-sm teal" onClick={onSeed}>
              <Sparkle size={12} />
              Start agent with this
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
