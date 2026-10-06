// Validate navigation, metadata, discovery and accessibility without network requests.
// Run after build.mjs; pass --split to check both custom-domain outputs together.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const website = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const split = process.argv.includes('--split');
const decode = text => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const marketingSlugs = ['index', 'features', 'canopod-mcp', 'workflows', 'download'];
const docSlugs = readdirSync(join(website, 'content')).filter(file => file.endsWith('.md')).map(file => file.replace(/\.md$/, ''));

function baseUrl(value) {
  const url = new URL(value);
  assert(/^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash, `Invalid site URL: ${value}`);
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url.href;
}

const siteUrl = baseUrl(process.env.CANOPOD_SITE_URL || (split ? 'https://canopod.com/' : 'https://emidhun.github.io/canopod/'));
const docsUrl = split ? baseUrl(process.env.CANOPOD_DOCS_URL || 'https://docs.canopod.com/') : siteUrl;
if (split) assert.notEqual(siteUrl, docsUrl, 'Split outputs need distinct public URLs');
const sites = (split ? [
  { name: 'website', folder: 'site-web', base: siteUrl, expected: marketingSlugs },
  { name: 'documentation', folder: 'site-docs', base: docsUrl, expected: docSlugs.map(slug => slug === 'getting-started' ? 'index' : slug) },
] : [{ name: 'combined', folder: 'site', base: siteUrl, expected: [...marketingSlugs, ...docSlugs] }]).map(site => ({
  ...site,
  root: join(website, site.folder),
  pages: new Map(),
  redirects: new Map(),
}));
const canonical = (site, file) => new URL(file === 'index.html' ? '' : file, site.base).href;
const titles = new Set();
const canonicalUrls = new Set();
let linkCount = 0;
let crossSiteLinks = 0;

// Inventory both hosts first, so a docs link from a marketing page can be checked
// against the actual docs build rather than silently treated as external.
for (const site of sites) {
  assert(existsSync(site.root), `Missing ${site.folder}; build ${split ? 'with --split' : 'the site'} first`);
  for (const file of readdirSync(site.root).filter(file => file.endsWith('.html'))) {
    const html = readFileSync(join(site.root, file), 'utf8');
    const page = { file, html, ids: [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]) };
    if (/<meta\b[^>]*http-equiv=["']refresh["']/i.test(html)) site.redirects.set(file, page);
    else site.pages.set(file, page);
  }
  assert.deepEqual([...site.pages.keys()].sort(), site.expected.map(slug => `${slug}.html`).sort(), `${site.name}: only its own canonical pages are published`);
  const allowedRedirects = !split ? [] : site.name === 'documentation' ? ['getting-started.html'] : docSlugs.map(slug => `${slug}.html`);
  for (const file of site.redirects.keys()) assert(allowedRedirects.includes(file), `${site.name}: unexpected redirect ${file}`);
  if (split && site.name === 'website') {
    assert.deepEqual([...site.redirects.keys()].sort(), [...allowedRedirects].sort(), 'website: every old documentation URL has a migration redirect');
  }
}

function localTarget(url) {
  // Longest prefix also supports staging two outputs below one test origin.
  const site = [...sites].sort((a, b) => b.base.length - a.base.length).find(candidate => url.href.startsWith(candidate.base));
  if (!site) return null;
  const base = new URL(site.base);
  const path = decodeURIComponent(url.pathname.slice(base.pathname.length)) || 'index.html';
  const absolute = resolve(site.root, path);
  assert(absolute.startsWith(site.root + sep), `URL escapes site output: ${url.href}`);
  return { site, path, absolute };
}

function checkLink(href, sourceSite, sourceFile, context = '') {
  if (/^(?:mailto:|tel:|data:|javascript:)/i.test(href)) return;
  const url = new URL(href, canonical(sourceSite, sourceFile));
  const target = localTarget(url);
  const label = `${sourceSite.name}/${sourceFile}${context}: ${href}`;
  if (!target) {
    assert(/^(?:https?:|\/\/)/i.test(href), `${label}: local link points outside either published site`);
    return;
  }
  assert(existsSync(target.absolute), `${label}: target is missing from ${target.site.folder}`);
  const page = target.site.pages.get(target.path) || target.site.redirects.get(target.path);
  if (url.hash && page) assert(page.ids.includes(decodeURIComponent(url.hash.slice(1))), `${label}: missing anchor`);
  linkCount++;
  if (sourceSite !== target.site) crossSiteLinks++;
}

function checkMarkdownLinks(text, site, file, context) {
  assert(!/\]\((?!https?:|mailto:|tel:|data:)[^\s)]+\)/.test(text), `${site.name}/${file}: relative Markdown link in ${context}`);
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) checkLink(decode(match[1]), site, file, ` (${context})`);
}

for (const site of sites) {
  for (const [file, { html, ids }] of site.pages) {
    const label = `${site.name}/${file}`;
    const expectedCanonical = canonical(site, file);
    assert.equal((html.match(/<h1(?:\s|>)/g) || []).length, 1, `${label}: one H1`);
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    assert(title && !titles.has(title), `${label}: unique title`); titles.add(title);
    assert.match(html, /<meta name="description" content="[^"]+"/, `${label}: description`);
    const canonicals = [...html.matchAll(/<link rel="canonical" href="([^"]+)"/g)];
    assert.equal(canonicals.length, 1, `${label}: one canonical`);
    assert.equal(decode(canonicals[0][1]), expectedCanonical, `${label}: canonical URL`);
    assert(!canonicalUrls.has(expectedCanonical), `${label}: canonical is not cross-published`);
    canonicalUrls.add(expectedCanonical);
    assert(!/content="[^"]*\bnoindex\b/i.test(html), `${label}: indexable`);
    assert(html.includes(`property="og:url" content="${expectedCanonical}"`), `${label}: social URL matches canonical`);
    const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(schemas.length, 1, `${label}: JSON-LD`);
    const schema = JSON.parse(schemas[0][1]);
    assert.equal(schema['@context'], 'https://schema.org', `${label}: schema context`);
    const pageSchema = schema['@graph'].find(item => ['WebPage', 'CollectionPage', 'AboutPage', 'ContactPage', 'TechArticle'].includes(item['@type']));
    assert(pageSchema, `${label}: page schema`);
    assert.equal(pageSchema.url, expectedCanonical, `${label}: schema URL`);
    assert.equal(pageSchema.isPartOf?.['@id'], `${site.base}#website`, `${label}: schema belongs to this host`);
    for (const breadcrumb of schema['@graph'].filter(item => item['@type'] === 'BreadcrumbList')) {
      for (const item of breadcrumb.itemListElement) checkLink(item.item, site, file, ' (breadcrumb schema)');
    }
    assert.equal(ids.length, new Set(ids).size, `${label}: duplicate IDs`);
    for (const match of html.matchAll(/\baria-controls="([^"]+)"/g)) assert(ids.includes(match[1]), `${label}: unresolved control ${match[1]}`);
    for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) checkLink(decode(match[1]), site, file);
    for (const image of html.matchAll(/<img\b([^>]*)>/g)) assert(/\balt="[^"]*"/.test(image[1]), `${label}: image alt text`);

    const mdPath = `content/${file.replace(/\.html$/, '.md')}`;
    const alternates = [...html.matchAll(/<link rel="alternate" type="text\/markdown" href="([^"]+)"/g)];
    assert.equal(alternates.length, 1, `${label}: one Markdown alternate`);
    assert.equal(decode(alternates[0][1]), new URL(mdPath, site.base).href, `${label}: Markdown alternate is on the same host`);
    assert(existsSync(join(site.root, mdPath)), `${label}: Markdown alternate exists`);
    const md = readFileSync(join(site.root, mdPath), 'utf8');
    assert(md.length > 100, `${label}: readable body`);
    assert(!md.includes('CANOPODCODEBLOCK'), `${label}: unresolved code placeholder`);
    assert(md.includes(`Canonical page: ${expectedCanonical}\n`), `${label}: Markdown canonical`);
    checkMarkdownLinks(md, site, file, 'Markdown alternate');
  }

  for (const [file, { html }] of site.redirects) {
    const targetFile = file === 'getting-started.html' ? 'index.html' : file;
    const expectedCanonical = new URL(targetFile === 'index.html' ? '' : targetFile, docsUrl).href;
    assert(/<meta name="robots" content="[^"]*\bnoindex\b/.test(html), `${site.name}/${file}: redirect alias is noindex`);
    assert(!/<article(?:\s|>)/.test(html), `${site.name}/${file}: alias must not duplicate the full documentation article`);
    assert(html.includes(`<link rel="canonical" href="${expectedCanonical}"`), `${site.name}/${file}: alias canonical points to the documentation page`);
    const destination = html.match(/http-equiv="refresh" content="[^";]+;\s*url=([^"]+)"/i)?.[1];
    assert(destination, `${site.name}/${file}: redirect destination`);
    const redirectUrl = new URL(decode(destination), new URL(file, site.base)).href;
    assert([expectedCanonical, new URL(targetFile, docsUrl).href].includes(redirectUrl), `${site.name}/${file}: redirects to the matching documentation page`);
    checkLink(redirectUrl, site, file, ' (redirect destination)');
    assert(/location\.replace\(/.test(html) && /location\.search/.test(html) && /location\.hash/.test(html), `${site.name}/${file}: redirects preserve the query and fragment`);
    for (const match of html.matchAll(/\bhref="([^"]+)"/g)) checkLink(decode(match[1]), site, file);
  }

  const sitemap = readFileSync(join(site.root, 'sitemap.xml'), 'utf8');
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => decode(match[1]));
  assert.equal(urls.length, site.pages.size, `${site.name}: sitemap page count excludes redirects`);
  assert.equal(new Set(urls).size, urls.length, `${site.name}: unique sitemap URLs`);
  for (const file of site.pages.keys()) assert(urls.includes(canonical(site, file)), `${site.name}: sitemap includes ${file}`);
  assert(!sitemap.includes('<lastmod>'), `${site.name}: no invented modification dates`);
  const markdownFiles = readdirSync(join(site.root, 'content')).filter(file => file.endsWith('.md'));
  assert.deepEqual(markdownFiles.sort(), [...site.pages.keys()].map(file => file.replace(/\.html$/, '.md')).sort(), `${site.name}: Markdown exports contain only this site's canonical pages`);

  const llms = readFileSync(join(site.root, 'llms.txt'), 'utf8');
  const mcpSlug = split && site.name === 'documentation' ? 'mcp' : 'canopod-mcp';
  assert(llms.includes(new URL(`content/${mcpSlug}.md`, site.base).href), `${site.name}: MCP discovery links to the relevant local guide`);
  assert(llms.includes('AGPL-3.0-only'), `${site.name}: license is explicit`);
  checkMarkdownLinks(llms, site, 'index.html', 'discovery index');
  const robots = readFileSync(join(site.root, 'robots.txt'), 'utf8');
  assert(robots.includes(`Sitemap: ${new URL('sitemap.xml', site.base).href}`), `${site.name}: robots references its own sitemap`);
  assert(!/^Disallow:\s*\/\s*$/m.test(robots), `${site.name}: robots permits crawling`);
  assert(existsSync(join(site.root, 'llms-full.txt')), `${site.name}: full-text export`);
  if (split) assert.equal(readFileSync(join(site.root, 'CNAME'), 'utf8').trim(), new URL(site.base).hostname, `${site.name}: CNAME matches public host`);
}

if (split) assert(crossSiteLinks > 0, 'Website and documentation link to each other');
const pageCount = sites.reduce((count, site) => count + site.pages.size, 0);
console.log(`Passed: ${pageCount} pages across ${sites.length} ${sites.length === 1 ? 'site' : 'sites'}, ${linkCount} internal links${split ? ` (${crossSiteLinks} between domains)` : ''}, unique metadata, JSON-LD, sitemaps, Markdown exports, image labels and interactive control targets.`);
