<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brandmark-dark.svg" />
    <img src="docs/assets/brandmark-light.svg" width="108" alt="Canopy brandmark — a git fork: two parents converging into one branch" />
  </picture>
</p>

<h1 align="center">canopy</h1>

<p align="center">A lightweight <b>menu-bar git-worktree + dev-service manager</b>.<br/>
Every branch checked out, provisioned, and running — side by side.</p>

<p align="center">
  <a href="https://github.com/emidhun/canopy/actions/workflows/ci.yml"><img src="https://github.com/emidhun/canopy/actions/workflows/ci.yml/badge.svg" alt="ci" /></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/demo-dark.gif" />
    <img src="docs/assets/demo.gif" alt="Canopy demo — onboard a repository, then add several git worktrees and watch each one appear in the sidebar with its own database and isolated ports" width="900" />
  </picture>
</p>

<p align="center">
  <a href="https://github.com/emidhun/canopy/releases/download/v0.4.7/Canopy_0.4.7_aarch64.dmg"><img src="https://img.shields.io/badge/macOS-Download_.dmg_(Apple_Silicon)-58c2c8?style=for-the-badge&logo=apple&logoColor=white&labelColor=1e1f22" alt="Download DMG for macOS (Apple Silicon)" /></a>
  <a href="#install"><img src="https://img.shields.io/badge/Homebrew-brew_install_canopy-58c2c8?style=for-the-badge&logo=homebrew&logoColor=white&labelColor=1e1f22" alt="Install with Homebrew" /></a>
</p>

<p align="center">
  <a href="https://github.com/emidhun/canopy/releases/download/v0.4.7/Canopy_0.4.7_amd64.deb"><img src="https://img.shields.io/badge/Linux-.deb-9a9ba0?style=flat-square&logo=debian&logoColor=white&labelColor=1e1f22" alt="Download .deb" /></a>
  <a href="https://github.com/emidhun/canopy/releases/download/v0.4.7/Canopy-0.4.7-1.x86_64.rpm"><img src="https://img.shields.io/badge/Linux-.rpm-9a9ba0?style=flat-square&logo=fedora&logoColor=white&labelColor=1e1f22" alt="Download .rpm" /></a>
  <a href="https://github.com/emidhun/canopy/releases/download/v0.4.7/Canopy_0.4.7_amd64.AppImage"><img src="https://img.shields.io/badge/Linux-.AppImage-9a9ba0?style=flat-square&logo=linux&logoColor=white&labelColor=1e1f22" alt="Download AppImage" /></a>
  <a href="https://github.com/emidhun/canopy/releases/latest"><img src="https://img.shields.io/badge/Windows-.exe-9a9ba0?style=flat-square&logo=windows&logoColor=white&labelColor=1e1f22" alt="Download Windows installer" /></a>
  <a href="https://github.com/emidhun/canopy/releases"><img src="https://img.shields.io/github/v/release/emidhun/canopy?style=flat-square&label=all%20releases&color=58c2c8&labelColor=1e1f22" alt="All releases" /></a>
  <br/>
  <sub>Linux &amp; Windows builds are experimental — <a href="https://github.com/emidhun/canopy/issues">feedback welcome</a>. See <a href="#install">Install</a> for the one-line quarantine fix on macOS.</sub>
</p>

Canopy discovers every worktree of your registered repos, provisions each one (dependencies, an
isolated database, deterministic ports), and lets you start/stop services, watch logs, manage
databases, and change ports — from a tray popover and a main window. Built for fast multi-repo /
submodule workflows like ToolJet.

- **Platform:** macOS **arm64** (Apple Silicon). Linux & Windows ports are experimental — they compile and pass CI, but aren't yet validated on a desktop.
- **Stack:** Tauri 2 (Rust) + React + zustand
- **Latest published version:** 0.4.7. The `release/0.5.0` branch is unreleased; its source and
  release notes may describe behavior that is not in the downloads above yet.

---

## Why Canopy

Working on several branches at once with `git worktree` means each checkout needs its own
dependencies, its own database, and its own set of ports — otherwise they collide. Doing that by
hand is tedious and error-prone. Canopy automates it:

- **Isolated per worktree** — each worktree gets its own database (`<repo>_<slug>`) and a
  deterministic set of ports (`basePort + index*10`), so multiple branches run side by side.
- **Zero-bash provisioning** — how a worktree is set up (env vars, install/build/migrate/teardown)
  is declared once in the repo via `.worktreemanager.json`, so it travels with the branch.
- **One place to run everything** — start/stop services, tail logs, pull, snapshot/restore/switch
  databases, edit ports — from a tray popover or the main window.

---

## Requirements

- **git**
- macOS on Apple Silicon (arm64) for the primary tested desktop build; Linux and Windows packages
  are experimental
- The runtimes and package managers your repository's configured commands use; Canopy itself does
  not require Node
- A local database only when your project or configured database actions need one
- Optionally, a committed `.worktreemanager.json` so setup travels with each branch — see the
  [Configuration guide](docs/configuration.md)

---

## Install

### macOS (Apple Silicon)

**Homebrew** (recommended — handles quarantine for you):

```sh
brew install --cask emidhun/canopy/canopy
```

**Or the DMG** from [Releases](https://github.com/emidhun/canopy/releases): Canopy isn't notarized
yet, so macOS quarantines it on download — clearing that quarantine is the step that matters:

```sh
hdiutil attach ~/Downloads/Canopy_<version>_aarch64.dmg
cp -R "/Volumes/Canopy/Canopy.app" /Applications/
hdiutil detach "/Volumes/Canopy"
xattr -dr com.apple.quarantine /Applications/Canopy.app      # clears quarantine
open /Applications/Canopy.app
```

Or drag **Canopy** to Applications and run only the `xattr -dr com.apple.quarantine` line. On macOS Sequoia you can
instead use System Settings → Privacy & Security → **Open Anyway**.

### Linux (experimental)

`.AppImage`, `.deb`, and `.rpm` packages are on the [Releases](https://github.com/emidhun/canopy/releases)
page. They build and pass CI but haven't been validated on a real desktop yet — issues welcome.

### Windows (experimental)

An NSIS installer (`Canopy_<version>_x64-setup.exe`) is published on the
[Releases](https://github.com/emidhun/canopy/releases/latest) page. Download it, run it, and launch
**Canopy** from the Start menu — it lives in the system tray. Windows SmartScreen may warn on first
run because the installer isn't code-signed yet; choose **More info → Run anyway**. Like Linux, the
Windows port compiles and is published for early adopters but hasn't been validated on a real
desktop — [feedback welcome](https://github.com/emidhun/canopy/issues). Step-by-step notes are in the
[Windows install guide](https://emidhun.github.io/canopy/install-windows.html).

Canopy runs as a **menu-bar / tray app** — look for the fork icon after launch. Full
install/signing details are in [docs/distribution.md](docs/distribution.md).

---

## Quick start (users)

1. Click the Canopy icon in the menu bar → **Open Manager**.
2. On first launch, choose **Add a repository**, pick the main checkout, and review the detected
   services and editable setup suggestions. Existing configuration should be reviewed, not replaced.
3. Optionally commit a `.worktreemanager.json` describing env overrides and setup commands so they
   travel with the branch (see the [Configuration guide](docs/configuration.md); a ToolJet example
   is in [docs/tooljet-config.md](docs/tooljet-config.md)).
4. **New worktree** → pick a new or existing branch/tag → Canopy creates the worktree, provisions it,
   and streams progress.
5. **Start all** to boot the worktree's services, then click a service's port (`:3000`) to open it
   in the browser.

The full walkthrough — with databases, ports, pull, and troubleshooting — is in the
**[User Guide](docs/user-guide.md)**.

---

## Development

```sh
# one-time
npm install

# standard preamble for build commands on this machine (Node 22 + cargo on PATH)
export PATH="$HOME/.asdf/installs/nodejs/v22.15.1/bin:$PATH" && source "$HOME/.cargo/env"

npm run tauri dev      # run the full app (both windows + tray), hot-reloads
npm run build          # type-check + build the frontend
npm run tauri build    # release .app bundle
```

From `src-tauri/`: `cargo check` (fast Rust check) and `cargo test --lib` (unit tests).

See **[docs/development.md](docs/development.md)** for prerequisites, the release/DMG steps, and the
environment gotchas that have bitten us (Node 18 vs 22, `pg_dump` versioning, the DMG-build hang).

---

## Documentation

The full documentation is a static site in **[`website/`](website/)** — 31 pages covering install,
onboarding, every feature, both settings scopes, the config-file reference, worked examples, and
building from source, with screenshots of every screen in light and dark.

```sh
node website/scripts/build.mjs   # content/*.md → website/site/
node website/scripts/serve.mjs   # preview on http://localhost:4180
```

It has no dependencies: the content is Markdown and the generator is plain Node. Pushing a change
under `website/` publishes it through `.github/workflows/docs.yml`. See
[website/README.md](website/README.md) for how to write a page, add a screenshot, or change the look.

<details>
<summary>Earlier per-topic notes in <code>docs/</code></summary>

These predate the redesign and describe the older UI (service cards, per-service log tabs, the
five-step wizard). Kept for now; `website/` is the current source of truth.

| Doc | What it covers |
|---|---|
| [docs/README.md](docs/README.md) | Documentation index + 60-second mental model |
| [docs/user-guide.md](docs/user-guide.md) | **Task-oriented guide for users** — install → configure → run |
| [docs/features.md](docs/features.md) | Reference: what every button and menu does |
| [docs/configuration.md](docs/configuration.md) | The three config layers, `.worktreemanager.json`, variables, ports, databases |
| [docs/architecture.md](docs/architecture.md) | How the pieces fit (backend = source of truth, two windows, events) |
| [docs/backend.md](docs/backend.md) | Rust module map, IPC commands, events |
| [docs/development.md](docs/development.md) | Run / build / sign / DMG + environment gotchas |
| [docs/distribution.md](docs/distribution.md) | Installing the DMG, signing/notarization, why no App Store |
| [docs/tooljet-config.md](docs/tooljet-config.md) | The ToolJet `.worktreemanager.json` reproduced |
| [docs/roadmap.md](docs/roadmap.md) | What's done, follow-ups, v2 ideas |

</details>

---

## Notes

- **Settings & state** live in `~/Library/Application Support/com.midhunkumare.canopy/`
  (`settings.json`, `state.json`).
- See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup and commit conventions.

---

## License

Canopy is open source under the [GNU AGPL-3.0](LICENSE). Using the app imposes no obligations on
you; the copyleft applies if you modify and distribute (or host) Canopy itself. Optional
commercial team/cloud add-ons may be offered separately in the future.
