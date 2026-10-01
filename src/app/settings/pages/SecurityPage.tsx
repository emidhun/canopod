// Security — how secrets are handled in provisioned files and exports.
import { type SecurityCfg } from "../../../ipc";
import { TRow } from "../primitives";
import { DEFAULT_SECURITY } from "../provision";
import type { PageProps } from "../types";

export default function SecurityPage({ settings, patch, markDirty }: PageProps) {
  const sec = settings.security ?? DEFAULT_SECURITY;
  const set = (p: Partial<SecurityCfg>) => { patch({ security: { ...sec, ...p } }); markDirty("security"); };
  return (
    <>
      <div className="sec">
        <div className="slab">Secrets</div>
        <TRow
          title="Mask values that look like secrets"
          hint="Keys named …token, …secret, …password or …key render as •••• in the config preview. Template references like ${WT_DB_NAME} are never masked — they're the mechanism, not a secret."
          on={sec.maskSecrets}
          onToggle={() => set({ maskSecrets: !sec.maskSecrets })}
        />
        <TRow
          title="Keep secrets out of exports"
          hint="Copy JSON and Export write the key names with masked values. Off by default: an export is usually a file you commit, where the values are the point."
          on={sec.maskInExports}
          onToggle={() => set({ maskInExports: !sec.maskInExports })}
        />
        <p className="hint">Masking never changes what is saved to .worktreemanager.json — worktrees are always provisioned with the real values.</p>
      </div>
      <div className="sec">
        <div className="slab">Git credentials</div>
        <div className="fgrid">
          <span className="lb">SSH key</span>
          <input className="inp mono" value={sec.sshKey} placeholder="git's own default" onChange={(e) => set({ sshKey: e.target.value })} />
          <span className="lb">Credential helper</span>
          <input className="inp mono" value={sec.credentialHelper} placeholder="git's own default" onChange={(e) => set({ credentialHelper: e.target.value })} />
        </div>
        <p className="hint">
          Applied per git invocation — Canopy never edits your repo or global git config.
          A chosen SSH key is used with <span className="mono">IdentitiesOnly</span>, so ssh-agent can't offer a different one first.
        </p>
      </div>
    </>
  );
}
