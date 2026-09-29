/* Service detail — opened from a chip in the service rail.

   Carries what ServiceCard used to: the cpu/mem/uptime trio with a CPU
   sparkline, the port override (Esc reverts), and Restart / Stop. When the
   process died, the failure leads — red marks the problem, and the button
   that fixes it stays teal, because restarting is constructive. */
import { useEffect, useMemo, useState } from "react";
import { Alert, Info, Restart, Server, Stop } from "../../icons";
import { errText, hasBackend, ipc, type EnvEntry } from "../../ipc";
import { useStore } from "../../store";
import { fmtUptime, type ServiceNode, type WorktreeNode } from "../../types";
import Modal, { Hint, Spacer, usePrimaryAction } from "./Modal";

export default function ServiceDetailModal({
  wt,
  svcKey,
  onClose,
}: {
  wt: WorktreeNode;
  /** the KEY, not the node: a captured node would freeze at the status it had
      when the chip was clicked, so a process dying while this is open would
      never surface its failure or exit code */
  svcKey: string;
  onClose: () => void;
}) {
  const stats = useStore((s) => s.stats[svcKey]);
  const history = useStore((s) => s.cpuHistory[svcKey]);
  const exitCode = useStore((s) => s.exitCodes[svcKey]);
  const logs = useStore((s) => s.logs[svcKey]);
  const tree = useStore((s) => s.tree);
  const svc = useMemo<ServiceNode | null>(() => {
    for (const r of tree) for (const w of r.worktrees) for (const s of w.services) if (s.svcKey === svcKey) return s;
    return null;
  }, [tree, svcKey]);
  const restartService = useStore((s) => s.restartService);
  const stopService = useStore((s) => s.stopService);
  const showToast = useStore((s) => s.showToast);

  const opened = String(svc?.port ?? "");
  const [port, setPort] = useState(opened);
  const changed = port !== opened;
  /* The derived port — base + index*10 — is what Esc reverts to and what
     labels the field. Reverting to "the value the modal happened to open
     with" was never meaningful: if that value was itself an override, Esc
     restored the override instead of undoing it. */
  const derived = svc?.derivedPort != null ? String(svc.derivedPort) : null;
  const overridden = derived != null && port !== derived;

  const [env, setEnv] = useState<EnvEntry[] | null>(null);
  useEffect(() => {
    if (!hasBackend()) return;
    let alive = true;
    ipc
      .serviceEnv(svcKey)
      .then((e) => alive && setEnv(e))
      .catch(() => alive && setEnv([]));
    return () => {
      alive = false;
    };
  }, [svcKey]);

  /* Clash detection needs only the tree — every other worktree's ports are
     already known here, so this is real rather than a backend gap. */
  const clash = useMemo(() => {
    const n = Number(port);
    if (!n) return null;
    for (const r of tree)
      for (const w of r.worktrees)
        for (const s of w.services)
          if (s.svcKey !== svcKey && s.port === n) return `${w.branch} · ${s.name}`;
    return null;
  }, [port, tree, svcKey]);

  // set_service_port rejects anything outside 1024–65535 (commands.rs:861).
  // Only gate on the port when it actually changed — a portless service
  // (ServiceNode.port === null) must still be restartable.
  const portOk = /^\d+$/.test(port) && Number(port) >= 1024 && Number(port) <= 65535 && !clash;
  const valid = changed ? portOk : true;
  const crashed = svc?.status === "error";
  const tail = (logs ?? []).filter((l) => l.lv === "err").slice(-2);

  const max = Math.max(12, ...(history ?? [0]));

  const save = async () => {
    if (changed) {
      if (!hasBackend()) {
        showToast("Port changes need the desktop app");
        return;
      }
      try {
        await ipc.setServicePort(svcKey, Number(port));
        showToast(`${svc?.name} port → ${port}`);
      } catch (e) {
        showToast(errText(e));
        return;
      }
    } else {
      restartService(svcKey);
    }
    onClose();
  };

  // the ⏎ the Restart / Save-&-restart button advertises. The only field here
  // is the port, where committing on ⏎ is what you would expect anyway.
  usePrimaryAction("enter", valid, save);

  return (
    <Modal
      icon={Server}
      title={svc?.name ?? "Service"}
      sub={crashed ? `${wt.branch} · exited${exitCode != null ? ` with code ${exitCode}` : ""}` : `${wt.branch} · ${svc?.status ?? "gone"}`}
      onClose={onClose}
      foot={
        <>
          <Hint icon={Info}>{changed ? "Saves the port, then restarts" : "Port is derived from the worktree index"}</Hint>
          <Spacer />
          <button className="cx-btn cx-btn--ghost" onClick={onClose}>
            Close
          </button>
          <button className="cx-btn cx-btn--primary" onClick={save} disabled={!valid}>
            <Restart size={12} />
            {changed ? "Save & restart" : "Restart"}
            <span className="cx-k">⏎</span>
          </button>
        </>
      }
    >
      {crashed && (
        <div className="cx-alert cx-alert--error">
          <span className="cx-alert__ic">
            <Alert size={13} />
          </span>
          <div>
            <b>Exited{exitCode != null ? ` with code ${exitCode}` : ""}.</b>
            {tail.length > 0 && <pre>{tail.map((l) => l.text).join("\n")}</pre>}
          </div>
        </div>
      )}

      <div className="cxm-fld">
        <div className="cxm-flab">{crashed ? "Last samples before exit" : "Now"}</div>
        <div className="cxm-mrow">
          {history && history.length > 0 && (
            <div className="cx-spark" title="recent CPU">
              {history.map((v, i) => (
                <i key={i} style={{ height: Math.max(2, Math.round((v / max) * 14)) }} />
              ))}
            </div>
          )}
          <div className="cxm-met">
            <span className="v">{stats ? `${stats.cpu.toFixed(1)}%` : "—"}</span>
            <span className="k">cpu</span>
          </div>
          <div className="cxm-met">
            <span className="v">{stats ? `${Math.round(stats.memMb)} MB` : "—"}</span>
            <span className="k">mem</span>
          </div>
          <div className="cxm-met">
            <span className="v">{fmtUptime(stats?.uptimeSec)}</span>
            <span className="k">uptime</span>
          </div>
          <Spacer />
          {svc?.status === "running" && (
            <button
              className="cx-btn cx-btn--sm"
              onClick={() => {
                stopService(svcKey);
                onClose();
              }}
            >
              <Stop size={10} />
              Stop
            </button>
          )}
        </div>
      </div>

      <div className="cxm-fld">
        <div className="cxm-flab cxm-flab--f">
          <Server size={11} />
          Port
        </div>
        <input
          className="cx-input cx-input--mono"
          value={port}
          spellCheck={false}
          onChange={(e) => setPort(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setPort(derived ?? opened);
            }
          }}
        />
        {clash ? (
          <div className="cxm-fhint cxm-fhint--bad">Port {port} is already used by {clash}.</div>
        ) : changed && !portOk ? (
          <div className="cxm-fhint cxm-fhint--bad">Port must be between 1024 and 65535.</div>
        ) : overridden ? (
          <div className="cxm-fhint cxm-fhint--warn">Overrides the derived port. Esc reverts to {derived}.</div>
        ) : (
          <div className="cxm-fhint">
            Derived: base port + index × 10{derived ? ` = ${derived}` : ""}. Change it only if something else holds the port.
          </div>
        )}
      </div>

      {env !== null && env.length > 0 && (
        <div className="cxm-fld">
          <div className="cxm-flab">Environment</div>
          <dl className="cx-kv cx-kv--env">
            {env.map((e) => (
              <span className="cx-kv__row" key={`${e.source}:${e.key}`}>
                <dt title={e.source === "spawn" ? "Set by Canopy when the process starts" : "Read from a provisioned .env"}>{e.key}</dt>
                <dd className={e.masked ? "cx-kv__masked" : undefined} title={e.masked ? "Value withheld — it looks like a credential" : e.value}>
                  {e.value || <em>empty</em>}
                </dd>
              </span>
            ))}
          </dl>
        </div>
      )}

    </Modal>
  );
}
