# Canopod website

The product website and documentation for [Canopod](https://github.com/emidhun/canopod) — a menu-bar
git-worktree and dev-service manager. Written from the app's own source at version **0.5.0**, so
anything not yet wired up is documented as such rather than described as if it worked.

## Build and preview

No dependencies. No `npm install`.

```sh
node scripts/build.mjs      # content/*.md → site/
node scripts/check.mjs      # links, metadata, structured data, discovery, controls
node scripts/serve.mjs      # http://localhost:4180, rebuilds on every page load

# Separate production domains:
node scripts/build.mjs --split
node scripts/check.mjs --split
```

Production publishes the product site at `https://canopod.com/` and documentation at
`https://docs.canopod.com/`. See [DEPLOYMENT.md](DEPLOYMENT.md) for the two GitHub Pages
repositories, deployment steps, and the exact Namecheap DNS records.

## Layout

```text
plan.md                  the plan this repo was built to, including the feature inventory
content/*.md             34 pages of documentation (Markdown + a few shortcodes)
scripts/landing.mjs       product homepage, benefits, interactive examples and downloads
scripts/product-pages.mjs product, MCP, workflow and download pages
scripts/site-ui.mjs       shared navigation, footer and product-page layout
scripts/sections.mjs      shared homepage MCP and download sections
scripts/seo.mjs           canonical metadata, JSON-LD, sitemap and text exports
scripts/check.mjs         validates all generated pages and discovery output
theme/landing.css         responsive homepage design, independent of documentation skins
theme/landing.js          accessible example/platform tabs, mobile navigation, install-copy action
scripts/nav.mjs          the information architecture — sidebar order and prev/next
scripts/md.mjs           the Markdown renderer (a deliberate subset)
scripts/build.mjs        content + theme + screenshots → site/
scripts/serve.mjs        dev server
scripts/screenshots.mjs  captures every screenshot from the real UI via Playwright
theme/styles.css         base layout, light-first palette, dark by token override
theme/skins/*.css        looks: studio (default), native, editorial, terminal
theme/app.js             theme toggle, search, TOC highlighting
assets/fonts/            Inter + JetBrains Mono, vendored from the app (88 KB)
assets/screens/light/    40 light-mode screenshots
assets/screens/dark/     40 dark-mode screenshots (same filenames)
site/                    build output (not committed — regenerate with scripts/build.mjs)
site-web/                split website output for canopod.com (ignored)
site-docs/               split documentation output for docs.canopod.com (ignored)
```

`index.html` is the product homepage; `getting-started.html` is the documentation home.
The product site also includes `features.html`, `canopod-mcp.html`, `workflows.html`, and
`download.html`. `mcp.html` remains the detailed setup guide and 15-tool reference.
The homepage uses a real app screenshot, existing local fonts and brandmark. The terminal, log,
and agent-handoff feature cards are responsive HTML/CSS examples, labeled as illustrations rather
than live application state. All asset and documentation paths stay relative, so the whole site
also works under the GitHub Pages subpath.
The version in `scripts/build.mjs` controls both documentation labels and homepage release links.
Downloads use the same release filenames documented in the repository README. No third-party
scripts, analytics, fonts, or runtime dependencies are added.

## Search and AI discovery

All 39 pages are rendered as complete static HTML. Each has a unique title and description,
canonical URL, Open Graph and Twitter text metadata, a Markdown alternate, and JSON-LD for the
website and page. Inner pages include breadcrumbs. The homepage also describes Canopod as a free
SoftwareApplication, with platform limitations and no invented ratings.

The build generates `sitemap.xml`, `robots.txt`, `llms.txt`, `llms-full.txt`, and `content/<slug>.md`.
Product text exports come from the visible HTML; documentation exports use the same Markdown source
as the pages. `llms.txt` is an optional reading convenience, not a standard required by search
engines or a guarantee of AI recommendations.

Combined builds use the canonical base `https://emidhun.github.io/canopod/`. Split builds default
to `https://canopod.com/` for marketing pages and `https://docs.canopod.com/` for documentation.
`CANOPOD_SITE_URL` and `CANOPOD_DOCS_URL` override those production bases; use identical values
for build and checks. The website workflow reads repository variables with those names.
Do not set them to localhost. The local preview deliberately shows deployment canonical URLs.
Each split output has its own sitemap, robots file, metadata, Markdown copies and AI reading index.

After publishing:

- Verify the public pages and sitemap are reachable, then submit the sitemap in Google Search Console
  and the search management tools you use. Account ownership verification must be done in those services.
- On a root-domain deployment, the generated `robots.txt` is in the correct location. On GitHub Pages
  under `/canopod/`, crawlers only use the **origin-root** `/robots.txt`; add a sitemap reference there
  if you control that separate site, or submit the sitemap directly. The generated subpath file
  documents this limitation and does not override root crawling rules.
- When the domain changes, rebuild with the new canonical base and configure redirects on the host.
- Measure actual search impressions and performance after deployment. Passing local checks does not
  guarantee indexing, rankings, rich results, or inclusion in AI answers.

This follows [Google's AI search guidance](https://developers.google.com/search/docs/appearance/ai-features):
the useful foundations are accessible pages, crawlable links, clear text and accurate structured data.
The site avoids keyword stuffing, fabricated reviews, hidden articles, and invented modification dates.

## Looks

The base stylesheet owns the layout. A skin is appended after it and restates
only the tokens and rules it changes, so a new one is a short file rather than a
fork.

```sh
node scripts/build.mjs                  # studio, the default
SKIN=native node scripts/build.mjs      # Canopod's own tokens and fonts
SKIN=editorial node scripts/build.mjs   # serif headings, warm paper
SKIN=terminal node scripts/build.mjs    # mono throughout, sharp corners
SKIN=docs node scripts/build.mjs        # the bare base, no skin
```

Every skin has to define its palette twice over: once on bare `:root` for light,
once under both `@media (prefers-color-scheme: dark)` (guarded with
`:root:not([data-theme="light"])`) and `:root[data-theme="dark"]`, so the toggle
wins in either direction.

## Content shortcodes

Beyond ordinary Markdown (headings, lists, tables, fenced code, blockquotes):

```markdown
:::note Optional title
A callout. Also :::tip, :::warn, :::danger.
:::

!shot main-worktree | An optional caption.
```

`!shot <slug>` emits a theme-aware figure: the light capture, the dark capture, and CSS that shows
whichever matches the page's theme. A slug with no capture renders a visible placeholder and is
reported by the build, so a missing screenshot cannot ship silently.

## Screenshots

Every screenshot comes from the **real UI**, not a mockup. In a plain browser Canopod's
`hasBackend()` is false, so it runs on `src/mock.ts` with three repositories and five worktrees —
enough to show every surface.

```sh
# from the repository root
npm run dev                                  # Vite on :1420

# from website/
node scripts/screenshots.mjs                 # light → assets/screens/light/
THEME=dark node scripts/screenshots.mjs      # dark  → assets/screens/dark/
ONLY=palette,overview node scripts/screenshots.mjs   # a subset, while iterating
node scripts/build.mjs
```

Both runs use the same viewport and the same mock data and seed the theme into `localStorage`
before first paint, so the two sets differ only in palette. Environment: `CANOPOD_REPO` (default: the repository root, one level up), `CANOPOD_URL` (default `http://localhost:1420`), `THEME`, `ONLY`.

## Deploying

`node scripts/build.mjs` produces a directory of relative-linked static HTML — every link and
asset path is relative, so it works from any host and from any sub-path (`user.github.io/canopod/`
needs no base-path config).

**GitHub Pages, free.** The workflow in [`.github/workflows/docs.yml`](../.github/workflows/docs.yml)
builds `website/` on the runner and publishes `site/` — nothing is committed, and there is nothing
to install (the content is Markdown, the generator is plain Node). It runs on any push to `main`
that touches `website/`, and can be triggered by hand from the Actions tab. On pull requests it
builds and asserts the output but does not deploy.

One-time setup on the repository: **Settings → Pages → Build and deployment → Source: GitHub
Actions**. After the first run the site is live at `https://emidhun.github.io/canopod/`. Pages is
free for public repositories (and included on every plan for private ones).

The workflow ends with a `touch site/.nojekyll` step — without it Pages runs the output through
Jekyll and drops the files and folders it does not recognise.

## Conventions

- **Accuracy over completeness.** Every claim traces to the app's source. Where a surface exists
  but has no backend, the page says *coming soon* exactly as the app does.
- **Screenshots earn their place.** They show a real state, and the caption says what to look at.
- **Both themes, always.** A page is not finished until its screenshots exist in `light/` **and**
  `dark/` under the same filename.
