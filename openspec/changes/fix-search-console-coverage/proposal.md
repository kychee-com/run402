## Why

Google Search Console reports 3 "Not found (404)" pages and 3 "Page with redirect" pages for run402.com, with only 2 of 21 discovered pages indexed. The 404s are caused by missing `index.html` files at parent directory paths (e.g., `/use-cases` returns 403 from S3), the redirects include `/subscribe` which is wastefully listed in the sitemap, and 9 real content pages are missing from the sitemap entirely.

## What Changes

- Remove `/subscribe` from `sitemap.xml` (it just redirects to `/billing`)
- Add 9 missing pages to `sitemap.xml`: 7 humans subpages (`about`, `faq`, `privacy`, `terms`, `legal`, `vision`, `mpp`) + `/agencies` + `/freelance`
- Create `site/use-cases/index.html` as a use-cases index/landing page (fixes the `/use-cases` 403)
- Add a CloudFront custom error response mapping 403 → 404 with a friendly error page, replacing raw S3 XML

## Capabilities

### New Capabilities
- `use-cases-index`: A landing page at `/use-cases` that lists all use-case pages with titles and descriptions
- `custom-error-page`: A branded 404 page served by CloudFront when S3 returns 403 for non-existent paths

### Modified Capabilities

## Impact

- `site/sitemap.xml` — entries added/removed
- `site/use-cases/index.html` — new file
- `site/404.html` — new file
- `infra/lib/site-stack.ts` — CloudFront error response configuration added
