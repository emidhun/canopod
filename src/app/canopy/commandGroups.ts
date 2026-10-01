// Command grouping (#115) — the pure logic behind the rail's Commands control
// and the Settings group datalist, split out so it can be unit-tested without
// rendering either surface.
//
// The rail shows the FIRST command as a one-click "run1" button; the rest fall
// into a menu bucketed by `group`, in first-seen order, with "" meaning
// ungrouped. `group` is optional here on purpose — a settings file written
// before groups existed has commands with no group at all.

/** Anything with an optional group — CustomCmd (group: string) satisfies it,
    as does a pre-groups command that omits the field entirely. */
export type MaybeGrouped = { group?: string };

/** Split commands into the leading run1 command and the rest bucketed by group.
    Insertion order is preserved both across buckets and within each bucket. */
export function groupCommands<T extends MaybeGrouped>(cmds: T[]): { flat: T[]; groups: Record<string, T[]> } {
  const flat = cmds.slice(0, 1);
  const rest = cmds.slice(1);
  const groups = rest.reduce<Record<string, T[]>>((acc, c) => {
    const g = c.group || "";
    (acc[g] ??= []).push(c);
    return acc;
  }, {});
  return { flat, groups };
}

/** Distinct, trimmed, non-empty group names in first-seen order — the options
    behind the Settings "Group" field's autocomplete. */
export function groupNames<T extends MaybeGrouped>(cmds: T[]): string[] {
  return Array.from(new Set(cmds.map((c) => (c.group ?? "").trim()).filter(Boolean)));
}
