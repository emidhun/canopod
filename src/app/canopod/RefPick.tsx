/* The searchable ref picker, shared by New worktree and Switch branch.

   Groups are Local / Remote / Tags. A branch already checked out in another
   worktree is shown but disabled and tagged "in use" — hiding it would leave
   you wondering where it went; git simply won't check it out twice. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Chevron, Fork, Plus, Search } from "../../icons";
import type { Branches } from "../../ipc";

export interface RefPickProps {
  value: string;
  onPick: (name: string, kind: "local" | "remote" | "tags" | "new") => void;
  branches: Branches | null;
  placeholder?: string;
  /** offer "Create <name>" when the typed text matches no known ref */
  allowCreate?: boolean;
  /** branch names already checked out elsewhere — shown, disabled, tagged */
  inUse?: Set<string>;
  /** a ref to omit entirely (the worktree's current branch, usually) */
  exclude?: string;
  autoFocus?: boolean;
}

export default function RefPick({
  value,
  onPick,
  branches,
  placeholder,
  allowCreate,
  inUse,
  exclude,
  autoFocus,
}: RefPickProps) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const d = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", d);
    return () => document.removeEventListener("mousedown", d);
  }, []);

  const t = q.trim();
  const groups = useMemo(() => {
    if (!branches) return [];
    const match = (n: string) => n !== exclude && (!t || n.toLowerCase().includes(t.toLowerCase()));
    return (
      [
        { k: "local" as const, label: "Local", items: branches.local.filter(match) },
        { k: "remote" as const, label: "Remote", items: branches.remote.filter(match) },
        { k: "tags" as const, label: "Tags", items: branches.tags.filter(match) },
      ] satisfies { k: "local" | "remote" | "tags"; label: string; items: string[] }[]
    ).filter((g) => g.items.length);
  }, [branches, t, exclude]);

  const known = useMemo(
    () => new Set([...(branches?.local ?? []), ...(branches?.remote ?? []), ...(branches?.tags ?? [])]),
    [branches],
  );
  // a name carrying a remote prefix isn't a branch you can create locally
  const canCreate = !!allowCreate && !!t && !known.has(t) && !t.startsWith("origin/");

  return (
    // While the menu is open Escape belongs to it, not to the enclosing dialog:
    // data-esc-claim tells Modal to stand down (see Modal.tsx). Handled here
    // rather than on the input because Tab can move focus onto a menu item, and
    // Escape has to close the menu from there too. Stopping the event also keeps
    // the app-level Escape (palette / attention queue) out of it. Closed, the
    // marker is gone and Escape is the dialog's again.
    <div
      className="cxm-pick"
      ref={box}
      data-esc-claim={open ? "" : undefined}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.stopPropagation();
        setOpen(false);
        // focus followed a menu item that is about to unmount; put it back on
        // the field instead of letting it fall to <body>
        box.current?.querySelector("input")?.focus();
      }}
    >
      <div className="cxm-pick-f" onClick={() => setOpen(true)}>
        <Search size={12} />
        <input
          value={open ? q : value}
          placeholder={value || placeholder}
          spellCheck={false}
          autoFocus={autoFocus}
          // Open only on an explicit click (the field wrapper) or when typing —
          // never on bare focus, or the modal's focus trap / focus returning
          // after a pick would re-open the menu on its own.
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "Enter") setOpen(true);
          }}
        />
        <Chevron size={12} />
      </div>

      {open && (
        <div className="cxm-pick-l">
          {!branches && <div className="cxm-pick-e">Loading refs…</div>}

          {canCreate && (
            <button
              className="cxm-pick-i cxm-pick-i--new"
              onClick={() => {
                onPick(t, "new");
                setQ("");
                setOpen(false);
              }}
            >
              <span className="ic">
                <Plus size={12} />
              </span>
              <span className="nm">
                Create <b style={{ fontWeight: 600 }}>{t}</b>
              </span>
            </button>
          )}

          {groups.map((g) => (
            <div key={g.k}>
              <div className="cxm-pick-g">{g.label}</div>
              {g.items.map((n) => {
                // selecting `origin/foo` creates or reuses local `foo`, so the
                // in-use test has to compare the name it will actually resolve to
                const short = g.k === "remote" ? n.replace(/^[^/]+\//, "") : n;
                const taken = g.k !== "tags" && inUse?.has(short) && short !== value;
                return (
                  <button
                    key={g.k + n}
                    className={"cxm-pick-i" + (n === value ? " is-on" : "")}
                    disabled={taken}
                    title={taken ? `${n} is checked out in another worktree` : undefined}
                    onClick={() => {
                      onPick(n, g.k);
                      setQ("");
                      setOpen(false);
                    }}
                  >
                    <span className="ic">
                      <Fork size={12} />
                    </span>
                    <span className="nm">{n}</span>
                    {taken && <span className="cx-tag cx-tag--warn">in use</span>}
                    {!taken && g.k !== "local" && <span className="cx-tag">{g.k === "tags" ? "tag" : "remote"}</span>}
                  </button>
                );
              })}
            </div>
          ))}

          {branches && !groups.length && !canCreate && <div className="cxm-pick-e">No refs match “{q}”.</div>}
        </div>
      )}
    </div>
  );
}
