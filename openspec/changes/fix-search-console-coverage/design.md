## Context

Google Search Console coverage report (2026-03-27) shows run402.com has 19 not-indexed pages and only 2 indexed. Three pages return 403 (S3 AccessDenied) which Google reports as 404. Three client-side redirect pages (`/subscribe`, `/health`, `/status`) are flagged. Nine content pages are missing from the sitemap.

The site is static HTML on S3 behind CloudFront with a viewer-request function that rewrites directory paths to `index.html`. When no `index.html` exists, S3 returns 403 XML.

## Goals / Non-Goals

**Goals:**
- Eliminate all 3 "Not found" errors by ensuring directory paths resolve to real pages
- Clean up sitemap: remove redirect-only URLs, add all content pages
- Serve a branded 404 page instead of raw S3 XML for genuinely missing paths

**Non-Goals:**
- SEO keyword optimization or content changes to existing pages
- Server-side redirects (CloudFront Function changes for `/subscribe`, `/health`, `/status`) — the client-side redirects work, Google just flags them; converting to 301s is a separate change
- Fixing the "discovered but not indexed" status — that resolves naturally as Google re-crawls

## Decisions

**1. Use-cases index page as a real landing page (not a redirect)**
The `/use-cases` path will be a proper page listing all 4 use cases with titles, descriptions, and links. This adds SEO value rather than just fixing the 403.

**2. CloudFront custom error response for 403→404**
CloudFront's `errorResponses` config will map S3's 403 to a 404 status with `/404.html` as the response page. This is the standard pattern for private S3 buckets behind CloudFront — S3 returns 403 for missing objects, and CloudFront translates it.

TTL: 300 seconds (5 minutes). Long enough to avoid hammering S3 for repeated bad URLs, short enough that a newly deployed page becomes reachable quickly.

**3. Error page uses inline styles (no external CSS)**
The 404 page must be self-contained since it's served for any path — relative CSS paths would break.

## Risks / Trade-offs

**[Risk] 403→404 mapping hides real permission errors** → The bucket is private with OAC; the only 403 source is missing objects. Real permission errors would be an OAC misconfiguration, which would break the entire site (not individual pages).

**[Risk] CDK deploy required for CloudFront error response** → This is an infra change, not just an S3 sync. Must run `cdk deploy` for the Site stack. Low risk since it only adds an error response config.
