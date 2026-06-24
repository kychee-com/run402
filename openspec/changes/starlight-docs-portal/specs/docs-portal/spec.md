## ADDED Requirements

### Requirement: Human-facing documentation portal at the docs root

`docs.run402.com` SHALL serve a navigable, human-readable documentation portal at its root (`/`), built as a static Astro Starlight site. The portal SHALL provide sidebar navigation, client-side search, and syntax highlighting, targeted at the developer supervising the agent. The portal SHALL be served from the existing run402 docs project (`prj_1780488560350_0018`) — no new project or infrastructure is introduced.

#### Scenario: Developer opens the docs root

- **WHEN** a developer navigates to `https://docs.run402.com/`
- **THEN** they SHALL receive a `text/html` documentation portal with sidebar navigation
- **AND** the page SHALL be served from the run402-hosted static site

#### Scenario: In-portal search

- **WHEN** a developer enters a query in the portal's search
- **THEN** the portal SHALL return matching documentation pages using its client-side search index
- **AND** the search SHALL function without any server-side runtime

### Requirement: Portal coexists with the flat agent files

The portal's HTML routes SHALL occupy `/` and topic paths only, leaving the flat agent-doc paths (`/llms-cli.txt`, `/llms-sdk.txt`, `/llms-mcp.txt`, `/SKILL.md`) untouched. The flat files SHALL continue to serve at those exact paths with their established content types (`text/plain` for `.txt`, `text/markdown` for `.md`).

#### Scenario: HTML route serves the portal

- **WHEN** a client requests `https://docs.run402.com/`
- **THEN** the response SHALL be `Content-Type: text/html`

#### Scenario: Flat-file path is unchanged by the portal

- **WHEN** an agent requests `https://docs.run402.com/llms-cli.txt`
- **THEN** the response SHALL be `Content-Type: text/plain`
- **AND** the bytes SHALL be the comprehensive CLI reference, unchanged by the portal's presence

### Requirement: The portal hosts an informational R402_* error-code reference

The portal SHALL host a human-readable reference of the `R402_*` error-envelope codes (messages and suggested fixes) for the supervising developer. This is an informational **mirror**; it is NOT the canonical target of the error envelopes' `docs` field. Those URLs resolve to `https://run402.com/errors/` (per-code anchors like `#R402_ASTRO_BUILD_FAILED`), shipped independently by the `astro-ssr-runtime` change. Consolidating the canonical error docs onto this portal is an optional future change, explicitly out of scope here.

#### Scenario: Error reference is browsable

- **WHEN** a developer opens the portal's error-code reference
- **THEN** the portal SHALL render the `R402_*` codes with their messages and suggested fixes

### Requirement: Portal is built static and deployed via the existing OIDC path

The portal SHALL be produced by a static Astro build (`output: 'static'`) and deployed through the existing `deploy-docs.yml` GitHub OIDC workflow as `spec.site` content. No server-side rendering function SHALL be introduced for the portal.

#### Scenario: Content change deploys statically

- **WHEN** a documentation content change is pushed to `main`
- **THEN** CI SHALL run the static Astro build and `run402 deploy apply` against the existing docs project
- **AND** the deploy SHALL ship only static site content, creating no SSR function
