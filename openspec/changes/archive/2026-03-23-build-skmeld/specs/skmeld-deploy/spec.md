## ADDED Requirements

### Requirement: One-click deploy script
`apps/skmeld/deploy.ts` SHALL provision a Run402 project, build the React SPA, bundle deploy (schema + RLS + views + seed + functions + site + subdomain), invoke bootstrap, and print credentials + URLs. It SHALL read BUYER_PRIVATE_KEY and ADMIN_KEY from .env.

#### Scenario: Fresh deploy
- **WHEN** an operator runs `npx tsx apps/skmeld/deploy.ts`
- **THEN** a project SHALL be provisioned, the app SHALL be deployed with all components, bootstrap SHALL run, and the console SHALL print the subdomain URL + admin credentials

### Requirement: run402.yaml manifest
The app SHALL include a run402.yaml declaring bootstrap variables (admin_email, app_name, seed_demo_data) with types, descriptions, and defaults. This enables agent discoverability when the app is published to the marketplace.

#### Scenario: Manifest declares bootstrap variables
- **WHEN** the app is published
- **THEN** GET /apps/v1/:versionId SHALL include bootstrap_variables with admin_email (required), app_name (optional), seed_demo_data (optional, default false)

### Requirement: Marketplace publishing
The deploy script SHALL support a `--publish` flag that publishes the deployed app as a forkable version with visibility=public, fork_allowed=true, and tags including "maintenance", "property", "skmeld".

#### Scenario: Publish to marketplace
- **WHEN** the operator runs `npx tsx apps/skmeld/deploy.ts --publish`
- **THEN** the app SHALL be published and visible via GET /apps/v1 with appropriate tags

### Requirement: Documentation
The app SHALL include: README.md (overview + quick start), docs/setup.md (detailed setup), docs/customization.md (how to change branding, categories, statuses, labels), docs/data-dictionary.md (all tables and columns), docs/fork-prompts.md (example prompts for HOA, office, church forks). LICENSE SHALL be MIT.

#### Scenario: Fork prompts guide customization
- **WHEN** an agent reads docs/fork-prompts.md
- **THEN** it SHALL find 3+ example prompts that describe how to fork and customize SkMeld for different verticals
