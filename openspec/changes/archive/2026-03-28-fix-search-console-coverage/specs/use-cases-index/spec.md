## ADDED Requirements

### Requirement: Use-cases index page exists at /use-cases
The site SHALL serve an HTML page at `/use-cases` (resolved via `/use-cases/index.html`) that lists all use-case pages with titles, brief descriptions, and links.

#### Scenario: Visiting /use-cases returns 200
- **WHEN** a user or crawler requests `https://run402.com/use-cases`
- **THEN** the server returns HTTP 200 with an HTML page

#### Scenario: All use-case pages are linked
- **WHEN** the use-cases index page is rendered
- **THEN** it contains links to all 4 use-case pages: `/use-cases/supabase-alternative-for-agents`, `/use-cases/vercel-alternative-for-agents`, `/use-cases/free-postgres-for-prototype`, `/use-cases/deploy-app-without-aws-account`

### Requirement: Use-cases index is in the sitemap
The `sitemap.xml` SHALL include `https://run402.com/use-cases` as an entry.

#### Scenario: Sitemap contains use-cases URL
- **WHEN** `sitemap.xml` is parsed
- **THEN** it contains a `<url>` entry with `<loc>https://run402.com/use-cases</loc>`
