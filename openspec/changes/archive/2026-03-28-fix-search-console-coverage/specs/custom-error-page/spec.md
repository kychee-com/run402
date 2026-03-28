## ADDED Requirements

### Requirement: CloudFront serves a branded 404 page for missing paths
CloudFront SHALL return a 404 status code with `/404.html` as the response body when S3 returns 403 (AccessDenied) for a non-existent object.

#### Scenario: Non-existent path returns 404 with branded page
- **WHEN** a user requests a path that does not exist (e.g., `/nonexistent`)
- **THEN** the response status is 404 and the body is the contents of `/404.html`

#### Scenario: 404 page is self-contained
- **WHEN** the 404 page is rendered
- **THEN** all styles are inline (no external CSS dependencies) and the page includes a link back to the homepage

### Requirement: Sitemap excludes redirect-only pages
The `sitemap.xml` SHALL NOT include URLs that serve only as redirects (no indexable content).

#### Scenario: /subscribe is not in sitemap
- **WHEN** `sitemap.xml` is parsed
- **THEN** it does not contain a `<url>` entry with `<loc>https://run402.com/subscribe</loc>`

### Requirement: Sitemap includes all content pages
The `sitemap.xml` SHALL include entries for all pages that serve indexable HTML content.

#### Scenario: Humans subpages are in sitemap
- **WHEN** `sitemap.xml` is parsed
- **THEN** it contains `<url>` entries for `/humans/about.html`, `/humans/faq.html`, `/humans/privacy.html`, `/humans/terms.html`, `/humans/legal.html`, `/humans/vision.html`, `/humans/mpp.html`

#### Scenario: Agencies and freelance pages are in sitemap
- **WHEN** `sitemap.xml` is parsed
- **THEN** it contains `<url>` entries for `/agencies` and `/freelance`
