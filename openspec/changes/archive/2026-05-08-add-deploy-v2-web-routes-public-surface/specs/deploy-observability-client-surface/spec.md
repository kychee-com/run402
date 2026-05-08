## MODIFIED Requirements

### Requirement: SDK defines deploy release inventory types

The SDK SHALL export typed deploy observability inventory shapes matching the shipped `/deploy/v2/releases/{id}` and `/deploy/v2/releases/active` envelopes.

The `ReleaseInventory` type SHALL be a union of `ActiveReleaseInventory` and `ReleaseSnapshotInventory`.

The shared inventory fields SHALL include `kind: "release_inventory"`, `schema_version: "agent-deploy-observability.v1"`, `release_id`, `project_id`, `parent_id`, `status`, `manifest_digest`, `created_at`, `created_by`, `activated_at`, `superseded_at`, `operation_id`, `plan_id`, `events_url`, `effective`, `state_kind`, `site`, `functions`, `secrets`, `subdomains`, `routes`, `migrations_applied`, and `warnings` when returned by the gateway.

The `state_kind` field SHALL be the discriminator for inventory semantics and SHALL allow only `"current_live"`, `"effective"`, and `"desired_manifest"`.

`ActiveReleaseInventory` SHALL have `state_kind: "current_live"`. `ReleaseSnapshotInventory` SHALL have `state_kind: "effective" | "desired_manifest"`.

Inventory site path entries SHALL expose `path`, `content_sha256`, and `content_type`. Inventory functions SHALL expose `name`, `code_hash`, `runtime`, `timeout_seconds`, `memory_mb`, and `schedule?: string | null`, and SHALL NOT expose `env_keys` or `source_sha`. Inventory secrets SHALL expose only `{ keys: string[] }`. Inventory subdomains SHALL expose `{ names: string[] }`. Inventory routes SHALL have type `MaterializedRoutes`, with `manifest_sha256: string | null` and `entries: RouteEntry[]`. Inventory migrations SHALL expose `migration_id`, `checksum_hex`, and `applied_at`.

`RouteEntry` SHALL expose `pattern: string`, `kind: "exact" | "prefix"`, `prefix: string | null`, `methods: RouteHttpMethod[] | null`, and `target: RouteTarget`. `methods: null` SHALL mean all supported route HTTP methods.

Release inventory SHALL include deploy-observability warning summaries when returned by the gateway, including route shadowing and carried-forward target warnings. Warning summaries SHALL use `DeployObservabilityWarningEntry[]` and SHALL be preserved losslessly by SDK, CLI, and MCP JSON output. If the gateway cannot return inventory warnings when this change is implemented, the implementation SHALL explicitly document the deferral in code comments and docs as a temporary divergence from the runtime vision.

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

#### Scenario: Inventory exposes materialized routes

- **WHEN** SDK inventory types are inspected
- **THEN** `ReleaseInventory["routes"]` SHALL contain `manifest_sha256` and `entries`
- **AND** each route entry SHALL expose pattern, kind, prefix, methods, and target

#### Scenario: Inventory preserves warning summaries

- **WHEN** the gateway returns release inventory warnings
- **THEN** `ReleaseInventory["warnings"]` SHALL expose them as deploy-observability warning entries
- **AND** CLI and MCP JSON output SHALL preserve them unchanged

### Requirement: SDK exposes release-to-release diff types and method

The SDK SHALL export a typed release-to-release diff envelope matching `GET /deploy/v2/releases/diff`.

The `ReleaseToReleaseDiff` type SHALL include `kind: "release_diff"`, `schema_version: "agent-deploy-observability.v1"`, `from_release_id`, `to_release_id`, `is_noop`, `summary`, `warnings`, `migrations`, `site`, `functions`, `secrets`, `subdomains`, and `routes`.

The migrations block SHALL be `{ applied_between_releases: string[] }`. It SHALL NOT include plan-only `new`, `noop`, or `mismatch` fields.

The secrets block SHALL include `added` and `removed` only. It SHALL NOT include `changed`.

The routes block SHALL have type `RoutesDiff`. `RoutesDiff` SHALL contain `manifest_sha256_old?: string | null`, `manifest_sha256_new?: string | null`, `added: RouteEntry[]`, `removed: RouteEntry[]`, `changed: RouteChangeEntry[]`, and optional `totals?: { added: number; removed: number; changed: number }`.

`RouteChangeEntry` SHALL contain `pattern: string`, `before: RouteEntry`, `after: RouteEntry`, and `fields_changed: Array<"methods" | "target" | "kind" | "prefix">`.

The root SDK SHALL expose `r.deploy.diff({ project, from, to, limit? })`; the scoped SDK SHALL expose `r.project(id).deploy.diff({ from, to, limit? })`. Implementations SHALL call `GET /deploy/v2/releases/diff?from=<from>&to=<to>` and add `limit` only when supplied. Query strings SHALL be built with `URLSearchParams`. Project ids SHALL be used only for apikey resolution/auth; they SHALL NOT be sent as query parameters or body fields.

The `from` selector SHALL accept a release id, `"empty"`, or `"active"`. The `to` selector SHALL accept a release id or `"active"`. In release diff selectors, `"active"` SHALL mean the gateway's current-live materialized state.

The `limit` option SHALL be forwarded to the gateway's `limit` query parameter and SHALL cap site diff entries only. The SDK/CLI/MCP SHALL NOT document it as a cap for warnings, functions, secrets, subdomains, routes, or migrations.

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

#### Scenario: Release diff includes routes

- **WHEN** SDK release diff types are inspected
- **THEN** `ReleaseToReleaseDiff["routes"]` SHALL have type `RoutesDiff`
- **AND** route diff data SHALL be available to CLI and MCP JSON output without loss

### Requirement: SDK plan and diff types align with deploy observability

The SDK SHALL update deploy plan/diff types so modern deploy observability shapes are represented without teaching migration mismatch as an ordinary successful plan bucket.

Successful modern plan diff types SHALL expose plan migrations as `new` and `noop` only. Migration checksum mismatch SHALL be represented as a thrown `Run402DeployError` with code `MIGRATION_CHECKSUM_MISMATCH`.

Successful modern plan diff types SHALL include a `routes` diff bucket with type `RoutesDiff` when the gateway returns route diff data. `PlanResponse` SHALL expose `routes?: RoutesDiff`, and `PlanDiffEnvelope` SHALL include `routes: RoutesDiff` when the gateway returns route diff data. `normalizePlanResponse()` SHALL copy top-level `routes` into `plan.diff.routes`.

While the gateway's `DEPLOY_PLAN_DIFF_V2_ENABLED` flag remains off, the SDK MAY keep a legacy-compatible plan diff union for current production responses. Any legacy compatibility type SHALL be documented as compatibility only and SHALL NOT be used in new docs/examples as the preferred shape.

The SDK SHALL introduce a deploy-observability warning type, for example `DeployObservabilityWarningEntry`, matching the gateway deploy-observability envelope: `severity` values are `"info"`, `"warn"`, and `"high"`; `requires_confirmation` is boolean; `affected` is an array; `confidence`, when present, is `"heuristic"`.

The SDK SHALL preserve compatibility for the existing exported deploy `WarningEntry` type while plan-diff-v2 remains feature-flagged. It SHALL NOT globally narrow legacy plan warnings from `"low" | "medium" | "high"` to `"info" | "warn" | "high"` in this change unless the implementation also proves no public compatibility break.

Known route warning codes SHALL be documented for agents, including `PUBLIC_ROUTED_FUNCTION`, `ROUTE_TARGET_CARRIED_FORWARD`, `ROUTE_SHADOWS_STATIC_PATH`, `WILDCARD_ROUTE_SHADOWS_STATIC_PATHS`, `METHOD_SPECIFIC_ROUTE_ALLOWS_GET_STATIC_FALLBACK`, and `ROUTE_TABLE_NEAR_LIMIT`.

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

#### Scenario: Route plan diff is typed

- **WHEN** the gateway returns a plan response with route diff buckets
- **THEN** the SDK SHALL expose those buckets through `PlanResponse.routes` and `PlanResponse.diff.routes`
- **AND** the deploy plan JSON SHALL remain lossless for CLI and MCP consumers

#### Scenario: Top-level route diff is normalized into plan diff

- **WHEN** the gateway returns top-level `routes` diff data on a plan response
- **THEN** `normalizePlanResponse()` SHALL preserve the top-level `routes`
- **AND** it SHALL also copy the data into `plan.diff.routes`
