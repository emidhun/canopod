// Static site builder — zero dependencies.
//
//   node scripts/build.mjs            build content/*.md → site/
//   node scripts/build.mjs --quiet    same, without the per-page log
//   node scripts/build.mjs --split    website → site-web/, docs → site-docs/
//
// Every page in scripts/nav.mjs must have a matching content/<slug>.md, and
// every !shot must have a light screenshot; missing ones are reported at the end
// (and rendered as a visible placeholder rather than a broken image).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NAV, FLAT } from "./nav.mjs";
import { render, frontmatter, esc } from "./md.mjs";
import { landingPage, HOME_TITLE, HOME_DESCRIPTION } from "./landing.mjs";
import { marketingPages } from "./product-pages.mjs";
import { productPage } from "./site-ui.mjs";
import { metadata, writeDiscoveryFiles } from "./seo.mjs";
import { routing } from "./urls.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = join(ROOT, "content");
const SITE = join(ROOT, "site");
const OUTPUTS = routing.split
  ? [{ section: "web", dir: join(ROOT, "site-web"), base: routing.webBase }, { section: "docs", dir: join(ROOT, "site-docs"), base: routing.docsBase }]
  : [{ section: "combined", dir: SITE, base: routing.webBase }];
const outputFor = slug => OUTPUTS.find(output => output.section === "combined" || output.section === routing.sectionFor(slug)).dir;
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
${metadata({slug, title: `${title} · Canopod docs`, description, version: VERSION})}
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
  <a class="brand" href="getting-started.html" aria-label="Canopod documentation home">
    ${BRANDMARK}
    <span>Canopod<span class="brand__d">docs</span></span>
  </a>
  <span class="ver">v${VERSION}</span>
  <nav class="docs-product-nav" aria-label="Product navigation"><a href="features.html">Product</a><a href="canopod-mcp.html">MCP</a><a href="download.html">Download</a></nav>
  <div class="search">
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
    <input id="q" type="search" placeholder="Search documentation" autocomplete="off" aria-label="Search the documentation" />
    <div id="results" class="results" hidden></div>
  </div>
  <button id="theme" class="ib" type="button" aria-label="Switch between light and dark" title="Toggle theme">
    <svg class="ic-sun" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2M12 19.4v2M2.6 12h2M19.4 12h2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M18.6 5.4l-1.4 1.4M6.8 17.2l-1.4 1.4"/></svg>
    <svg class="ic-moon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.4 8.4 0 1 0 10.5 10.5Z"/></svg>
  </button>
  <button id="menu" class="ib ib--menu" type="button" aria-label="Open documentation navigation" aria-controls="side" aria-expanded="false"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
</header>
<div class="shell">
  <aside class="side" id="side"><nav class="docs-mobile-product-nav" aria-label="Product navigation"><a href="features.html">Product</a><a href="canopod-mcp.html">MCP</a><a href="download.html">Download</a></nav><nav aria-label="Documentation navigation">${sidebar(slug)}</nav></aside>
  <main class="main" id="main">
    <article class="doc${home ? " doc--home" : ""}">
      <nav class="doc-breadcrumb" aria-label="Breadcrumb"><a href="index.html">Canopod</a><span aria-hidden="true">/</span><span aria-current="page">${esc(title)}</span></nav>
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

function redirectPage({ title, canonical, target = canonical }) {
  const destination = JSON.stringify(target).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en" data-canopod-redirect><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex,follow">
<link rel="canonical" href="${esc(canonical)}">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
<script>location.replace(${destination} + location.search + location.hash);</script></head>
<body><h1>${esc(title)}</h1><p><a href="${esc(target)}">Continue to the documentation.</a></p></body></html>\n`;
}

function build() {
  for (const output of OUTPUTS) {
    rmSync(output.dir, { recursive: true, force: true });
    mkdirSync(output.dir, { recursive: true });
  }

  const index = [];
  const discoveryPages = [];
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
    writeFileSync(join(outputFor(slug), routing.pagePath(slug)), routing.rewriteHtml(out, slug));
    discoveryPages.push({slug, title: pageTitle, description: meta.description, markdown: body});
    index.push({
      slug: routing.outputSlug(slug),
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
    if (!quiet) console.log(`  ${routing.pagePath(slug)}  (${toc.length} sections)`);
  }

  writeFileSync(join(outputFor("getting-started"), "search-index.json"), JSON.stringify(index));
  const home = landingPage(VERSION);
  writeFileSync(join(outputFor("index"), "index.html"), routing.rewriteHtml(home, "index"));
  discoveryPages.unshift({slug: "index", title: HOME_TITLE, description: HOME_DESCRIPTION, markdown: htmlToMarkdown(home.match(/<main[^>]*>([\s\S]*?)<\/main>/)[1])});
  const productPages = marketingPages(VERSION);
  for (const entry of productPages) {
    writeFileSync(join(outputFor(entry.slug), routing.pagePath(entry.slug)), routing.rewriteHtml(productPage({...entry, version: VERSION}), entry.slug));
    discoveryPages.push({...entry, markdown: htmlToMarkdown(entry.body)});
  }
  if (routing.split) {
    // Retain the original docs-home path for existing bookmarks. It is excluded
    // from discovery files, while canonical metadata points to the docs root.
    writeFileSync(join(outputFor("getting-started"), "getting-started.html"), redirectPage({
      title: "Canopod documentation has moved", canonical: routing.pageUrl("getting-started"), target: "index.html",
    }));
    // GitHub Pages redirects the old repository URL onto its custom domain.
    // Keep former /canopod/<doc>.html bookmarks working through that hop, then
    // send readers to the documentation domain without indexing duplicate pages.
    for (const { slug, title } of discoveryPages.filter(entry => routing.sectionFor(entry.slug) === "docs")) {
      writeFileSync(join(outputFor("index"), `${slug}.html`), redirectPage({
        title: `${title} — Canopod documentation`, canonical: routing.pageUrl(slug),
      }));
    }
  }

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
  for (const output of OUTPUTS) {
    const pages = discoveryPages.filter(entry => output.section === "combined" || routing.sectionFor(entry.slug) === output.section);
    const discovery = writeDiscoveryFiles({siteDir: output.dir, pages, version: VERSION, section: output.section});
    writeFileSync(join(output.dir, ".nojekyll"), "");
    if (routing.split) writeFileSync(join(output.dir, "CNAME"), `${new URL(output.base).hostname}\n`);
    if (output.section !== "docs") {
      copyFileSync(join(THEME, "landing.css"), join(output.dir, "landing.css"));
      copyFileSync(join(THEME, "landing.js"), join(output.dir, "landing.js"));
    }
    if (output.section !== "web") {
      writeFileSync(join(output.dir, "styles.css"), css);
      copyFileSync(join(THEME, "app.js"), join(output.dir, "app.js"));
    }
    const fonts = copyDir(join(ROOT, "assets", "fonts"), join(output.dir, "assets", "fonts"));
    copyDir(join(ROOT, "assets", "icons"), join(output.dir, "assets", "icons"));
    const shots = copyDir(SHOTS, join(output.dir, "assets", "screens"));
    if (!quiet && fonts) console.log(`  ${fonts} font files, skin "${skin}"`);
    console.log(`Built ${pages.length} pages, ${shots} screenshot files → ${output.dir.slice(ROOT.length + 1)}/`);
    console.log(`Discovery: ${discovery.pages} canonical URLs at ${discovery.siteUrl}, sitemap, Markdown copies and llms files.`);
  }
  if (missingShots.size) console.log(`Missing light screenshots (${missingShots.size}): ${[...missingShots].join(", ")}`);
  if (missingDark.size) console.log(`Missing dark screenshots (${missingDark.size}): ${[...missingDark].join(", ")}`);
  if (!missingShots.size && !missingDark.size) console.log("Every screenshot resolves in both themes.");
}

// Derive machine-readable product copy from the same HTML visitors see.
// There is no separate hidden marketing article to keep in sync.
function htmlToMarkdown(html) {
  const codeBlocks = [];
  const decode = value => value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = html
    .replace(/<(svg|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
      codeBlocks.push(decode(code.replace(/<[^>]*>/g, "")));
      return `\n\nCANOPODCODEBLOCK${codeBlocks.length - 1}END\n\n`;
    })
    .replace(/(^|>)([ \t]*)#/g, "$1$2\\#")
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => ` [${label.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()}](${href}) `)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, heading) => `\n\n${"#".repeat(Number(level))} ${heading}\n\n`)
    .replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/gi, (_, alt) => `\n${alt}\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<\/(?:p|div|section|article|figure|li|dt|dd|ol|ul|summary)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  return decode(text).split("\n").map(line => line.replace(/[ \t]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim()
    .replace(/CANOPODCODEBLOCK(\d+)END/g, (_, number) => "```\n" + codeBlocks[Number(number)].trim() + "\n```");
}

build();
