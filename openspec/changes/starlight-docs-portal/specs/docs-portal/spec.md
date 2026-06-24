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

### Requirement: The portal hosts the R402_* error reference for the envelope docs-URL contract

The portal SHALL host the `R402_*` error-code reference. Error envelopes carry a `docs` URL of the form `https://docs.run402.com/<topic>/<page>#<anchor>` (e.g. `astro/errors#build-failed`, `functions/errors#snapstart-init-io`, `cache/errors#unsupported-vary`). The portal SHALL serve those topic pages with anchors matching the codes' published `docs` URLs. The exact per-topic page split and anchor slugs are owned by the in-flight `astro-ssr-runtime` change; they SHALL be reconciled with its canonical code list before that change is generally available. (v1 ships a consolidated, browsable reference; the per-topic anchor split is the reconciliation deliverable.)

#### Scenario: Error reference is browsable

- **WHEN** a developer opens the portal's error-code reference
- **THEN** the portal SHALL render the `R402_*` codes with their messages and suggested fixes

#### Scenario: Envelope docs URLs resolve to the matching code

- **WHEN** an error envelope's `docs` URL (e.g. `https://docs.run402.com/astro/errors#build-failed`) is followed
- **THEN** the portal SHALL load the corresponding topic page anchored at that code's section

### Requirement: Portal is built static and deployed via the existing OIDC path

The portal SHALL be produced by a static Astro build (`output: 'static'`) and deployed through the existing `deploy-docs.yml` GitHub OIDC workflow as `spec.site` content. No server-side rendering function SHALL be introduced for the portal.

#### Scenario: Content change deploys statically

- **WHEN** a documentation content change is pushed to `main`
- **THEN** CI SHALL run the static Astro build and `run402 deploy apply` against the existing docs project
- **AND** the deploy SHALL ship only static site content, creating no SSR function
