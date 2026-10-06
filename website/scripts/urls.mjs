// Shared routes for the combined local preview and the two public domains.
import { FLAT } from "./nav.mjs";

export const MARKETING_SLUGS = ["index", "features", "canopod-mcp", "workflows", "download"];
const marketing = new Set(MARKETING_SLUGS);
const docs = new Set(FLAT.map(({ slug }) => slug));

function checkedBase(value, label) {
  let url;
  try { url = new URL(value); } catch {
    throw new Error(`${label} must be an absolute HTTP(S) site URL.`);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || /[\s\\]/.test(value)) {
    throw new Error(`${label} must use HTTP(S), with no credentials, whitespace, query, or fragment.`);
  }
  if (/\.(?:html?|xml|txt)$/i.test(url.pathname)) {
    throw new Error(`${label} must name the site directory, not a file.`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  return url.href;
}

/** Slugs are source identifiers: "index" always means the product homepage. */
export function createRouting({
  split = process.argv.includes("--split"),
  siteUrl = process.env.CANOPOD_SITE_URL,
  docsUrl = process.env.CANOPOD_DOCS_URL,
} = {}) {
  const webBase = checkedBase(siteUrl || (split ? "https://canopod.com/" : "https://emidhun.github.io/canopod/"), "CANOPOD_SITE_URL");
  const docsBase = split ? checkedBase(docsUrl || "https://docs.canopod.com/", "CANOPOD_DOCS_URL") : webBase;
  const sectionFor = slug => docs.has(slug) ? "docs" : "web";
  const baseFor = slug => sectionFor(slug) === "docs" ? docsBase : webBase;
  const outputSlug = slug => split && slug === "getting-started" ? "index" : slug;
  const pagePath = slug => `${outputSlug(slug)}.html`;
  const pageUrl = slug => new URL(outputSlug(slug) === "index" ? "" : pagePath(slug), baseFor(slug)).href;
  const markdownUrl = slug => new URL(`content/${outputSlug(slug)}.md`, baseFor(slug)).href;

  // Authored HTML links use the combined site's slugs. Keep same-site links
  // relative for portable previews; only the other site's links need an origin.
  function routeHref(href, sourceSlug, { absolute = false } = {}) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return href;
    const match = href.match(/^(?:\.\/)?([a-z0-9-]+)\.html([?#].*)?$/);
    if (match && (marketing.has(match[1]) || docs.has(match[1]))) {
      const [, target, suffix = ""] = match;
      const crossSite = split && sectionFor(target) !== sectionFor(sourceSlug);
      return (absolute || crossSite ? pageUrl(target) : pagePath(target)) + suffix;
    }
    return absolute ? new URL(href, pageUrl(sourceSlug)).href : href;
  }

  function rewriteHtml(html, sourceSlug) {
    if (!split) return html;
    return html.replace(/\b(href|src)=("|')([^"']*)\2/g, (_match, attribute, quote, href) =>
      `${attribute}=${quote}${routeHref(href, sourceSlug)}${quote}`);
  }

  return { split, webBase, docsBase, sectionFor, baseFor, outputSlug, pagePath, pageUrl, markdownUrl, routeHref, rewriteHtml };
}

export const routing = createRouting();
