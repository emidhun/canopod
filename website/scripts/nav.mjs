// The site's information architecture. Order here is the order in the sidebar,
// and it's also the order prev/next walks, so a page that isn't listed here
// isn't part of the site.
//
// Labels are plain descriptions of the page. Slugs never change, so relabelling
// a page cannot break a link.
export const NAV = [
  {
    group: "Getting started",
    items: [
      ["index", "Home"],
      ["overview", "What Canopy is"],
      ["install-macos", "Install on macOS"],
      ["install-windows", "Install on Windows"],
      ["install-linux", "Install on Linux"],
      ["onboarding", "Adding a repository"],
      ["first-worktree", "Your first worktree"],
    ],
  },
  {
    group: "Using Canopy",
    items: [
      ["main-window", "The main window"],
      ["next-action", "The next action"],
      ["worktrees", "Worktrees"],
      ["services-ports", "Services and ports"],
      ["databases", "Databases"],
      ["logs", "Logs"],
      ["agents-terminals", "Terminals and agents"],
      ["popover", "The menu-bar popover"],
      ["palette-overview", "Palette and overview"],
      ["shortcuts", "Keyboard shortcuts"],
    ],
  },
  {
    group: "Settings",
    items: [
      ["settings-platform", "Application settings"],
      ["settings-repository", "Repository settings"],
      ["settings-storage", "Where settings live"],
    ],
  },
  {
    group: "Configuration",
    items: [
      ["config-worktreemanager", ".worktreemanager.json"],
      ["config-variables", "Template variables"],
      ["config-state", "settings.json & state.json"],
    ],
  },
  {
    group: "Examples",
    items: [
      ["example-simple-web", "Simple web app"],
      ["example-node-postgres", "Node + Postgres app"],
      ["example-tooljet", "ToolJet monorepo"],
      ["example-other-stacks", "Other stacks"],
    ],
  },
  {
    group: "Development",
    items: [
      ["dev-setup", "Building from source"],
      ["prod-setup", "Building a release"],
    ],
  },
  {
    group: "Reference",
    items: [
      ["reference-ipc", "Commands and events"],
      ["troubleshooting", "Troubleshooting"],
      ["limitations", "Limitations"],
    ],
  },
];

/** Flat [slug, label] list in sidebar order — what prev/next walks. */
export const FLAT = NAV.flatMap((g) => g.items.map(([slug, label]) => ({ slug, label, group: g.group })));
