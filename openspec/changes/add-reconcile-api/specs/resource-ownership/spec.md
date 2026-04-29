## ADDED Requirements

### Requirement: Reconcile-managed resources are tagged with ownership metadata

Every resource (function, secret, site deployment, subdomain claim, custom domain attachment, route rule) created or updated through `apps.reconcile` SHALL be tagged with ownership metadata: `owner: "reconcile"`, `project`, `environment`, `app_spec_version`, `bundle_id`. Resources created through primitive APIs (`functions.deploy`, `blobs.put`, `sites.deploy`, etc.) without going through reconcile SHALL be tagged `owner: "manual"`.

#### Scenario: Reconcile creates a function tagged with ownership

- **WHEN** a function is created or updated via `apps.reconcile`
- **THEN** the function record carries tags `(owner: "reconcile", project, environment, app_spec_version, bundle_id)`

#### Scenario: Direct functions.deploy creates a manual function

- **WHEN** a function is created via `functions.deploy` (not through reconcile)
- **THEN** the function record carries tag `owner: "manual"`

### Requirement: Reconcile prunes only resources it owns

When `apps.reconcile` is called with `prune` flags enabled (e.g. `prune: { functions: true }`), the server SHALL delete only resources tagged `(owner: "reconcile", project, environment)` that are not in the new desired state. Resources tagged `owner: "manual"` SHALL NEVER be auto-deleted by reconcile, regardless of prune flags.

#### Scenario: Reconcile with prune deletes orphaned reconcile-owned function

- **WHEN** a previous reconcile created functions `webhook` and `cron`
- **AND** the new reconcile spec only contains `webhook`
- **AND** the reconcile is called with `prune: { functions: true }`
- **THEN** `cron` is deleted
- **AND** the reconcile result's `phase_results.functions.items` includes `{ name: "cron", status: "removed" }`

#### Scenario: Reconcile with prune does not delete manual functions

- **WHEN** a manual function `legacy_handler` exists (created via `functions.deploy`)
- **AND** a reconcile spec does not include `legacy_handler`
- **AND** the reconcile is called with `prune: { functions: true }`
- **THEN** `legacy_handler` is NOT deleted
- **AND** it appears in the reconcile result's `live_state.drift` array

#### Scenario: Reconcile without prune does not delete anything

- **WHEN** a reconcile spec does not include resources from a prior reconcile
- **AND** the call omits the `prune` block (or sets all prune flags false)
- **THEN** no resources are deleted
- **AND** the orphaned resources appear in `live_state.drift` and `warnings`

### Requirement: Drift between desired and live is reported, not auto-corrected

Reconcile and describe responses SHALL include a `drift` block listing resources that exist in `live_state` but are not part of the current head bundle's desired state. Drift entries SHALL include `resource_type`, `resource_id`, `drift_type` (`"orphan"` | `"manual"` | `"foreign_owner"`), and optional `detail`. Drift SHALL NEVER be auto-corrected without explicit caller intent (i.e. an explicit prune flag).

#### Scenario: Manual function appears as drift

- **WHEN** an agent reconciles an environment with the same spec twice, but between the calls a manual `functions.deploy` adds `helper_fn`
- **THEN** the second reconcile's `live_state.drift` includes `{ resource_type: "function", resource_id: "helper_fn", drift_type: "manual" }`

#### Scenario: Drift survives a no-op reconcile

- **WHEN** the spec matches the previous head bundle exactly (status would be `noop`) but drift exists
- **THEN** the response still has `status: "noop"` (no mutations occurred)
- **AND** `live_state.drift` is populated
- **AND** `warnings` includes `{ type: "drift_present", count: N }`

### Requirement: Pruning policy can be set per resource type

The `prune` block in `apps.reconcile` SHALL accept independent flags per resource category: `functions`, `secrets`, `routes`, `custom_domains`, `subdomain`. The default (when `prune` is omitted) SHALL be `false` for all categories. AppSpec MAY set a default `prune` block that callers can override at reconcile time.

#### Scenario: Spec sets default prune; reconcile overrides

- **WHEN** the AppSpec includes `"prune": { "functions": true, "secrets": false }`
- **AND** a reconcile call passes `prune: { functions: false }`
- **THEN** the reconcile uses `prune: { functions: false, secrets: false }` for that call
- **AND** the AppSpec default does not auto-merge in for unspecified flags

### Requirement: Bundle metadata is preserved and surfaced

Every reconcile call SHALL accept optional `metadata: { revision?, branch?, actor?, session?, tags? }` and store it on the resulting bundle. Subsequent `apps.describe`, `apps.get`, `apps.list`, `apps.events`, and `apps.logs` SHALL surface this metadata for correlation across sessions and agents.

#### Scenario: Bundle metadata flows into describe

- **WHEN** an agent reconciles with `metadata: { revision: "git-sha-abc", branch: "main", actor: "agent-1", session: "sess_xyz" }`
- **THEN** `apps.describe`'s `head_bundle.metadata` includes those fields
- **AND** `apps.events({ bundleId })` includes `actor` and `session` on emitted events

### Requirement: capabilities surface includes feature flags for ownership and prune

`projects.capabilities` SHALL include the set of supported `prune` categories and `drift` detection features for the project's tier. Lower tiers MAY restrict pruning to a subset of resource categories.

#### Scenario: Tier-restricted pruning

- **WHEN** a project on a tier without custom-domain pruning calls reconcile with `prune: { custom_domains: true }`
- **THEN** preflight fails with `error.type: "feature_unavailable"` and `next_actions` pointing at tier upgrade
