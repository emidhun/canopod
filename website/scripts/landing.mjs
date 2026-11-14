import { REPO, icon, mark, downloadButton, siteHeader, siteFooter } from "./site-ui.mjs";
import { downloadSection, mcpSpotlight, workflowLinks } from "./sections.mjs";
import { metadata } from "./seo.mjs";

export const HOME_TITLE = "Canopod — Git worktree manager & local MCP server";
export const HOME_DESCRIPTION = "Run branches side by side with Canopod. Manage Git worktrees, service ports, Postgres workflows and a local MCP server for Claude Code and Codex. Free and open source.";

export function landingPage(version) {
  const release = `${REPO}/releases/download/v${version}`;
  const dmg = `${release}/Canopod_${version}_aarch64.dmg`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#101615">
  ${metadata({slug: "index", title: HOME_TITLE, description: HOME_DESCRIPTION, version})}
  <link rel="icon" type="image/png" sizes="32x32" href="assets/icons/favicon-32.png">
  <link rel="apple-touch-icon" href="assets/icons/apple-touch-icon.png">
  <link rel="preload" href="assets/fonts/inter-variable-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="landing.css">
  <script src="landing.js" defer></script>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
${siteHeader("index")}
<main id="main">
  <section class="hero container" aria-labelledby="hero-title">
    <a class="release-pill" href="canopod-mcp.html"><span>NEW IN v${version}</span> Meet Canopod MCP <span class="release-plus">+</span></a>
    <p class="eyebrow hero-eyebrow">GIT WORKTREES. LOCAL SERVICES. CONNECTED AGENTS.</p>
    <h1 id="hero-title">Every branch.<br><em>Its own space.</em></h1>
    <p class="hero-description">Canopod keeps your branches, services, and databases organized.<br>Work from the app, or let your coding agent handle setup through MCP.</p>
    <div class="hero-actions">${downloadButton(dmg)}<a class="button button-secondary" href="canopod-mcp.html">Explore Canopod MCP</a></div>
    <p class="download-meta">Free & open source <span>·</span> macOS, Apple Silicon <span>·</span> <a href="#download">Other platforms</a></p>
    <div class="hero-showcase">
      <div class="workspace-ribbon" aria-label="Example parallel workspaces"><span class="ribbon-label">ONE REPO. ROOM FOR EVERYTHING.</span><div><span>${icon("branch")} main <b>:3000</b></span><span>${icon("branch")} feature/checkout <b>:3010</b></span><span>${icon("branch")} hotfix/refund <b>:3020</b></span></div></div>
      <div class="app-frame"><img src="assets/screens/dark/main-worktree.png" width="2800" height="1640" fetchpriority="high" alt="Canopod's real interface with worktrees in the sidebar, running Frontend and Server services, and their combined logs."></div>
      <div class="showcase-caption"><span>${mark} Worktrees, services, and logs in one window.</span><span>CANOPOD FOR DESKTOP</span></div>
    </div>
    <div class="trust-strip"><span>${icon("code")} Free & open source</span><span>${icon("layers")} Runs on your machine</span><span>${icon("terminal")} Claude Code + Codex via MCP</span></div>
  </section>

  ${mcpSpotlight()}

  <section class="problem-section section-pad" aria-labelledby="problem-title">
    <div class="container">
      <div class="section-heading split-heading"><div><p class="eyebrow">WHEN ANOTHER BRANCH NEEDS YOUR ATTENTION</p><h2 id="problem-title">A quick review shouldn’t<br><span>derail your afternoon.</span></h2></div><p>You just wanted to review a PR.<br>Now you’re stashing changes, freeing a port,<br>and wondering which database you migrated.</p></div>
      <div class="problem-grid">
        <article><span class="problem-number">01 / YOUR CODE</span><h3>“Let me stash this first.”</h3><p>A hotfix shouldn’t put your feature on hold. Keep each branch checked out in its own worktree.</p><div class="resolution">${icon("check")} Pick up where you left off</div></article>
        <article><span class="problem-number">02 / YOUR SERVICES</span><h3>“What’s using port 3000?”</h3><p>Give each worktree its own stable service ports. Keep your branches running alongside each other.</p><div class="resolution">${icon("check")} Less port juggling</div></article>
        <article><span class="problem-number">03 / YOUR DATA</span><h3>“That migration broke main.”</h3><p>Configure a Postgres database per worktree. Try a schema change without sharing the same database.</p><div class="resolution">${icon("check")} A space to experiment</div></article>
      </div>
    </div>
  </section>

  <section class="product-section section-pad container" id="product" aria-labelledby="product-title">
    <div class="section-heading"><p class="eyebrow">PARALLEL, WITHOUT THE CHAOS</p><h2 id="product-title">Keep each branch<br><em>ready to work on.</em></h2><p>One repository. Independent workspaces.<br>Each with the services, ports, and context it needs.</p></div>
    <div class="isolation-demo">
      <div class="demo-intro"><span>${icon("branch")} acme-web</span><span>INTERACTIVE EXAMPLE</span></div>
      <div class="branch-selector" role="tablist" aria-label="Example worktree">
        <button id="branch-main" role="tab" aria-selected="false" aria-controls="branch-panel" tabindex="-1" data-branch="main">${icon("branch")}<span>main<small>Your baseline</small></span><i class="running-dot"></i></button>
        <button id="branch-feature" role="tab" aria-selected="true" aria-controls="branch-panel" tabindex="0" data-branch="feature">${icon("branch")}<span>feature/checkout<small>Work in progress</small></span><i class="running-dot"></i></button>
        <button id="branch-hotfix" role="tab" aria-selected="false" aria-controls="branch-panel" tabindex="-1" data-branch="hotfix">${icon("branch")}<span>hotfix/refund<small>The urgent fix</small></span><i class="running-dot"></i></button>
      </div>
      <div class="branch-panel" role="tabpanel" id="branch-panel" aria-labelledby="branch-feature" tabindex="0">
        <div class="workspace-summary"><span class="mono">YOUR WORKTREE</span><h3 id="demo-branch-name">feature/checkout</h3><span class="running-badge"><i class="running-dot"></i> Running independently</span></div>
        <dl class="resource-grid"><div><dt>${icon("code")} Frontend</dt><dd id="demo-frontend">localhost:3010</dd><span>Its own port</span></div><div><dt>${icon("terminal")} Server</dt><dd id="demo-server">localhost:4010</dd><span>Its own process</span></div><div><dt>${icon("database")} Postgres</dt><dd id="demo-database">acme_feature_checkout</dd><span>Its own data</span></div></dl>
        <div class="demo-terminal"><span class="terminal-prefix">✓</span><span id="demo-message">Checkout is ready. Main and your hotfix keep running.</span><span class="terminal-cursor" aria-hidden="true"></span></div>
      </div>
      <p class="demo-note">Select a branch to see its workspace. Example ports and databases; configure your own setup once.</p>
    </div>
    <div class="feature-pair" id="workspace-tools">
      <article class="feature-card">
        <div class="feature-copy"><span class="feature-symbol">${icon("terminal")}</span><h3>Find the log.<br>Keep the context.</h3><p>Start and stop services, read their logs, and open a shell in the right worktree. All together, instead of scattered across your desktop.</p><a class="text-link" href="agents-terminals.html">Explore terminals & logs</a></div>
        <figure class="workspace-preview feature-preview" aria-label="Illustrative terminal and service logs for a worktree">
          <div class="preview-bar"><span>${icon("branch")} feature/checkout</span><span class="preview-label">WORKTREE</span></div>
          <div class="preview-services"><span><i class="running-dot"></i> Frontend <code>:3010</code></span><span><i class="running-dot"></i> Server <code>:4010</code></span></div>
          <div class="preview-terminal"><div class="preview-pane-title">${icon("terminal")} Terminal <span>in your worktree</span></div><pre><code><span class="preview-prompt">$</span> git branch --show-current
<span class="preview-output">feature/checkout</span></code></pre></div>
          <div class="preview-logs"><div class="preview-pane-title">${icon("layers")} Service logs</div><div class="preview-log-line"><span class="log-source">Frontend</span><code>GET /checkout</code><span class="log-status">200</span></div><div class="preview-log-line"><span class="log-source">Server</span><code>GET /api/cart</code><span class="log-status">200</span></div></div>
          <figcaption>Example workspace · your commands, in context.</figcaption>
        </figure>
      </article>
      <article class="feature-card agent-card">
        <div class="feature-copy"><span class="feature-symbol">${icon("layers")}</span><h3>Your agent starts<br>on the same page.</h3><p>Give Claude Code, Codex, or your favorite CLI the task, branch, ports, and database in a structured handoff. The agent knows where to start.</p><a class="text-link" href="agents-terminals.html">See how agent handoffs work</a></div>
        <figure class="handoff-preview feature-preview" aria-label="Illustrative context file for a coding agent">
          <div class="preview-bar"><span>${icon("code")} .canopod/context.md</span><span class="preview-label">HANDOFF</span></div>
          <div class="handoff-body"><div class="handoff-task"><span>YOUR TASK</span><p>Build the new checkout.</p></div><dl class="handoff-context"><div><dt>branch</dt><dd>feature/checkout</dd></div><div><dt>frontend</dt><dd>localhost:3010</dd></div><div><dt>database</dt><dd>acme_feature_checkout</dd></div></dl><p class="handoff-note">${icon("check")} The context to pick up where you left off.</p></div>
          <figcaption>Example handoff · ready for your coding agent.</figcaption>
        </figure>
      </article>
    </div>
    <div class="small-features"><div>${icon("database")}<span><strong>Data, with a way back.</strong> Snapshot and restore local Postgres databases.</span></div><div>${icon("branch")}<span><strong>One setup to repeat.</strong> Commit your provisioning steps with the repo.</span></div><div>${mark}<span><strong>There when you need it.</strong> A lightweight manager in your menu bar.</span></div></div>
  </section>

  ${workflowLinks()}

  <section class="workflow-section section-pad" id="workflow" aria-labelledby="workflow-title"><div class="container">
    <div class="section-heading split-heading"><div><p class="eyebrow">FROM REPO TO RUNNING</p><h2 id="workflow-title">Set up your repo once.<br>Reuse it on the next branch.</h2></div><a class="text-link" href="first-worktree.html">Read the quick-start guide</a></div>
    <div class="workflow-grid"><article><span class="step-number">01</span><h3>Bring your repository.</h3><p>Point Canopod at a local repo. Review detected Node services, or add the commands your stack needs.</p><span class="step-command">${icon("plus")} Add repository</span></article><article><span class="step-number">02</span><h3>Make room for a branch.</h3><p>Choose a branch or tag. Canopod creates its worktree and runs your configured setup steps.</p><span class="step-command">${icon("branch")} New worktree <kbd>⌘ N</kbd></span></article><article><span class="step-number">03</span><h3>Start it. Keep going.</h3><p>Run your services, open the app, and get to work. Your other branches can keep doing their thing.</p><span class="step-command">${icon("terminal")} Start services</span></article></div>
  </div></section>

  ${downloadSection(version)}

  <section class="faq-section container" aria-labelledby="faq-title"><div><p class="eyebrow">COMMON QUESTIONS</p><h2 id="faq-title">Before you<br> branch out.</h2><a class="text-link" href="getting-started.html">Browse the documentation</a></div><div class="faq-list">
    <details><summary>Do I need to know Git worktrees?${icon("plus")}</summary><p>Just the idea: a worktree is another checkout of your repository, on a different branch. Canopod handles creating and managing them, so you can keep several branches open at once. <a href="overview.html">See how it works.</a></p></details>
    <details><summary>Does it work with my stack?${icon("plus")}</summary><p>Canopod detects services and commands from package.json for Node projects. You can configure commands for other stacks, including Rails, Django, Go, and Rust. Database snapshot and restore tools are Postgres-specific. <a href="example-other-stacks.html">Explore stack examples.</a></p></details>
    <details><summary>Can I use it with coding agents?${icon("plus")}</summary><p>Yes. Launch your configured coding-agent CLI in a worktree with a structured task handoff. Canopod MCP also lets agents inspect worktrees, run configured setup, and start or stop services. You choose the repositories and permissions. <a href="canopod-mcp.html">Explore Canopod MCP.</a></p></details>
    <details><summary>Is it free? Where does my code go?${icon("plus")}</summary><p>Canopod is free and open source under AGPL-3.0. Your repositories and services run locally, and Canopod sends no telemetry. Release checks and update downloads contact GitHub. Any coding agent you connect follows its own data settings. <a href="security.html">Read the security notes.</a></p></details>
    <details><summary>What do I need installed?${icon("plus")}</summary><p>Git, plus the runtimes and package managers your project uses. Local Postgres is only needed for Postgres workflows. The primary tested build is macOS on Apple Silicon; Linux and Windows packages are experimental. <a href="install-macos.html">View the requirements.</a></p></details>
  </div></section>
</main>
${siteFooter()}
</body>
</html>`;
}
