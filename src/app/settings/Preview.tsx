// ⌘P — the repo's .worktreemanager.json as the save step would write it.
import { ChevRight, X } from "../../icons";
import type { SetupPolicy, SetupTask } from "../../ipc";
import { buildConfig, hlLine, type FileCardT } from "./provision";
import { Rot } from "./primitives";

export default function Preview({ cards, setup, extras, policy, mask, onClose }: { cards: FileCardT[]; setup: SetupTask[]; extras: { teardown: string[]; migrate: string[] }; policy: SetupPolicy; mask: boolean; onClose: () => void }) {
  const json = JSON.stringify(buildConfig(cards, setup, extras.teardown, extras.migrate, policy, mask), null, 2);
  const lines = json.split("\n");
  return (
    <div className="ppreview">
      <div className="pvhead">
        <button className="ib pvback" title="Back to the editor" onClick={onClose}><Rot deg={180}><ChevRight size={12} /></Rot></button>
        <b>Preview</b><span className="fn">.worktreemanager.json</span>
        <button className="ib" title="Close preview" onClick={onClose}><X size={12} /></button>
      </div>
      <div className="pvbody">
        {lines.map((ln, n) => (
          <div className="cl" key={n}><span className="ln">{n + 1}</span><span className="tx" dangerouslySetInnerHTML={{ __html: hlLine(ln) }} /></div>
        ))}
      </div>
    </div>
  );
}
