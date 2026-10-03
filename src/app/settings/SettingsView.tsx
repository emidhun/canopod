// Settings — the redesigned configuration editors (design: Canopy Settings.html).
//
// This file is the SHELL only: navigation, the repo scope picker, dirty
// tracking, ⌘F search, ⌘P preview, import/export and the save step. Each page
// lives in ./pages and receives the PageProps bundle; adding a page means
// adding a file and one line to catalog.ts, not editing this one.
//
// ONE navigation list: platform pages, the repository picker acting as the
// scope divider, then that repo's pages — nothing named twice. Unsaved changes
// are named per section in the nav and the bar.
//
// Backend honesty (design-build): pages with real wiring persist through
// getSettings/saveSettings (Repository, Services, Agents, Commands) and
// getRepoConfig/saveRepoConfig (Files, Setup), plus Appearance (theme, density
// and accent) which applies live through the appearance module (localStorage,
// not the Settings save step). Pages with no backend today (Terminal shell,
// Notifications, Advanced updates/crash, Security) render a "coming soon"
// banner with disabled controls rather than fake ones. Shortcuts is a static
// reference of the real keybindings.
import { useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { errText, hasBackend, ipc, type ProvisionEntry, type ProvisionFormat, type RepoCfg, type Settings, type SetupPolicy, type SetupTask } from "../../ipc";
import { useStore } from "../../store";
import {
  Braces, Check, Chevron, Copy, Download, Fork, More, Plus, Pull, Refresh, Search,
  Settings as Cog, Sliders, Spinner, X,
} from "../../icons";
import { ALLPAGES, ICONS, pageOf, PLATFORM, REPOPAGES, REPO_PAGE_IDS, type PageId, type PageMeta } from "./catalog";
import type { PageProps } from "./types";
import { MOCK, MOCK_CARDS, MOCK_SETUP } from "./mocks";
import { buildConfig, cleanRepo, DEFAULT_POLICY, fromCards, normalizeRepo, parseSetup, toCards, type FileCardT } from "./provision";
import { describeIncomplete, incompleteRows, type IncompleteRow } from "./incomplete";
import SearchOverlay from "./SearchOverlay";
import Preview from "./Preview";
import ServicesPage from "./pages/ServicesPage";
import AgentsPage from "./pages/AgentsPage";
import CommandsPage from "./pages/CommandsPage";
import FilesPage from "./pages/FilesPage";
import SetupPage from "./pages/SetupPage";
import RepoGeneralPage from "./pages/RepoGeneralPage";
import McpPage from "./pages/McpPage";
import GeneralPage from "./pages/GeneralPage";
import TerminalPage from "./pages/TerminalPage";
import NotificationsPage from "./pages/NotificationsPage";
import ShortcutsPage from "./pages/ShortcutsPage";
import AdvancedPage from "./pages/AdvancedPage";
import SecurityPage from "./pages/SecurityPage";
import Modal from "../canopy/Modal";
import { invalidateTermCfg } from "../TerminalPane";

/** a page whose repo has no refused rows gets this rather than a fresh Map */
const NO_INVALID: ReadonlyMap<string, IncompleteRow> = new Map();

/* ══════════════════════════════ shell ══════════════════════════════════ */
export default function SettingsView({ onClose }: { onClose: () => void }) {
  const showToast = useStore((s) => s.showToast);
  const tree = useStore((s) => s.tree);
  const bumpSettings = useStore((s) => s.bumpSettings);
  const settingsRev = useStore((s) => s.settingsRev);
  const selKey = useStore((s) => s.selKey);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [page, setPage] = useState<PageId>(() => {
    const requested = import.meta.env.DEV && !hasBackend() ? new URLSearchParams(window.location.search).get("page") : null;
    return ALLPAGES.find(p => p.id === requested)?.id ?? "general";
  });
  const [repoId, setRepoId] = useState<string>("");
  const [repoMenu, setRepoMenu] = useState(false);
  const [search, setSearch] = useState(false);
  const [preview, setPreview] = useState(false);
  const [navQ, setNavQ] = useState("");
  const [flashId, setFlashId] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Set<PageId>>(new Set());
  // Rows the last save refused (#43), per repo. A row key is kind + index and
  // carries no repo, so one flat map would mark repo B's valid row at the same
  // index. Cleared as soon as the user edits, and on Discard.
  const [invalidByRepo, setInvalidByRepo] = useState<ReadonlyMap<string, ReadonlyMap<string, IncompleteRow>>>(new Map());
  const clearInvalid = () => setInvalidByRepo((m) => (m.size ? new Map() : m));

  const [cardsByRepo, setCardsByRepo] = useState<Record<string, FileCardT[]>>({});
  const [setupByRepo, setSetupByRepo] = useState<Record<string, SetupTask[]>>({});
  const [policyByRepo, setPolicyByRepo] = useState<Record<string, SetupPolicy>>({});
  const [extrasByRepo, setExtrasByRepo] = useState<Record<string, { teardown: string[]; migrate: string[] }>>({});
  const [loadedRepos, setLoadedRepos] = useState<ReadonlySet<string>>(new Set());
  const editRevision = useRef(0);
  const repoEditRevision = useRef(new Map<string, number>());
  const dirtyRepos = useRef<Set<string>>(new Set());
  const repoMenuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [moreMenu, setMoreMenu] = useState(false);

  const flash = (m: string) => showToast(m);
  const markDirty = (id: PageId) => {
    editRevision.current += 1;
    if (repoId) repoEditRevision.current.set(repoId, editRevision.current);
    setDirty((d) => new Set(d).add(id));
    clearInvalid();
    if ((id === "files" || id === "setup") && repoId) dirtyRepos.current.add(repoId);
  };

  function load() {
    setLoadError(null);
    clearInvalid();
    setLoadedRepos(new Set());
    if (!hasBackend()) {
      setSettings({ ...MOCK, repos: MOCK.repos.map(normalizeRepo) });
      setRepoId(MOCK.repos[0].id);
      setCardsByRepo({ [MOCK.repos[0].id]: toCards(MOCK_CARDS) });
      setSetupByRepo({ [MOCK.repos[0].id]: MOCK_SETUP });
      setLoadedRepos(new Set(MOCK.repos.map((r) => r.id)));
      setDirty(new Set());
      dirtyRepos.current = new Set();
      return;
    }
    ipc.getSettings().then((s) => {
      setSettings({ ...s, repos: s.repos.map(normalizeRepo) });
      if (s.repos[0]) setRepoId(s.repos[0].id);
      setDirty(new Set());
      dirtyRepos.current = new Set();
      s.repos.forEach((r) => {
        ipc.getRepoConfig(r.id).then((c) => {
          setCardsByRepo((m) => ({ ...m, [r.id]: toCards(c.provision) }));
          setSetupByRepo((m) => ({ ...m, [r.id]: c.setup }));
          setLoadedRepos((ids) => new Set(ids).add(r.id));
          setPolicyByRepo((m) => ({ ...m, [r.id]: c.setupPolicy ?? DEFAULT_POLICY }));
          setExtrasByRepo((m) => ({ ...m, [r.id]: { teardown: c.teardown || [], migrate: c.migrate || [] } }));
        }).catch(() => {});
      });
    }).catch((e) => { setLoadError(errText(e)); showToast(`Failed to load settings: ${errText(e)}`); });
  }
  useEffect(load, []);

  // Sync (and Save) bump settingsRev. When it changes while Settings is open,
  // re-read each repo's `.worktreemanager.json` from disk so Setup, Files and
  // Migrate reflect edits made outside the app — but never clobber a repo the
  // user is mid-edit on (still in dirtyRepos with unsaved changes).
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    if (!hasBackend() || !settings) return;
    settings.repos.forEach((r) => {
      if (dirtyRepos.current.has(r.id)) return;
      ipc.getRepoConfig(r.id).then((c) => {
        if (dirtyRepos.current.has(r.id)) return;
        setCardsByRepo((m) => ({ ...m, [r.id]: toCards(c.provision) }));
        setSetupByRepo((m) => ({ ...m, [r.id]: c.setup }));
        setExtrasByRepo((m) => ({ ...m, [r.id]: { teardown: c.teardown || [], migrate: c.migrate || [] } }));
      }).catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsRev]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "f") { e.preventDefault(); setSearch(true); }
      else if (meta && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty.size) save(); }
      // ⌘P previews the repo's config file — it has nothing to show from a
      // platform page, where the panel would render blank
      else if (meta && e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (REPO_PAGE_IDS.has(page) && repoId) setPreview((v) => !v);
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, settings, repoId, page, cardsByRepo, setupByRepo, policyByRepo, extrasByRepo, loadedRepos, saving]);

  useEffect(() => {
    if (!repoMenu) return;
    repoMenuRef.current?.querySelector<HTMLElement>("[role='dialog'] button")?.focus();
    const d = (e: MouseEvent) => { if (repoMenuRef.current && !repoMenuRef.current.contains(e.target as Node)) setRepoMenu(false); };
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setRepoMenu(false); repoMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
      if (e.key === "Tab") {
        const items = Array.from(repoMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role='dialog'] button") ?? []);
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        if (items.length && (current < 0 || (e.shiftKey ? current === 0 : current === items.length - 1))) {
          e.preventDefault(); items[e.shiftKey ? items.length - 1 : 0].focus();
        }
      }
    };
    document.addEventListener("mousedown", d);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", d); document.removeEventListener("keydown", k); };
  }, [repoMenu]);

  useEffect(() => {
    if (!moreMenu) return;
    const d = (e: MouseEvent) => { if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreMenu(false); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { setMoreMenu(false); moreRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); } };
    document.addEventListener("mousedown", d);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", d); document.removeEventListener("keydown", k); };
  }, [moreMenu]);

  if (!settings) return <div className="cxset-root"><div className="empty settings-load" role={loadError ? "alert" : "status"}>
    <h2>{loadError ? "Could not load settings" : "Loading settings…"}</h2>
    {loadError ? <><p>{loadError}</p><button className="btn" onClick={load}>Retry</button></> : <Spinner size={16} />}
    <button className="btn gh" onClick={onClose}>Back to workspace</button>
  </div></div>;

  const repo = settings.repos.find((r) => r.id === repoId) || null;
  const repoIndex = settings.repos.findIndex((r) => r.id === repoId);
  const wtCount = (id: string) => tree.find((r) => r.repoId === id)?.worktrees.length ?? 0;
  const patch = (p: Partial<Settings>) => setSettings({ ...settings, ...p });
  const patchRepo = (p: Partial<RepoCfg>) => patch({ repos: settings.repos.map((r, ri) => (ri === repoIndex ? { ...r, ...p } : r)) });
  const cards = (repo && cardsByRepo[repo.id]) || [];
  const setup = (repo && setupByRepo[repo.id]) || [];
  const policy = (repo && policyByRepo[repo.id]) || DEFAULT_POLICY;
  const extras = (repo && extrasByRepo[repo.id]) || { teardown: [], migrate: [] };
  const setCards = (next: FileCardT[]) => { if (repo) setCardsByRepo((m) => ({ ...m, [repo.id]: next })); };
  const setSetup = (next: SetupTask[]) => { if (repo) setSetupByRepo((m) => ({ ...m, [repo.id]: next })); };
  const setExtras = (next: { teardown: string[]; migrate: string[] }) => { if (repo) setExtrasByRepo((m) => ({ ...m, [repo.id]: next })); };
  const setPolicy = (next: SetupPolicy) => { if (repo) setPolicyByRepo((m) => ({ ...m, [repo.id]: next })); };
  const isRepoPage = REPO_PAGE_IDS.has(page);
  const p = pageOf(page);

  const requestClose = () => { if (dirty.size) setConfirmClose(true); else onClose(); };

  async function save(closeAfter = false) {
    if (!settings || saving) return;
    const revision = editRevision.current;
    const repoRevisions = new Map(repoEditRevision.current);
    const reposToSave = new Set(dirtyRepos.current);
    if ([...reposToSave].some((id) => !loadedRepos.has(id))) {
      showToast("Repo config has not loaded — wait or reload before saving");
      return;
    }

    // A half-filled row cannot be persisted. It used to be filtered out here
    // silently, which reads as data loss (#43) — refuse the save instead, name
    // the row, and jump to the page holding it so it is on screen.
    // Name the repo in the message when there is more than one — the save jumps
    // scope, and "which repository?" is otherwise unanswerable from the toast.
    const many = settings.repos.length > 1;
    const bad = settings.repos.flatMap((r) =>
      incompleteRows(r).map((row) => ({ ...row, repoId: r.id, repo: many ? r.name : undefined })),
    );
    if (bad.length) {
      const first = bad[0];
      const byRepo = new Map<string, Map<string, IncompleteRow>>();
      for (const row of bad) {
        const m = byRepo.get(row.repoId) ?? new Map<string, IncompleteRow>();
        m.set(row.key, row);
        byRepo.set(row.repoId, m);
      }
      setInvalidByRepo(byRepo);
      if (first.repoId !== repoId) setRepoId(first.repoId);
      setPage(first.page);
      showToast(describeIncomplete(bad));
      return;
    }
    clearInvalid();

    const cleaned: Settings = {
      ...settings,
      repos: settings.repos.map((r) => cleanRepo(r).repo),
    };
    setSaving(true);
    try {
      if (hasBackend()) {
        const saved = await ipc.saveSettings(cleaned);
        setSettings((current) => current === settings ? saved : current ? { ...current, revision: saved.revision } : current);
        const failures: string[] = [];
        await Promise.all(
          cleaned.repos.filter((r) => reposToSave.has(r.id)).map((r) =>
            ipc.saveRepoConfig(r.id, fromCards(cardsByRepo[r.id] || []), (setupByRepo[r.id] || []).filter((t) => t.cmd.trim()), policyByRepo[r.id], extrasByRepo[r.id])
              .then(() => { if (repoEditRevision.current.get(r.id) === repoRevisions.get(r.id)) dirtyRepos.current.delete(r.id); })
              .catch((e) => failures.push(`${r.name}: ${e}`)),
          ),
        );
        if (failures.length) { showToast(`Saved app settings, but repo config failed — ${failures.join(" · ")}`); setSaving(false); return; }
      }
      if (!hasBackend()) setSettings(cleaned);
      // the next terminal pane to mount must read the saved shell config
      invalidateTermCfg();
      bumpSettings();
      const n = dirty.size;
      if (editRevision.current === revision) {
        setDirty(new Set());
        if (closeAfter) onClose();
      }
      showToast(editRevision.current !== revision ? "Saved — newer edits are still unsaved" : n <= 1 ? "Settings saved" : `Saved ${n} sections`);
    } catch (e) {
      showToast(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  async function addRepo() {
    if (!hasBackend()) { showToast("Folder picker needs the desktop app"); return; }
    const dir = await openDialog({ directory: true, multiple: false, title: "Select a git repository" });
    if (typeof dir !== "string") return;
    try {
      const added = await ipc.addRepo(dir);
      const fresh = await ipc.getSettings();
      setSettings({ ...fresh, repos: fresh.repos.map(normalizeRepo) });
      setRepoId(added.id);
      setPage("repo-general");
      showToast("Repository added — configure it below");
    } catch (e) { showToast(errText(e)); }
  }

  async function removeRepo() {
    if (!repo) return;
    if (!hasBackend()) { showToast("Removing a repository needs the desktop app"); return; }
    try {
      await ipc.removeRepo(repo.id);
      const fresh = await ipc.getSettings();
      setSettings({ ...fresh, repos: fresh.repos.map(normalizeRepo) });
      setRepoId(fresh.repos[0]?.id ?? "");
      setPage("general");
      showToast(`Removed ${repo.name}`);
    } catch (e) { showToast(errText(e)); }
  }

  const goTo = (r: { page: PageId; label: string }) => {
    setPage(r.page); setSearch(false);
    setFlashId(r.page + "-" + r.label); setTimeout(() => setFlashId(null), 1200);
    showToast(`Jumped to ${r.label}`);
  };

  /* ── .worktreemanager.json import / export (mirrors the previous repo
        config editor: native save + backend write out, FileReader in) ── */
  /* Masking applies to what LEAVES the app (copy / export), never to what is
     saved: a masked config written back to disk would provision the literal
     string "••••••••" into every worktree. save_repo_config is unaffected. */
  const configJson = () =>
    JSON.stringify(buildConfig(cards, setup, extras.teardown, extras.migrate, policy, !!settings.security?.maskInExports), null, 2);
  const copyJson = () => {
    if (!repo) return;
    navigator.clipboard?.writeText(configJson()).then(() => showToast("Copied .worktreemanager.json"), () => showToast("Copy failed"));
  };
  const exportJson = async () => {
    if (!repo) return;
    if (!hasBackend()) { showToast("Export needs the desktop app"); return; }
    try {
      const path = await saveDialog({ title: "Export repo config", defaultPath: `${repo.path || ""}/.worktreemanager.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path) return;
      await ipc.saveTextFile(path, configJson() + "\n");
      showToast(`Exported ${path}`);
    } catch (e) { showToast(`Export failed: ${e}`); }
  };
  const importJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || !repo) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const parsed = JSON.parse(String(r.result));
        const list: ProvisionEntry[] = Array.isArray(parsed.provision)
          ? parsed.provision.map((o: Record<string, unknown>) => ({
              path: String(o.path || ""),
              format: (["dotenv", "json", "yaml", "text"].includes(o.format as string) ? o.format : "dotenv") as ProvisionFormat,
              from: String(o.from || ""),
              interpolate: !!o.interpolate,
              keys: o.keys && typeof o.keys === "object" ? Object.entries(o.keys as object).map(([k, v]) => [k, String(v)] as [string, string]) : [],
            }))
          : [];
        setCards(toCards(list));
        markDirty("files");
        // an imported config may use either shape — normalise on the way in
        if (Array.isArray(parsed.teardown) || Array.isArray(parsed.migrate)) {
          const commands = (value: unknown, fallback: string[]) => {
            if (value === undefined) return fallback;
            if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error("Lifecycle commands must be arrays of strings");
            return value as string[];
          };
          setExtras({ teardown: commands(parsed.teardown, extras.teardown), migrate: commands(parsed.migrate, extras.migrate) });
          markDirty("files");
        }
        if (Array.isArray(parsed.setup)) { setSetup(parseSetup(parsed.setup)); markDirty("setup"); }
        setPage("files");
        showToast(list.length ? `Imported ${list.length} file${list.length > 1 ? "s" : ""} — review, then Save` : "No provision entries found");
      } catch {
        showToast(`Couldn't parse ${f.name} — invalid JSON`);
      }
    };
    r.readAsText(f);
    e.target.value = "";
  };
  const triggerImport = () => { if (!hasBackend()) { showToast("Import needs the desktop app"); return; } fileRef.current?.click(); };
  // read the repo's OWN .worktreemanager.json by its known path — a file picker
  // can't reach it on macOS (dotfiles are hidden), but the backend reads it
  // directly, so this imports the hidden config without a picker
  const reloadFromRepo = async () => {
    if (!repo) return;
    if (!hasBackend()) { showToast("Reading the config file needs the desktop app"); return; }
    try {
      const c = await ipc.getRepoConfig(repo.id);
      setCards(toCards(c.provision)); markDirty("files");
      setSetup(c.setup); markDirty("setup");
      setExtrasByRepo((m) => ({ ...m, [repo.id]: { teardown: c.teardown || [], migrate: c.migrate || [] } }));
      setPage("files");
      showToast(`Loaded ${repo.name}'s .worktreemanager.json — review, then Save`);
    } catch (e) { showToast(`Couldn't read the config file: ${e}`); }
  };

  const pageProps: PageProps = { repo, patchRepo, settings, patch, markDirty, flash, cards, setCards, setup, setSetup, extras, setExtras, policy, setPolicy, onRemoveRepo: removeRepo, onExportJson: exportJson, onImportJson: triggerImport, onCopyJson: copyJson, selKey, reload: load, invalid: (repo && invalidByRepo.get(repo.id)) || NO_INVALID };
  const body = () => {
    if (isRepoPage && !repo) {
      return (
        <div className="empty">
          <p>No repository selected. Add a git repository and Canopy will track every worktree in it.</p>
          <button className="btn sm" onClick={addRepo}><Plus size={10} />Add repository</button>
        </div>
      );
    }
    if ((page === "files" || page === "setup") && repo && !loadedRepos.has(repo.id)) {
      return <div role="status">Repo config has not loaded yet. If loading fails, use Discard to retry.</div>;
    }
    switch (page) {
      case "mcp": return <McpPage />;
      case "services": return <ServicesPage {...pageProps} />;
      case "agents": return <AgentsPage {...pageProps} />;
      case "commands": return <CommandsPage {...pageProps} />;
      case "files": return <FilesPage {...pageProps} />;
      case "setup": return <SetupPage {...pageProps} />;
      case "repo-general": return <RepoGeneralPage {...pageProps} />;
      case "terminal": return <TerminalPage {...pageProps} />;
      case "notifications": return <NotificationsPage {...pageProps} />;
      case "shortcuts": return <ShortcutsPage {...pageProps} />;
      case "advanced": return <AdvancedPage {...pageProps} />;
      case "security": return <SecurityPage {...pageProps} />;
      default: return <GeneralPage {...pageProps} />;
    }
  };

  const navRow = (item: PageMeta) => {
    if (navQ && !(item.label + " " + item.desc).toLowerCase().includes(navQ.toLowerCase())) return null;
    const Ic = ICONS[item.ic] || Sliders;
    const isDirty = dirty.has(item.id);
    const count = item.id === "services" ? repo?.services.length
      : item.id === "agents" ? repo?.agents?.length
      : item.id === "commands" ? repo?.customCommands?.length
      : item.id === "files" ? cards.length
      : item.id === "setup" ? setup.length
      : undefined;
    return (
      <button key={item.id} className={"nrow" + (page === item.id ? " sel" : "")} onClick={() => setPage(item.id)}>
        <span className="ic"><Ic size={13} /></span>
        <span className="lb">{item.label}</span>
        {isDirty && <span className="dot" title="Unsaved changes" />}
        {count != null && !isDirty && <span className="ct">{count}</span>}
      </button>
    );
  };

  const dirtyNames = [...dirty].map((d) => pageOf(d).title);
  const noNavMatch = navQ && !ALLPAGES.some((x) => (x.label + " " + x.desc).toLowerCase().includes(navQ.toLowerCase()));

  return (
    <div className="cxset-root">
      <div className="tbar">
        <div className="ttl"><span className="ic"><Cog size={13} /></span>Settings</div>
        <span className="sp" />
        <button className="ib" onClick={() => setSearch(true)} title="Search all settings (⌘F)"><Search size={13} />Search<span className="k">⌘F</span></button>
        {/* The JSON preview belongs to a REPOSITORY's config, so it is offered
            on the repo pages that have one (below) — not from the title bar,
            where it sat over platform pages it has nothing to do with. */}
        <button className="btn gh" onClick={requestClose} disabled={saving} title="Close settings">Back to workspace</button>
      </div>

      <div className="body">
        <div className="nav">
          <div className="navsearch">
            <Search size={12} />
            <input placeholder="Filter pages…" value={navQ} onChange={(e) => setNavQ(e.target.value)} />
            {navQ && <button className="ib" aria-label="Clear page filter" style={{ height: 18, minWidth: 18 }} onClick={() => setNavQ("")}><X size={11} /></button>}
          </div>
          <div className="navlist">
            <div className="navgrp">Application</div>
            {PLATFORM.map(navRow)}
            <div style={{ position: "relative" }} ref={repoMenuRef}>
              {repo && (
                <button className="repopick" aria-haspopup="dialog" aria-expanded={repoMenu} onClick={() => setRepoMenu((m) => !m)} title="Switch repository">
                  <span className="ic"><Fork size={12} /></span>
                  <span className="rn">{repo.name}</span>
                  <span className="rc">{wtCount(repo.id)} wt</span>
                  <Chevron size={11} />
                </button>
              )}
              {repoMenu && (
                <div className="varmenu" role="dialog" aria-label="Choose repository" style={{ left: 6, right: "auto", top: 30, width: 204 }}>
                  <div className="vh">Repository</div>
                  {settings.repos.map((r) => (
                    <button className="vitem" key={r.id} onClick={() => { setRepoId(r.id); setRepoMenu(false); }} style={{ color: r.id === repoId ? "var(--action-primary)" : "var(--text-primary)" }}>
                      <Fork size={11} />
                      <span style={{ color: "inherit", fontSize: "var(--fs-body)" }}>{r.name}</span>
                      <span>{wtCount(r.id)} wt</span>
                    </button>
                  ))}
                  {settings.repos.length === 0 && <button className="vitem" onClick={() => { setRepoMenu(false); addRepo(); }}><span>Add a repository…</span></button>}
                </div>
              )}
            </div>
            {repo && REPOPAGES.map(navRow)}
            {noNavMatch && <div className="srempty" style={{ padding: "16px 8px", fontSize: "var(--fs-small)" }}>No page matches.<br />Try ⌘F to search settings.</div>}
          </div>
        </div>

        <div className="page">
          <div className="phead">
            <div className="pt">
              <div className="scope-label">{isRepoPage ? `Repository · ${repo?.name ?? "None selected"}` : "Application · This machine"}</div>
              <h2>{p.title}
                {isRepoPage && repo && <span className="sub">{repo.name}</span>}
                {dirty.has(page) && <span className="dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--action-primary)" }} title="Unsaved changes" />}
              </h2>
              <p>{p.blurb}</p>
            </div>
            <div className="pa">
              {isRepoPage && repo && (
                <button className={"btn sm" + (preview ? " pri" : "")} onClick={() => setPreview((v) => !v)}><Braces size={11} />{preview ? "Hide" : "Preview"} JSON<span className="k">⌘P</span></button>
              )}
              {/* .worktreemanager.json is a property of one repository. On the
                  platform pages there is no repo in scope, so the menu had
                  nothing true to act on — it is not offered there. */}
              {isRepoPage && repo && (
                <div style={{ position: "relative" }} ref={moreRef}>
                  <button className={"ib" + (moreMenu ? " on" : "")} title="More — the repo's .worktreemanager.json" onClick={() => setMoreMenu((m) => !m)} aria-haspopup="menu" aria-expanded={moreMenu}><More size={15} /></button>
                  {moreMenu && (
                    <div className="varmenu" style={{ top: 30, width: 244 }}>
                      <div className="vh">.worktreemanager.json</div>
                      <button className="vitem" onClick={() => { copyJson(); setMoreMenu(false); }}><Copy size={12} /><span style={{ marginLeft: 0, color: "var(--text-primary)" }}>Copy JSON</span></button>
                      <button className="vitem" onClick={() => { exportJson(); setMoreMenu(false); }}><Download size={12} /><span style={{ marginLeft: 0, color: "var(--text-primary)" }}>Export config…</span></button>
                      <button className="vitem" onClick={() => { reloadFromRepo(); setMoreMenu(false); }} title="Reads the repo's own .worktreemanager.json by path (it's hidden, so a file picker can't see it)"><Refresh size={12} /><span style={{ marginLeft: 0, color: "var(--text-primary)" }}>Load from repo file</span></button>
                      <button className="vitem" onClick={() => { triggerImport(); setMoreMenu(false); }}><Pull size={12} /><span style={{ marginLeft: 0, color: "var(--text-primary)" }}>Import from file…</span></button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="pbody">
            <div className={"pmain" + (flashId?.startsWith(page + "-") ? " flashrow" : "")}>{body()}</div>
            {preview && isRepoPage && repo && (
              <Preview cards={cards} setup={setup} extras={extras} policy={policy} mask={settings.security?.maskSecrets !== false} onClose={() => setPreview(false)} />
            )}
          </div>
        </div>
      </div>

      {dirty.size > 0 ? (
        <div className="dirty">
          <span className="dd" />
          <span className="dt"><b>Unsaved changes</b> in <span className="sect">{dirtyNames.join(", ")}</span></span>
          <span style={{ flex: 1 }} />
          <button className="btn gh" disabled={saving} onClick={load}>Discard all changes</button>
          <button className="btn pri" disabled={saving} onClick={() => save()}>{saving ? <Spinner size={11} /> : <Check size={11} />}Save all changes<span className="k">⌘S</span></button>
        </div>
      ) : (
        <div className="statusline">
          {/* name the file only where it IS the file being edited */}
          <span className="mono">{isRepoPage && repo ? ".worktreemanager.json" : "Canopy settings"}</span>
          <span className="sdiv" />
          <span>All changes saved</span>
          <span style={{ flex: 1 }} />
          {isRepoPage && repo && <span>{wtCount(repo.id)} worktrees · {cards.length} provisioned files · {repo.services.length} services</span>}
        </div>
      )}

      <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={importJson} />
      {confirmClose && <Modal title="Save your changes?" sub="Application and repository configuration" busy={saving} onClose={() => setConfirmClose(false)} foot={<>
        <button className="cx-btn cx-btn--ghost" onClick={() => setConfirmClose(false)}>Keep editing</button>
        <button className="cx-btn" disabled={saving} onClick={onClose}>Discard changes</button>
        <button className="cx-btn cx-btn--primary" disabled={saving} onClick={() => save(true)}>{saving ? "Saving…" : "Save and leave"}</button>
      </>}><p>Your edits in {dirtyNames.join(", ")} have not been saved. Appearance changes already applied to this machine are kept.</p></Modal>}
      {search && <SearchOverlay onClose={() => setSearch(false)} onGo={goTo} />}
    </div>
  );
}
