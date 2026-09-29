// Advanced — diagnostics, experiments and reset.
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { errText, hasBackend, ipc, type Diagnostics, type Experiment } from "../../../ipc";
import { Copy, Logs, Refresh } from "../../../icons";
import { TRow, Adv } from "../primitives";
import type { PageProps } from "../types";

export default function AdvancedPage({ flash, settings, patch, markDirty, reload }: PageProps) {
  const [ver, setVer] = useState("—");
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (!hasBackend()) { setVer("dev"); return; }
    getVersion().then(setVer).catch(() => setVer("—"));
    // The real config path, not a macOS-shaped guess — the old hardcoded
    // "~/Library/Application Support/…" was wrong on Linux and Windows.
    ipc.gatherDiagnostics().then(([d]) => setDiag(d)).catch(() => {});
    ipc.listExperiments().then(setExperiments).catch(() => {});
  }, []);

  const configPath = diag ? `${diag.configDir}/settings.json` : "—";
  const flags = settings.experiments ?? {};
  const setFlag = (id: string, on: boolean) => { patch({ experiments: { ...flags, [id]: on } }); markDirty("advanced"); };

  const copyDiagnostics = async () => {
    if (!hasBackend()) return flash("Diagnostics need the desktop app");
    try {
      const [, markdown] = await ipc.gatherDiagnostics();
      await navigator.clipboard.writeText(markdown);
      flash("Diagnostics copied — paste into an issue");
    } catch (e) {
      flash(`Couldn't copy — ${errText(e)}`);
    }
  };

  return (
    <>
      <div className="sec">
        <div className="slab">Diagnostics</div>
        <div className="fgrid">
          <span className="lb">Version</span>
          <span style={{ font: "var(--fs-small) var(--mono)", color: "var(--text-secondary)" }}>{ver}</span>
          <span className="lb">Config</span>
          <div className="row"><input className="inp mono gr" value={configPath} readOnly />
            <button className="ico" title="Copy path" onClick={() => { navigator.clipboard?.writeText(configPath).then(() => flash("Path copied"), () => flash("Copy failed")); }}><Copy size={12} /></button></div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" title="Copy an environment summary for a bug report" onClick={copyDiagnostics}><Copy size={11} />Copy diagnostics</button>
          <button className="btn" title="Reveal the log directory" onClick={() => ipc.openLogDir().catch((e) => flash(errText(e)))}><Logs size={11} />Open logs</button>
        </div>
        <p className="hint">Counts and versions only — never repository paths, branch names or environment values.</p>
      </div>
      <div className="sec">
        <div className="slab">Experiments<span className="n">may change or disappear</span></div>
        {experiments.length === 0 ? (
          <p className="hint">This build ships no experiments.</p>
        ) : (
          experiments.map((e) => (
            <TRow key={e.id} title={e.label} hint={e.hint} on={!!flags[e.id]} onToggle={() => setFlag(e.id, !flags[e.id])} />
          ))
        )}
      </div>
      <Adv label="Reset">
        <div className="row">
          <button className="btn" title="Delete rotated service logs" onClick={async () => {
            if (!hasBackend()) return flash("Needs the desktop app");
            try {
              const c = await ipc.clearCaches();
              flash(c.serviceLogs ? `Removed ${c.serviceLogs} rotated log${c.serviceLogs === 1 ? "" : "s"} (${Math.round(c.bytes / 1024)} KB)` : "Nothing to clear");
            } catch (e) { flash(errText(e)); }
          }}><Refresh size={11} />Clear caches</button>
          <span style={{ flex: 1 }} />
          {confirmReset ? (
            <>
              <button className="btn" onClick={() => setConfirmReset(false)}>Cancel</button>
              <button className="btn danger" onClick={async () => {
                setConfirmReset(false);
                if (!hasBackend()) return flash("Needs the desktop app");
                try { await ipc.resetSettings(); reload(); flash("Settings reset — repositories kept"); }
                catch (e) { flash(errText(e)); }
              }}>Yes, reset settings</button>
            </>
          ) : (
            <button className="btn danger" onClick={() => setConfirmReset(true)}>Reset all settings</button>
          )}
        </div>
        <p className="hint">
          Clearing caches removes rotated service logs only — never a worktree, database or settings file.
          Resetting restores defaults but keeps your registered repositories.
        </p>
      </Adv>
    </>
  );
}
