/* Launching agent + shell sessions, shared by the work surface and ⌘K.

   The logic is the agent lane's, lifted so both entry points behave
   identically: the handoff is written to .canopy/context.md first, then the
   agent runs as its OWN PTY with the prompt as its first argument. Running it
   as the session's command means the session ends — and the tab flips to
   "ended" — exactly when the agent exits.

   Every launch takes an explicit TARGET. Closing over "whatever is selected"
   was wrong in two ways: `select()` does not update this render's closure, so
   launching from an overview row created the session in the previously
   selected worktree; and a hook-held context snapshot went stale the moment
   the context editor saved. Both are avoided by resolving the repo, worktree,
   agent profile and context at call time. */
import { useCallback, useEffect, useState } from "react";
import { errText, hasBackend, ipc, type AgentCfg } from "../../ipc";
import { nextTermId, useStore } from "../../store";
import type { RepoNode, WorktreeNode } from "../../types";
import { ALL_CONTEXT, composeAgentPrompt, composeContextMd, readWtContext, runtimeFor, type ContextParts } from "../WorktreeContext";

const defaultAgent = (legacy: string): AgentCfg => ({
  id: "default",
  name: "Claude",
  command: legacy.trim() || "claude",
  promptOnLaunch: true,
  waitingPatterns: "",
});
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Where a launch should happen. Omitted fields fall back to the hook's
    defaults, which is what the work surface wants (it is always in-context). */
export interface LaunchTarget {
  repo?: RepoNode;
  wt?: WorktreeNode;
  profile?: AgentCfg;
}

export interface LaneLaunch {
  /** the default repo's configured launchers (never empty) */
  agents: AgentCfg[];
  startAgent: (target?: LaunchTarget) => Promise<void>;
  startShell: (target?: LaunchTarget) => void;
}

export function useLaneLaunch(defaultRepo: RepoNode, defaultWt: WorktreeNode): LaneLaunch {
  const showToast = useStore((s) => s.showToast);
  const openSession = useStore((s) => s.openSession);
  const settingsRev = useStore((s) => s.settingsRev);
  const [agents, setAgents] = useState<AgentCfg[]>([defaultAgent("")]);

  const profilesFor = useCallback(async (repoId: string): Promise<AgentCfg[]> => {
    if (!hasBackend()) return [defaultAgent("")];
    try {
      const settings = await ipc.getSettings();
      const configured = settings.repos.find((r) => r.id === repoId);
      const next = (configured?.agents ?? []).filter((a) => a.id.trim() && a.command.trim());
      return next.length ? next : [defaultAgent(configured?.agentCommand || "")];
    } catch {
      return [defaultAgent("")];
    }
  }, []);

  // the default repo's list, for any UI that wants to render the choices
  useEffect(() => {
    let alive = true;
    if (!defaultRepo.repoId) return;
    profilesFor(defaultRepo.repoId).then((a) => alive && setAgents(a));
    return () => {
      alive = false;
    };
  }, [defaultRepo.repoId, settingsRev, profilesFor]);

  /** "Claude", then "Claude 2", … — tab labels stay tellable apart at a glance.
      Reads live store state, not this render's snapshot, so two launches in the
      same tick can't both claim the unsuffixed name. */
  const uniqueTitle = useCallback((wtKey: string, base: string) => {
    const live = useStore.getState().sessions[wtKey] ?? [];
    const taken = new Set(live.map((s) => s.title));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }, []);

  const startAgent = useCallback(
    async (target?: LaunchTarget) => {
      const repo = target?.repo ?? defaultRepo;
      const wt = target?.wt ?? defaultWt;
      if (!wt.wtKey) return;

      const profile = target?.profile ?? (repo.repoId === defaultRepo.repoId ? agents[0] : (await profilesFor(repo.repoId))[0]);
      if (!profile) return;

      const id = nextTermId(wt.wtKey, "agent");
      const title = uniqueTitle(wt.wtKey, profile.name || "Agent");
      if (!hasBackend()) {
        openSession({ id, wtKey: wt.wtKey, kind: "agent", title, agentId: profile.id, command: "agent" });
        showToast(`${title} — ${repo.name} · ${wt.branch}`);
        return;
      }
      try {
        const settings = await ipc.getSettings().catch(() => null);
        const repoCfg = settings?.repos.find((r) => r.id === repo.repoId);

        // Concurrency: an agent is a real CLI doing real work, and several at
        // once on one machine compete for CPU and for the same dev database.
        // Counted across the repo, not the worktree — the machine is what's
        // shared. Refuse rather than queue: a launch that silently waits looks
        // like one that failed.
        const limit = repoCfg?.maxParallelAgents ?? 0;
        if (limit > 0) {
          const wtKeys = new Set(repo.worktrees.map((w) => w.wtKey));
          const live = Object.entries(useStore.getState().sessions)
            .filter(([k]) => wtKeys.has(k))
            .flatMap(([, ss]) => ss)
            .filter((s) => s.kind === "agent" && s.running).length;
          if (live >= limit) {
            showToast(`${live} of ${limit} agents already running in ${repo.name} — stop one first`);
            return;
          }
        }

        const runtime = runtimeFor(repo, wt);
        // read the PERSISTED context, so an edit made moments ago is included
        const ctx = readWtContext(wt.wtKey);
        const parts: ContextParts = repoCfg?.agentContext ?? ALL_CONTEXT;
        // The last error lines from this worktree's unhealthy services, only
        // when the repo opted in.
        const failing = parts.failingLogs
          ? wt.services
              .filter((s) => s.status === "error")
              .flatMap((s) => (useStore.getState().logs[s.svcKey] ?? []).filter((l) => l.lv === "err").slice(-10).map((l) => `${s.name}: ${l.text}`))
          : [];
        // Always write the handoff: even a blank brief includes the branch,
        // database and resolved ports the agent needs to work safely.
        await ipc.writeWorktreeContext(wt.path, composeContextMd(ctx, runtime, parts, failing));
        const prompt = composeAgentPrompt(ctx, runtime);
        // A profile can opt out for CLIs that do not accept an initial
        // positional prompt; those still get CANOPY_CONTEXT_FILE.
        const command = profile.promptOnLaunch ? `${profile.command} ${shellQuote(prompt)}` : profile.command;
        openSession({ id, wtKey: wt.wtKey, kind: "agent", title, agentId: profile.id, command });
        showToast(`${title} started — ${wt.branch}`);
      } catch (e) {
        showToast(`Agent start failed — ${errText(e)}`);
      }
    },
    [agents, defaultRepo, defaultWt, openSession, profilesFor, showToast, uniqueTitle],
  );

  const startShell = useCallback(
    (target?: LaunchTarget) => {
      const wt = target?.wt ?? defaultWt;
      if (!wt.wtKey) return;
      const id = nextTermId(wt.wtKey, "shell");
      openSession({ id, wtKey: wt.wtKey, kind: "shell", title: uniqueTitle(wt.wtKey, "Shell") });
    },
    [defaultWt, openSession, uniqueTitle],
  );

  return { agents, startAgent, startShell };
}
