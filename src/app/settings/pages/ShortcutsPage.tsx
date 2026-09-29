// Shortcuts — the real keybindings, and the page that remaps them.
//
// Rendered from the registry the keydown handler dispatches off, so the two
// cannot drift: a row here exists because something listens for it.
import { useEffect, useState } from "react";
import { Refresh, Search } from "../../../icons";
import { KEY_ACTIONS, conflicts, displayBinding, normalizeBinding, resolveBindings } from "../../keys";
import type { PageProps } from "../types";

export default function ShortcutsPage({ settings, patch, markDirty, flash }: PageProps) {
  const [q, setQ] = useState("");
  /** the action currently capturing a keystroke, if any */
  const [capturing, setCapturing] = useState<string | null>(null);

  const bindings = resolveBindings(settings);
  const clashing = conflicts(bindings);
  const rows = KEY_ACTIONS.filter((a) => !q || (a.label + a.scope + displayBinding(bindings[a.id])).toLowerCase().includes(q.toLowerCase()));

  // While capturing, the whole keyboard belongs to this row — otherwise
  // pressing ⌘O to rebind it would ALSO switch to the overview underneath.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setCapturing(null); return; }
      // a bare modifier is not a binding — wait for the real key
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
      const next = normalizeBinding(e);
      patch({ keybindings: { ...(settings.keybindings ?? {}), [capturing]: next } });
      markDirty("shortcuts");
      setCapturing(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [capturing, settings.keybindings, patch, markDirty]);

  const reset = (id: string) => {
    const next = { ...(settings.keybindings ?? {}) };
    delete next[id];
    patch({ keybindings: next });
    markDirty("shortcuts");
  };

  return (
    <div className="sec">
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="navsearch" style={{ margin: 0, flex: 1, maxWidth: 260 }}>
          <Search size={12} /><input placeholder="Filter shortcuts…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => { patch({ keybindings: {} }); markDirty("shortcuts"); flash("Shortcuts restored to defaults"); }}>
          <Refresh size={11} />Restore defaults
        </button>
      </div>
      <table className="keys">
        <thead><tr><th>Command</th><th>Keys</th><th>Scope</th><th /></tr></thead>
        <tbody>{rows.map((a) => {
          const overridden = !!settings.keybindings?.[a.id];
          return (
            <tr key={a.id} style={clashing.has(a.id) ? { color: "var(--state-error)" } : undefined}>
              <td>{a.label}</td>
              <td>
                <button
                  className={"kbdk" + (capturing === a.id ? " is-capturing" : "")}
                  disabled={a.fixed}
                  title={a.fixed ? "Fixed — dismissing things must always work" : "Click, then press the keys you want"}
                  onClick={() => !a.fixed && setCapturing(a.id)}
                  style={{ background: "none", border: 0, padding: 0, cursor: a.fixed ? "default" : "pointer" }}
                >
                  {capturing === a.id ? <i>press keys…</i> : displayBinding(bindings[a.id]).split(" ").map((k, i) => <i key={i}>{k}</i>)}
                </button>
              </td>
              <td style={{ color: "var(--text-tertiary)" }}>{a.scope}</td>
              <td style={{ textAlign: "right" }}>
                {overridden && <span className="ico" title="Restore the default" onClick={() => reset(a.id)}><Refresh size={11} /></span>}
              </td>
            </tr>
          );
        })}</tbody>
      </table>
      {rows.length === 0 && <div className="srempty">No shortcuts match “{q}”.</div>}
      {clashing.size > 0 && (
        <div className="hint" style={{ marginTop: 12, color: "var(--state-error)" }}>
          Two shortcuts share a binding. Both are shown in red; the one higher in this list is the one that fires.
        </div>
      )}
      <div className="hint" style={{ marginTop: 12 }}>
        Click a shortcut and press the keys you want. Esc cancels. ⌘ and Ctrl are the same binding — one setting works on every platform.
      </div>
    </div>
  );
}
