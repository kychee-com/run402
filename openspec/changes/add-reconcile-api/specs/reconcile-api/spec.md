## ADDED Requirements

### Requirement: apps.reconcile is the primary deployment motion

The platform SHALL expose an `apps.reconcile` HTTP endpoint and SDK method that takes a desired application state (a typed AppSpec plus content-addressed bundle references) and reconciles it against the live state of a named environment. Reconcile SHALL be the recommended primary motion for agents; per-resource APIs (`sites.deploy`, `functions.deploy`, etc.) SHALL remain as escape hatches.

#### Scenario: Reconcile with mode=preview produces a diff without mutation

- **WHEN** a client calls `apps.reconcile` with `mode: "preview"` and a complete AppSpec
- **THEN** the response includes `status: "preview"` and a populated `diff` block
- **AND** no resources are mutated
- **AND** no bundle is created
- **AND** no migrations are applied

#### Scenario: Reconcile with mode=apply executes the planned changes

- **WHEN** a client calls `apps.reconcile` with `mode: "apply"` and the desired state differs from current
- **THEN** the server runs preflight, then executes phase-by-phase mutation
- **AND** the response includes `status: "applied" | "partial"`, full `phase_results`, and `live_state`
- **AND** a new `bundleId` is returned

#### Scenario: Reconcile with no changes returns noop

- **WHEN** a client calls `apps.reconcile` with `mode: "apply"` and the desired state matches current state exactly
- **THEN** the response has `status: "noop"`
- **AND** no migrations, secret writes, function deploys, or site deploys occur
- **AND** the existing `bundleId` is returned (no new bundle is created)

#### Scenario: Reconcile fails preflight with no side effects

- **WHEN** preflight detects an unmet condition (e.g. tier too low, subdomain unavailable, DNS unverified, quota exceeded, checksum mismatch)
- **THEN** the response has `status: "blocked"` and `phase_results.preflight.checks` populated with the failing checks
- **AND** no mutations occur in any phase
- **AND** the response includes `next_actions` pointing at remediation calls

### Requirement: apps.describe returns the current live state of an environment

The platform SHALL expose an `apps.describe` endpoint and SDK method that takes `(project, environment)` and returns the full live state, including head bundle, resource versions, drift, and recent bundle history.

#### Scenario: Agent calls describe after context reset

- **WHEN** an agent (with no local memory of prior bundles) calls `apps.describe({ project, environment })`
- **THEN** the response includes `head_bundle.id`, `live_state` (functions, secrets fingerprints, applied migrations, site URL, subdomain, custom domains), and `recent_bundles`
- **AND** the response includes `drift` listing any live resources not owned by the head bundle

#### Scenario: Describe an environment that does not exist yet

- **WHEN** a client calls `apps.describe` for an environment with no prior reconcile
- **THEN** the response returns `head_bundle: null` and an empty `live_state`
- **AND** does not error

### Requirement: apps.diff is a first-class read-only operation

The platform SHALL expose an `apps.diff` endpoint that takes the same input as reconcile (minus mode/waitFor/verify) and returns only the `diff` block. It SHALL NOT mutate state.

#### Scenario: Diff is cheaper than reconcile preview

- **WHEN** a client calls `apps.diff` with a desired state
- **THEN** the response includes only the `diff` block
- **AND** no preflight checks that require external state (e.g. DNS verification probes) are run if not strictly needed for diff computation

### Requirement: Reconcile result carries per-phase ledger

The reconcile response SHALL include a `phase_results` block keyed by phase name (`preflight`, `migrations`, `secrets`, `functions`, `site`, `subdomain`, `custom_domains`). Each phase SHALL carry its own `status`. Phases that contain multiple items (functions, custom_domains) SHALL include a per-item array with status.

#### Scenario: Partial-failure reconcile shows exactly which items failed

- **WHEN** a reconcile call results in some phases applied and others failed
- **THEN** `phase_results.<phase>.status` reflects the per-phase outcome
- **AND** for multi-item phases, `phase_results.<phase>.items` includes a status per item
- **AND** `live_state` reflects the actual current truth (not the desired state)

#### Scenario: Failed function build includes structured error

- **WHEN** a function build fails during reconcile
- **THEN** `phase_results.functions.items[i].error` includes structured fields: `file`, `line`, `column`, `code`, `message`, `severity`
- **AND** does not return a prose-only error blob

### Requirement: Concurrency control via base + auto-merge

Reconcile SHALL support optimistic concurrency via an optional `base` parameter (the bundle ID the agent expects to be current head). When omitted, callers can specify `concurrency: "auto-merge" | "fail-on-drift" | "force"`.

#### Scenario: Agent has stale base; auto-merge succeeds with no resource conflicts

- **WHEN** the agent submits with `base: "bundle_abc"` and concurrency `"auto-merge"`
- **AND** the current head is `bundle_xyz` but `xyz`'s changes do not conflict with the agent's desired state
- **THEN** the reconcile succeeds and produces a new bundle on top of `xyz`

#### Scenario: Agent has stale base; conflicting change fails the reconcile

- **WHEN** the agent submits with `base: "bundle_abc"` and concurrency `"fail-on-drift"`
- **AND** the current head is `bundle_xyz` (different from `abc`)
- **THEN** the reconcile fails with `error.type: "concurrency_conflict"` and `next_actions` pointing at `apps.describe` and a retry strategy

### Requirement: Bundle and history endpoints

The platform SHALL expose `apps.get(bundleId)` to fetch a specific bundle's spec, manifest, phase_results, and metadata. It SHALL expose `apps.list({ project, environment?, limit?, cursor? })` returning a paginated bundle history with cursor-based pagination.

#### Scenario: Get a bundle by ID

- **WHEN** a client calls `apps.get(bundleId)`
- **THEN** the response includes the AppSpec, bundle manifest, phase_results, live_state at deploy time, and metadata (revision, branch, actor, session)

#### Scenario: List bundles is paginated

- **WHEN** a client calls `apps.list` and there are more results than the page size
- **THEN** the response includes `next_cursor`
- **AND** SDK consumers can use async iteration to walk all bundles

### Requirement: Promote moves a preview's bundle to another environment

The platform SHALL expose `apps.promote({ from, to })` that atomically copies the head bundle of one environment to another. The operation SHALL preflight whether the target environment can accept the bundle (DB head compatibility, subdomain conflicts, etc.) and SHALL fail with structured errors when not.

#### Scenario: Promote a verified preview to production

- **WHEN** a client calls `apps.promote({ from: "preview/feat-auth", to: "production" })`
- **AND** preflight passes (production DB head is compatible, no subdomain conflicts)
- **THEN** the production environment's head bundle pointer is atomically updated to the preview's bundle
- **AND** functions, site, subdomain, and custom domains are swapped in a single observable transition

#### Scenario: Promotion blocked by DB head mismatch

- **WHEN** the preview was reconciled with newer migrations than production has applied
- **THEN** promote fails with `error.type: "db_head_mismatch"` and `next_actions` pointing at running the missing migrations on production directly

### Requirement: AppSpec schema is typed and versioned

The platform SHALL publish a typed JSON schema for `run402.json` (the AppSpec), versioned via a `$schema` URL and an integer `version` field. The schema SHALL describe build configuration, function definitions, route rules, header rules, redirects, health checks, and prune policy. The schema SHALL be discoverable via `projects.capabilities`.

#### Scenario: SDK validates AppSpec locally before submitting

- **WHEN** an agent constructs an AppSpec and calls reconcile via the SDK
- **THEN** the SDK validates the spec against the schema before issuing the HTTP call
- **AND** schema violations produce a typed local error with `path` and `message` per violation

#### Scenario: Schema version mismatch is a clear error

- **WHEN** a client submits an AppSpec with a `version` the gateway does not support
- **THEN** the response is `error.type: "spec_version_unsupported"` with `supported_versions`

### Requirement: Reconcile waits for health when requested

Reconcile SHALL accept `waitFor: "active" | "healthy" | "none"`. When `"healthy"`, the gateway runs the spec's `verify` block (HTTP probes against site routes, function invocations against the deployed functions) and returns the result inline. The reconcile response SHALL NOT report `status: "applied"` when health checks fail; it reports `status: "partial"` with `health.status: "failed"`.

#### Scenario: Site deploys but health check fails

- **WHEN** reconcile applies a site deployment but the health check `GET /` returns 500
- **THEN** the response has `status: "partial"`, `phase_results.site.status: "ok"`, but `health.status: "failed"` with the failing check
- **AND** `next_actions` includes pointers at `apps.logs` for debugging
