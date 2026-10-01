/* The Canopy workspace shell.

   Owns the view (worktree vs overview), layout presets, keyboard bindings, and
   the one runner that turns a NextAction into work. Everything that offers
   "the next thing" routes through `runNext`, so the worktree bar's button,
   ⌘K's Suggested row, ⏎, and the overview's row action stay in lockstep. */
import { useEffect, useMemo, useRef, useState } from "react";
import { errText, hasBackend, ipc, type PrunableWorktree } from "../ipc";
import { initSync, useStore } from "../store";
import type { RepoNode, WorktreeNode } from "../types";
import { Plus } from "../icons";
import { attentionItems, nextAction, type AttnItem, type NextAction } from "./nextAction";
import { actionFor, resolveBindings } from "./keys";
import { TopBar, AttentionPop } from "./canopy/TopBar";
import SidebarNav from "./canopy/SidebarNav";
import WorktreeView from "./canopy/WorktreeView";
import Overview from "./canopy/Overview";
import Palette from "./canopy/Palette";
import StatusBar from "./canopy/StatusBar";
import { LAYOUT_ORDER, LAYOUTS, panesOf, type LayoutId, type PaneKind } from "./canopy/WorkSurface";
import { useLaneLaunch } from "./canopy/laneLaunch";
import DatabaseModal from "./canopy/DatabaseModal";
import NoticeModal from "./canopy/NoticeModal";
import SetupRunnerModal from "./canopy/SetupRunnerModal";
import ServiceDetailModal from "./canopy/ServiceDetailModal";
import ContextModal from "./canopy/ContextModal";
import SettingsView from "./settings/SettingsView";
import NewWorktreeModal from "./NewWorktreeModal";
import RemoveWorktreeModal from "./RemoveWorktreeModal";
import RemoveWorktreesModal from "./RemoveWorktreesModal";
import PruneWorktreesModal from "./PruneWorktreesModal";
import SwitchBranchModal from "./SwitchBranchModal";
import UncommittedChangesModal from "./UncommittedChangesModal";
import Onboarding from "../onboarding/Onboarding";
import { nudgeFontScale, resetFontScale } from "../appearance";

export default function App() {
  const tree = useStore((s) => s.tree);
  const selKey = useStore((s) => s.selKey);
  const select = useStore((s) => s.select);
  const sessions = useStore((s) => s.sessions);
  const toast = useStore((s) => s.toast);
  const showToast = useStore((s) => s.showToast);
  const primeLogs = useStore((s) => s.primeLogs);
  const addRepo = useStore((s) => s.addRepo);
  const addRepoOpen = useStore((s) => s.addRepoOpen);
  const closeAddRepo = useStore((s) => s.closeAddRepo);
  const startAll = useStore((s) => s.startAll);
  const startService = useStore((s) => s.startService);
  const restartService = useStore((s) => s.restartService);
  const gitPull = useStore((s) => s.gitPull);
  const openPort = useStore((s) => s.openPort);
  const openWorktree = useStore((s) => s.openWorktree);
  const setActiveTerm = useStore((s) => s.setActiveTerm);
  const notices = useStore((s) => s.notices);
  const dismissNotice = useStore((s) => s.dismissNotice);
  const syncSubmodules = useStore((s) => s.syncSubmodules);
  const bumpSettings = useStore((s) => s.bumpSettings);
  const switchBranchEnabled = useStore((s) => s.showSwitchBranch);

  const [view, setView] = useState<"wt" | "overview">("wt");
  // the pane set is the state; a preset is just a named one, so a hand-made
  // combination is as valid as ⌘1–⌘5 and the status bar simply calls it Custom
  const [panes, setPanes] = useState<PaneKind[]>(() => panesOf("runtime"));
  const setLayout = (l: LayoutId) => setPanes(panesOf(l));
  const [sideHidden, setSideHidden] = useState(false);
  const [palette, setPalette] = useState(false);
  const [attnOpen, setAttnOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewWt, setShowNewWt] = useState(false);
  const [showSwitchBranch, setShowSwitchBranch] = useState(false);
  const [showDirty, setShowDirty] = useState(false);
  const [showDb, setShowDb] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  /* A setup run handed over by the create dialog. Kept separate from
     `showSetup` because the worktree is not in the tree yet — the backend
     rescans only once setup has finished — so there is no `sel` to render
     from, only the key the run is emitting under. */
  const [setupFor, setSetupFor] = useState<{ wtKey: string; branch: string } | null>(null);
  const [showCtx, setShowCtx] = useState(false);
  const [svcDetail, setSvcDetail] = useState<string | null>(null);
  const [removeWtFor, setRemoveWtFor] = useState<WorktreeNode | null>(null);
  const [removeWtsFor, setRemoveWtsFor] = useState<WorktreeNode[] | null>(null);
  const [pruneFor, setPruneFor] = useState<(PrunableWorktree & { dbName: string | null })[] | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [obDismissed, setObDismissed] = useState(false);
  const [noticeId, setNoticeId] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const attnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => initSync(), []);
  // uptime / relative-time re-render
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const sel = useMemo<{ repo: RepoNode; wt: WorktreeNode } | null>(() => {
    for (const r of tree) for (const w of r.worktrees) if (w.wtKey === selKey) return { repo: r, wt: w };
    const r = tree[0];
    return r?.worktrees[0] ? { repo: r, wt: r.worktrees[0] } : null;
  }, [tree, selKey]);

  // the logs pane merges every service's buffer, so prime them all on switch
  useEffect(() => {
    if (sel) primeLogs(sel.wt.wtKey);
  }, [sel?.wt.wtKey, primeLogs]);

  const attn = useMemo<AttnItem[]>(() => attentionItems(tree, sessions, notices), [tree, sessions, notices]);
  const notice = useMemo(() => notices.find((n) => n.id === noticeId) ?? null, [notices, noticeId]);
  const na = useMemo<NextAction | null>(
    () => (sel ? nextAction(sel.wt, sessions[sel.wt.wtKey] ?? []) : null),
    [sel, sessions],
  );

  const running = tree.reduce(
    (n, r) => n + r.worktrees.reduce((m, w) => m + w.services.filter((s) => s.status === "running").length, 0),
    0,
  );
  const agentCount = Object.values(sessions)
    .flat()
    .filter((s) => s.kind === "agent" && s.running).length;

  const launch = useLaneLaunch(sel?.repo ?? EMPTY_REPO, sel?.wt ?? EMPTY_WT);

  /** Resolve a launch target by key. `select()` does not update this render's
      closure, so anything launching for a worktree other than the currently
      selected one has to say which one explicitly. */
  const targetFor = (wtKey: string) => {
    for (const r of tree) for (const w of r.worktrees) if (w.wtKey === wtKey) return { repo: r, wt: w };
    return undefined;
  };

  /* ── the one action ───────────────────────────────────────────────
     Every surface that offers "the next thing" calls this. */
  const runNext = (action?: NextAction | null, forKey?: string) => {
    const key = forKey ?? sel?.wt.wtKey;
    if (!key) return;
    const target = tree.flatMap((r) => r.worktrees).find((w) => w.wtKey === key);
    if (!target) return;
    const a = action ?? nextAction(target, sessions[key] ?? []);

    switch (a.id) {
      case "restart":
        if (a.svcKey) restartService(a.svcKey);
        break;
      case "answer":
      case "watch":
        select(key);
        setView("wt");
        setLayout("agent");
        if (a.sessionId) setActiveTerm(key, a.sessionId);
        break;
      case "setup":
        select(key);
        setView("wt");
        setShowSetup(true);
        break;
      case "starting":
        break; // busy — acting again would double-start
      case "pull":
        gitPull(key);
        break;
      case "start":
        startAll(key);
        break;
      case "startrest":
        if (a.svcKey) startService(a.svcKey);
        else startAll(key);
        break;
      case "review":
        openWorktree(key, "editor");
        break;
      case "open":
        if (a.port) openPort(a.port);
        break;
      case "agent":
        select(key);
        setView("wt");
        setLayout("agent");
        launch.startAgent(targetFor(key));
        break;
    }
  };

  const goto = (wtKey: string, want?: "terminal") => {
    select(wtKey);
    setView("wt");
    if (want === "terminal") {
      setLayout("shell");
      launch.startShell(targetFor(wtKey));
    }
  };

  const openTerminalFor = (wtKey: string) => {
    select(wtKey);
    setView("wt");
    setLayout("shell");
    // open one only if that worktree has none — naming the target means this
    // works for any worktree, not just the one already selected
    if ((sessions[wtKey] ?? []).every((s) => s.kind !== "shell")) launch.startShell(targetFor(wtKey));
  };

  // Sync = rescan + reconcile worktrees deleted on disk. We snapshot the tree
  // BEFORE refreshing, because a vanished worktree's db name lives in its (now
  // gone) .env — the snapshot is the only place we still know it.
  const sync = async () => {
    if (!hasBackend()) {
      showToast("Sync needs the desktop app");
      return;
    }
    showToast("Syncing worktrees…");
    const known = new Map(tree.flatMap((r) => r.worktrees.map((w) => [w.wtKey, w.dbName] as const)));
    try {
      await ipc.refresh();
      // Sync also reconciles Settings with what's on disk: a repo's
      // `.worktreemanager.json` (setup tasks, provisioned files, migrate) may
      // have changed outside the app, so signal open views to re-read it.
      bumpSettings();
      const prunable = await ipc.listPrunableWorktrees();
      if (prunable.length > 0) {
        setPruneFor(prunable.map((p) => ({ ...p, dbName: known.get(p.path) ?? null })));
      }
    } catch (e) {
      showToast(`Sync failed — ${errText(e)}`);
    }
  };

  // declared before the keyboard handler, which stands down for it on ⌘N
  const onboardingActive = showOnboarding || addRepoOpen || (tree.length === 0 && !obDismissed);

  

  // Effective bindings: registry defaults with the user's overrides applied.
  // Re-read whenever settings are saved, so a remap takes effect immediately
  // rather than on the next launch.
  const [bindings, setBindings] = useState<Record<string, string>>(() => resolveBindings(null));
  const settingsRev = useStore((s) => s.settingsRev);
  useEffect(() => {
    if (!hasBackend()) return;
    let alive = true;
    ipc
      .getSettings()
      .then((st) => alive && setBindings(resolveBindings(st)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [settingsRev]);

  /* ── keyboard: the whole app is reachable without the mouse ───────
     Dispatch is table-driven off the registry, so every shortcut is
     remappable and the Shortcuts page can never drift from what actually
     fires — both read the same source. */

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = /^(INPUT|TEXTAREA)$/.test(el?.tagName ?? "") || (el as HTMLElement | null)?.isContentEditable === true;
      const action = actionFor(e, bindings);

      // Escape is fixed and always wins: a remap that stole it would leave
      // modals and the palette with no keyboard dismissal at all.
      if (e.key === "Escape") {
        setPalette(false);
        setAttnOpen(false);
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      // ⌘+ / ⌘- / ⌘0 — app-wide text zoom. Deliberately OUTSIDE the registry
      // dispatch: it must work from anywhere, even in a field or with the
      // palette open, because it never collides with text entry.
      if (meta && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        nudgeFontScale(1);
        return;
      }
      if (meta && (e.key === "-" || e.key === "_")) {
        e.preventDefault();
        nudgeFontScale(-1);
        return;
      }
      if (meta && e.key === "0") {
        e.preventDefault();
        resetFontScale();
        return;
      }

      /* A dialog owns the keyboard while it is up. The scrim is the reliable
         signal: every dialog renders exactly one, wherever it was mounted. */
      const dialogOpen = !!document.querySelector(".cx-scrim");
      if (!action) return;
      // The palette owns the keyboard while open, except for its own toggle.
      if (palette && action !== "palette") return;

      switch (action) {
        case "palette":
          e.preventDefault();
          setPalette((p) => !p);
          break;
        case "new-worktree":
          // Onboarding binds this itself, and stacking a dialog behind an open
          // one leaves two scrims with no way to tell which has focus.
          e.preventDefault();
          if (!onboardingActive && !dialogOpen) setShowNewWt(true);
          break;
        case "settings":
          e.preventDefault();
          if (!dialogOpen) setShowSettings(true);
          break;
        case "add-repo":
          e.preventDefault();
          addRepo();
          break;
        case "sync-submodules":
          e.preventDefault();
          if (sel) syncSubmodules(sel.wt.wtKey);
          break;
        case "toggle-sidebar":
          e.preventDefault();
          setSideHidden((s) => !s);
          break;
        case "overview":
          e.preventDefault();
          setView((v) => (v === "overview" ? "wt" : "overview"));
          break;
        case "switch-branch":
          e.preventDefault();
          // Settings can turn the action off; the shortcut has to obey, or the
          // toggle only hides the button and the feature is still one key away.
          if (sel && switchBranchEnabled) setShowSwitchBranch(true);
          break;
        case "run-next":
          // ⏎ must never fire while a terminal or a field has focus
          if (typing || view !== "wt" || !na || na.kind === "busy") return;
          e.preventDefault();
          runNext(na);
          break;
        default:
          if (action.startsWith("layout-")) {
            const n = Number(action.slice("layout-".length));
            if (n >= 1 && n <= LAYOUT_ORDER.length) {
              e.preventDefault();
              setLayout(LAYOUT_ORDER[n - 1]);
            }
          }

      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  });

  /* commands from the menu-bar tray (a separate webview): it shows this window,
     then emits — we open the matching surface here. */
  useEffect(() => {
    if (!hasBackend()) return;
    const unlisten: Array<() => void> = [];
    let dead = false;
    const track = (p: Promise<() => void>) => p.then((u) => (dead ? u() : unlisten.push(u)));
    import("@tauri-apps/api/event").then(({ listen }) => {
      track(listen("tray:new-worktree", () => setShowNewWt(true)));
      track(listen("tray:overview", () => setView("overview")));
      track(listen("tray:settings", () => setShowSettings(true)));
    });
    return () => {
      dead = true;
      unlisten.forEach((u) => u());
    };
  }, []);

  const worktreeCount = tree.reduce((n, r) => n + r.worktrees.length, 0);

  return (
    <div className="cxs-shell">
      <TopBar
        repo={sel?.repo ?? null}
        wt={view === "overview" ? null : (sel?.wt ?? null)}
        attn={attn}
        running={running}
        agents={agentCount}
        onPalette={() => setPalette(true)}
        onAttn={() => setAttnOpen((a) => !a)}
        onOverview={() => setView("overview")}
        onRefresh={sync}
        onSettings={() => setShowSettings(true)}
        attnRef={attnRef}
      />

      <div className="cxs-body">
        <SidebarNav
          hidden={sideHidden}
          view={view}
          selKey={sel?.wt.wtKey ?? null}
          attn={attn}
          onSelect={(k) => goto(k)}
          onOverview={() => setView("overview")}
          onToggle={() => setSideHidden((s) => !s)}
          onNew={() => setShowNewWt(true)}
          onOpenTerminal={openTerminalFor}
          onRemoveMany={(keys) => setRemoveWtsFor(tree.flatMap((r) => r.worktrees).filter((w) => keys.includes(w.wtKey)))}
        />

        {showSettings ? (
          <SettingsView onClose={() => setShowSettings(false)} />
        ) : view === "overview" ? (
          <Overview
            attn={attn}
            onSelect={(k) => goto(k)}
            onOpenTerminal={openTerminalFor}
            onRunNext={(k) => runNext(null, k)}
            sideHidden={sideHidden}
            onShowSide={() => setSideHidden(false)}
          />
        ) : !sel ? (
          <div className="cxs-main">
            <div className="cxs-empty">
              <span className="eic">
                <Plus size={17} />
              </span>
              <span className="et">No repositories yet</span>
              <span className="es">Add a repository and Canopy will track every worktree in it.</span>
              <button className="cx-next" onClick={() => setShowOnboarding(true)} style={{ marginTop: 3 }}>
                <Plus size={12} />
                Add your first repository
              </button>
            </div>
          </div>
        ) : (
          na && (
            <WorktreeView
              wt={sel.wt}
              na={na}
              onNext={() => runNext(na)}
              panes={panes}
              setPanes={setPanes}
              launch={launch}
              sideHidden={sideHidden}
              onShowSide={() => setSideHidden(false)}
              onRemove={() => setRemoveWtFor(sel.wt)}
              onDatabase={() => setShowDb(true)}
              onSetup={() => setShowSetup(true)}
              onOpenService={(s) => setSvcDetail(s.svcKey)}
              onEditContext={() => setShowCtx(true)}
              onSwitchBranch={switchBranchEnabled ? () => setShowSwitchBranch(true) : undefined}
            />
          )
        )}
      </div>

      <StatusBar
        wt={showSettings ? null : (sel?.wt ?? null)}
        view={showSettings ? "overview" : view}
        attn={attn}
        panes={panes}
        onCycleLayout={() => {
          const at = LAYOUT_ORDER.findIndex((l) => LAYOUTS[l].panes.join() === panes.join());
          setLayout(LAYOUT_ORDER[(at + 1) % LAYOUT_ORDER.length]);
        }}
        onAttn={() => setAttnOpen((a) => !a)}
        onSwitchBranch={switchBranchEnabled ? () => setShowSwitchBranch(true) : undefined}
        onDirty={() => setShowDirty(true)}
        worktreeCount={worktreeCount}
        repoCount={tree.length}
      />

      {attnOpen && (
        <AttentionPop
          anchor={attnRef}
          items={attn}
          onClose={() => setAttnOpen(false)}
          onDismiss={(a) => a.noticeId && dismissNotice(a.noticeId)}
          onPick={(a) => {
            setAttnOpen(false);
            // A failure notice is the detail, not a destination — the worktree
            // it names may not even exist. Completions just clear.
            if (a.noticeId && a.kind === "error") {
              setNoticeId(a.noticeId);
              return;
            }
            if (a.noticeId) {
              dismissNotice(a.noticeId);
              if (tree.some((r) => r.worktrees.some((w) => w.wtKey === a.wtKey))) goto(a.wtKey);
              return;
            }
            goto(a.wtKey);
            if (a.kind === "wait") setLayout("agent");
          }}
        />
      )}

      {palette && (
        <Palette
          selKey={sel?.wt.wtKey ?? null}
          attn={attn}
          onClose={() => setPalette(false)}
          onSelect={(k) => goto(k)}
          onOverview={() => setView("overview")}
          onAction={(a) => runNext(a)}
          onRunFor={(k) => runNext(null, k)}
          onLayout={(l) => {
            setLayout(l);
            setView("wt");
          }}
          onNewWorktree={() => setShowNewWt(true)}
          onSettings={() => setShowSettings(true)}
          onOpenTerminal={() => sel && openTerminalFor(sel.wt.wtKey)}
          onStartAgent={() => {
            setView("wt");
            setLayout("agent");
            launch.startAgent(sel ? { repo: sel.repo, wt: sel.wt } : undefined);
          }}
        />
      )}

      {showDb && sel && <DatabaseModal wt={sel.wt} onClose={() => setShowDb(false)} />}
      {showSetup && sel && (
        <SetupRunnerModal
          wtKey={sel.wt.wtKey}
          branch={sel.wt.branch}
          onClose={() => setShowSetup(false)}
          onStartServices={() => startAll(sel.wt.wtKey)}
        />
      )}
      {setupFor && (
        <SetupRunnerModal
          wtKey={setupFor.wtKey}
          branch={setupFor.branch}
          onClose={() => setSetupFor(null)}
          onStartServices={() => startAll(setupFor.wtKey)}
        />
      )}
      {svcDetail && sel && <ServiceDetailModal wt={sel.wt} svcKey={svcDetail} onClose={() => setSvcDetail(null)} />}
      {showCtx && sel && (
        <ContextModal
          repo={sel.repo}
          wt={sel.wt}
          onClose={() => setShowCtx(false)}
          onStartAgent={() => {
            setView("wt");
            setLayout("agent");
            launch.startAgent(sel ? { repo: sel.repo, wt: sel.wt } : undefined);
          }}
        />
      )}
      {showNewWt && (
        <NewWorktreeModal
          repoId={sel?.repo.repoId ?? ""}
          onClose={() => setShowNewWt(false)}
          onSetupStarted={(wtKey, branch) => setSetupFor({ wtKey, branch })}
        />
      )}
      {removeWtFor && <RemoveWorktreeModal wt={removeWtFor} onClose={() => setRemoveWtFor(null)} />}
      {removeWtsFor && removeWtsFor.length > 0 && (
        <RemoveWorktreesModal wts={removeWtsFor} onClose={() => setRemoveWtsFor(null)} />
      )}
      {pruneFor && pruneFor.length > 0 && <PruneWorktreesModal items={pruneFor} onClose={() => setPruneFor(null)} />}
      {showSwitchBranch && sel && (
        <SwitchBranchModal repo={sel.repo} wt={sel.wt} onClose={() => setShowSwitchBranch(false)} />
      )}
      {showDirty && sel && <UncommittedChangesModal wt={sel.wt} onClose={() => setShowDirty(false)} />}
      {notice && <NoticeModal notice={notice} onClose={() => setNoticeId(null)} />}
      {onboardingActive && (
        <Onboarding
          initialView={addRepoOpen ? "add" : "empty"}
          onClose={() => {
            setShowOnboarding(false);
            closeAddRepo();
            setObDismissed(true);
          }}
          onCreateWorktree={() => setShowNewWt(true)}
        />
      )}
      {toast && <div className="cx-toast">{toast}</div>}
    </div>
  );
}

/* Stable placeholders so the launch hook keeps a consistent identity while the
   tree is still loading — it reads repo/worktree lazily inside its callbacks. */
const EMPTY_REPO: RepoNode = { repoId: "", name: "", path: "", worktrees: [] };
const EMPTY_WT: WorktreeNode = {
  wtKey: "",
  branch: "",
  path: "",
  isMain: false,
  git: null,
  dbName: null,
  setup: null,
  setupConfigured: false,
  pinned: false,
  services: [],
};
