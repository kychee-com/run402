## ADDED Requirements

### Requirement: The portal is organized around the supervising developer, not the agent files

The portal SHALL present audience-separated information architecture — a `Start / Concepts / Build / Operate / Reference / Examples` structure — rather than rendering the agent reference files as the primary human surface. The homepage SHALL state the positioning *"a full-stack application platform that coding agents provision, deploy, and operate within a finite spending allowance"* and route three audiences (developers, coding agents, integrators) to distinct entry points.

#### Scenario: Homepage routes by audience

- **WHEN** a developer lands on `https://docs.run402.com/`
- **THEN** the page SHALL present the application-platform positioning (not "the backend")
- **AND** offer distinct paths for developers (tutorials/trust model), agents (`llms.txt`/`SKILL.md`/task docs), and integrators (SDK/CLI/MCP/HTTP/OpenAPI)

#### Scenario: Browser title is not duplicated

- **WHEN** any portal page renders its `<title>`
- **THEN** it SHALL NOT repeat the site name (no `Run402 Docs | Run402 Docs`)

### Requirement: Concept pages teach the human mental models

The portal SHALL provide concept pages for the platform's load-bearing ideas: **allowances** (what is authorized, prepaid vs on-chain balance, behavior at zero, holds, replenishment, refunds, revocation, what is NOT capped), **credentials & trust boundaries** (each credential's holder/scope/browser-safety/rotation), and **releases** (plan/stage/activate, replace vs patch, carry-forward, promotion, why promotion does not undo migrations). Each guarantee SHALL be stated only as the implementation actually provides it.

#### Scenario: Allowance hard-cap stated as an invariant

- **WHEN** a developer reads `/concepts/allowances/`
- **THEN** the page SHALL state the spending-cap invariant (with replenishment disabled, no purchase exceeds the prepaid balance; authorization+reservation are atomic; no fallback card)
- **AND** SHALL state what the allowance does NOT cap (e.g. external services called by application code)

#### Scenario: Credentials trust-boundary table is present

- **WHEN** a developer reads `/concepts/credentials/`
- **THEN** the page SHALL tabulate each credential (allowance key, operator session, anon_key, service_key, user session, OIDC binding, runtime secrets) with holder, scope, browser-safety, and rotation/revocation

### Requirement: A prompt-first first-app tutorial is the primary onboarding

The `Start` section SHALL include a tutorial whose primary flow is a natural-language prompt (no CLI commands in the main path), documenting what the agent needs, what it will do, what success looks like, what it must not do, and how the human verifies the result. Underlying commands SHALL be available in a collapsed section.

#### Scenario: First-app tutorial leads with a prompt

- **WHEN** a developer opens `/start/first-app/`
- **THEN** the primary flow SHALL be a copy-pasteable prompt plus a human verification checklist
- **AND** raw CLI commands SHALL appear only in a collapsed "what the agent executes" section

### Requirement: API and schemas are rendered, not just linked

The `Reference` section SHALL render the OpenAPI document and the JSON Schemas (`ReleaseSpec`, exposure manifest) as navigable pages with per-property anchors, generated from the committed `openapi.json` / `schemas/*.json` at build time.

#### Scenario: HTTP API reference is browsable

- **WHEN** a developer opens `/reference/http/`
- **THEN** the portal SHALL render the OpenAPI operations from `openapi.json` with per-operation anchors

### Requirement: Reference monoliths are split into navigable pages without losing machine-completeness

The CLI/SDK/MCP references SHALL be split into ordered sub-pages (via the existing single-source generator, so the flat `llms-*.txt` stay byte-complete). Rendered reference pages SHALL NOT contain a duplicate body-level H1 alongside the frontmatter title. Platform-operator/admin commands SHALL be presented on a clearly-separated page, not interleaved with the ordinary developer command flow.

#### Scenario: A reference page is navigable and single-H1

- **WHEN** a developer opens the CLI reference
- **THEN** it SHALL be split into sectioned sub-pages with a manageable table of contents
- **AND** SHALL render exactly one top-level heading (no `CLI reference` + `Run402 CLI ...` duplication)

#### Scenario: Flat files stay byte-complete after the split

- **WHEN** the reference content is reorganized into sub-pages and the generator runs
- **THEN** `llms-cli.txt` / `llms-sdk.txt` / `llms-mcp.txt` SHALL remain complete (regen-clean gate passes)

#### Scenario: Platform-operator commands are separated

- **WHEN** a developer browses the CLI reference
- **THEN** platform-admin commands SHALL live on a distinct "platform operators" page, not in the developer flow
