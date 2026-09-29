// The Settings page catalog — which pages exist, what they are called, and the
// searchable index behind ⌘F. Page components read this; it reads nothing back.
import { type ComponentType } from "react";
import { Bell, Braces, Cube, Doc, Fork, Keyboard, Server, Shield, Sliders, Sparkle, Terminal, Settings as Cog } from "../../icons";

export type IconC = ComponentType<{ size?: number }>;
export const ICONS: Record<string, IconC> = {
  sliders: Sliders, terminal: Terminal, bell: Bell, keyboard: Keyboard, cube: Cube, fork: Fork,
  server: Server, sparkle: Sparkle, code: Braces, doc: Doc, shield: Shield, settings: Cog,
};

export type PageId =
  | "general" | "terminal" | "notifications" | "shortcuts" | "advanced"
  | "repo-general" | "services" | "agents" | "commands" | "files" | "setup" | "security";

export type PageMeta = { id: PageId; ic: string; label: string; desc: string; title: string; blurb: string };

export const PLATFORM: PageMeta[] = [
  { id: "general", ic: "sliders", label: "General", desc: "Appearance and behaviour", title: "General", blurb: "How Canopy looks and what it does on launch." },
  { id: "terminal", ic: "terminal", label: "Terminal", desc: "Shell, font, env", title: "Terminal", blurb: "The shell Canopy opens inside a worktree, and what it inherits." },
  { id: "notifications", ic: "bell", label: "Notifications", desc: "What interrupts you", title: "Notifications", blurb: "Canopy only interrupts you for things that need a decision." },
  { id: "shortcuts", ic: "keyboard", label: "Shortcuts", desc: "Keyboard map", title: "Keyboard shortcuts", blurb: "Every command is reachable from the keyboard." },
  { id: "advanced", ic: "cube", label: "Advanced", desc: "Diagnostics, experiments", title: "Advanced", blurb: "Diagnostics, experiments and reset." },
];
export const REPOPAGES: PageMeta[] = [
  { id: "repo-general", ic: "fork", label: "General", desc: "Paths and defaults", title: "Repository", blurb: "Where this repo lives and what every new worktree starts with." },
  { id: "services", ic: "server", label: "Services", desc: "Runtimes, ports", title: "Services", blurb: "Long-running processes Canopy starts per worktree. Ports derive from the worktree index so they never collide." },
  { id: "agents", ic: "sparkle", label: "Agents", desc: "Coding agents", title: "Agents", blurb: "Which agent CLIs are available, and what context they inherit." },
  { id: "commands", ic: "code", label: "Commands", desc: "One-off scripts", title: "Custom commands", blurb: "Named scripts you can launch in any worktree from the + menu." },
  { id: "files", ic: "doc", label: "Files", desc: "Provisioned config", title: "Provisioned files", blurb: "Files seeded or templated into every new worktree — any path, any format." },
  { id: "setup", ic: "cube", label: "Setup", desc: "Tasks on create", title: "Setup", blurb: "Commands run in order the first time a worktree is created." },
  { id: "security", ic: "shield", label: "Security", desc: "Secrets, SSH", title: "Security", blurb: "How secrets are handled in provisioned files and exports." },
];
export const ALLPAGES = [...PLATFORM, ...REPOPAGES];
export const pageOf = (id: PageId): PageMeta => ALLPAGES.find((p) => p.id === id) || ALLPAGES[0];
export const REPO_PAGE_IDS = new Set<PageId>(REPOPAGES.map((p) => p.id));

/* the searchable index — every setting, not just page names */
export const INDEX: { page: PageId; label: string; hint: string }[] = (
  [
    ["general", "Editor command", "code, cursor, subl"], ["general", "Theme", "dark, match system"],
    ["general", "Density", "compact or comfortable"], ["general", "Accent colour", "teal, green, amber"],
    ["general", "Show switch-branch action", "worktree menu"],
    ["terminal", "Terminal application", "Terminal, iTerm"], ["terminal", "Shell program", "/bin/zsh"],
    ["terminal", "Font and size", "SF Mono, JetBrains"], ["terminal", "Inherit provisioned env", "ports, database"],
    ["notifications", "Service crash alerts", "interrupt when a service dies"],
    ["notifications", "Agent needs a decision", "blocked agent"],
    ["shortcuts", "Command palette", "⌘K"], ["shortcuts", "Save changes", "⌘S"],
    ["shortcuts", "Toggle worktree list", "⌘B"], ["shortcuts", "Layout presets", "⌘1 ⌘2 ⌘3 ⌘4 ⌘5"],
    ["shortcuts", "New worktree", "⌘N"], ["shortcuts", "Add repository", "⇧⌘N"],
    ["shortcuts", "Sync submodules", "⇧⌘S"], ["shortcuts", "Switch branch", "⌘\\"],
    ["shortcuts", "Pull everything", "⌘⏎"], ["shortcuts", "Run next action", "⏎"],
    ["shortcuts", "Cross-worktree overview", "⌘O"], ["shortcuts", "Open settings", "⌘,"],
    ["shortcuts", "Select several worktrees", "⌘click ⇧click"],
    ["advanced", "Diagnostics", "version, config path"], ["advanced", "Experiments", "parallel setup"],
    ["repo-general", "Repository path", "where the repo lives"], ["repo-general", "Worktree root", ".worktrees"],
    ["repo-general", "Remove repository", "stop tracking"],
    ["services", "Base port", "derived per worktree index"], ["services", "Service command", "how a service starts"],
    ["services", "Working directory", "cwd"], ["services", "Extra env", "KEY=VALUE"],
    ["agents", "Agent CLI", "claude, codex, aider"], ["agents", "Prompt on launch", "seed the handoff"],
    ["commands", "Custom command", "label and script"],
    ["files", "Provisioned file", "path and format"], ["files", "Template variables", "${INT_DB_NAME} ${WT_SERVICE_PORT}"],
    ["files", "dotenv format", ".env files"],
    ["setup", "Setup tasks", "install, migrate, build"],
    ["security", "Mask secrets", "hide token values"], ["security", "SSH key", "git credentials"],
  ] as [PageId, string, string][]
).map(([page, label, hint]) => ({ page, label, hint }));

export const VARS: { t: string; d: string }[] = [
  { t: "${INT_DB_NAME}", d: "tj_history" },
  { t: "${INT_SLUG}", d: "fix-history-state" },
  { t: "${WT_INDEX}", d: "3" },
  { t: "${WT_SERVICE_PORT}", d: "8272" },
  { t: "${WT_PATH}", d: "~/ToolJet/.worktrees/…" },
  { t: "${REPO_PATH}", d: "~/ToolJet" },
];
