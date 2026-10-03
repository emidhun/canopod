// Record the landing-page demo from the REAL Canopod UI: onboard a repository,
// then add several worktrees and watch them appear in the sidebar.
//
// Prerequisites: the app's Vite dev server is running (npm run dev in the repo
// root, port 1420). In a plain browser hasBackend() is false, so main.tsx
// exposes the store as window.__canopodStore; this script drives the real UI
// (open onboarding, open + fill the New-worktree modal, click Create) and lets
// a mock-only override of createWorktree append the row, so the capture shows
// the genuine interface reacting — not a hand-drawn mock.
//
//   node scripts/demo.mjs            → assets/demo/demo.webm (+ frame checkpoints)
//   THEME=dark node scripts/demo.mjs
//
// Assemble the GIF afterwards with scripts/demo-gif.sh (ffmpeg).
import { mkdirSync, existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = process.env.CANOPOD_REPO || resolve(ROOT, "..");
const BASE = process.env.CANOPOD_URL || "http://localhost:1420";
const THEME = process.env.THEME === "dark" ? "dark" : "light";
const OUT = join(ROOT, "assets", "demo", THEME);
const VIEW = { width: 1280, height: 800 };

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* The repository the demo "onboards" — one main worktree, mirrors mock.ts. */
const nowS = () => Date.now() / 1000;
const SEED_REPO = {
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
      git: { ahead: 0, behind: 0, dirty: false, lastCommitTs: nowS() - 2 * 3600, lastCommitMsg: "checkout: fix tax rounding" },
      services: [
        { svcKey: "~/code/acme-web::frontend", serviceId: "frontend", name: "Frontend", kind: "web", port: 3000, status: "running" },
        { svcKey: "~/code/acme-web::server", serviceId: "server", name: "Server", kind: "server", port: 4000, status: "running" },
      ],
    },
  ],
};

/* The worktrees the demo adds, in order. Each is typed into the real modal;
   ports and database name are derived from position, as the app would. */
const ADDS = [
  { branch: "feature/checkout" },
  { branch: "hotfix/refund" },
  { branch: "experiment/redis-cache" },
];

async function main() {
  const pwPath = join(APP, "node_modules", "playwright", "index.js");
  if (!existsSync(pwPath)) {
    console.error(`Playwright not found at ${pwPath}\nSet CANOPOD_REPO to the Canopod checkout.`);
    process.exit(1);
  }
  const pw = await import(`file://${pwPath}`);
  const chromium = pw.chromium ?? pw.default?.chromium;

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: VIEW,
    colorScheme: THEME,
    recordVideo: { dir: OUT, size: VIEW },
  });
  const page = await ctx.newPage();
  const appr = JSON.stringify({ theme: THEME, density: "comfortable", accent: "teal", fontScale: 1 });
  await page.addInitScript(`try { localStorage.setItem("canopod.appearance", ${JSON.stringify(appr)}); } catch (e) {}`);
  await page.goto(`${BASE}/index.html`, { waitUntil: "load" });
  await page.waitForSelector(".cxs-shell");

  let step = 0;
  const shot = async (name) => {
    await page.screenshot({ path: join(OUT, `${String(++step).padStart(2, "0")}-${name}.png`) });
    console.log(`  checkpoint ${name}`);
  };

  // Inject a soft fake cursor so mouse movement reads on camera (Playwright's
  // video has no OS pointer). It follows the real mousemove events Playwright
  // dispatches, so what it points at is where clicks actually land.
  await page.addStyleTag({
    content: `#democursor{position:fixed;z-index:99999;width:22px;height:22px;margin:-4px 0 0 -4px;pointer-events:none;
      transition:transform .12s ease-out;left:0;top:0}
      #democursor svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}`,
  });
  await page.evaluate(() => {
    const c = document.createElement("div");
    c.id = "democursor";
    c.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22" fill="none"><path d="M3 2l6 15 2.2-6.2L17 8.6 3 2z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
    document.body.appendChild(c);
    addEventListener("mousemove", (e) => { c.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; }, true);
  });

  // Seed the demo world and make worktree-create work in the mock: append a
  // realistic row instead of the "needs the desktop app" refusal.
  await page.evaluate(() => {
    const store = window.__canopodStore;
    if (!store) throw new Error("window.__canopodStore missing — is main.tsx's dev hook present?");
    store.setState({ tree: [] });
    store.setState({
      createWorktree: async (a) => {
        await new Promise((r) => setTimeout(r, 450)); // feel of real work
        store.setState((st) => ({
          tree: st.tree.map((r) => {
            if (r.repoId !== a.repoId) return r;
            const main = r.worktrees[0];
            return {
              ...r,
              worktrees: [
                ...r.worktrees,
                {
                  wtKey: a.wtPath,
                  branch: a.branch,
                  path: a.wtPath,
                  isMain: false,
                  dbName: `db_${r.worktrees.length + 1}`,
                  git: { ahead: 0, behind: 0, dirty: false, lastCommitTs: Date.now() / 1000, lastCommitMsg: `branch created from ${main.branch}` },
                  services: main.services.map((s) => ({
                    ...s,
                    svcKey: `${a.wtPath}::${s.serviceId}`,
                    port: s.port ? s.port + 10 * (r.worktrees.length) : null,
                    status: "stopped",
                  })),
                },
              ],
            };
          }),
          toast: `Worktree ready — ${a.branch}`,
        }));
        setTimeout(() => store.setState({ toast: null }), 1800);
        return a.wtPath;
      },
    });
  });

  // ── 1. Onboarding: the add-a-repository screen ─────────────────────
  await pause(400);
  await page.keyboard.press("Shift+Meta+n");
  await page.waitForSelector(".ob-root");
  await pause(1100);
  await shot("onboarding");

  // "adding" the repo: the mock has no folder picker, so seed the tree and
  // dismiss onboarding — the main window fills in with the repo and its main.
  await page.evaluate((repo) => {
    const store = window.__canopodStore;
    store.setState({ tree: [repo], selKey: repo.worktrees[0].wtKey });
    store.getState().closeAddRepo?.();
  }, SEED_REPO);
  await page.waitForSelector(".cxs-wtr");
  await pause(1000);
  await shot("repo-added");

  // ── 2. Add worktrees through the real New-worktree modal ───────────
  for (const add of ADDS) {
    await page.keyboard.press("Meta+n");
    await page.waitForSelector(".cx-modal");
    await pause(350);
    const input = page.locator(".cx-modal .cx-input--mono").first();
    await input.click();
    await input.fill("");
    for (const ch of add.branch) { await page.keyboard.type(ch, { delay: 28 }); }
    await pause(300);
    await shot(`typing-${add.branch.replace(/\W+/g, "-")}`);
    const create = page.locator(".cx-modal .cx-btn--primary");
    await create.click();
    await page.waitForSelector(".cx-modal", { state: "detached", timeout: 5000 }).catch(() => {});
    await pause(650);
    await shot(`added-${add.branch.replace(/\W+/g, "-")}`);
  }

  // ── 3. Rest on the populated sidebar ───────────────────────────────
  await pause(1300);
  await shot("final");

  const videoPath = await page.video().path();
  await ctx.close(); // finalizes the video file
  await browser.close();

  // give the recorded video a stable name
  const finalVideo = join(OUT, "..", `demo-${THEME}.webm`);
  renameSync(videoPath, finalVideo);
  // clean up the empty theme dir's stray webm entries
  for (const f of readdirSync(OUT)) if (f.endsWith(".webm")) rmSync(join(OUT, f));
  console.log(`\nVideo → ${finalVideo}`);
  console.log(`Checkpoints → ${OUT}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
