# Connect canopod.com and docs.canopod.com

The website and documentation are static sites. Namecheap remains the domain registrar;
GitHub Pages hosts both sites. No application backend is required.

| GitHub repository | Published content | Custom domain |
| --- | --- | --- |
| [emidhun/canopod](https://github.com/emidhun/canopod) | Product website | `canopod.com` |
| [emidhun/canopod-docs](https://github.com/emidhun/canopod-docs) | Documentation | `docs.canopod.com` |

All editable content stays in `emidhun/canopod/website`. The second repository contains
only the documentation publishing workflow and its README. GitHub Pages allows one site
per repository, so the second repository supplies the second hosting destination.

## 1. Publish the two sites

In each repository, open **Settings → Pages**, and choose **GitHub Actions** as the source.

- The **website** workflow in `canopod` runs when website changes reach `main`. It publishes
  `website/site-web`.
- In `canopod-docs`, open **Actions → Publish documentation → Run workflow**. Leave
  `source_ref` set to `main` to build the current source from `emidhun/canopod`. It publishes
  `website/site-docs` into the docs repository's own Pages site.

The docs workflow is stored as a template at `deployment/docs-pages.yml` in this directory;
its installed location in `canopod-docs` is `.github/workflows/docs.yml`.

For later documentation changes, push the source to `canopod/main`, then run **Publish
documentation** again. This avoids storing a cross-repository access token. The website
deploys automatically; the docs workflow is intentionally started manually.

Both workflows validate all pages, cross-domain links, fragments, canonical URLs,
sitemaps, and Markdown copies before publishing.

## 2. Set the custom domains in GitHub first

After the first successful deploy, open:

1. [Website Pages settings](https://github.com/emidhun/canopod/settings/pages): set
   **Custom domain** to `canopod.com` and save.
2. [Docs Pages settings](https://github.com/emidhun/canopod-docs/settings/pages): set
   **Custom domain** to `docs.canopod.com` and save.

Do this before changing the DNS records below. A DNS check may remain pending until step 3.
GitHub recommends verifying domain ownership first in your account's **Settings → Pages**;
if you do so, copy the exact TXT record GitHub provides into Namecheap. Do not invent the
verification value.

The generated `CNAME` files help with other static publishing methods, but GitHub Actions
deployments use the domain saved in **Settings → Pages**, not the file alone.

## 3. Add these records in Namecheap

Go to **Domain List → canopod.com → Manage → Advanced DNS → Host Records**.
These instructions apply when Namecheap BasicDNS, PremiumDNS, or FreeDNS is authoritative.
If the domain uses another provider's nameservers, edit the records at that provider instead.

Add the following six records. Use **Automatic** for TTL.

| Type | Host | Value |
| --- | --- | --- |
| A Record | `@` | `185.199.108.153` |
| A Record | `@` | `185.199.109.153` |
| A Record | `@` | `185.199.110.153` |
| A Record | `@` | `185.199.111.153` |
| CNAME Record | `www` | `emidhun.github.io` |
| CNAME Record | `docs` | `emidhun.github.io` |

The two CNAME values are deliberately the same. GitHub uses each repository's saved custom
domain to choose the right site. Use the hostname only: no `https://`, repository name, or path.

Replace conflicting parking/redirect/A/CNAME records for these exact hosts. If old AAAA
records exist for `@`, either remove them or replace them with GitHub's documented IPv6
addresses so IPv6 visitors reach the same host. Keep unrelated MX and TXT records, including
email records. Do not add a wildcard record.

With `canopod.com` configured as the website's custom domain, GitHub redirects
`www.canopod.com` to `canopod.com`.

## 4. Enable HTTPS and check the result

DNS changes and certificate provisioning can take up to 24 hours. Once GitHub's DNS check
passes and the certificate is ready, enable **Enforce HTTPS** in both repositories' Pages settings.

Check:

- <https://canopod.com/> shows the product homepage.
- <https://docs.canopod.com/> shows the documentation home.
- The website's **Docs** link opens the docs domain.
- The documentation's **Product**, **MCP**, and **Download** links open the website domain.
- Old documentation paths on the website redirect to the corresponding docs page.

GitHub Pages does not provide custom server-side 301 rules. The legacy docs paths use
canonical, noindex HTML redirects with a visible fallback link and preserve query strings
and anchors when JavaScript is available. Only the destination pages appear in sitemaps.

## Search engines

Verify `canopod.com` as a Domain property in Google Search Console, then submit both sitemaps:

- `https://canopod.com/sitemap.xml`
- `https://docs.canopod.com/sitemap.xml`

Each host publishes its own root `robots.txt`, canonical URLs, sitemap, Markdown page copies,
and optional `llms.txt` / `llms-full.txt`. Indexing and ranking are controlled by search engines.

## Local build commands

```sh
# One combined site for localhost previews:
node website/scripts/build.mjs
node website/scripts/check.mjs

# Two independent publishable outputs:
node website/scripts/build.mjs --split
node website/scripts/check.mjs --split
```

Split builds default to the two production domains above. `CANOPOD_SITE_URL` and
`CANOPOD_DOCS_URL` can override them; pass the same values to build and check. The defaults
for combined localhost previews retain the original GitHub Pages canonical base.

## Official references

- [GitHub Pages custom domains and DNS values](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
- [GitHub Pages site limits](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [Namecheap A record setup](https://www.namecheap.com/support/knowledgebase/article.aspx/319/2237/how-can-i-set-up-an-a-address-record-for-my-domain/)
- [Namecheap CNAME setup](https://www.namecheap.com/support/knowledgebase/article.aspx/9646/2237/how-to-create-a-cname-record-for-your-domain/)
