// Terminal — the shell Canopy opens inside a worktree.
import { type TermCfg } from "../../../ipc";
import { TRow } from "../primitives";
import { DEFAULT_TERM } from "../provision";
import type { PageProps } from "../types";

export default function TerminalPage({ settings, patch, markDirty }: PageProps) {
  /* Every field's empty/zero value means "keep the built-in behaviour", so the
     placeholders show what you get by leaving one blank rather than pretending
     to be a stored value. The renderer's real defaults stay in TerminalPane
     instead of being duplicated here as magic numbers. */
  const t = settings.embeddedTerminal ?? DEFAULT_TERM;
  const set = (p: Partial<TermCfg>) => { patch({ embeddedTerminal: { ...t, ...p } }); markDirty("terminal"); };
  const num = (v: string) => (v.trim() === "" ? 0 : Number(v));
  return (
    <>
      <div className="sec">
        <div className="slab">Terminal application</div>
        <div className="fgrid">
          <span className="lb">Program</span>
          <div className="row"><input className="inp mono gr" value={settings.terminal} placeholder="Terminal" onChange={(e) => { patch({ terminal: e.target.value }); markDirty("terminal"); }} />
            <span className="hint" style={{ marginTop: 0 }}>Opened by “Open in terminal”.</span></div>
        </div>
      </div>
      <div className="sec">
        <div className="slab">Embedded shell<span className="n">applies to shells opened from now on</span></div>
        <div className="fgrid">
          <span className="lb">Program</span>
          <input className="inp mono" value={t.program} placeholder="your login shell" onChange={(e) => set({ program: e.target.value })} />
          <span className="lb">Arguments</span>
          <input className="inp mono" value={t.args} placeholder="only used with an explicit program" disabled={!t.program.trim()}
            title={t.program.trim() ? undefined : "Canopy passes its own -l/-i flags to a login shell it picked; your arguments would collide with them."}
            onChange={(e) => set({ args: e.target.value })} />
          <span className="lb">Font</span>
          <div className="row">
            <input className="inp mono gr" value={t.fontFamily} placeholder="the app's mono stack" onChange={(e) => set({ fontFamily: e.target.value })} />
            <input className="inp mono" value={t.fontSize || ""} placeholder="12.5" style={{ width: 70 }} onChange={(e) => set({ fontSize: num(e.target.value) })} />
          </div>
          <span className="lb">Scrollback</span>
          <input className="inp mono" value={t.scrollback || ""} placeholder="2500" style={{ width: 90 }} onChange={(e) => set({ scrollback: num(e.target.value) })} />
          <span className="lb">Cursor</span>
          <select className="inp" value={t.cursor || "block"} onChange={(e) => set({ cursor: e.target.value })}>
            <option value="block">Block</option>
            <option value="underline">Underline</option>
            <option value="bar">Bar</option>
          </select>
        </div>
        <TRow title="Blink the cursor" on={t.cursorBlink} onToggle={() => set({ cursorBlink: !t.cursorBlink })} />
        <TRow title="Flash on bell" hint="A process emitting BEL flashes its pane. A beep from a worktree you can't see tells you nothing about where it came from." on={t.bell} onToggle={() => set({ bell: !t.bell })} />
        <TRow title="Open in the worktree directory" hint="Off starts new shells in your home directory. A launched command always runs in the worktree." on={t.cwdWorktree} onToggle={() => set({ cwdWorktree: !t.cwdWorktree })} />
        <TRow title="Inherit provisioned env" hint="Exposes WT_SLUG, WT_DB_NAME and the derived service ports, so a command you type sees what the services see." on={t.inheritEnv} onToggle={() => set({ inheritEnv: !t.inheritEnv })} />
      </div>
    </>
  );
}
