# Contributing to Canopod

Thanks for your interest! Canopod is a Tauri 2 (Rust) + React app.

## Dev setup

Prerequisites: **Rust** (rustup), **Node 22+**. Then:

```sh
npm install
npm run tauri dev      # full app (both windows + tray); rebuilds on src-tauri changes
```

More detail — including release builds, signing, and macOS gotchas — in
[docs/development.md](docs/development.md).

## Before you open a PR

```sh
npx tsc --noEmit                 # frontend types
npm run build                    # frontend build
cargo check && cargo test        # from src-tauri/
```

CI runs the same on ubuntu + macos — the ubuntu job exists to keep the
`cfg(not(target_os = "macos"))` code paths compiling, so please don't skip it.

## Conventions

- Commit subjects: imperative, lower-case, no trailing period (`add per-submodule pull`).
  No `Co-Authored-By` trailers.
- Keep platform-specific code behind `cfg(target_os = ...)` with a fallback for other
  platforms — see `src-tauri/src/tray.rs` for the pattern.
- Config-file writes must **fail closed**: never silently rewrite or default a file the
  user hand-edits (see `setup.rs` for the pattern and its tests).
- UI follows the design-handoff tokens in `src/styles/tokens.css`; new CSS goes in
  `src/styles/app.css` using existing variables.

## Filing issues

Include your OS + version, what you did, what you expected, and the relevant log output
(the Console pane in-app, or `~/Library/Application Support/com.midhunkumare.canopod/`).

## Licensing of contributions

Canopod is licensed under [AGPL-3.0-only](LICENSE). By submitting a contribution you certify the
[DCO](https://developercertificate.org/) (add `Signed-off-by:` via `git commit -s`) **and** you
grant the maintainer a perpetual, irrevocable right to relicense your contribution — this keeps
dual-licensing possible (e.g. commercial add-ons) while the open core stays AGPL.
