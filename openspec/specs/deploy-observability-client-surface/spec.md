# deploy-observability-client-surface Specification

## Purpose
TBD - created by archiving change expose-deploy-observability. Update Purpose after archive.
## Requirements
### Requirement: SDK defines deploy release inventory types

The SDK SHALL export typed deploy observability inventory shapes matching the shipped `/deploy/v2/releases/{id}` and `/deploy/v2/releases/active` envelopes.

The `ReleaseInventory` type SHALL be a union of `ActiveReleaseInventory` and `ReleaseSnapshotInventory`.

The shared inventory fields SHALL include `kind: "release_inventory"`, `schema_version: "agent-deploy-observability.v1"`, `release_id`, `project_id`, `parent_id`, `status`, `manifest_digest`, `created_at`, `created_by`, `activated_at`, `superseded_at`, `operation_id`, `plan_id`, `events_url`, `effective`, `state_kind`, `release_generation`, `static_manifest_sha256`, `static_manifest_metadata`, `site`, `functions`, `secrets`, `subdomains`, `routes`, `migrations_applied`, and `warnings` when returned by the gateway.

The `state_kind` field SHALL be the discriminator for inventory semantics and SHALL allow only `"current_live"`, `"effective"`, and `"desired_manifest"`.

`release_generation` SHALL be `number | null`. `static_manifest_sha256` SHALL be `string | null`. `static_manifest_metadata` SHALL have type `StaticManifestMetadata | null` unless the gateway guarantees a zero-valued metadata object for staticless releases.

`StaticManifestMetadata` SHALL expose `file_count: number`, `total_bytes: number`, `cache_classes: Record<string, number>`, `cache_class_sources: Record<string, number>`, and `spa_fallback: string | null`.

The SDK MAY export `EMPTY_STATIC_MANIFEST_METADATA` and `normalizeStaticManifestMetadata(...)` for consumers that want zero-object ergonomics. Docs SHALL state that `null` means metadata is unavailable and does not necessarily mean the release has zero static files.

`ActiveReleaseInventory` SHALL have `state_kind: "current_live"`. `ReleaseSnapshotInventory` SHALL have `state_kind: "effective" | "desired_manifest"`.

Inventory site path entries SHALL expose `path`, `content_sha256`, and `content_type`. Inventory functions SHALL expose `name`, `code_hash`, `runtime`, `timeout_seconds`, `memory_mb`, and `schedule?: string | null`, and SHALL NOT expose `env_keys` or `source_sha`. Inventory secrets SHALL expose only `{ keys: string[] }`. Inventory subdomains SHALL expose `{ names: string[] }`. Inventory routes SHALL have type `MaterializedRoutes`, with `manifest_sha256: string | null` and `entries: RouteEntry[]`. Inventory migrations SHALL expose `migration_id`, `checksum_hex`, and `applied_at`.

#### Scenario: Inventory exposes static manifest identity

- **WHEN** TypeScript code handles `ReleaseInventory`
- **THEN** it SHALL be able to read `release_generation`, `static_manifest_sha256`, and `static_manifest_metadata`
- **AND** when `static_manifest_metadata` is non-null, `cache_classes` and `cache_class_sources` SHALL be count maps, not fixed-key objects

#### Scenario: Active inventory is current-live

- **WHEN** TypeScript code handles the return value of `getActiveRelease`
- **THEN** the return type SHALL be `ActiveReleaseInventory`
- **AND** `state_kind` SHALL narrow to `"current_live"`
- **AND** docs SHALL state that this response reads current live tables and can include changes made after activation

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

- `r.project(id).deploy.getRelease(releaseId, opts?): Promise<ReleaseInventory>`
- `r.project(id).deploy.getActiveRelease(opts?): Promise<ActiveReleaseInventory>`

Implementations SHALL send `GET /deploy/v2/releases/{id}` and `GET /deploy/v2/releases/active` respectively, adding `?site_limit=N` only when a site limit is supplied. Release ids SHALL be path-encoded with `encodeURIComponent`. Project ids SHALL be used only for apikey resolution/auth; they SHALL NOT be sent as query parameters or body fields to these GET endpoints.

#### Scenario: Root get release sends apikey auth

- **WHEN** `r.deploy.getRelease({ project: "prj_123", releaseId: "rel_123" })` is called
- **THEN** the SDK SHALL resolve apikey auth for `prj_123`
- **AND** send `GET /deploy/v2/releases/rel_123`
- **AND** return a typed `ReleaseInventory`

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

The `ReleaseToReleaseDiff` type SHALL include `kind: "release_diff"`, `schema_version: "agent-deploy-observability.v1"`, `from_release_id`, `to_release_id`, `is_noop`, `summary`, `warnings`, `migrations`, `site`, `functions`, `secrets`, `subdomains`, `routes`, and `static_assets`.

The migrations block SHALL be `{ applied_between_releases: string[] }`. It SHALL NOT include plan-only `new`, `noop`, or `mismatch` fields.

The secrets block SHALL include `added` and `removed` only. It SHALL NOT include `changed`.

The `static_assets` block SHALL have type `StaticAssetsDiff`.

The root SDK SHALL expose `r.deploy.diff({ project, from, to, limit? })`; the scoped SDK SHALL expose `r.project(id).deploy.diff({ from, to, limit? })`. Implementations SHALL call `GET /deploy/v2/releases/diff?from=<from>&to=<to>` and add `limit` only when supplied. Query strings SHALL be built with `URLSearchParams`. Project ids SHALL be used only for apikey resolution/auth; they SHALL NOT be sent as query parameters or body fields.

#### Scenario: Release diff includes static asset summary

- **WHEN** TypeScript code receives `ReleaseToReleaseDiff`
- **THEN** it SHALL expose `static_assets.unchanged`, `changed`, `added`, `removed`, `newly_uploaded_cas_bytes`, `reused_cas_bytes`, `deployment_copy_bytes_eliminated`, `legacy_immutable_warnings`, `previous_immutable_failures`, and `cas_authorization_failures`

#### Scenario: Release diff uses monotonic migration shape

- **WHEN** TypeScript code receives `ReleaseToReleaseDiff["migrations"]`
- **THEN** it SHALL expose `applied_between_releases: string[]`
- **AND** SHALL NOT expose `new`, `noop`, or `mismatch`

### Requirement: SDK plan and diff types align with deploy observability

The SDK SHALL update deploy plan/diff types so modern deploy observability shapes are represented without teaching migration mismatch as an ordinary successful plan bucket.

Successful modern plan diff types SHALL expose plan migrations as `new` and `noop` only. Migration checksum mismatch SHALL be represented as a thrown `Run402DeployError` with code `MIGRATION_CHECKSUM_MISMATCH`.

Successful modern plan diff types SHALL include a `static_assets` diff bucket with type `StaticAssetsDiff` when the gateway returns static asset diff data. `PlanResponse` SHALL expose `static_assets?: StaticAssetsDiff`, and `PlanDiffEnvelope` SHALL include `static_assets: StaticAssetsDiff` when the gateway returns modern plan diff data. `normalizePlanResponse()` SHALL preserve top-level `static_assets` and copy it into `plan.diff.static_assets` when needed for legacy consumers.

`StaticAssetsDiff` SHALL expose:

- `unchanged`, `changed`, `added`, and `removed` path counts
- `newly_uploaded_cas_bytes`
- `reused_cas_bytes`
- `deployment_copy_bytes_eliminated`
- `legacy_immutable_warnings: Array<{ path: string; sha256: string; reason: string }>`
- `previous_immutable_failures: Array<{ path: string; previous_sha256: string; candidate_sha256: string }>`
- `cas_authorization_failures: string[]`

While the gateway's modern plan diff flag remains off in any environment, the SDK MAY keep a legacy-compatible plan diff union. Any legacy compatibility type SHALL be documented as compatibility only and SHALL NOT be used in new docs/examples as the preferred shape.

#### Scenario: Plan diff includes static assets

- **WHEN** the gateway returns `static_assets` on a deploy plan response
- **THEN** `r.deploy.plan` and `r.deploy.apply` SHALL expose that bucket losslessly
- **AND** CLI and MCP JSON output SHALL preserve the full bucket

#### Scenario: Top-level static assets are normalized into plan diff

- **WHEN** the gateway returns top-level `static_assets` data on a plan response
- **THEN** `normalizePlanResponse()` SHALL preserve the top-level `static_assets`
- **AND** it SHALL also copy the data into `plan.diff.static_assets`

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

The public repo SHALL update drift gates and documentation surfaces for deploy release observability and stable static asset identity.

`sync.test.ts` SHALL include the new SDK resolve, CLI deploy diagnose/resolve, MCP `deploy_diagnose_url`, and OpenClaw deploy diagnose/resolve surface entries. Public docs SHALL describe release generation, static manifest SHA and metadata, `static_assets`, public URL diagnostics, diff target selectors, and plan/diff type updates.

`documentation.md` SHALL include a checklist row for stable static asset identity and public URL diagnostics so future maintainers update SDK types, CLI/MCP surfaces, `llms*.txt`, skill files, README surfaces, and private-site docs when `/deploy/v2/resolve` or static asset observability changes.

#### Scenario: Sync test knows deploy URL diagnostics

- **WHEN** `npm run test:sync` runs
- **THEN** it SHALL fail if `deploy_diagnose_url` is missing from MCP registration, CLI/OpenClaw parity, or SDK capability mapping

#### Scenario: Docs drift is detected

- **WHEN** a developer adds `static_assets` SDK types but forgets public docs
- **THEN** the sync/docs guard SHALL fail with an actionable message naming the missing surface when practical

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

### Requirement: SDK exposes stable public URL diagnostics

The SDK deploy namespace SHALL expose a typed read-only public URL diagnostics method backed by `GET /deploy/v2/resolve`.

The root SDK SHALL expose:

- `r.deploy.resolve({ project, url, method? }): Promise<DeployResolveResponse>`
- `r.deploy.resolve({ project, host, path?, method? }): Promise<DeployResolveResponse>`

The scoped SDK SHALL expose:

- `r.project(id).deploy.resolve({ url, method?, project? }): Promise<DeployResolveResponse>`
- `r.project(id).deploy.resolve({ host, path?, method?, project? }): Promise<DeployResolveResponse>`

The SDK SHALL send apikey auth for the resolved project id. The project id SHALL be used only for local apikey resolution/auth and SHALL NOT be sent as a query parameter or body field. The request SHALL use `URLSearchParams` for query params. Callers SHALL provide exactly one of `url` or `host`. URL input SHALL be absolute, SHALL use `http:` or `https:`, SHALL NOT contain username/password credentials, SHALL parse `url.hostname` as `host`, and SHALL parse `url.pathname` as `path`. URL query strings and fragments SHALL NOT be sent to the gateway because route matching ignores them. In host/path mode, `host` SHALL NOT contain a scheme, path, query, or fragment; `path` SHALL be typed as `string`, SHALL start with `/` when supplied, SHALL NOT contain `?` or `#`, and SHALL default to gateway behavior when omitted. `method` SHALL default to gateway behavior when omitted.

The SDK SHALL export `DeployResolveOptions`, `ScopedDeployResolveOptions`, `DeployResolveResponse`, `DeployResolveRouteMatch`, `DeployResolveMethod`, `DeployResolveMatch`, `KnownDeployResolveMatch`, `DeployResolveFallbackState`, `KnownDeployResolveFallbackState`, `KnownDeployResolveResult`, `StaticCacheClass`, `KnownStaticCacheClass`, `NormalizedDeployResolveRequest`, `DeployResolveSummary`, `DeployResolveWarning`, `DeployResolveNextStep`, and any nested public helper types referenced by the response.

`DeployResolveMethod` SHALL include the route HTTP method literals plus future string values. Method values SHALL be normalized or rejected consistently before making a request.

`DeployResolveResponse` SHALL represent host-miss bodies where only `hostname`, `result`, `match`, `authorized`, and `fallback_state` are present. Rich release/static fields SHALL be optional or nullable as returned by the gateway.

`KnownDeployResolveMatch` SHALL include the match literals emitted by the private gateway contract. For the current gateway contract, this set is `"host_missing"`, `"manifest_missing"`, `"path_error"`, `"none"`, `"static_exact"`, `"static_index"`, `"spa_fallback"`, and `"spa_fallback_missing"`. `DeployResolveMatch` SHALL be future-safe and allow unknown string values without type errors. Route-aware literals such as `"route_static_alias"`, `"route_function"`, and `"method_not_allowed"` SHALL be added to `KnownDeployResolveMatch` only if the private gateway/OpenAPI contract emits them and tests include matching fixtures.

`KnownStaticCacheClass` SHALL include `"html"`, `"immutable_versioned"`, and `"revalidating_asset"`. `StaticCacheClass` SHALL be future-safe and allow unknown string values without type errors.

`KnownDeployResolveFallbackState` SHALL include `"unavailable"`, `"path_error"`, `"method_not_static"`, `"not_used"`, `"target_missing"`, `"used"`, `"not_configured"`, and `"not_eligible"`. `DeployResolveFallbackState` SHALL be future-safe and allow unknown string values without type errors.

`KnownDeployResolveResult` SHALL include `200`, `400`, `404`, and `503` for the current gateway contract. If route-aware method mismatch is added upstream, `KnownDeployResolveResult` SHALL also include `405`. `DeployResolveResponse.result` SHALL be typed as `number`, not a closed numeric union. The SDK docs SHALL state that `result` is the diagnostic body status, not necessarily the HTTP response status.

`cache_policy` SHALL be typed as `string | null` because the gateway derives it from cache class today but may add policies later. Current known non-null values are `"public, max-age=31536000, immutable"` and `"public, max-age=0, must-revalidate"`. Docs SHALL tell consumers not to hard-code cache policy strings.

`channel` SHALL be future-compatible. The gateway currently emits `"production"`, but SDK types SHALL allow future string channel values without a breaking SDK release.

When the gateway returns route-table diagnostic context, `DeployResolveResponse` SHALL preserve it as `route?: DeployResolveRouteMatch | null`, where `DeployResolveRouteMatch` includes `pattern`, `methods`, and `target: RouteTarget`. Public docs SHALL NOT promise complete function-route/static-route-target/method-mismatch introspection unless the private gateway contract returns this route-aware context.

The SDK SHALL export deterministic summary helpers, static-hit and route-hit type guards, structured warning/next-step types, and normalized request types for deploy resolve responses so CLI/MCP/OpenClaw and TypeScript agents can avoid ad hoc optional-field probing.

`DeployResolveSummary` SHALL include `would_serve: boolean`, `diagnostic_status: number`, `match: DeployResolveMatch`, a coarse `category` string, `summary: string`, `warnings: DeployResolveWarning[]`, and `next_steps: DeployResolveNextStep[]`. `DeployResolveWarning` and `DeployResolveNextStep` SHALL each include a stable `code` and human-readable `message`. `NormalizedDeployResolveRequest` SHALL include the selected project, `project_scope: "credential_lookup_only"`, `project_sent_to_gateway: false`, normalized host/path/method, and ignored URL query/fragment values when present.

#### Scenario: Root resolve accepts a full URL

- **WHEN** `r.deploy.resolve({ project: "prj_123", url: "https://Example.COM/assets/app.js?x=1#top", method: "GET" })` is called
- **THEN** the SDK SHALL resolve apikey auth for `prj_123`
- **AND** send `GET /deploy/v2/resolve?host=Example.COM&path=%2Fassets%2Fapp.js&method=GET`
- **AND** return `DeployResolveResponse`

#### Scenario: Root resolve accepts host and path

- **WHEN** `r.deploy.resolve({ project: "prj_123", host: "Example.COM", path: "/assets/app.js", method: "GET" })` is called
- **THEN** the SDK SHALL resolve apikey auth for `prj_123`
- **AND** send `GET /deploy/v2/resolve?host=Example.COM&path=%2Fassets%2Fapp.js&method=GET`
- **AND** return `DeployResolveResponse`

#### Scenario: Scoped resolve binds project

- **WHEN** `r.project("prj_123").deploy.resolve({ url: "https://example.com/" })` is called
- **THEN** the SDK SHALL use apikey auth for `prj_123`
- **AND** SHALL preserve the existing scoped-client override-friendly pattern when `project` is explicitly supplied

#### Scenario: Resolve rejects ambiguous inputs

- **WHEN** a caller supplies both `url` and `host`
- **THEN** the SDK SHALL reject before making a network call
- **AND** explain that URL input and host/path input are mutually exclusive

#### Scenario: Resolve rejects misleading URL inputs

- **WHEN** a caller supplies a non-HTTP URL, URL credentials, a host containing a scheme/path/query/fragment, or a host/path `path` containing `?` or `#`
- **THEN** the SDK SHALL reject before making a network call
- **AND** explain how to provide either a full public URL or a clean host/path pair

#### Scenario: Host miss is representable

- **WHEN** the gateway returns `{ "hostname": "missing.example", "result": 404, "match": "host_missing", "authorized": false, "fallback_state": "not_used" }`
- **THEN** the SDK response type SHALL accept that object without requiring release id, project id, manifest metadata, cache class, or static sha fields

#### Scenario: Route-aware diagnostics are preserved when returned

- **WHEN** the gateway returns `match: "route_static_alias"` and a `route` object containing `{ "pattern": "/events", "methods": ["GET", "HEAD"], "target": { "type": "static", "file": "events.html" } }`
- **THEN** the SDK response type SHALL preserve the route object without dropping the static target file
- **AND** CLI and MCP output SHALL preserve the same route object in machine-readable output
- **AND** public docs SHALL describe this as route-aware diagnostics only if the private gateway contract includes a matching fixture/OpenAPI shape

#### Scenario: Unknown gateway literals are preserved

- **WHEN** the gateway returns an unknown `match`, `fallback_state`, `cache_class`, or `cache_policy`
- **THEN** SDK types SHALL allow the value
- **AND** CLI/MCP JSON output SHALL preserve the value

#### Scenario: Resolve keeps canonical error envelopes

- **WHEN** the gateway rejects an invalid host with an HTTP 400 error envelope
- **THEN** the SDK SHALL surface the existing `Run402Error` hierarchy behavior
- **AND** SHALL NOT coerce the HTTP error into a `DeployResolveResponse`

### Requirement: CLI and MCP expose public URL diagnostics

The CLI SHALL expose primary agent-facing diagnostics as `run402 deploy diagnose --project <id> <url> [--method GET]`. The CLI SHALL also expose lower-level parity forms `run402 deploy resolve --project <id> --url <url> [--method GET]` and `run402 deploy resolve --project <id> --host <host> [--path /x] [--method GET]`. When `--project` is omitted, the CLI SHALL use the active project id using the same local config behavior as other project-scoped deploy read commands.

Successful CLI output SHALL be JSON and SHALL wrap the gateway response without colliding with gateway fields. The JSON SHALL include `status`, `would_serve`, `diagnostic_status`, `match`, `summary`, normalized `request`, `warnings`, full `resolution`, and structured `next_steps`:

```json
{
  "status": "ok",
  "would_serve": false,
  "diagnostic_status": 404,
  "match": "host_missing",
  "summary": "GET https://missing.example/ did not resolve because the host is not bound to this account/project context.",
  "request": {
    "project": "prj_123",
    "project_scope": "credential_lookup_only",
    "project_sent_to_gateway": false,
    "original_url": "https://missing.example/?utm=x#hero",
    "host": "missing.example",
    "path": "/",
    "method": "GET",
    "ignored": {
      "query": "?utm=x",
      "fragment": "#hero"
    }
  },
  "warnings": [
    {
      "code": "query_ignored",
      "message": "Query strings do not affect Run402 route resolution."
    },
    {
      "code": "fragment_ignored",
      "message": "URL fragments are never sent to the server and do not affect resolution."
    }
  ],
  "resolution": {
    "hostname": "missing.example",
    "result": 404,
    "match": "host_missing",
    "authorized": false,
    "fallback_state": "not_used"
  },
  "next_steps": [
    {
      "code": "check_domain_binding",
      "message": "Check that the host is configured as a Run402 custom domain or subdomain."
    },
    {
      "code": "check_dns",
      "message": "Check DNS and domain binding status."
    },
    {
      "code": "check_credentials",
      "message": "Check that the selected local project credentials can inspect this host."
    }
  ]
}
```

Diagnostic misses SHALL exit 0 and use `status: "ok"`. CLI input errors and SDK/HTTP errors SHALL exit nonzero and use the existing CLI error envelope conventions.

The MCP server SHALL expose a read-only `deploy_diagnose_url` tool with `project_id`, either `url` or `host`/`path`, and optional `method`. The tool SHALL use `getSdk().deploy.resolve(...)` and shared SDK error mapping. Successful MCP responses SHALL include normalized request details, `would_serve`, `diagnostic_status`, `match`, a human-readable summary, structured warnings, deterministic next steps, structured machine-readable data when the MCP server shape supports it, and a fenced `json` block containing the full response as fallback.

#### Scenario: CLI diagnose prints structured JSON

- **WHEN** a user runs `run402 deploy diagnose --project prj_123 "https://example.com/assets/app.js?cache=1#hero"`
- **THEN** the CLI SHALL call `r.deploy.resolve({ project: "prj_123", url: "https://example.com/assets/app.js?cache=1#hero" })`
- **AND** stdout SHALL include `status: "ok"`, `would_serve`, `diagnostic_status`, `match`, a normalized `request`, `warnings`, full `resolution`, and structured `next_steps`
- **AND** stdout SHALL disclose the ignored query string and fragment in structured fields

#### Scenario: CLI host miss is not a process error

- **WHEN** the gateway returns a successful diagnostic body with `match: "host_missing"` and `result: 404`
- **THEN** the CLI SHALL print `status: "ok"` and `would_serve: false`
- **AND** SHALL NOT treat the diagnostic miss as a failed SDK call

#### Scenario: MCP diagnostics map to SDK

- **WHEN** `deploy_diagnose_url` receives `{ "project_id": "prj_123", "url": "https://example.com/" }`
- **THEN** it SHALL call `getSdk().deploy.resolve({ project: "prj_123", url: "https://example.com/" })`
- **AND** the machine-readable output and fenced JSON SHALL preserve `match`, `result`, `fallback_state`, `route`, static manifest metadata, and legacy immutable risk fields when returned

#### Scenario: Resolve surfaces are read-only

- **WHEN** CLI help or MCP tool descriptions are inspected
- **THEN** they SHALL describe resolve as authenticated diagnostics
- **AND** SHALL NOT imply that resolve fetches bytes, invalidates cache, mutates deploy state, or exposes internal CAS URLs

### Requirement: SDK exposes deploy result summary helper

The SDK SHALL export a pure helper named `summarizeDeployResult(result: DeployResult): DeploySummary` from the isomorphic SDK entry point. The Node SDK entry point SHALL re-export the same helper.

`DeploySummary` SHALL be an exported SDK type with `schema_version: "deploy-summary.v1"`, `release_id`, `operation_id`, `headline`, `warnings`, and optional resource summary sections derived only from fields already present on `DeployResult`.

The helper SHALL NOT call the gateway, read local credential state, access the filesystem, mutate the input result, or require Node-only APIs.

#### Scenario: SDK user summarizes a deploy result

- **WHEN** TypeScript code imports `summarizeDeployResult` from `@run402/sdk`
- **THEN** it SHALL be able to pass a `DeployResult`
- **AND** receive a `DeploySummary` with matching `release_id` and `operation_id`
- **AND** the helper SHALL make no additional HTTP requests

#### Scenario: Node SDK re-exports summary helper

- **WHEN** TypeScript code imports `summarizeDeployResult` from `@run402/sdk/node`
- **THEN** it SHALL receive the same isomorphic helper
- **AND** the helper SHALL not depend on Node manifest, filesystem, keystore, or allowance helpers

### Requirement: Deploy summary includes only reliable current fields

`DeploySummary` SHALL summarize only data the SDK can derive from the current `DeployResult.diff` and `DeployResult.warnings` contract.

The summary MAY include:

- `is_noop?: boolean` when `diff.is_noop` is a boolean
- `site.paths` when modern site or static asset diff data is present
- `site.cas` when `diff.static_assets` is present
- `functions` when modern function diff data is present
- `migrations` when modern plan migration diff data is present
- `routes` when modern route diff data is present
- `secrets` when secrets diff data is present
- `subdomains` when modern subdomain diff data is present
- `warnings` for every result

The summary SHALL NOT include phase timings, client-side duration estimates, server duration estimates, or function old/new code hashes.

If a resource bucket is missing or only present in an older legacy shape whose full modern meaning cannot be represented, the helper SHALL omit that resource summary section instead of fabricating zeros.

#### Scenario: Static asset summary uses CAS counters

- **WHEN** `DeployResult.diff.static_assets` includes path counts and CAS byte counters
- **THEN** the summary SHALL include `site.paths.added`, `changed`, `removed`, `unchanged`, and `total_changed`
- **AND** the summary SHALL include `site.cas.newly_uploaded_bytes`, `reused_bytes`, and `deployment_copy_bytes_eliminated`

#### Scenario: Site summary without static assets omits unavailable unchanged count

- **WHEN** `DeployResult.diff.site` is present but `DeployResult.diff.static_assets` is absent
- **THEN** the summary SHALL include `site.paths.added`, `changed`, `removed`, and `total_changed`
- **AND** it SHALL omit `site.paths.unchanged`
- **AND** it SHALL omit `site.cas`

#### Scenario: Function summary excludes code hash deltas

- **WHEN** `DeployResult.diff.functions.changed` contains changed function names and `fields_changed`
- **THEN** the summary SHALL include each changed function `name` and `fields_changed`
- **AND** it SHALL NOT include `code_hash_old`, `code_hash_new`, `source_sha`, or any inferred hash delta field

#### Scenario: Timing fields are absent

- **WHEN** a deploy result is summarized
- **THEN** `DeploySummary` SHALL NOT include `timings`, `duration_ms`, `phase_durations`, or any client-side timing estimate field

#### Scenario: Missing buckets are omitted

- **WHEN** a deploy result has no `routes` diff bucket
- **THEN** the summary SHALL omit `routes`
- **AND** SHALL NOT emit `{ added: 0, changed: 0, removed: 0 }` for that missing bucket

### Requirement: Deploy summary warning counts are deterministic

`DeploySummary.warnings` SHALL always be present and SHALL include:

- `count`: total number of warnings in `DeployResult.warnings`
- `blocking`: number of warnings where `requires_confirmation` is true or `code` is `MISSING_REQUIRED_SECRET`
- `codes`: unique warning codes in deterministic sorted order

Warnings SHALL be counted from `DeployResult.warnings`, not from any duplicated or compatibility `diff.warnings` bucket.

#### Scenario: Blocking warning count includes missing secrets

- **WHEN** a deploy result includes a warning with `code: "MISSING_REQUIRED_SECRET"` and `requires_confirmation: false`
- **THEN** `DeploySummary.warnings.blocking` SHALL count that warning as blocking

#### Scenario: Warning codes are unique and sorted

- **WHEN** a deploy result includes duplicate warning codes in any order
- **THEN** `DeploySummary.warnings.codes` SHALL include each code once
- **AND** SHALL return the codes in deterministic sorted order

### Requirement: Deploy summary docs and first-party surfaces stay scoped

The SDK documentation SHALL describe `summarizeDeployResult`, the `DeploySummary` shape, and the reliability boundaries: no timings, no inferred function hash deltas, no fabricated zero sections for missing buckets, and no extra gateway calls.

This change SHALL NOT require a new MCP tool, CLI subcommand, CLI flag, or HTTP API documentation update. Existing CLI and MCP deploy JSON output SHALL continue to preserve raw deploy result data unless a separate change explicitly updates those surfaces.

#### Scenario: SDK docs mention summary helper

- **WHEN** SDK documentation is updated for this change
- **THEN** `sdk/README.md` and `sdk/llms-sdk.txt` SHALL mention `summarizeDeployResult`
- **AND** SHALL document that the helper is derived from existing deploy result data

#### Scenario: CLI and MCP have no new required surface

- **WHEN** this change is implemented
- **THEN** no new CLI command, CLI flag, MCP tool, or sync-test `SURFACE` capability SHALL be required solely for deploy summaries
- **AND** any future CLI/MCP formatter adoption SHALL preserve existing raw deploy result data or be handled as a separate output-contract change
