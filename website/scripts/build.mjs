// Static site builder — zero dependencies.
//
//   node scripts/build.mjs            build content/*.md → site/
//   node scripts/build.mjs --quiet    same, without the per-page log
//
// Every page in scripts/nav.mjs must have a matching content/<slug>.md, and
// every !shot must have a light screenshot; missing ones are reported at the end
// (and rendered as a visible placeholder rather than a broken image).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NAV, FLAT } from "./nav.mjs";
import { render, frontmatter, esc } from "./md.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = join(ROOT, "content");
const SITE = join(ROOT, "site");
const THEME = join(ROOT, "theme");
const SHOTS = join(ROOT, "assets", "screens");
const quiet = process.argv.includes("--quiet");

const VERSION = "0.5.0";

/* The canonical Canopod brandmark, copied from the brand sheet (24u grid, 2u
   stroke): two parents bracketed into one child. The ink strokes take
   `currentColor` so the mark follows the page's text colour in either theme,
   while the nodes keep the fixed brand teal they have in the app icon. */
const BRANDMARK = `<svg class="brandmark" viewBox="0 0 24 24" width="20" height="20" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M7 8v1.5a2.5 2.5 0 0 0 2.5 2.5h5a2.5 2.5 0 0 0 2.5 -2.5v-1.5" />
      <path d="M12 12v4" />
      <g stroke="#58c2c8"><circle cx="7" cy="6" r="2.05" /><circle cx="17" cy="6" r="2.05" /><circle cx="12" cy="18" r="2.05" /></g>
    </svg>`;
const missingShots = new Set();
const missingDark = new Set();

/** PNG intrinsic size, straight out of the IHDR chunk (bytes 16–24). */
function pngSize(file) {
  try {
    const head = readFileSync(file).subarray(16, 24);
    return { w: head.readUInt32BE(0), h: head.readUInt32BE(4) };
  } catch {
    return null;
  }
}

function shotFigure(slug, caption) {
  const light = join(SHOTS, "light", `${slug}.png`);
  const dark = join(SHOTS, "dark", `${slug}.png`);
  const hasLight = existsSync(light);
  const hasDark = existsSync(dark);
  if (!hasLight) missingShots.add(slug);
  if (hasLight && !hasDark) missingDark.add(slug);
  const cap = caption ? `<figcaption>${esc(caption)}</figcaption>` : "";
  if (!hasLight) {
    return `<figure class="shot shot--pending"><div class="shot__ph">screenshot pending — <code>${esc(slug)}</code></div>${cap}</figure>`;
  }
  const alt = esc(caption || slug.replace(/-/g, " "));
  // Captures are taken at deviceScaleFactor 2, so half the pixel size is the
  // size the UI actually had. Emitting it keeps a small surface (the 336px-wide
  // popover) from being blown up to the width of the content column — and gives
  // the browser the aspect ratio up front, so nothing reflows as images load.
  const size = pngSize(light);
  const dims = size ? ` width="${Math.round(size.w / 2)}" height="${Math.round(size.h / 2)}"` : "";
  const imgs =
    `<img class="shot__img shot__img--light" src="assets/screens/light/${slug}.png" alt="${alt}"${dims} loading="lazy" />` +
    (hasDark
      ? `<img class="shot__img shot__img--dark" src="assets/screens/dark/${slug}.png" alt="${alt}"${dims} loading="lazy" />`
      : "");
  return `<figure class="shot">${imgs}${cap}</figure>`;
}

function sidebar(currentSlug) {
  return NAV.map((g) => {
    const items = g.items
      .map(([slug, label]) => {
        const on = slug === currentSlug ? ' class="on" aria-current="page"' : "";
        return `<li><a href="${slug}.html"${on}>${esc(label)}</a></li>`;
      })
      .join("");
    return `<div class="navgrp"><p class="navgrp__t">${esc(g.group)}</p><ul>${items}</ul></div>`;
  }).join("");
}

function tocList(toc) {
  if (toc.length < 2) return "";
  const items = toc
    .map((h) => `<li class="lv${h.level}"><a href="#${h.id}">${esc(h.text)}</a></li>`)
    .join("");
  return `<nav class="toc" aria-label="On this page"><p class="toc__t">On this page</p><ul>${items}</ul></nav>`;
}

function page({ slug, title, description, bodyHtml, toc, prev, next, home }) {
  const prevLink = prev
    ? `<a class="pn pn--prev" href="${prev.slug}.html"><span>Previous</span><b>${esc(prev.label)}</b></a>`
    : "<span></span>";
  const nextLink = next
    ? `<a class="pn pn--next" href="${next.slug}.html"><span>Next</span><b>${esc(next.label)}</b></a>`
    : "<span></span>";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} · Canopod docs</title>
<meta name="description" content="${esc(description || "")}" />
<link rel="icon" type="image/png" sizes="32x32" href="assets/icons/favicon-32.png" />
<link rel="icon" type="image/png" sizes="128x128" href="assets/icons/favicon-128.png" />
<link rel="apple-touch-icon" href="assets/icons/apple-touch-icon.png" />
<link rel="stylesheet" href="styles.css" />
<script>
  // Set the theme before first paint so there is no flash of the wrong palette.
  try {
    var t = localStorage.getItem("canopoddocs.theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch (e) {}
</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="hd">
  <a class="brand" href="index.html">
    ${BRANDMARK}
    <span>Canopod<span class="brand__d">docs</span></span>
  </a>
  <span class="ver">v${VERSION}</span>
  <div class="search">
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
    <input id="q" type="search" placeholder="Search documentation" autocomplete="off" aria-label="Search the documentation" />
    <div id="results" class="results" hidden></div>
  </div>
  <button id="theme" class="ib" type="button" aria-label="Switch between light and dark" title="Toggle theme">
    <svg class="ic-sun" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2M12 19.4v2M2.6 12h2M19.4 12h2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M18.6 5.4l-1.4 1.4M6.8 17.2l-1.4 1.4"/></svg>
    <svg class="ic-moon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.4 8.4 0 1 0 10.5 10.5Z"/></svg>
  </button>
  <button id="menu" class="ib ib--menu" type="button" aria-label="Menu"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
</header>
<div class="shell">
  <aside class="side" id="side">${sidebar(slug)}</aside>
  <main class="main" id="main">
    <article class="doc${home ? " doc--home" : ""}">
${bodyHtml}
      <div class="pnrow">${prevLink}${nextLink}</div>
      <footer class="foot">
        <p>Documentation for Canopod ${VERSION}. Controls marked <em>coming soon</em> are present in
        the interface but have no implementation behind them yet.</p>
      </footer>
    </article>
    ${home ? "" : tocList(toc)}
  </main>
</div>
<script src="app.js"></script>
</body>
</html>
`;
}

function copyDir(from, to) {
  if (!existsSync(from)) return 0;
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) n += copyDir(src, dst);
    else {
      copyFileSync(src, dst);
      n++;
    }
  }
  return n;
}

function build() {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });

  const index = [];
  for (let n = 0; n < FLAT.length; n++) {
    const { slug, label } = FLAT[n];
    const file = join(CONTENT, `${slug}.md`);
    if (!existsSync(file)) {
      console.error(`  MISSING content/${slug}.md (listed in nav)`);
      continue;
    }
    const { meta, body } = frontmatter(readFileSync(file, "utf8"));
    const { html, toc, title } = render(body, shotFigure);
    const pageTitle = meta.title || title || label;
    const out = page({
      slug,
      title: pageTitle,
      description: meta.description,
      bodyHtml: html,
      toc,
      prev: n > 0 ? FLAT[n - 1] : null,
      next: n < FLAT.length - 1 ? FLAT[n + 1] : null,
      // the landing page skips the table of contents: it's a set of doors, not
      // a document you read down
      home: meta.layout === "home",
    });
    writeFileSync(join(SITE, `${slug}.html`), out);
    index.push({
      slug,
      title: pageTitle,
      group: FLAT[n].group,
      description: meta.description || "",
      headings: toc.map((h) => h.text),
      text: body
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/[#>*`|_-]/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 1800),
    });
    if (!quiet) console.log(`  ${slug}.html  (${toc.length} sections)`);
  }

  writeFileSync(join(SITE, "search-index.json"), JSON.stringify(index));

  // Stylesheet = the base layout plus a skin appended after it, so a skin only
  // has to restate the tokens (and the few rules) it changes.
  //   SKIN=native node scripts/build.mjs      (or editorial | terminal | docs)
  // "docs" is the bare base with no skin — the plain look the site started as.
  const skin = process.env.SKIN || "studio";
  const skinFile = join(THEME, "skins", `${skin}.css`);
  let css = readFileSync(join(THEME, "styles.css"), "utf8");
  if (skin !== "docs") {
    if (!existsSync(skinFile)) {
      console.error(`  unknown skin "${skin}" — no theme/skins/${skin}.css`);
      process.exit(1);
    }
    css += `\n\n/* ── skin: ${skin} ─────────────────────────────────── */\n` + readFileSync(skinFile, "utf8");
  }
  writeFileSync(join(SITE, "styles.css"), css);
  copyFileSync(join(THEME, "app.js"), join(SITE, "app.js"));

  const fonts = copyDir(join(ROOT, "assets", "fonts"), join(SITE, "assets", "fonts"));
  copyDir(join(ROOT, "assets", "icons"), join(SITE, "assets", "icons"));
  const shots = copyDir(SHOTS, join(SITE, "assets", "screens"));
  if (!quiet && fonts) console.log(`  ${fonts} font files, skin "${skin}"`);

  console.log(`\nBuilt ${index.length} pages, ${shots} screenshot files → site/`);
  if (missingShots.size) console.log(`Missing light screenshots (${missingShots.size}): ${[...missingShots].join(", ")}`);
  if (missingDark.size) console.log(`Missing dark screenshots (${missingDark.size}): ${[...missingDark].join(", ")}`);
  if (!missingShots.size && !missingDark.size) console.log("Every screenshot resolves in both themes.");
}

build();
