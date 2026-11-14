// Search metadata and optional, plain-text discovery documents. No dependencies.
// CANOPOD_SITE_URL is the deployed site directory, including any subpath.
// llms.txt is a reader convenience, not a search-engine requirement or promise.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { routing } from "./urls.mjs";

const REPOSITORY = "https://github.com/emidhun/canopod";
const PRODUCT_DESCRIPTION = "Canopod is a free, open-source Git worktree and local development service manager with an optional local MCP server for coding agents.";

function checkedSlug(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("Page slugs must contain lowercase letters, numbers, and single hyphens only.");
  }
  return slug;
}

function escapeMarkup(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function singleLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function jsonForHtml(value) {
  // In a script element, HTML entities are not decoded. JSON escapes prevent
  // a literal closing script tag while retaining the original string value.
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function canonicalUrl(slug) {
  checkedSlug(slug);
  return routing.pageUrl(slug);
}

function markdownUrl(slug) {
  return routing.markdownUrl(checkedSlug(slug));
}

/** Return a complete, escaped HTML head fragment. Pass the final page title. */
export function metadata({ slug, title, description, kind = "WebPage", version }) {
  const url = canonicalUrl(slug);
  const base = routing.baseFor(slug);
  const productBase = routing.webBase;
  const siteName = routing.split && routing.sectionFor(slug) === "docs" ? "Canopod documentation" : "Canopod";
  const pageTitle = singleLine(title) || "Canopod";
  const summary = singleLine(description) || PRODUCT_DESCRIPTION;
  // Only use schema types which describe a page; arbitrary type names are errors.
  if (!["WebPage", "CollectionPage", "AboutPage", "ContactPage", "TechArticle"].includes(kind)) {
    throw new Error(`Unsupported metadata page kind: ${kind}`);
  }
  const page = {
    "@type": kind,
    "@id": `${url}#webpage`,
    url,
    name: pageTitle,
    description: summary,
    inLanguage: "en",
    isPartOf: { "@id": `${base}#website` },
    about: { "@id": `${productBase}#software` },
  };
  const graph = [{
    "@type": "WebSite",
    "@id": `${base}#website`,
    url: base,
    name: siteName,
    description: PRODUCT_DESCRIPTION,
    inLanguage: "en",
  }, page];

  if (slug !== "index") {
    page.breadcrumb = { "@id": `${url}#breadcrumb` };
    graph.push({
      "@type": "BreadcrumbList",
      "@id": `${url}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Canopod", item: productBase },
        { "@type": "ListItem", position: 2, name: pageTitle.replace(/\s*[·|—]\s*Canopod.*$/, ""), item: url },
      ],
    });
  } else {
    page.mainEntity = { "@id": `${base}#software` };
    graph.push({
      "@type": "SoftwareApplication",
      "@id": `${base}#software`,
      name: "Canopod",
      url: base,
      description: `${PRODUCT_DESCRIPTION} macOS on Apple Silicon is the validated desktop platform; Windows and Linux packages are experimental.`,
      applicationCategory: "DeveloperApplication",
      operatingSystem: ["macOS (Apple Silicon)", "Windows (experimental)", "Linux (experimental)"],
      isAccessibleForFree: true,
      license: `${REPOSITORY}/blob/main/LICENSE`,
      downloadUrl: `${REPOSITORY}/releases`,
      ...(version ? { softwareVersion: singleLine(version) } : {}),
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD", url: `${base}#download` },
    });
  }

  return `<title>${escapeMarkup(pageTitle)}</title>
<meta name="description" content="${escapeMarkup(summary)}" />
<link rel="canonical" href="${escapeMarkup(url)}" />
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${escapeMarkup(siteName)}" />
<meta property="og:locale" content="en_US" />
<meta property="og:title" content="${escapeMarkup(pageTitle)}" />
<meta property="og:description" content="${escapeMarkup(summary)}" />
<meta property="og:url" content="${escapeMarkup(url)}" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${escapeMarkup(pageTitle)}" />
<meta name="twitter:description" content="${escapeMarkup(summary)}" />
<link rel="alternate" type="text/markdown" href="${escapeMarkup(markdownUrl(slug))}" title="${escapeMarkup(pageTitle)} — Markdown" />
<link rel="describedby" type="text/plain" href="${escapeMarkup(new URL("llms.txt", base).href)}" title="Canopod documentation index" />
<script type="application/ld+json">${jsonForHtml({ "@context": "https://schema.org", "@graph": graph })}</script>`;
}

function markdownLabel(value) {
  return singleLine(value).replace(/[\\[\]]/g, "\\$&");
}

function readableMarkdown(source, slug) {
  let fenced = false;
  return String(source || "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line; }
      if (fenced) return line;
      const shot = line.match(/^!shot\s+([\w-]+)\s*(?:\|\s*(.*))?$/);
      if (shot) return `![${markdownLabel(shot[2] || shot[1].replace(/-/g, " "))}](${new URL(`assets/screens/light/${shot[1]}.png`, routing.baseFor(slug)).href})`;
      line = line.replace(/^:::(note|tip|warn|danger)\s*(.*)$/, (_match, type, label) => `> **${label || type}:**`)
        .replace(/^:::\s*$/, "");
      // Convert the site's HTML navigation cards to plain Markdown, without
      // altering inline code such as <repo>_<slug> or code fences.
      line = line.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (_match, href, label) => `[${label.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}](${href})`)
        .replace(/<\/?(?:div|section|aside|details|summary|span|strong|em|p|ul|ol|li|h[1-6])\b[^>]*>/g, " ")
        .replace(/<br\s*\/?\s*>/g, " ");
      return line.replace(/(!?\[[^\]]*\]\()([^\s)]+)(\))/g, (_match, before, href, after) => {
        if (/^(?:https?:|mailto:|tel:|data:)/i.test(href)) return before + href + after;
        return before + routing.routeHref(href, slug, { absolute: true }) + after;
      });
    }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const FACTS = `Canopod manages Git worktrees, configured development services, ports, logs, terminals, and Postgres database workflows on your own machine. Its source license is AGPL-3.0-only, and downloads are free.

The optional MCP server uses Streamable HTTP on loopback. MCP is off by default. Access is granted per registered repository and capability. It can expose cached status, bounded redacted logs and configuration; create worktrees and run configured setup; manage configured services; and update supported configuration fields with revision checks. It exposes no general shell tool. Dedicated worktree-removal and database-management tools are not exposed in version 0.5. Configured setup and service commands do execute; configuration permission can change an existing service command. Remote MCP exposure is unsupported.

Claude Code and Codex have client setup support. The packaged canopod-backend supports headless operation. The desktop app and an independent headless backend must not own the same runtime directories at the same time.

macOS on Apple Silicon is the validated desktop platform. Linux and Windows packages compile and ship but remain experimental and have not been validated on a desktop. There is no Intel Mac build. The macOS app is not notarized, and the Windows installer is not code-signed. Follow the installation guide for your platform.

Database tooling is Postgres-specific. Other databases can run as services. Canopod sends no analytics; release checks and update downloads contact GitHub. Connected coding agents have their own data handling settings. The limitations and security pages describe the current boundaries.`;

/**
 * Synchronously write sitemap.xml, robots.txt, llms.txt, llms-full.txt and one
 * content/<slug>.md alternate per page. Pass public page content only.
 * pages: Array<{slug, title, description, markdown?: string}>.
 * No filesystem timestamps are advertised as content modification dates.
 */
export function writeDiscoveryFiles({ siteDir, pages, version, section = "combined" }) {
  if (!siteDir || !Array.isArray(pages) || pages.length === 0) {
    throw new Error("writeDiscoveryFiles requires a siteDir and non-empty pages array.");
  }
  const seen = new Set();
  const entries = pages.map((page) => {
    checkedSlug(page.slug);
    if (seen.has(page.slug)) throw new Error(`Duplicate discovery page: ${page.slug}`);
    seen.add(page.slug);
    return { ...page, title: singleLine(page.title) || page.slug, description: singleLine(page.description) };
  });
  const base = section === "docs" ? routing.docsBase : routing.webBase;
  const output = resolve(siteDir);
  mkdirSync(join(output, "content"), { recursive: true });
  const documents = entries.map((entry) => {
    const body = readableMarkdown(entry.markdown, entry.slug) || `# ${entry.title}\n\n${entry.description}`;
    const text = `${body}\n\n---\n\nCanonical page: ${canonicalUrl(entry.slug)}\n${version ? `Product version: ${singleLine(version)}\n` : ""}`;
    writeFileSync(join(output, "content", `${routing.outputSlug(entry.slug)}.md`), text);
    return text;
  });

  const sitemapUrl = new URL("sitemap.xml", base).href;
  writeFileSync(join(output, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.map((entry) => `  <url><loc>${escapeMarkup(canonicalUrl(entry.slug))}</loc></url>`).join("\n")}\n</urlset>\n`);

  const subpath = new URL(base).pathname !== "/";
  writeFileSync(join(output, "robots.txt"), `# Canopod public website\n${subpath ? `# This site is served below ${new URL(base).pathname}\n# Crawlers read robots.txt only at the origin root, not this subpath.\n# Add the Sitemap line to the origin-root robots.txt where possible,\n# or submit the sitemap URL directly in Google Search Console.\n` : ""}User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n`);

  const coreSlugs = ["index", "features", "canopod-mcp", "workflows", "download", "getting-started", "overview", "mcp", "install-macos", "install-windows", "install-linux", "first-worktree", "services-ports", "databases", "security", "limitations"];
  const core = coreSlugs.map((slug) => entries.find((entry) => entry.slug === slug)).filter(Boolean);
  const rest = entries.filter((entry) => !coreSlugs.includes(entry.slug));
  const item = (entry) => `- [${markdownLabel(entry.title)}](${markdownUrl(entry.slug)}): ${entry.description || "Canopod product documentation."}`;
  const preface = `# Canopod\n\n> ${PRODUCT_DESCRIPTION}\n\n${version ? `Documentation for Canopod ${singleLine(version)}.\n\n` : ""}${FACTS}\n\nThis optional index helps readers and tools find public documentation. It does not grant permissions or guarantee search or AI visibility.\n`;
  const related = routing.split ? `\n- [Canopod website](${routing.webBase}): Features, workflows, and downloads.\n- [Canopod documentation](${routing.docsBase}): Installation, configuration, and MCP setup.` : "";
  const llms = `${preface}\n## Start here\n\n${core.map(item).join("\n")}\n\n## ${section === "web" ? "More pages" : "Documentation"}\n\n${rest.map(item).join("\n")}\n\n## Project\n\n- [Source code](${REPOSITORY}): Public source and AGPL-3.0-only license.\n- [Releases](${REPOSITORY}/releases): Published builds and release notes.\n- [All page text](${new URL("llms-full.txt", base).href}): A combined copy of the public pages on this site.${related}\n`;
  writeFileSync(join(output, "llms.txt"), llms);
  writeFileSync(join(output, "llms-full.txt"), `${preface}\n\n${documents.join("\n\n===== Next page =====\n\n")}`);
  return { pages: entries.length, siteUrl: base, sitemapUrl, requiresRootRobots: subpath };
}
