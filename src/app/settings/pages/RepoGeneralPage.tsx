// Repository — where this repo lives and what new worktrees start with.
import { useState } from "react";
import Modal, { Hint, Spacer } from "../../canopy/Modal";
import { Download, Finder, Pull, Trash } from "../../../icons";
import { TRow, Adv } from "../primitives";
import { errText, hasBackend, ipc, type WorktreeDefaults } from "../../../ipc";
import { DEFAULT_WT_DEFAULTS } from "../provision";
import type { PageProps } from "../types";

export default function RepoGeneralPage({ repo, patchRepo, markDirty, flash, onRemoveRepo, onExportJson, onImportJson }: PageProps) {
  const [confirm, setConfirm] = useState(false);
  if (!repo) return null;
  const wd = repo.worktreeDefaults ?? DEFAULT_WT_DEFAULTS;
  const setWd = (p: Partial<WorktreeDefaults>) => { patchRepo({ worktreeDefaults: { ...wd, ...p } }); markDirty("repo-general"); };
  return (
    <>
      <div className="sec">
        <div className="slab">Repository</div>
        <div className="fgrid">
          <span className="lb">Name</span><input className="inp" value={repo.name} onChange={(e) => { patchRepo({ name: e.target.value }); markDirty("repo-general"); }} />
          <span className="lb">Path</span>
          <div className="row"><input className="inp mono gr" value={repo.path} readOnly />
            <button className="ico" title="Reveal in Finder" onClick={() => { if (!hasBackend()) return flash("Needs the desktop app"); ipc.revealRepo(repo.id).catch((e) => flash(errText(e))); }}><Finder size={12} /></button></div>
          <span className="lb">Worktree root</span><input className="inp mono" value={repo.worktreeDir} placeholder=".worktrees" onChange={(e) => { patchRepo({ worktreeDir: e.target.value }); markDirty("repo-general"); }} />
          <span className="lb">Default base</span>
          <input className="inp mono" value={repo.defaultBase} placeholder="main" onChange={(e) => { patchRepo({ defaultBase: e.target.value }); markDirty("repo-general"); }} />
        </div>
      </div>
      <div className="sec">
        <div className="slab">Defaults for new worktrees</div>
        <TRow title="Run setup automatically" hint="Provision files and run setup tasks as soon as the worktree is created. Off leaves it unprovisioned until you press Run setup."
          on={wd.runSetup} onToggle={() => setWd({ runSetup: !wd.runSetup })} />
        <TRow title="Start services after setup" hint="Boot the service list once provisioning finishes. Ignored when setup is skipped — a service started against an unprovisioned worktree just crashes."
          on={wd.startServices} onToggle={() => setWd({ startServices: !wd.startServices })} />
        <TRow title="Create an isolated database" hint="Gives the worktree its own database name from the branch slug. Off points ${WT_DB_NAME} at the main checkout's PG_DB, so worktrees share one database."
          on={wd.isolatedDatabase} onToggle={() => setWd({ isolatedDatabase: !wd.isolatedDatabase })} />
      </div>
      <div className="sec">
        <div className="slab">Configuration file</div>
        <div className="row">
          <button className="btn" title="Export .worktreemanager.json" onClick={onExportJson}><Download size={11} />Export config</button>
          <button className="btn" title="Import a .worktreemanager.json" onClick={onImportJson}><Pull size={11} />Import config</button>
          <span className="hint" style={{ marginTop: 0 }}>Import replaces this repo's provisioned files and setup — review, then Save.</span>
        </div>
      </div>
      <Adv label="Danger zone">
        <div className="row">
          <button className="btn danger" onClick={() => setConfirm(true)}><Trash size={11} />Remove repository</button>
          <span className="hint" style={{ marginTop: 0 }}>Stops tracking {repo.name} in Canopy. Your files are untouched.</span>
        </div>
      </Adv>
      {confirm && (
        <Modal
          danger
          icon={Trash}
          title="Remove repository"
          sub={repo.name}
          onClose={() => setConfirm(false)}
          foot={
            <>
              <Hint>You can add it again anytime.</Hint>
              <Spacer />
              <button className="cx-btn cx-btn--ghost" onClick={() => setConfirm(false)}>Cancel</button>
              <button className="cx-btn cx-btn--danger" onClick={() => { setConfirm(false); onRemoveRepo(); }}>
                <Trash size={12} />Remove repository
              </button>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: "var(--fs-body)", lineHeight: 1.55, color: "var(--text-secondary)" }}>
            Canopy will stop tracking <b style={{ color: "var(--text-primary)" }}>{repo.name}</b> and remove its
            configuration here — its services, custom commands and agents.
          </p>
          <p style={{ margin: "10px 0 0", fontSize: "var(--fs-small)", lineHeight: 1.55, color: "var(--text-tertiary)" }}>
            The repository, its worktrees and its <span style={{ fontFamily: "var(--mono)" }}>.worktreemanager.json</span>{" "}
            (provisioned files and setup) on disk are not touched.
          </p>
        </Modal>
      )}
    </>
  );
}
