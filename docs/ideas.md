# Feature Ideas

Ideas sourced from competitive analysis (primarily here.now comparison, March 2026).

---

## Password Protection for Sites

**Source:** here.now supports `PATCH /api/v1/publish/:slug/metadata` with `{"password": "secret"}`. Server-side enforcement, survives redeploys, removable with `{"password": null}`.

**Why:** Table stakes for sharing work-in-progress with clients/teammates. "Here's the staging URL, password is X" is a very common workflow. Currently all Run402 sites are world-readable.

**Implementation:** The gateway's subdomain middleware (`packages/gateway/src/middleware/subdomain.ts`) already intercepts `*.run402.com` requests, resolves the subdomain, and serves files from S3. Add a password check there:

1. Add `password_hash` column to `internal.subdomains` (or new `internal.site_metadata` table)
2. Store bcrypt hash when password is set via a new endpoint (e.g., `PATCH /subdomains/v1/:name/metadata`)
3. On request: if site has a password and no valid session cookie → return a password form
4. On correct password → set a signed cookie, redirect to the site
5. `{"password": null}` removes protection

No CloudFront Function or Lambda@Edge needed — the gateway already mediates all subdomain requests.

---

## Per-Site Payment Gating

**Source:** here.now supports setting a price on any site via metadata (`{"price": {"amount": "1.00", "currency": "USD"}}`). Visitors see a payment page. Agents get a 402 response with session URLs. Payments go to the site owner's wallet. Payment gating and password protection are mutually exclusive.

**Why:** Monetization primitive for creators and agents. An agent could generate a report, tool, or analysis and charge for access. Run402 already has x402 infrastructure but only uses it for API-level access (project creation, tier purchase), not per-site access.

**Implementation:** Similar to password protection — the subdomain middleware checks if the site has a price set. If so, return a 402 with payment instructions (for agents) or a payment page (for browsers). On payment confirmation, set a grant cookie/token. Reuse existing x402 payment verification logic.

---

## Site Duplication (Server-Side Copy)

**Source:** here.now supports `POST /api/v1/publish/:slug/duplicate`. Full server-side copy under a new slug — no re-upload. Optionally override viewer metadata.

**Why:** Enables forking/templating workflows. Agent takes an existing site, duplicates it, modifies the copy. Useful for A/B test pages, personalized variants, templates. Run402 has a fork/publish concept for full-stack apps but no lightweight site-only copy.

**Implementation:** New endpoint (e.g., `POST /deployments/v1/:id/duplicate`). Server-side `S3 CopyObject` for all files under `sites/{source_id}/*` to `sites/{new_id}/*`. Record new deployment in DB. Return new deployment URL. Requires wallet auth + ownership verification (deployment must belong to caller's project).

---

## Auto-Viewer for Single Files

**Source:** here.now auto-detects when a site has exactly one file and no `index.html`. Serves a rich viewer — image viewer for images, PDF viewer for PDFs, video player for video, audio player for audio.

**Why:** Common agent workflow: generate a single artifact (chart, report, recording) and share it. The auto-viewer adds a nice frame with title/description instead of raw file rendering. Small polish, good UX for the "instant sharing" use case.

**Implementation:** In the subdomain middleware / CloudFront Function: if the deployment has exactly one file and it's not `index.html`, wrap it in an HTML viewer template. Could be a simple HTML page with appropriate embed (`<img>`, `<video>`, `<iframe>` for PDF, `<audio>`). The template could be a static HTML file in S3 that gets the file URL injected.
