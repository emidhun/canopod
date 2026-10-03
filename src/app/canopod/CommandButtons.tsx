/* Custom commands (Settings → Commands) surfaced as real buttons in the rail —
   they belong beside the runtime they operate on, and the rail has room the
   worktree bar does not.

   The first command gets its own labelled run button; the rest collapse into a
   single "Commands" popover so the bar cannot grow without bound as the user
   adds more. Mirrors the design's CmdButtons (cx-app.jsx). Commands carry an
   optional `group`, and the popover renders a header per group; ungrouped
   commands sit together under no header, so a repo that never sets one looks
   exactly as it did. */
import { useEffect, useRef, useState } from "react";
import { Chevron, Play, Spinner } from "../../icons";
import { errText, hasBackend, ipc, type CustomCmd } from "../../ipc";
import { groupCommands } from "./commandGroups";
import { mockCustomCommands } from "../../mock";
import { useStore } from "../../store";
import type { WorktreeNode } from "../../types";

/** `group` is optional in practice — a settings file written before groups
    existed has none — so it is read defensively rather than assumed. */
type Grouped = CustomCmd & { group?: string };

export default function CommandButtons({ wt }: { wt: WorktreeNode }) {
  const [open, setOpen] = useState(false);
  // commands are stored WITH the repo id they were loaded for; a repo switch
  // then derives [] on the SAME render (not a frame later via an effect), so a
  // stale command can never be shown or run against the newly selected worktree
  const [loaded, setLoaded] = useState<{ repoId: string | undefined; list: CustomCmd[] }>({ repoId: undefined, list: [] });
  // the shell-side op buffer is shared per worktree, so only one custom command
  // may run at a time — a second would interleave output and its completion
  // would flip the worktree to idle while the first is still running
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const settingsRev = useStore((s) => s.settingsRev);
  const showToast = useStore((s) => s.showToast);
  // commands are repo-scoped; a worktree doesn't carry its repo id, so derive it
  // from the tree. The selector returns a primitive, so this only re-renders
  // when the owning repo actually changes.
  const repoId = useStore((s) => s.tree.find((r) => r.worktrees.some((w) => w.wtKey === wt.wtKey))?.repoId);

  // only trust the loaded list when it belongs to the current repo
  const cmds = loaded.repoId === repoId ? loaded.list : [];

  // WorktreeView is reused (no key) across repo switches; close any open menu
  // when the repo changes (the stale list is already gated out by `cmds` above)
  useEffect(() => {
    setOpen(false);
  }, [repoId]);

  // per-repo commands; reload when settings are saved
  useEffect(() => {
    if (!hasBackend()) {
      setLoaded({ repoId, list: mockCustomCommands() });
      return;
    }
    if (!repoId) {
      setLoaded({ repoId, list: [] });
      return;
    }
    let alive = true;
    ipc
      .getSettings()
      .then((s) => {
        if (alive) setLoaded({ repoId, list: s.repos.find((r) => r.id === repoId)?.customCommands ?? [] });
      })
      .catch(() => alive && setLoaded({ repoId, list: [] }));
    return () => {
      alive = false;
    };
  }, [repoId, settingsRev]);

  // this is a plain popover of buttons (not an ARIA menu), so native Tab moves
  // between rows; add outside-click + Escape dismissal, move focus in on open,
  // and hand it back to the trigger on close
  useEffect(() => {
    if (!open) return;
    const d = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", d);
    document.addEventListener("keydown", k);
    box.current?.querySelector<HTMLElement>(".cxs-cmdrow")?.focus();
    return () => {
      document.removeEventListener("mousedown", d);
      document.removeEventListener("keydown", k);
    };
  }, [open]);

  if (cmds.length === 0) return null;

  const run = (c: CustomCmd) => {
    if (busy) return;
    // activating a popover row unmounts the focused button; hand focus back to
    // the trigger so keyboard users aren't dropped onto <body> (run1 clicks
    // leave the popover closed, so this only fires for menu rows)
    if (open) trigger.current?.focus();
    setOpen(false);
    if (!hasBackend()) {
      showToast(`Running ${c.label} — ${wt.branch}`);
      return;
    }
    setBusy(true);
    showToast(`Running ${c.label} — ${wt.branch}…`);
    ipc
      .runCustomCommand(wt.wtKey, c.command)
      .then(() => showToast(`${c.label} finished — ${wt.branch}`))
      .catch((e) => showToast(`${c.label} failed — ${errText(e)}`))
      .finally(() => setBusy(false));
  };

  const { flat, groups } = groupCommands(cmds as Grouped[]);

  return (
    <div className="cxs-cmds" ref={box}>
      {flat.map((c, i) => (
        <button key={i} className="cxs-cmdb cxs-cmdb--run1" title={c.command} onClick={() => run(c)} disabled={busy}>
          {busy ? <Spinner size={10} /> : <Play size={10} />}
          <span className="t">{c.label}</span>
        </button>
      ))}
      {cmds.length > 1 && (
        <>
          <button
            ref={trigger}
            className={"cxs-cmdb" + (open ? " is-on" : "")}
            title="Custom commands"
            onClick={() => setOpen((o) => !o)}
            disabled={busy}
            aria-expanded={open}
          >
            <Play size={10} />
            <span className="t">Commands</span>
            <Chevron size={11} />
          </button>
          {open && (
            <div className="cxs-cmdpop">
              {Object.entries(groups).map(([g, list]) => (
                <div key={g || "_"}>
                  {g && <div className="cxs-cg">{g}</div>}
                  {list.map((c, i) => (
                    <button key={i} className="cxs-cmdrow" onClick={() => run(c)} disabled={busy}>
                      <Play size={10} />
                      <span className="l">{c.label}</span>
                      <span className="c">{c.command}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
