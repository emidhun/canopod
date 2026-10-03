# Development & build

## Prerequisites (this machine)
- **Rust** (rustup) — `source "$HOME/.cargo/env"` to put `cargo` on PATH.
- **Node 22+** — the asdf default here is **18** (too old for Vite). Use Node 22 explicitly:
  ```sh
  export PATH="$HOME/.asdf/installs/nodejs/v22.15.1/bin:$PATH"
  ```
  (asdf stores it v-prefixed: `v22.15.1`.) The project has a `.tool-versions` pinning `nodejs v22.15.1`.
- **Xcode Command Line Tools** (for codesign).
- For running ToolJet itself: git, Postgres, and the repo's `.worktreemanager.json`.

Standard preamble for any build command:
```sh
export PATH="$HOME/.asdf/installs/nodejs/v22.15.1/bin:$PATH" && source "$HOME/.cargo/env"
```

## Commands
```sh
npm install
npm run dev            # vite only
npm run tauri dev      # full app (both windows + tray); rebuilds on src-tauri changes
npm run build          # type-check + vite build (frontend)
cargo check            # from src-tauri/ — fast Rust check
cargo test --lib       # from src-tauri/ — unit tests
npm run tauri build    # release .app (see DMG note below)
```

## Dependency security

Dependabot monitors npm, Cargo and GitHub Actions dependencies. The `security` job in
`.github/workflows/ci.yml` runs the RustSec audit against the committed `src-tauri/Cargo.lock` on
pull requests and pushes to `main`; known vulnerabilities fail the job.

Run the same check locally with `cargo audit --file src-tauri/Cargo.lock` when `cargo-audit` is
installed. Do not dismiss an advisory merely to make CI green. Upgrade to a patched compatible
release where possible. If a framework blocks the upgrade, use a minimal reviewed backport pinned to
an immutable Git commit, document why it exists in `Cargo.toml`, and remove it when the supported
framework line includes the fix.

## Building a release DMG (important workarounds)
0. **Official releases come from CI** — pushing a `v*` tag builds draft macOS, Linux and Windows
   packages via `.github/workflows/release.yml`, then runs packaged smoke checks in that same workflow.
   The packaged smoke starts the GUI-free backend, registers a temporary repository,
   enables read-only MCP, verifies protocol/prompt/tool discovery and typed cached
   status, enforces the 50 ms warm p95 budget, then launches the desktop app
   against those exact draft assets. A release stays draft when any install, version or launch
   probe fails. The steps below are for local one-off builds.
   CI reads the updater private key from the `TAURI_SIGNING_PRIVATE_KEY` repository secret and
   publishes signed updater bundles plus `latest.json`. Keep an offline backup of that key: losing
   it permanently prevents existing installations from accepting future updates. For a local signed
   bundle, set `TAURI_SIGNING_PRIVATE_KEY` to the key contents and add
   `--config src-tauri/tauri.release.conf.json` to `tauri build`. Ordinary local builds intentionally
   omit updater artifacts and do not need the release key. This passwordless project key also needs
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""` set explicitly so the signer never opens an interactive
   password prompt in CI.
1. **Build app-only locally.** Tauri's `bundle_dmg.sh` step **hangs** on this machine (it drives
   Finder/AppleScript), so pass `--bundles app`: `npm run tauri build -- --bundles app`
   (CI runners bundle the DMG fine).
2. **Signing is automatic** — `bundle.macOS.signingIdentity: "-"` in `tauri.conf.json` makes Tauri
   run a real ad-hoc `codesign` pass. (The linker's default per-binary signature seals resource
   metadata that doesn't survive copying the app off a DMG → "damaged". Never again.) Verify:
   ```sh
   codesign --verify --deep --strict src-tauri/target/release/bundle/macos/Canopod.app
   ```
3. **Make the DMG with hdiutil** (not bundle_dmg):
   ```sh
   STAGE=/tmp/canopod-dmg; rm -rf "$STAGE" ~/Desktop/Canopod-0.3.0-arm64.dmg; mkdir -p "$STAGE"
   cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
   hdiutil create -volname Canopod -srcfolder "$STAGE" -ov -format UDZO ~/Desktop/Canopod-0.3.0-arm64.dmg
   rm -rf "$STAGE"
   ```
4. Relaunch: `pkill -f "Canopod.app"; open "$APP"`.

The full one-shot block is what the assistant runs each ship; keep it together.

## App icon
Regenerated from a 1024px PNG (dark squircle + Canopod mark) via `npm run tauri icon <png>` →
`src-tauri/icons/*` (incl. `.icns`/`.ico`). Source PNG: `design/canopod-appicon-1024.png`. The
icon HTML used to render it is ephemeral (`/tmp/canopod-appicon.html` in history). Android/iOS icon
dirs are deleted (macOS-only).

## Visual verification without the GUI
Screenshots of the live NSPanel are unreliable (Screen Recording perms). To eyeball UI, serve `dist`
and headless-render with Chrome:
```sh
python3 -m http.server 4173 --directory dist &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --window-size=1240,800 --screenshot=/tmp/app.png http://localhost:4173/index.html
```
Note: in a plain browser the app falls back to **mock data** (`src/mock.ts`); `hasBackend()` is false.
Some UI (e.g. the database bar) only shows when a worktree has a `dbName`.

## Gotchas that have bitten us (read before debugging)
- **Node 18 vs 22.** asdf default is 18; ToolJet's server is `engine-strict` Node 22.15.1. Canopod
  prepends the worktree's pinned Node (`toolchain.rs`) for setup/service/reset/migrate/teardown. Don't
  remove that or installs fail with `notsup`.
- **Plugins must be built per worktree.** ToolJet server imports `@tooljet/plugins/dist/server`; setup
  must `npm --prefix plugins install && npm --prefix plugins run build` or migrations fail with
  `Cannot find module @tooljet/plugins/dist/server`.
- **`TOOLJET_SERVER_PORT`.** The frontend bakes the server URL at webpack launch from
  `process.env.TOOLJET_SERVER_PORT` (falls back to 3000). It's set in the worktree `.env` via the
  `env` block (`${WT_SERVER_PORT}`). The frontend's *own* port needs `--port $PORT` in its command.
- **`pg_dump` version.** Snapshot/export must use binaries **matching the server's major version**.
  PATH's `pg_dump` here is 14 (too old → refuses to dump a 16 server), but the newest (Postgres.app
  `latest` = 17) is also wrong: a 17 dump emits `SET transaction_timeout` (a PG17 GUC) and a newer
  archive format that a 16 server/pg_restore rejects on restore. `db.rs` now queries the live server
  (`SHOW server_version_num`) and `pg_path_prefix_for(major)` prefers `Postgres.app/Versions/<major>/bin`,
  falling back to the newest only when no exact match is installed.
- **BSD `sed`** doesn't support `0,/re/` (GNU-ism). Use perl/python or the Edit tool for one-shot
  in-place edits in scripts.
- **`tauri build` DMG hang** — see above; bundle app-only + hdiutil.
