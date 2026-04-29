## ADDED Requirements

### Requirement: environment is a first-class dimension on app-level APIs

The `apps.reconcile`, `apps.describe`, `apps.diff`, `apps.list`, `apps.promote`, `apps.retire`, `apps.events`, `apps.logs`, and `apps.health` endpoints SHALL accept an `environment` parameter (string, default `"production"`). Reserved environment names: `production`, `preview/<branch>`, `preview/<id>`. Per-resource APIs (sites, functions, secrets) SHALL gain optional `environment` parameters for direct manipulation when reconcile is not used.

#### Scenario: First reconcile to a preview creates the environment

- **WHEN** a client calls `apps.reconcile({ environment: "preview/feat-auth", ... })` for the first time
- **THEN** the environment is created on demand
- **AND** resources tagged `environment: "preview/feat-auth"` are isolated from `production`

#### Scenario: Production is the default environment

- **WHEN** a client calls `apps.reconcile` without an `environment` parameter
- **THEN** the call targets `environment: "production"` implicitly

### Requirement: Preview environments serve from environment-prefixed subdomains

When a preview environment claims a subdomain or attaches to a project's default subdomain, the resulting URL SHALL be prefixed by the environment's safe slug. For `preview/feat-auth` claiming subdomain `myapp`, the URL is `https://feat-auth.myapp.preview.run402.com` (or equivalent prefix scheme decided by the gateway).

#### Scenario: Preview subdomain URL differs from production

- **WHEN** a preview environment is reconciled with the same subdomain config as production
- **THEN** the response's `live_state.subdomain.url` for the preview includes a stable preview-prefix scheme distinct from production's URL

### Requirement: Functions and sites in preview environments are isolated from production

Preview-environment function invocations SHALL NOT route to production function instances. Preview-environment site requests SHALL serve preview-environment site files. Each environment's `head_bundle` is independent.

#### Scenario: Updating a preview function does not affect production

- **WHEN** a client reconciles `preview/feat-auth` with a new function version
- **THEN** invoking the function in `preview/feat-auth` returns the new behavior
- **AND** invoking the function in `production` returns the prior production behavior

### Requirement: Secrets can be environment-scoped or shared

Secrets SHALL support both project-level (shared across environments, default) and environment-level scoping. When a secret is set with an explicit `environment`, it overrides the project-level secret for that environment only.

#### Scenario: Preview environment overrides a production secret

- **WHEN** a client sets `STRIPE_KEY` at project level (live key) and overrides `STRIPE_KEY` for `preview/feat-auth` (test key)
- **THEN** functions invoked in `preview/feat-auth` see the test key
- **AND** functions invoked in `production` see the live key

### Requirement: Preview retire tears down environment-scoped resources

`apps.retire({ environment })` SHALL delete all resources tagged `(owner: "reconcile", environment)`. Manual resources tagged with that environment SHALL NOT be auto-deleted; they SHALL be reported in the response's `orphaned_manual_resources` list.

#### Scenario: Retire a preview environment

- **WHEN** a client calls `apps.retire({ environment: "preview/feat-auth" })`
- **THEN** functions, site deployment, subdomain claims, custom domain attachments, and environment-scoped secrets owned by reconcile in that environment are deleted
- **AND** the head bundle pointer for the environment is removed
- **AND** any DB schema branch (if branching is enabled) is dropped

#### Scenario: Retire production is rejected

- **WHEN** a client calls `apps.retire({ environment: "production" })`
- **THEN** the call fails with `error.type: "cannot_retire_production"` and `hint` pointing at `apps.delete_project` for full project teardown

### Requirement: Preview DB branching is a tier feature surfaced via capabilities

Preview environments SHALL share the project's database by default. When the project's tier supports it (surfaced via `projects.capabilities`), preview environments MAY have isolated database branches (cloned schema, independent data). Branching policy is set in the AppSpec under `environment_overrides`.

#### Scenario: Capabilities exposes preview DB branching availability

- **WHEN** a client calls `projects.capabilities`
- **THEN** the response includes `features.preview_db_branching: bool` reflecting whether the current tier supports per-preview DB branches

#### Scenario: Reconcile with branching requested on a tier without it

- **WHEN** an AppSpec requests preview DB branching but the project's tier does not include it
- **THEN** preflight fails with `error.type: "tier_too_low"` and `next_actions` pointing at `tier.set` and `projects.capabilities`

### Requirement: Promote moves environment heads atomically

`apps.promote({ from, to })` SHALL atomically swap the `to` environment's head bundle to the `from` environment's bundle. Functions, site deployment pointer, subdomain claim ownership, and custom domain attachments SHALL all transition in a single observable atomic operation. Migrations SHALL NOT be replayed; promotion SHALL fail preflight when the target environment's DB head is incompatible.

#### Scenario: Successful promotion

- **WHEN** `apps.promote({ from: "preview/feat-auth", to: "production" })` runs and preflight passes
- **THEN** all production resource pointers (functions, site, subdomain, custom domains) atomically reflect the preview's bundle
- **AND** subsequent `apps.describe({ environment: "production" })` returns the promoted bundle as head

#### Scenario: Promotion fails on DB head incompatibility

- **WHEN** the preview applied migrations newer than production
- **THEN** `apps.promote` fails preflight with `error.type: "db_head_mismatch"`, listing the migrations production needs to apply
- **AND** `next_actions` includes a call to `sql.migrate` against production with the missing migrations
