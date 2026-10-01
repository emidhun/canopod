---
title: Building a release
description: How a Canopy release is built, signed and published, and how this documentation is built and deployed.
---

# Building a release

Two production paths here: shipping Canopy itself, and building and deploying this documentation site.

## Releasing Canopy

### The release pipeline

Push a tag matching `v*` and `.github/workflows/release.yml` builds installers on three runners in
parallel, then creates a **draft** GitHub release:

| Runner | Target | Artifacts |
|---|---|---|
| `macos-latest` | `--target aarch64-apple-darwin` | `.app`, `.dmg` (Apple Silicon) |
| `ubuntu-latest` | default | `.deb`, `.rpm`, `.AppImage` |
| `windows-latest` | default | NSIS `.exe` |

`fail-fast` is off, so an untested port failing to build doesn't cost you the macOS artifact. The job
needs `contents: write`, because the default token on a new repository is read-only.

### Cutting a release

```sh
# 1. bump the version consistently
#    package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json
#    and the canopy package entry in src-tauri/Cargo.lock

# 2. verify locally
npm run build && npm run csp:check
cd src-tauri && cargo test --locked && cargo clippy --all-targets --features devtools --locked -- -D warnings && cd ..

# 3. commit, tag, push
git commit -am "Bump version to 0.4.8"
git tag v0.4.8
git push origin main --tags

# 4. the workflow builds; review the draft release, then publish
```

Keep all four version records in step. `tauri.conf.json` is what the app reports in Settings →
Advanced and in the popover's footer.

### What CI checks on every push

`.github/workflows/ci.yml` runs three jobs, and the non-macOS ones exist for a specific reason: to
compile the platform code paths a macOS `cargo check` never sees.

| Job | Compiles / checks |
|---|---|
| `linux` | The `cfg(not(macos))` paths (tray fallback, `xdg-open`, terminal detection), plus clippy, `cargo test`, and the CSP render check in headless Chromium. |
| `windows` | The `cfg(windows)` paths: Job Object process control, Git Bash, Windows Node and Postgres paths. |
| `macos` | Mirrors local development. |

The CSP check answers a question nothing else in the pipeline can: does the app actually paint under
the shipped Content-Security-Policy? `cargo test` never loads a webview, `tauri dev` runs under the
development CSP, and `tauri build` proves the bundle compiles and signs rather than that it renders.
The failure it catches is a blank window on first launch of a release build.

### Building a DMG locally

CI is the normal path. For a one-off local build:

```sh
export PATH="$HOME/.asdf/installs/nodejs/v22.15.1/bin:$PATH" && source "$HOME/.cargo/env"

# 1. app bundle only — the DMG step hangs locally (it drives Finder via AppleScript)
npm run tauri build -- --bundles app

# 2. verify the ad-hoc signature
codesign --verify --deep --strict src-tauri/target/release/bundle/macos/Canopy.app

# 3. make the DMG with hdiutil
APP=src-tauri/target/release/bundle/macos/Canopy.app
STAGE=/tmp/canopy-dmg; rm -rf "$STAGE" ~/Desktop/Canopy-0.4.7-arm64.dmg; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
hdiutil create -volname Canopy -srcfolder "$STAGE" -ov -format UDZO ~/Desktop/Canopy-0.4.7-arm64.dmg
rm -rf "$STAGE"
```

Signing happens automatically: `bundle.macOS.signingIdentity: "-"` in `tauri.conf.json` makes Tauri run
a real ad-hoc `codesign` pass, which is what stops the app reporting as "damaged" after being copied
off a DMG.

### Signing and notarization

Current builds are ad-hoc signed, not notarized, and arm64 only. That's why installing from the DMG
needs one `xattr -dr com.apple.quarantine` (see [Install on macOS](install-macos.html)).

Getting rid of the warning properly needs an Apple Developer Program membership:

1. Create a *Developer ID Application* certificate.
2. Configure the identity plus notarization credentials (Apple ID or API key, team id) in the build
   environment.
3. `tauri build` then signs and submits to the notary service. Staple the ticket afterwards.

The DMG then opens with a double-click, no Terminal and no warnings. Do it under an organisation
account rather than borrowing personal credentials.

### Why not the Mac App Store

Canopy can't be sandboxed. It spawns arbitrary process trees (`npm`, `git`, `webpack`, `killpg`),
touches arbitrary filesystem paths since worktrees live wherever you put them, and uses private window
APIs (`NSPanel`, `macOSPrivateApi`) for the menu-bar popover. All three are disallowed or crippled by
the App Store sandbox, which is why most developer tools ship outside it.

### Universal (Intel + Apple Silicon)

Not built. It would need the `x86_64-apple-darwin` target and
`tauri build --target universal-apple-darwin`.

### Security posture

A strict Content-Security-Policy ships in `tauri.conf.json`: `default-src 'self'`, `script-src 'self'`
with no `unsafe-inline` in production, `connect-src ipc: http://ipc.localhost`, `object-src 'none'`,
`frame-src 'none'`. A Rust test asserts the policy still carries those directives, and the CI render
check proves the app works under it.

The Tauri capability set is the default one plus what the app actually uses: dialog, opener, and fs for
the paths it reads.

Canopy has no telemetry or analytics. In `0.5.0`, update checks are opt-in and contact GitHub only
when enabled or run manually. The local application API binds to loopback, and MCP remains disabled
until the user explicitly enables it.

## Building and deploying this documentation

The site has no dependencies on purpose: content is Markdown, the renderer is about 200 lines of Node,
and the output makes no external requests.

```sh
node scripts/build.mjs      # content/*.md → site/
node scripts/serve.mjs      # dev server on http://localhost:4180 (rebuilds per page load)
```

Nothing to install. No `npm install`, no lockfile, no CDN at runtime.

### Deploying to GitHub Pages

```yaml
# .github/workflows/pages.yml
name: pages
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: node scripts/build.mjs
      - run: touch site/.nojekyll
      - uses: actions/upload-pages-artifact@v3
        with: { path: site }
      - id: deploy
        uses: actions/deploy-pages@v4
```

`.nojekyll` matters. Without it, GitHub Pages runs Jekyll and drops files it doesn't recognise.

Any static host works the same way, since the output is a directory of relative-linked HTML.

### Documentation screenshots

Every screenshot on this site comes from the real UI in
[mock mode](dev-setup.html#mock-mode), not from a mockup:

```sh
# in the Canopy repo
npm run dev                                    # Vite on :1420

# in this repo
node scripts/screenshots.mjs                   # light theme  → assets/screens/light/
THEME=dark node scripts/screenshots.mjs        # dark theme   → assets/screens/dark/
node scripts/build.mjs                         # rebuild with both sets wired up
```

The script drives Chromium through Playwright (resolved from the Canopy repo's `node_modules`), seeds
`localStorage` with the theme before load, then walks each surface (layouts, dialogs, menus, every
Settings page) and writes one PNG per shot. Both runs use the same viewport and the same mock data, so
the light and dark sets differ only in palette. Filenames match across the two directories, and the
layout swaps them by theme.

Both sets are captured in full, one after the other, light first and then dark, so the two can't end up
half-mixed.
