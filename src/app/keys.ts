/* The keybinding registry.

   Every global shortcut is declared here once, with a default, and the keydown
   handler matches against the registry rather than a chain of hardcoded `if
   (meta && e.key === "b")` branches. That is what makes remapping possible at
   all — without a registry there is nothing to remap, and the Shortcuts page
   can only be a static list that drifts from the code the moment either
   changes.

   Overrides live in `Settings.keybindings` (a map of action id → binding), so
   they travel with the config file like every other preference and are visible
   to the popover window. */
import type { Settings } from "../ipc";

export type KeyScope = "Global" | "Worktree" | "Settings";

export interface KeyAction {
  id: string;
  label: string;
  scope: KeyScope;
  /** the shipped binding, in the same normalized form as an override */
  def: string;
  /** shortcuts the app hard-codes for a reason (Escape dismisses things
      everywhere); listed so the page is complete, but not remappable */
  fixed?: boolean;
}

/** Canonical form: modifiers in a fixed order, then the key, lowercased.
    `Mod` is ⌘ on macOS and Ctrl elsewhere — one binding, both platforms. */
export function normalizeBinding(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  parts.push(key);
  return parts.join("+");
}

/** How a binding is written for a human. */
export function displayBinding(binding: string, mac = navigator.platform.toLowerCase().includes("mac")): string {
  return binding
    .split("+")
    .map((p) => {
      if (p === "Mod") return mac ? "⌘" : "Ctrl";
      if (p === "Alt") return mac ? "⌥" : "Alt";
      if (p === "Shift") return mac ? "⇧" : "Shift";
      if (p === "Enter") return "⏎";
      if (p === "Escape") return "Esc";
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join(mac ? " " : "+");
}

export const KEY_ACTIONS: KeyAction[] = [
  { id: "palette", label: "Command palette", scope: "Global", def: "Mod+k" },
  { id: "new-worktree", label: "New worktree", scope: "Global", def: "Mod+n" },
  { id: "toggle-sidebar", label: "Toggle worktree list", scope: "Global", def: "Mod+b" },
  { id: "overview", label: "Cross-worktree overview", scope: "Global", def: "Mod+o" },
  { id: "dismiss", label: "Dismiss / close", scope: "Global", def: "Escape", fixed: true },
  { id: "settings", label: "Open settings", scope: "Global", def: "Mod+," },
  { id: "add-repo", label: "Add repository", scope: "Global", def: "Mod+Shift+n" },
  { id: "sync-submodules", label: "Sync submodules", scope: "Worktree", def: "Mod+Shift+s" },
  { id: "switch-branch", label: "Switch branch", scope: "Worktree", def: "Mod+\\" },
  { id: "layout-1", label: "Runtime layout", scope: "Worktree", def: "Mod+1" },
  { id: "layout-2", label: "Split layout", scope: "Worktree", def: "Mod+2" },
  { id: "layout-3", label: "Agent layout", scope: "Worktree", def: "Mod+3" },
  { id: "layout-4", label: "Shell layout", scope: "Worktree", def: "Mod+4" },
  { id: "layout-5", label: "Logs layout", scope: "Worktree", def: "Mod+5" },
  { id: "run-next", label: "Run next action", scope: "Worktree", def: "Enter" },
];

/** The effective binding for every action: defaults with the user's overrides
    applied. An override naming an action this build no longer has is ignored,
    the same way an unknown experiment flag is. */
export function resolveBindings(settings: Settings | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of KEY_ACTIONS) out[a.id] = a.def;
  for (const [id, binding] of Object.entries(settings?.keybindings ?? {})) {
    const action = KEY_ACTIONS.find((a) => a.id === id);
    // A fixed action cannot be remapped even if a hand-edited config tries:
    // losing Escape would leave modals with no keyboard dismissal at all.
    if (action && !action.fixed && binding.trim()) out[id] = binding.trim();
  }
  return out;
}

/** Action ids that share a binding with another action.
 *
 *  Surfaced rather than prevented: two bindings can legitimately collide while
 *  someone is halfway through swapping them, and refusing the first edit makes
 *  the swap impossible. The page shows the clash; the resolver below decides
 *  which one actually fires. */
export function conflicts(bindings: Record<string, string>): Set<string> {
  const seen = new Map<string, string[]>();
  for (const [id, b] of Object.entries(bindings)) {
    seen.set(b, [...(seen.get(b) ?? []), id]);
  }
  const bad = new Set<string>();
  for (const ids of seen.values()) if (ids.length > 1) ids.forEach((i) => bad.add(i));
  return bad;
}

/** Which action a keystroke triggers, or null.
 *
 *  On a conflict the FIRST action in registry order wins, deterministically —
 *  so a clash produces one consistent behaviour rather than one that depends
 *  on object key order. */
export function actionFor(e: KeyboardEvent, bindings: Record<string, string>): string | null {
  const pressed = normalizeBinding(e);
  for (const a of KEY_ACTIONS) {
    if (bindings[a.id] === pressed) return a.id;
  }
  return null;
}
