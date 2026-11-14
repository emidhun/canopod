import { metadata } from "./seo.mjs";

export const REPO = "https://github.com/emidhun/canopod";
export const BREW = "brew install --cask emidhun/canopod/canopod";
const paths = {
  branch: '<path d="M6 5v14m0-9h7a5 5 0 0 0 5-5"/><circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="4" r="2"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/>',
  terminal: '<path d="m4 6 6 6-6 6m9 0h7"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  code: '<path d="m7 6-6 6 6 6m10-12 6 6-6 6m-4-16-2 20"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  github: '<path d="M9 19c-4 1-4-2-6-2m12 5v-4c0-1 .1-2-1-3 4-.5 7-2 7-6 0-2-.5-3-1.5-4 .2-1 .2-2-.2-3-2-.1-3 1-4 1.5a15 15 0 0 0-6 0C8 3 7 2 5 2c-.5 1-.5 2-.2 3C3.5 6 3 7 3 9c0 4 3 5.5 7 6-1 1-1 2-1 3v4"/>',
};
export const icon = (name, cls = "") => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.branch}</svg>`;
export const mark = `<svg class="brand-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 8v1.5a2.5 2.5 0 0 0 2.5 2.5h5a2.5 2.5 0 0 0 2.5-2.5V8M12 12v4"/><g stroke="#78ded1"><circle cx="7" cy="6" r="2.05"/><circle cx="17" cy="6" r="2.05"/><circle cx="12" cy="18" r="2.05"/></g></svg>`;
export const brand = `<a class="brand" href="index.html" aria-label="Canopod home">${mark}<span>canopod</span></a>`;
export const downloadButton = (href, label = "Download for macOS", cls = "") => `<a class="button button-primary ${cls}" href="${href}">${icon("download")}<span>${label}</span></a>`;

export function siteHeader(active) {
  const items = [['features', 'Product'], ['canopod-mcp', 'MCP'], ['workflows', 'Workflows'], ['getting-started', 'Docs']];
  const links = items.map(([slug, label]) => `<a href="${slug}.html"${active === slug ? ' aria-current="page"' : ''}>${label}${slug === 'canopod-mcp' ? '<span class="nav-tag">0.5</span>' : ''}</a>`).join('');
  return `<header class="header"><div class="nav-shell container">${brand}<nav class="desktop-nav" aria-label="Main navigation">${links}<a href="${REPO}" class="github-link">${icon('github')}<span>GitHub</span></a></nav><a class="button button-small nav-download" href="download.html">Download ${icon('download')}</a><button class="menu-toggle" aria-expanded="false" aria-controls="mobile-nav" aria-label="Open navigation"><span></span><span></span></button></div><nav class="mobile-nav" id="mobile-nav" aria-label="Mobile navigation" hidden>${links}<a href="${REPO}">GitHub</a><a href="download.html">Download Canopod</a></nav></header>`;
}

export function siteFooter() {
  return `<footer class="footer container"><div class="footer-grid"><div class="footer-about">${brand}<p>A Git worktree manager for developers<br>and the agents they work with.</p><a class="project-source" href="${REPO}">${icon('github')} Built in the open</a></div><nav aria-label="Product links"><h2>Product</h2><a href="features.html">Features</a><a href="canopod-mcp.html">Canopod MCP</a><a href="workflows.html">Workflows</a><a href="download.html">Download</a></nav><nav aria-label="Resources"><h2>Resources</h2><a href="getting-started.html">Documentation</a><a href="mcp.html">MCP setup guide</a><a href="config-worktreemanager.html">Configuration</a><a href="troubleshooting.html">Troubleshooting</a></nav><nav aria-label="Project links"><h2>Project</h2><a href="${REPO}/releases">Release notes</a><a href="${REPO}/issues">Issues & feedback</a><a href="security.html">Security</a><a href="${REPO}/blob/main/LICENSE">AGPL-3.0 license</a></nav></div><div class="footer-bottom"><span>Free, open source, and local. No account required.</span><div><a href="limitations.html">Platform support & limitations</a><a href="llms.txt">Read with an AI assistant</a></div></div></footer><span class="sr-only" id="action-status" role="status" aria-live="polite"></span>`;
}

export function productPage({slug,title,description,body,version}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#101615">${metadata({slug,title,description,version})}<link rel="icon" type="image/png" sizes="32x32" href="assets/icons/favicon-32.png"><link rel="apple-touch-icon" href="assets/icons/apple-touch-icon.png"><link rel="preload" href="assets/fonts/inter-variable-latin.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="landing.css"><script src="landing.js" defer></script></head><body class="product-page"><a class="skip-link" href="#main">Skip to content</a>${siteHeader(slug)}<main id="main"><nav class="breadcrumbs container" aria-label="Breadcrumb"><a href="index.html">Canopod</a><span aria-hidden="true">/</span><span aria-current="page">${({features:"Product", "canopod-mcp":"Canopod MCP",workflows:"Workflows",download:"Download"})[slug] || "Product"}</span></nav>${body}</main>${siteFooter()}</body></html>`;
}

export function pageIntro({eyebrow,title,description,actions = ''}) {
  return `<section class="page-intro container"><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="page-description">${description}</p>${actions ? `<div class="hero-actions">${actions}</div>` : ''}</section>`;
}

export function finalCta({title='Your next branch is waiting.',description='Download Canopod, add a repository, and give it a workspace of its own.'} = {}) {
  return `<section class="final-cta container"><div><h2>${title}</h2><p>${description}</p></div><a class="button button-primary" href="download.html">${icon('download')} Download Canopod</a></section>`;
}
