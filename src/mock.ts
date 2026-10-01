// Phase-2 mock backend — reproduces the prototype SEED + simulated behavior.
// Deleted in Phase 3/4 when the Rust backend takes over via ipc.ts.
import type { LogLine, RepoNode, ServiceNode, SetupState, SvcKind } from "./types";

const svc = (
  wtKey: string,
  serviceId: string,
  name: string,
  kind: SvcKind,
  port: number | null,
  status: ServiceNode["status"],
): ServiceNode => ({ svcKey: `${wtKey}::${serviceId}`, serviceId, name, kind, port, derivedPort: port, status });

const min = 60;
const nowS = () => Date.now() / 1000;

/* A provisioned worktree, as the marker file would report it. */
const RAN: SetupState = { ranAt: nowS() - 3 * 24 * 60 * min, ok: true, source: "marker" };

/* Custom commands for the no-backend dev build, so the rail's command buttons
   render without a real settings file. Mirrors the design's CMDS seed. */
export function mockCustomCommands(): { label: string; command: string; group: string }[] {
  return [
    { label: "Lint", command: "pnpm lint", group: "Checks" },
    { label: "Unit tests", command: "pnpm test --run", group: "Checks" },
    { label: "Typecheck", command: "pnpm tsc --noEmit", group: "Checks" },
    { label: "Storybook", command: "pnpm storybook", group: "" },
  ];
}

export function mockTree(): RepoNode[] {
  return [
    {
      repoId: "acme-web",
      name: "acme-web",
      path: "~/code/acme-web",
      worktrees: [
        {
          wtKey: "~/code/acme-web",
          branch: "main",
          path: "~/code/acme-web",
          isMain: true,
          dbName: null,
          setup: RAN,
          setupConfigured: true,
          pinned: false,
          git: { ahead: 0, behind: 0, dirty: false, lastCommitTs: nowS() - 2 * 60 * min, lastCommitMsg: "checkout: fix tax rounding" },
          services: [
            svc("~/code/acme-web", "frontend", "Frontend", "web", 3000, "running"),
            svc("~/code/acme-web", "server", "Server", "server", 4000, "running"),
          ],
        },
        {
          wtKey: "~/code/.wt/acme-web-checkout",
          branch: "feature/checkout",
          path: "~/code/.wt/acme-web-checkout",
          isMain: false,
          dbName: "db_2",
          setup: RAN,
          setupConfigured: true,
          pinned: true,
          git: { ahead: 7, behind: 2, dirty: true, lastCommitTs: nowS() - 11 * min, lastCommitMsg: "wip: express checkout drawer" },
          services: [
            svc("~/code/.wt/acme-web-checkout", "frontend", "Frontend", "web", 3010, "stopped"),
            svc("~/code/.wt/acme-web-checkout", "server", "Server", "server", 4010, "stopped"),
          ],
        },
      ],
    },
    {
      repoId: "payments-api",
      name: "payments-api",
      path: "~/code/payments-api",
      worktrees: [
        {
          wtKey: "~/code/payments-api",
          branch: "main",
          path: "~/code/payments-api",
          isMain: true,
          dbName: null,
          setup: RAN,
          setupConfigured: true,
          pinned: false,
          git: { ahead: 0, behind: 0, dirty: false, lastCommitTs: nowS() - 24 * 60 * min, lastCommitMsg: "bump stripe sdk to 14.2" },
          services: [
            svc("~/code/payments-api", "api", "API", "server", 8080, "running"),
            svc("~/code/payments-api", "worker", "Worker", "worker", null, "stopped"),
          ],
        },
        {
          wtKey: "~/code/.wt/payments-refund",
          branch: "hotfix/refund",
          path: "~/code/.wt/payments-refund",
          isMain: false,
          dbName: "db_4",
          setup: null,
          setupConfigured: true,
          pinned: false,
          git: { ahead: 3, behind: 0, dirty: true, lastCommitTs: nowS() - 4 * min, lastCommitMsg: "refund: idempotency key guard" },
          services: [svc("~/code/.wt/payments-refund", "api", "API", "server", 8090, "running")],
        },
      ],
    },
    {
      repoId: "design-system",
      name: "design-system",
      path: "~/dev/design-system",
      worktrees: [
        {
          wtKey: "~/dev/design-system",
          branch: "main",
          path: "~/dev/design-system",
          isMain: true,
          dbName: null,
          setup: null,
          setupConfigured: false,
          pinned: false,
          git: { ahead: 1, behind: 0, dirty: false, lastCommitTs: nowS() - 5 * 60 * min, lastCommitMsg: "Button: focus ring tokens" },
          services: [svc("~/dev/design-system", "storybook", "Storybook", "web", 6006, "running")],
        },
      ],
    },
  ];
}

const LOG_POOL: Record<SvcKind, [LogLine["lv"], string][]> = {
  web: [
    ["info", "hmr update applied in 41ms"],
    ["ok", "compiled successfully"],
    ["info", "GET / 200 — 12ms"],
    ["info", "GET /assets/app.js 200 — 4ms"],
    ["warn", "chunk vendors.js is 612 KiB (large)"],
    ["info", "page reload: src/App.tsx"],
  ],
  server: [
    ["info", "GET /api/health 200 — 3ms"],
    ["info", "POST /api/orders 201 — 88ms"],
    ["ok", "db pool: 8 idle / 2 active"],
    ["warn", "slow query 214ms — orders.findMany"],
    ["info", "GET /api/users/42 200 — 19ms"],
    ["err", "401 /api/admin — missing token"],
  ],
  worker: [
    ["info", "job processed id=8821 (queue: jobs)"],
    ["ok", "batch flush ok — 24 records"],
    ["info", "queue depth: 3"],
    ["warn", "retry 1/3 — job id=8830"],
  ],
};

export const logTime = () => new Date().toTimeString().slice(0, 8);

export function genLine(kind: SvcKind): LogLine {
  const pool = LOG_POOL[kind] || LOG_POOL.server;
  const [lv, text] = pool[Math.floor(Math.random() * pool.length)];
  return { t: logTime(), lv, text };
}
