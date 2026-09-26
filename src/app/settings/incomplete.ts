// #43 — which Settings rows cannot be saved, and how to say so.
//
// A service, custom command or agent row that is missing a required field
// cannot be persisted. It used to be filtered out during save with no warning,
// which reads as data loss. Instead: find those rows, block the save, name the
// first one, and hand back keys the editors use to mark them.
//
// An entirely untouched row is the exception — "+ Add" drops one into the
// editor, and blocking on it would make the button unusable — so it is still
// dropped quietly. It carries nothing to lose.
import type { RepoCfg } from "../../ipc";
import type { PageId } from "./catalog";

export type RowKind = "service" | "command" | "agent";

export type IncompleteRow = {
  kind: RowKind;
  /** set by the caller when more than one repo is configured, so the message
      can say which one is at fault rather than silently switching scope */
  repo?: string;
  page: PageId;
  /** kind + index: a blank id still addresses the right row */
  key: string;
  label: string;
  /** phrased for a sentence: "needs an id and a command" */
  missing: string[];
};

export const rowKey = (kind: RowKind, index: number) => `${kind}:${index}`;

const PAGE: Record<RowKind, PageId> = { service: "services", command: "commands", agent: "agents" };
const SECTION: Record<RowKind, string> = { service: "Services", command: "Commands", agent: "Agents" };
const NOUN: Record<RowKind, string> = { service: "service", command: "command", agent: "agent" };

const blank = (s: string | undefined) => !s?.trim();

/** the fields the user types into — an all-blank row is an untouched one */
type Spec = { label: string; value: string | undefined; required?: string };

function rowsOf(r: RepoCfg): { kind: RowKind; index: number; fields: Spec[]; label: string }[] {
  return [
    ...r.services.map((s, index) => ({
      kind: "service" as const, index,
      // the id is generated, never typed — like an agent's, it neither marks
      // the row as touched nor blocks the save; cleanRepo backfills a blank one
      fields: [
        { label: "name", value: s.name },
        { label: "command", value: s.command, required: "a command" },
        { label: "directory", value: s.cwd },
        { label: "environment", value: Object.keys(s.env || {}).length ? "configured" : "" },
        { label: "base port", value: s.basePort == null ? "" : String(s.basePort) },
      ],
      label: s.name?.trim() || s.id?.trim() || "Untitled service",
    })),
    ...(r.customCommands || []).map((c, index) => ({
      kind: "command" as const, index,
      fields: [
        { label: "label", value: c.label, required: "a label" },
        { label: "command", value: c.command, required: "a command" },
        { label: "group", value: c.group },
      ],
      label: c.label?.trim() || "Untitled command",
    })),
    ...(r.agents || []).map((a, index) => ({
      kind: "agent" as const, index,
      // the id is generated, never typed — it does not count as "touched"
      fields: [
        { label: "waiting patterns", value: a.waitingPatterns },
        { label: "name", value: a.name, required: "a name" },
        { label: "command", value: a.command, required: "a command" },
      ],
      label: a.name?.trim() || "Untitled agent",
    })),
  ];
}

export function incompleteRows(r: RepoCfg): IncompleteRow[] {
  const out: IncompleteRow[] = [];
  for (const row of rowsOf(r)) {
    if (row.fields.every((f) => blank(f.value))) continue; // untouched
    const missing = row.fields.filter((f) => f.required && blank(f.value)).map((f) => f.required as string);
    if (!missing.length) continue;
    out.push({ kind: row.kind, page: PAGE[row.kind], key: rowKey(row.kind, row.index), label: row.label, missing });
  }
  return out;
}

const listOf = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

export function describeIncomplete(rows: IncompleteRow[]): string {
  if (!rows.length) return "";
  if (rows.length === 1) {
    const r = rows[0];
    const where = r.repo ? ` in ${r.repo}` : "";
    return `Nothing saved — the ${NOUN[r.kind]} "${r.label}"${where} needs ${listOf(r.missing)}.`;
  }
  const sections = [...new Set(rows.map((r) => SECTION[r.kind]))];
  // the save jumps repo scope to reach the first bad row, so name the repos
  // here too — otherwise "which repository?" is unanswerable from the toast
  const repos = [...new Set(rows.map((r) => r.repo).filter(Boolean) as string[])];
  const where = repos.length ? ` (${listOf(repos)})` : "";
  return `Nothing saved — ${rows.length} incomplete rows in ${listOf(sections)}${where}.`;
}

/** the note shown on the row itself: "needs an id and a command" */
export const missingText = (r: IncompleteRow) => `needs ${listOf(r.missing)}`;
