// General — appearance and launch behaviour.
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { hasBackend, ipc, type UpdateStatus } from "../../../ipc";
import { getAppearance, setAppearance, type Accent, type Density, type Theme } from "../../../appearance";
import { TRow } from "../primitives";
import type { PageProps } from "../types";

export const ACCENT_SWATCHES: { id: Accent; name: string; color: string }[] = [
  { id: "teal", name: "Teal", color: "var(--swatch-teal)" },
  { id: "green", name: "Green", color: "var(--swatch-green)" },
  { id: "amber", name: "Amber", color: "var(--swatch-amber)" },
  { id: "violet", name: "Violet", color: "var(--swatch-violet)" },
];


export default function GeneralPage({ settings, patch, markDirty }: PageProps) {
  // Appearance applies live and persists to localStorage (not the Settings save
  // step); mirror it here and re-read when another window changes it.
  const [appr, setAppr] = useState(getAppearance());
  const change = (p: Partial<{ theme: Theme; density: Density; accent: Accent }>) => setAppr(setAppearance(p));
  useEffect(() => {
    const h = () => setAppr(getAppearance());
    window.addEventListener("canopy:appearance", h);
    return () => window.removeEventListener("canopy:appearance", h);
  }, []);
  return (
    <>
      <div className="sec">
        <div className="slab">Editor</div>
        <div className="fgrid">
          <span className="lb">Command</span>
          <div className="row"><input className="inp mono gr" value={settings.editor.command} placeholder="code" onChange={(e) => { patch({ editor: { command: e.target.value } }); markDirty("general"); }} />
            <span className="hint" style={{ marginTop: 0 }}>Used for “Open in editor”.</span></div>
        </div>
      </div>
      <div className="sec">
        <div className="slab">Behaviour</div>
        <TRow title="Show the Switch-branch action" hint="Offer “Switch branch…” in the worktree menu and ⌘\." on={settings.showSwitchBranch !== false} onToggle={() => { patch({ showSwitchBranch: !(settings.showSwitchBranch !== false) }); markDirty("general"); }} />
      </div>
      <div className="sec">
        <div className="slab">Appearance<span className="n">applied instantly, saved on this machine</span></div>
        <div className="fgrid">
          <span className="lb">Theme</span>
          <select className="inp" value={appr.theme} onChange={(e) => change({ theme: e.target.value as Theme })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">Match system</option>
          </select>
          <span className="lb">Density</span>
          <select className="inp" value={appr.density} onChange={(e) => change({ density: e.target.value as Density })}>
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
          <span className="lb">Accent</span>
          <div className="row">{ACCENT_SWATCHES.map((a) => (
            <button key={a.id} className="ico" title={a.name} aria-pressed={appr.accent === a.id} onClick={() => change({ accent: a.id })}
              style={{ background: a.color, borderColor: appr.accent === a.id ? "var(--text-primary)" : "transparent", width: 22, height: 22 }} />))}</div>
        </div>
      </div>
      <UpdatesSection settings={settings} patch={patch} markDirty={markDirty} />
    </>
  );
}

/* Updates + crash reports.

   Canopy checks whether a newer release exists and links to it; it does not
   download or install. That needs signed release bundles, which this project
   does not produce yet — an updater that silently fails every launch would be
   worse than an honest link. Crash reports are written to the log directory
   and never transmitted, because there is nowhere to transmit them to. */
function UpdatesSection({ settings, patch, markDirty }: Pick<PageProps, "settings" | "patch" | "markDirty">) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [crashes, setCrashes] = useState(0);

  useEffect(() => {
    if (!hasBackend()) return;
    ipc.crashReportCount().then(setCrashes).catch(() => {});
  }, [settings.crashReports?.enabled]);

  const check = async () => {
    if (!hasBackend()) return;
    setChecking(true);
    try {
      setStatus(await ipc.checkForUpdate());
    } catch {
      /* the command reports its own failure in `error`; a rejection here means
         the backend is gone, and there is nothing useful to say about that */
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="sec">
      <div className="slab">Updates &amp; diagnostics</div>
      <TRow
        title="Check for updates automatically"
        hint="Asks GitHub twice a day whether a newer release exists. Nothing is downloaded or installed."
        on={settings.updates?.autoCheck === true}
        onToggle={() => { patch({ updates: { autoCheck: !(settings.updates?.autoCheck === true) } }); markDirty("general"); }}
      />
      <div className="row" style={{ marginTop: 8, alignItems: "center", gap: 10 }}>
        <button className="btn" onClick={check} disabled={checking || !hasBackend()}>
          {checking ? "Checking…" : "Check now"}
        </button>
        <span className="hint" style={{ marginTop: 0 }}>
          {!status
            ? `You're on ${hasBackend() ? "this build" : "a dev build"}.`
            : status.error
              ? status.error
              : status.available
                ? `${status.latest} is available — you have ${status.current}.`
                : `Up to date (${status.current}).`}
        </span>
        {status?.available && status.url && (
          <button className="btn" onClick={() => openUrl(status.url as string).catch(() => {})}>
            Open release
          </button>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <TRow
          title="Record crash reports"
          hint="Writes a stack trace to the log folder if Canopy crashes. Stack traces only, and nothing is sent anywhere."
          on={!!settings.crashReports?.enabled}
          onToggle={() => { patch({ crashReports: { enabled: !settings.crashReports?.enabled } }); markDirty("general"); }}
        />
        {crashes > 0 && (
          <div className="row" style={{ marginTop: 8, alignItems: "center", gap: 10 }}>
            <button className="btn" onClick={() => ipc.openCrashReports().catch(() => {})}>
              Show {crashes} report{crashes === 1 ? "" : "s"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
