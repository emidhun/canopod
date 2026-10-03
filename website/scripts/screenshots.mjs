// Capture every documentation screenshot from the REAL Canopod UI.
//
// Prerequisites: the app's Vite dev server is running (npm run dev in the repo
// root, port 1420). In a plain browser `hasBackend()` is false, so the app runs on
// src/mock.ts — three repos, five worktrees, live stats and logs.
//
//   node scripts/screenshots.mjs                 → assets/screens/light/
//   THEME=dark node scripts/screenshots.mjs      → assets/screens/dark/
//   ONLY=palette,overview node scripts/screenshots.mjs   (subset, for iterating)
//
// Playwright is resolved from the Canopod repo, so this repo needs no
// dependencies of its own.
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = process.env.CANOPOD_REPO || resolve(ROOT, "..");
const BASE = process.env.CANOPOD_URL || "http://localhost:1420";
const THEME = process.env.THEME === "dark" ? "dark" : "light";
const OUT = join(ROOT, "assets", "screens", THEME);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim())) : null;

const VIEW = { width: 1400, height: 820 };
const POPOVER_VIEW = { width: 336, height: 392 };
const SCALE = 2;

const wanted = (name) => !ONLY || ONLY.has(name);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pwPath = join(APP, "node_modules", "playwright", "index.js");
  if (!existsSync(pwPath)) {
    console.error(`Playwright not found at ${pwPath}\nSet CANOPOD_REPO to the Canopod checkout.`);
    process.exit(1);
  }
  // playwright is CommonJS: named exports may only be reachable through `default`
  const pw = await import(`file://${pwPath}`);
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (!chromium) {
    console.error("Could not load playwright's chromium export.");
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  let shots = 0;

  /** A fresh page with the theme (and anything else) seeded before first paint. */
  async function open(entry = "index.html", view = VIEW, appearance = {}) {
    const ctx = await browser.newContext({ viewport: view, deviceScaleFactor: SCALE, colorScheme: THEME });
    const page = await ctx.newPage();
    const appr = JSON.stringify({ theme: THEME, density: "comfortable", accent: "teal", fontScale: 1, ...appearance });
    await page.addInitScript(`try { localStorage.setItem("canopod.appearance", ${JSON.stringify(appr)}); } catch (e) {}`);
    await page.goto(`${BASE}/${entry}`, { waitUntil: "load" });
    return { ctx, page };
  }

  async function shot(page, name, target) {
    const path = join(OUT, `${name}.png`);
    if (target) await target.screenshot({ path });
    else await page.screenshot({ path });
    shots++;
    console.log(`  ${THEME}/${name}.png`);
  }

  /** Click the menu/popover row whose text contains `text`. */
  async function clickText(page, selector, text) {
    const el = page.locator(selector, { hasText: text }).first();
    await el.waitFor({ state: "visible", timeout: 5000 });
    await el.click();
  }

  /* ── the main window ─────────────────────────────────────────────── */
  {
    const { ctx, page } = await open();
    await page.waitForSelector(".cxs-shell");
    // let the mock tick produce a few log lines and stats samples
    await pause(2600);

    if (wanted("main-worktree")) await shot(page, "main-worktree");
    if (wanted("main-topbar")) await shot(page, "main-topbar", page.locator(".cxs-topbar"));
    if (wanted("main-sidebar")) await shot(page, "main-sidebar", page.locator(".cxs-side"));
    if (wanted("main-rail")) await shot(page, "main-rail", page.locator(".cxs-rail"));
    if (wanted("main-statusbar")) await shot(page, "main-statusbar", page.locator(".cxs-statusbar"));

    // layouts: ⌘1 Logs, ⌘2 Terminal, ⌘3 Terminal + logs
    if (wanted("layout-split")) {
      await page.keyboard.press("Meta+3");
      await pause(500);
      await shot(page, "layout-split");
    }
    if (wanted("layout-terminal")) {
      await page.keyboard.press("Meta+2");
      await pause(400);
      await shot(page, "layout-terminal");
    }
    await page.keyboard.press("Meta+1");
    await pause(400);

    // logs: the level filter popover
    if (wanted("logs-filters")) {
      await clickText(page, ".cxs-fchip", "Levels");
      await page.waitForSelector(".cxs-fltpop");
      await pause(200);
      await shot(page, "logs-filters");
      await page.keyboard.press("Escape");
      await page.mouse.click(720, 300);
      await pause(200);
    }

    // command palette
    if (wanted("palette")) {
      await page.keyboard.press("Meta+k");
      await page.waitForSelector(".cxs-pal");
      await pause(300);
      await shot(page, "palette");
      await page.keyboard.press("Escape");
      await pause(250);
    }

    // attention queue
    if (wanted("attention")) {
      await page.locator(".cxs-attn").first().click();
      await page.waitForSelector(".cxs-attnpop");
      await pause(250);
      await shot(page, "attention");
      await page.keyboard.press("Escape");
      await pause(200);
    }

    // overview
    if (wanted("overview")) {
      await page.keyboard.press("Meta+o");
      await page.waitForSelector(".cxs-ov");
      await pause(600);
      await shot(page, "overview");
      await page.keyboard.press("Meta+o");
      await pause(400);
    }

    // text zoom
    if (wanted("zoom")) {
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Meta+Equal");
        await pause(120);
      }
      await pause(500);
      await shot(page, "zoom");
      await page.keyboard.press("Meta+0");
      await pause(400);
    }

    await ctx.close();
  }

  /* ── an agent session (its own page, so the agent chip stays out of other shots) ── */
  if (wanted("layout-agent")) {
    const { ctx, page } = await open();
    await page.waitForSelector(".cxs-shell");
    await pause(1200);
    await page.keyboard.press("Meta+2");
    await page.locator(".cx-btn--primary", { hasText: "Start agent" }).click();
    await page.waitForSelector(".cxs-ctxbar");
    // let the launch toast clear
    await pause(4500);
    await shot(page, "layout-agent");
    await ctx.close();
  }

  /* ── a worktree with a database, dirty git and no main-checkout limits ── */
  {
    const { ctx, page } = await open();
    await page.waitForSelector(".cxs-shell");
    await pause(1200);
    // second sidebar row = feature/checkout (has a db name and is dirty)
    const rows = page.locator(".cxs-wtr");
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const label = await rows.nth(i).getAttribute("title");
      if (label && label.includes("feature/checkout")) {
        await rows.nth(i).click();
        break;
      }
    }
    await pause(900);

    if (wanted("worktree-menu")) {
      await page.locator('.cxs-acts .cx-ib[title="More"]').click();
      await page.waitForSelector(".cx-pop");
      await pause(250);
      await shot(page, "worktree-menu");
      await page.keyboard.press("Escape");
      await pause(200);
    }

    if (wanted("modal-database")) {
      // the database lives in the rail's "More services and database" popover
      await page.locator(".cxs-runtime-more").click();
      await page.locator(".cxs-runtime-db").click();
      await page.waitForSelector(".cx-modal");
      await pause(350);
      await shot(page, "modal-database");
      await page.keyboard.press("Escape");
      await pause(300);
    }

    if (wanted("modal-context")) {
      await page.locator('.cxs-acts .cx-ib[title="More"]').click();
      await clickText(page, ".cx-pop__item", "Context");
      await page.waitForSelector(".cx-modal");
      await pause(400);
      await shot(page, "modal-context");
      await page.keyboard.press("Escape");
      await pause(300);
    }

    if (wanted("modal-service")) {
      await page.locator(".cxs-svc .svc-detail").first().click();
      await page.waitForSelector(".cx-modal");
      await pause(350);
      await shot(page, "modal-service");
      await page.keyboard.press("Escape");
      await pause(300);
    }

    if (wanted("modal-remove-worktree")) {
      await page.locator('.cxs-acts .cx-ib[title="More"]').click();
      await clickText(page, ".cx-pop__item", "Remove worktree");
      await page.waitForSelector(".cx-modal");
      await pause(400);
      await shot(page, "modal-remove-worktree");
      await page.keyboard.press("Escape");
      await pause(300);
    }

    if (wanted("modal-switch-branch")) {
      await page.keyboard.press("Meta+\\");
      await page.waitForSelector(".cx-modal");
      await pause(400);
      await shot(page, "modal-switch-branch");
      await page.keyboard.press("Escape");
      await pause(300);
    }

    if (wanted("modal-uncommitted")) {
      await page.locator(".cxs-gc--dirty").click();
      await page.waitForSelector(".cx-modal");
      await pause(500);
      await shot(page, "modal-uncommitted");
      await page.keyboard.press("Escape");
      await pause(300);
    }

    if (wanted("pull-menu")) {
      await page.locator(".cxs-pullcaret").click();
      await page.waitForSelector(".cxs-pullpop");
      await pause(400);
      await shot(page, "pull-menu");
      await page.keyboard.press("Escape");
      await pause(250);
    }

    if (wanted("modal-new-worktree") || wanted("modal-new-worktree-handoff")) {
      await page.keyboard.press("Meta+n");
      await page.waitForSelector(".cx-modal");
      await pause(500);
      if (wanted("modal-new-worktree")) await shot(page, "modal-new-worktree");
      if (wanted("modal-new-worktree-handoff")) {
        await page.locator(".cxm-disc summary").click();
        await pause(400);
        await shot(page, "modal-new-worktree-handoff");
      }
      await page.keyboard.press("Escape");
      await pause(250);
    }

    await ctx.close();
  }

  /* ── Settings ────────────────────────────────────────────────────── */
  {
    const PAGES = [
      ["settings-general", "General", "platform"],
      ["settings-terminal", "Terminal", "platform"],
      ["settings-notifications", "Notifications", "platform"],
      ["settings-shortcuts", "Shortcuts", "platform"],
      ["settings-advanced", "Advanced", "platform"],
      ["settings-repo", "General", "repo"],
      ["settings-services", "Services", "repo"],
      ["settings-agents", "Agents", "repo"],
      ["settings-commands", "Commands", "repo"],
      ["settings-files", "Files", "repo"],
      ["settings-setup", "Setup", "repo"],
      ["settings-security", "Security", "repo"],
    ];
    const { ctx, page } = await open();
    await page.waitForSelector(".cxs-shell");
    await pause(1000);
    await page.locator('.cxs-tb-r .cx-ib[title="Settings"]').click();
    await page.waitForSelector(".cxset-root .nav");
    await pause(700);

    // nav rows: platform pages come first, repo pages after the repository picker
    const navRows = page.locator(".nrow");
    for (const [name, label, scope] of PAGES) {
      if (!wanted(name)) continue;
      const total = await navRows.count();
      let target = null;
      for (let i = 0; i < total; i++) {
        // the row also carries a count badge / dirty dot, so compare the label span
        const text = (await navRows.nth(i).locator(".lb").innerText()).trim();
        if (text !== label) continue;
        // "General" exists twice — the first is platform, the second is the repo
        if (scope === "platform") {
          target = navRows.nth(i);
          break;
        }
        target = navRows.nth(i); // keep the last match for repo scope
      }
      if (!target) {
        console.log(`  (skipped ${name}: no nav row "${label}")`);
        continue;
      }
      await target.click();
      await pause(600);
      // open the first collapsible object so the page shows real fields
      if (name === "settings-services" || name === "settings-agents" || name === "settings-commands") {
        const head = page.locator(".ohead").first();
        if (await head.count()) {
          await head.click();
          await pause(400);
        }
      }
      await shot(page, name);
    }

    if (wanted("settings-json")) {
      await page.keyboard.press("Meta+p");
      await pause(600);
      await shot(page, "settings-json");
      await page.keyboard.press("Meta+p");
      await pause(300);
    }

    if (wanted("settings-search")) {
      await page.keyboard.press("Meta+f");
      await page.waitForSelector(".sr");
      await page.locator(".srf input").type("port", { delay: 40 });
      await pause(500);
      await shot(page, "settings-search");
      await page.keyboard.press("Escape");
      await pause(250);
    }

    await ctx.close();
  }

  /* ── Onboarding ──────────────────────────────────────────────────── */
  {
    const { ctx, page } = await open();
    await page.waitForSelector(".cxs-shell");
    await pause(900);
    await page.keyboard.press("Shift+Meta+n");
    await page.waitForSelector(".ob-root");
    await pause(700);
    if (wanted("onboarding-add")) await shot(page, "onboarding-add");
    if (wanted("onboarding-empty")) {
      await page.locator(".ofoot .ob-skip").click();
      await page.waitForSelector(".hero");
      await pause(700);
      await shot(page, "onboarding-empty");
    }
    await ctx.close();
  }

  /* ── the menu-bar popover ────────────────────────────────────────── */
  if (wanted("popover")) {
    const { ctx, page } = await open("popover.html", POPOVER_VIEW);
    await page.waitForSelector(".pop");
    await pause(2200);
    await shot(page, "popover");
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${shots} ${THEME} screenshots → assets/screens/${THEME}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
