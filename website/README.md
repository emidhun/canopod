# Canopy documentation

The documentation website for [Canopy](https://github.com/emidhun/canopy) — a menu-bar
git-worktree and dev-service manager. Written from the app's own source at version **0.5.0**, so
anything not yet wired up is documented as such rather than described as if it worked.

## Build and preview

No dependencies. No `npm install`.

```sh
node scripts/build.mjs      # content/*.md → site/
node scripts/serve.mjs      # http://localhost:4180, rebuilds on every page load
```

## Layout

```text
plan.md                  the plan this repo was built to, including the feature inventory
content/*.md             33 pages of documentation (Markdown + a few shortcodes)
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
```

## Looks

The base stylesheet owns the layout. A skin is appended after it and restates
only the tokens and rules it changes, so a new one is a short file rather than a
fork.

```sh
node scripts/build.mjs                  # studio, the default
SKIN=native node scripts/build.mjs      # Canopy's own tokens and fonts
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

Every screenshot comes from the **real UI**, not a mockup. In a plain browser Canopy's
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
before first paint, so the two sets differ only in palette. Environment: `CANOPY_REPO` (default: the repository root, one level up), `CANOPY_URL` (default `http://localhost:1420`), `THEME`, `ONLY`.

## Deploying

`node scripts/build.mjs` produces a directory of relative-linked static HTML — every link and
asset path is relative, so it works from any host and from any sub-path (`user.github.io/canopy/`
needs no base-path config).

**GitHub Pages, free.** The workflow in [`.github/workflows/docs.yml`](../.github/workflows/docs.yml)
builds `website/` on the runner and publishes `site/` — nothing is committed, and there is nothing
to install (the content is Markdown, the generator is plain Node). It runs on any push to `main`
that touches `website/`, and can be triggered by hand from the Actions tab. On pull requests it
builds and asserts the output but does not deploy.

One-time setup on the repository: **Settings → Pages → Build and deployment → Source: GitHub
Actions**. After the first run the site is live at `https://emidhun.github.io/canopy/`. Pages is
free for public repositories (and included on every plan for private ones).

The workflow ends with a `touch site/.nojekyll` step — without it Pages runs the output through
Jekyll and drops the files and folders it does not recognise.

## Conventions

- **Accuracy over completeness.** Every claim traces to the app's source. Where a surface exists
  but has no backend, the page says *coming soon* exactly as the app does.
- **Screenshots earn their place.** They show a real state, and the caption says what to look at.
- **Both themes, always.** A page is not finished until its screenshots exist in `light/` **and**
  `dark/` under the same filename.

The written guides target 0.5.0. Some screenshot illustrations were captured before the workspace refinements; follow the current control names and shortcuts in the text.
