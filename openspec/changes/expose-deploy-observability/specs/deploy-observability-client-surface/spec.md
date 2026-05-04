## ADDED Requirements

### Requirement: SDK defines deploy release inventory types

The SDK SHALL export typed deploy observability inventory shapes matching the shipped `/deploy/v2/releases/{id}` and `/deploy/v2/releases/active` envelopes.

The `ReleaseInventory` type SHALL be a union of `ActiveReleaseInventory` and `ReleaseSnapshotInventory`.

The shared inventory fields SHALL include `kind: "release_inventory"`, `schema_version: "agent-deploy-observability.v1"`, `release_id`, `project_id`, `parent_id`, `status`, `manifest_digest`, `created_at`, `created_by`, `activated_at`, `superseded_at`, `operation_id`, `plan_id`, `events_url`, `effective`, `state_kind`, `site`, `functions`, `secrets`, `subdomains`, and `migrations_applied`.

The `state_kind` field SHALL be the discriminator for inventory semantics and SHALL allow only `"current_live"`, `"effective"`, and `"desired_manifest"`.

`ActiveReleaseInventory` SHALL have `state_kind: "current_live"`. `ReleaseSnapshotInventory` SHALL have `state_kind: "effective" | "desired_manifest"`.

Inventory site path entries SHALL expose `path`, `content_sha256`, and `content_type`. Inventory functions SHALL expose `name`, `code_hash`, `runtime`, `timeout_seconds`, `memory_mb`, and `schedule?: string | null`, and SHALL NOT expose `env_keys` or `source_sha`. Inventory secrets SHALL expose only `{ keys: string[] }`. Inventory subdomains SHALL expose `{ names: string[] }`. Inventory migrations SHALL expose `migration_id`, `checksum_hex`, and `applied_at`.

#### Scenario: Active inventory is current-live

- **WHEN** TypeScript code handles the return value of `getActiveRelease`
- **THEN** the return type SHALL be `ActiveReleaseInventory`
- **AND** `state_kind` SHALL narrow to `"current_live"`
- **AND** docs SHALL state that this response reads current live tables and can include changes made after activation

#### Scenario: Release inventory distinguishes effective from desired manifest

- **WHEN** TypeScript code handles the return value of `getRelease`
- **THEN** the return type SHALL be `ReleaseSnapshotInventory`
- **AND** `state_kind` SHALL allow `"effective"` for active or superseded releases
- **AND** SHALL allow `"desired_manifest"` for failed or staged releases
- **AND** SHALL NOT allow `"current_live"` on this method's return type

#### Scenario: Inventory secrets are keys-only

- **WHEN** SDK inventory types are inspected
- **THEN** `ReleaseInventory["secrets"]` SHALL contain `keys: string[]`
- **AND** SHALL NOT contain value, hash, prefix, length, or other value-derived fields

### Requirement: SDK exposes project-aware release inventory methods

The SDK deploy namespace SHALL expose project-aware methods for release inventory reads. Root SDK calls SHALL include a project id so the SDK can send the gateway's required apikey auth; scoped SDK calls SHALL bind the scoped project id.

The root SDK SHALL expose:

- `r.deploy.getRelease({ project, releaseId, siteLimit? }): Promise<ReleaseSnapshotInventory>`
- `r.deploy.getActiveRelease({ project, siteLimit? }): Promise<ActiveReleaseInventory>`

The scoped SDK SHALL expose:

- `r.project(id).deploy.getRelease(releaseId, opts?): Promise<ReleaseSnapshotInventory>`
- `r.project(id).deploy.getActiveRelease(opts?): Promise<ActiveReleaseInventory>`

Implementations SHALL send `GET /deploy/v2/releases/{id}` and `GET /deploy/v2/releases/active` respectively, adding `?site_limit=N` only when a site limit is supplied. Release ids SHALL be path-encoded with `encodeURIComponent`. Project ids SHALL be used only for apikey resolution/auth; they SHALL NOT be sent as query parameters or body fields to these GET endpoints.

For semver-minor compatibility with the existing early stubs, the SDK MAY keep deprecated overloads for `getRelease(releaseId, opts?)` and `diff(opts)` where `project` is optional in the type. At runtime, any call without a project id SHALL throw `LocalError` before making a gateway request.

#### Scenario: Root get release sends apikey auth

- **WHEN** `r.deploy.getRelease({ project: "prj_123", releaseId: "rel_123" })` is called
- **THEN** the SDK SHALL resolve apikey auth for `prj_123`
- **AND** send `GET /deploy/v2/releases/rel_123`
- **AND** return a typed `ReleaseInventory`

#### Scenario: Root get release requires project context

- **WHEN** legacy-style code calls `r.deploy.getRelease("rel_123")` without a project id
- **THEN** the SDK SHALL fail locally with an actionable `LocalError`
- **AND** SHALL NOT send an unauthenticated request to the gateway

#### Scenario: Release id is path encoded

- **WHEN** `r.deploy.getRelease({ project: "prj_123", releaseId: "rel_/weird" })` is called
- **THEN** the SDK SHALL encode the release id path segment
- **AND** SHALL NOT concatenate the raw value into the URL

#### Scenario: Scoped active release binds project

- **WHEN** `r.project("prj_123").deploy.getActiveRelease({ siteLimit: 10000 })` is called
- **THEN** the SDK SHALL send `GET /deploy/v2/releases/active?site_limit=10000` with apikey auth for `prj_123`
- **AND** return a typed `ReleaseInventory`

#### Scenario: Scoped release methods allow explicit project override

- **WHEN** `r.project("prj_a").deploy.getRelease("rel_123", { project: "prj_b" })` is called
- **THEN** the SDK SHALL use apikey auth for `prj_b`
- **AND** SHALL preserve the existing scoped-client override-friendly pattern

### Requirement: SDK exposes release-to-release diff types and method

The SDK SHALL export a typed release-to-release diff envelope matching `GET /deploy/v2/releases/diff`.

The `ReleaseToReleaseDiff` type SHALL include `kind: "release_diff"`, `schema_version: "agent-deploy-observability.v1"`, `from_release_id`, `to_release_id`, `is_noop`, `summary`, `warnings`, `migrations`, `site`, `functions`, `secrets`, and `subdomains`.

The migrations block SHALL be `{ applied_between_releases: string[] }`. It SHALL NOT include plan-only `new`, `noop`, or `mismatch` fields.

The secrets block SHALL include `added` and `removed` only. It SHALL NOT include `changed`.

The root SDK SHALL expose `r.deploy.diff({ project, from, to, limit? })`; the scoped SDK SHALL expose `r.project(id).deploy.diff({ from, to, limit? })`. Implementations SHALL call `GET /deploy/v2/releases/diff?from=<from>&to=<to>` and add `limit` only when supplied. Query strings SHALL be built with `URLSearchParams`. Project ids SHALL be used only for apikey resolution/auth; they SHALL NOT be sent as query parameters or body fields.

The `from` selector SHALL accept a release id, `"empty"`, or `"active"`. The `to` selector SHALL accept a release id or `"active"`. In release diff selectors, `"active"` SHALL mean the gateway's current-live materialized state.

The `limit` option SHALL be forwarded to the gateway's `limit` query parameter and SHALL cap site diff entries only. The SDK/CLI/MCP SHALL NOT document it as a cap for warnings, functions, secrets, subdomains, or migrations.

#### Scenario: Release diff uses monotonic migration shape

- **WHEN** TypeScript code receives `ReleaseToReleaseDiff["migrations"]`
- **THEN** it SHALL expose `applied_between_releases: string[]`
- **AND** SHALL NOT expose `new`, `noop`, or `mismatch`

#### Scenario: Release diff sends project auth and query params

- **WHEN** `r.deploy.diff({ project: "prj_123", from: "empty", to: "active", limit: 500 })` is called
- **THEN** the SDK SHALL send `GET /deploy/v2/releases/diff?from=empty&to=active&limit=500`
- **AND** SHALL include apikey auth for `prj_123`

#### Scenario: Release diff secrets have no changed slot

- **WHEN** SDK release diff types are inspected
- **THEN** `ReleaseToReleaseDiff["secrets"]` SHALL contain `added` and `removed`
- **AND** SHALL NOT contain `changed`

### Requirement: SDK plan and diff types align with deploy observability

The SDK SHALL update deploy plan/diff types so modern deploy observability shapes are represented without teaching migration mismatch as an ordinary successful plan bucket.

Successful modern plan diff types SHALL expose plan migrations as `new` and `noop` only. Migration checksum mismatch SHALL be represented as a thrown `Run402DeployError` with code `MIGRATION_CHECKSUM_MISMATCH`.

While the gateway's `DEPLOY_PLAN_DIFF_V2_ENABLED` flag remains off, the SDK MAY keep a legacy-compatible plan diff union for current production responses. Any legacy compatibility type SHALL be documented as compatibility only and SHALL NOT be used in new docs/examples as the preferred shape.

The SDK SHALL introduce a deploy-observability warning type, for example `DeployObservabilityWarningEntry`, matching the gateway deploy-observability envelope: `severity` values are `"info"`, `"warn"`, and `"high"`; `requires_confirmation` is boolean; `affected` is an array; `confidence`, when present, is `"heuristic"`.

The SDK SHALL preserve compatibility for the existing exported deploy `WarningEntry` type while plan-diff-v2 remains feature-flagged. It SHALL NOT globally narrow legacy plan warnings from `"low" | "medium" | "high"` to `"info" | "warn" | "high"` in this change unless the implementation also proves no public compatibility break.

#### Scenario: Modern plan migration type omits mismatch

- **WHEN** TypeScript code consumes the modern plan diff migration type
- **THEN** the type SHALL expose `new` and `noop`
- **AND** SHALL NOT expose `mismatch`

#### Scenario: Legacy plan diff remains compatible until flag flip

- **WHEN** the gateway returns the current flag-off plan response shape
- **THEN** `r.deploy.plan` and `r.deploy.apply` SHALL continue to parse the response
- **AND** SHALL still surface `plan.diff` and `warnings`

#### Scenario: Deploy observability warning type uses gateway severity

- **WHEN** TypeScript code constructs a deploy-observability warning with `severity: "warn"` and `confidence: "heuristic"`
- **THEN** the SDK deploy-observability warning type SHALL accept it
- **AND** SHALL reject the old `"low"` / `"medium"` confidence model for deploy-observability warnings

#### Scenario: Legacy warning type remains compatible

- **WHEN** code compiles against existing flag-off plan warning types
- **THEN** this change SHALL NOT require immediate migration away from the legacy warning shape

### Requirement: CLI exposes deploy release get, active, and diff commands

The CLI SHALL add release observability commands under the existing deploy command group.

The commands SHALL be:

- `run402 deploy release get <release_id> [--project <id>] [--site-limit <n>]`
- `run402 deploy release active [--project <id>] [--site-limit <n>]`
- `run402 deploy release diff --from <release_id|empty|active> --to <release_id|active> [--project <id>] [--limit <n>]`

When `--project` is omitted, the CLI SHALL use the active project id using the same local config behavior as other project-scoped commands.

Successful commands SHALL print JSON to stdout without colliding with gateway fields. Inventory commands SHALL print `{ "status": "ok", "release": <ReleaseInventory> }`; diff commands SHALL print `{ "status": "ok", "diff": <ReleaseToReleaseDiff> }`. Errors SHALL use the existing SDK error reporting path.

#### Scenario: CLI gets a release by id

- **WHEN** a user runs `run402 deploy release get rel_123 --project prj_123`
- **THEN** the CLI SHALL call `r.deploy.getRelease({ project: "prj_123", releaseId: "rel_123" })`
- **AND** print a JSON envelope with `status: "ok"` and `release.kind: "release_inventory"`

#### Scenario: CLI active release documents current-live semantics

- **WHEN** a user runs `run402 deploy release active --help`
- **THEN** the help text SHALL state that active release inventory is current-live state
- **AND** SHALL distinguish it from activation-time release snapshots

#### Scenario: CLI release diff accepts active and empty selectors

- **WHEN** a user runs `run402 deploy release diff --from empty --to active --project prj_123`
- **THEN** the CLI SHALL call `r.deploy.diff({ project: "prj_123", from: "empty", to: "active" })`
- **AND** print a JSON envelope with `status: "ok"` and `diff.kind: "release_diff"`

#### Scenario: CLI help exposes nested release help

- **WHEN** a user runs `run402 deploy release --help`
- **THEN** the CLI SHALL list `get`, `active`, and `diff`
- **AND** SHALL mention `site-limit`, `limit`, `empty`, and `active` where relevant

### Requirement: MCP exposes deploy release get, active, and diff tools

The MCP server SHALL expose read-only deploy release observability tools backed by the SDK.

The tools SHALL be:

- `deploy_release_get` with `project_id`, `release_id`, and optional `site_limit`
- `deploy_release_active` with `project_id` and optional `site_limit`
- `deploy_release_diff` with `project_id`, `from`, `to`, and optional `limit`

Each tool SHALL use shared SDK error mapping. Successful responses SHALL include enough prose for humans and a fenced `json` block containing the full gateway envelope for agents. MCP schemas SHALL be strict. Local validation SHALL be syntactic; semantic errors such as `DIFF_SAME_RELEASE` and `INVALID_DIFF_TARGET` SHALL remain gateway errors so agents receive canonical codes.

#### Scenario: MCP release get maps to SDK

- **WHEN** `deploy_release_get` receives `{ project_id: "prj_123", release_id: "rel_123" }`
- **THEN** it SHALL call `getSdk().deploy.getRelease({ project: "prj_123", releaseId: "rel_123" })`
- **AND** return `kind: "release_inventory"` in the response JSON

#### Scenario: MCP active release tool warns about semantics

- **WHEN** `deploy_release_active` returns a response
- **THEN** its human-readable text SHALL mention current-live state
- **AND** the fenced JSON SHALL include `state_kind: "current_live"` when the gateway returns it

#### Scenario: MCP release diff preserves warnings

- **WHEN** `deploy_release_diff` receives a diff response with warnings
- **THEN** the tool SHALL include warning codes and `requires_confirmation` values in the fenced JSON
- **AND** SHALL NOT block for confirmation because the tool is read-only

#### Scenario: MCP tools are read-only

- **WHEN** MCP tool metadata or descriptions are inspected
- **THEN** the release observability tools SHALL be described as read-only
- **AND** SHALL NOT require allowance auth intended for mutating deploy operations

### Requirement: Documentation and sync cover deploy observability

The public repo SHALL update drift gates and documentation surfaces for deploy release observability.

`sync.test.ts` SHALL include the new SDK, CLI, MCP, and OpenClaw surface entries. Public docs SHALL describe the new release inventory and diff methods/commands/tools, the `state_kind` distinction, feature-flag 501 behavior, diff target selectors, and plan/diff type updates.

`documentation.md` SHALL include a checklist row for changes to deploy release observability so future maintainers update SDK types, CLI/MCP surfaces, `llms*.txt`, skill files, README surfaces, and private-site docs when `/deploy/v2/releases/*` changes.

#### Scenario: Sync test knows the release observability surface

- **WHEN** `npm run test:sync` runs
- **THEN** the new release get, active, and diff capabilities SHALL be represented in `SURFACE`
- **AND** each capability SHALL map to its SDK method in `SDK_BY_CAPABILITY`

#### Scenario: Documentation map points to the right surfaces

- **WHEN** a future maintainer changes `/deploy/v2/releases/*`
- **THEN** `documentation.md` SHALL direct them to update SDK docs, CLI docs, MCP docs, skills, sync tests, and private API docs/changelog as applicable

#### Scenario: Agent docs mention feature flag behavior

- **WHEN** agent-facing docs describe release observability endpoints
- **THEN** they SHALL state that flag-off gateways return JSON 501 `FEATURE_DISABLED`
- **AND** SHALL not describe this case as an HTML 404 or missing route

### Requirement: Tests verify endpoint wiring and type drift

The implementation SHALL add focused tests for SDK endpoint construction, scoped wrappers, CLI command parsing/help, MCP handler behavior, and type-level drift.

Tests SHALL avoid depending on live production feature flags in ordinary unit test runs. Any staging/runtime checks for flag-off 501, `NO_ACTIVE_RELEASE`, `DIFF_SAME_RELEASE`, or `INVALID_DIFF_TARGET` SHALL remain opt-in integration tests.

#### Scenario: SDK tests assert URL and auth headers

- **WHEN** SDK unit tests call release inventory and diff methods with a mocked credential provider
- **THEN** the tests SHALL assert the exact `/deploy/v2/releases/*` paths
- **AND** assert that apikey auth headers are sent for the supplied project

#### Scenario: Type tests catch forbidden diff fields

- **WHEN** SDK type tests compile
- **THEN** they SHALL fail if release-to-release diff migrations expose `new`, `noop`, or `mismatch`
- **AND** fail if release-to-release secrets expose `changed`
- **AND** these tests SHALL run through `tsc --noEmit`, `npm run build`, or another real type-checking command rather than only `tsx` transpilation

#### Scenario: CLI and MCP tests cover all three operations

- **WHEN** CLI e2e/help tests and MCP handler tests run
- **THEN** each of get, active, and diff SHALL have at least one success-path test
- **AND** help text SHALL mention `active`, `empty`, `site-limit`, and `limit` where relevant
