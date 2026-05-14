## MODIFIED Requirements

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

`DeployResolveResponse` SHALL explicitly type the stable-host diagnostics now returned by the gateway while retaining unknown-field preservation. These fields SHALL include:

- `authorization_result?: DeployResolveAuthorizationResult | null`, with known values `"authorized"`, `"not_public"`, `"not_applicable"`, `"manifest_missing"`, `"target_missing"`, `"active_release_missing"`, `"path_error"`, `"missing_cas_object"`, `"unfinalized_or_deleting_cas_object"`, `"size_mismatch"`, and `"unauthorized_cas_object"`
- `cas_object?: DeployResolveCasObject | null`, where CAS health includes `sha256`, `exists`, `expected_size`, and optional or nullable `actual_size`
- `response_variant?: DeployResolveResponseVariant | null`, where hostname-specific HTML variant diagnostics include `kind`, `varies_by`, `hostname`, `release_id`, `release_generation`, `path`, `raw_static_sha256`, and `variant_inputs_hash`
- route/static diagnostic fields including `allow`, `route_pattern`, `target_type`, `target_name`, and `target_file`

All new string-valued diagnostic unions SHALL be future-safe and allow unknown strings without type errors. All additive diagnostic fields SHALL be optional or nullable unless the gateway guarantees them on every successful resolve response.

`KnownDeployResolveMatch` SHALL include the match literals emitted by the stable gateway contract. For the current gateway contract, this set is `"host_missing"`, `"manifest_missing"`, `"active_release_missing"`, `"path_error"`, `"none"`, `"static_exact"`, `"static_index"`, `"spa_fallback"`, `"spa_fallback_missing"`, `"route_function"`, `"route_static_alias"`, and `"route_method_miss"`. `DeployResolveMatch` SHALL be future-safe and allow unknown string values without type errors.

`KnownStaticCacheClass` SHALL include `"html"`, `"immutable_versioned"`, and `"revalidating_asset"`. `StaticCacheClass` SHALL be future-safe and allow unknown string values without type errors.

`KnownDeployResolveFallbackState` SHALL include `"unavailable"`, `"path_error"`, `"method_not_static"`, `"not_used"`, `"target_missing"`, `"used"`, `"not_configured"`, and `"not_eligible"`. `DeployResolveFallbackState` SHALL be future-safe and allow unknown string values without type errors.

`KnownDeployResolveResult` SHALL include `200`, `400`, `404`, and `503` for the current gateway contract. If route-aware method mismatch is represented with diagnostic status `405`, `KnownDeployResolveResult` SHALL also include `405`. `DeployResolveResponse.result` SHALL be typed as `number`, not a closed numeric union. The SDK docs SHALL state that `result` is the diagnostic body status, not necessarily the HTTP response status.

`cache_policy` SHALL be typed as `string | null` because the gateway derives it from cache class today but may add policies later. Current known non-null values are `"public, max-age=31536000, immutable"` and `"public, max-age=0, must-revalidate"`. Docs SHALL tell consumers not to hard-code cache policy strings.

`channel` SHALL be future-compatible. The gateway currently emits `"production"`, but SDK types SHALL allow future string channel values without a breaking SDK release.

When the gateway returns route-table diagnostic context, `DeployResolveResponse` SHALL preserve it as `route?: DeployResolveRouteMatch | null`, where `DeployResolveRouteMatch` includes `pattern`, `methods`, and `target: RouteTarget`. When the gateway returns flattened route/static diagnostic fields, `DeployResolveResponse` SHALL preserve those fields as well.

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

#### Scenario: Static CAS failure is representable

- **WHEN** the gateway returns `match: "static_exact"`, `authorization_result: "missing_cas_object"`, and `cas_object: { "sha256": "abc123", "exists": false, "expected_size": 1234, "actual_size": null }`
- **THEN** the SDK response type SHALL accept the payload
- **AND** `buildDeployResolveSummary` SHALL produce a non-serving diagnostic with a CAS-specific category or next step
- **AND** CLI and MCP machine-readable output SHALL preserve the full `cas_object`

#### Scenario: HTML response variant is representable

- **WHEN** the gateway returns `response_variant` with hostname-specific HTML variant fields
- **THEN** the SDK response type SHALL expose `kind`, `varies_by`, `hostname`, `release_id`, `release_generation`, `path`, `raw_static_sha256`, and `variant_inputs_hash`
- **AND** CLI and MCP machine-readable output SHALL preserve the full `response_variant`

#### Scenario: Route-aware diagnostics are preserved when returned

- **WHEN** the gateway returns `match: "route_static_alias"` and a `route` object containing `{ "pattern": "/events", "methods": ["GET", "HEAD"], "target": { "type": "static", "file": "events.html" } }`
- **THEN** the SDK response type SHALL preserve the route object without dropping the static target file
- **AND** CLI and MCP output SHALL preserve the same route object in machine-readable output

#### Scenario: Flattened route static diagnostics are preserved

- **WHEN** the gateway returns `match: "route_static_alias"`, `route_pattern: "/events"`, `target_type: "static"`, and `target_file: "events.html"`
- **THEN** the SDK response type SHALL expose those fields
- **AND** CLI and MCP machine-readable output SHALL preserve them without requiring the nested `route` object

#### Scenario: Route method miss is summarized

- **WHEN** the gateway returns `match: "route_method_miss"` with `allow` and route diagnostic fields
- **THEN** `buildDeployResolveSummary` SHALL report a route/method diagnostic instead of a generic unknown match
- **AND** next steps SHALL tell callers to inspect the route methods or retry with one of the allowed methods

#### Scenario: Unknown gateway literals are preserved

- **WHEN** the gateway returns an unknown `match`, `fallback_state`, `cache_class`, `authorization_result`, `response_variant.kind`, or `cache_policy`
- **THEN** SDK types SHALL allow the value
- **AND** CLI/MCP JSON output SHALL preserve the value

#### Scenario: Resolve keeps canonical error envelopes

- **WHEN** the gateway rejects an invalid host with an HTTP 400 error envelope
- **THEN** the SDK SHALL surface the existing `Run402Error` hierarchy behavior
- **AND** SHALL NOT coerce the HTTP error into a `DeployResolveResponse`

### Requirement: CLI and MCP expose public URL diagnostics

The CLI SHALL expose primary agent-facing diagnostics as `run402 deploy diagnose --project <id> <url> [--method GET]`. The CLI SHALL also expose lower-level parity forms `run402 deploy resolve --project <id> --url <url> [--method GET]` and `run402 deploy resolve --project <id> --host <host> [--path /x] [--method GET]`. When `--project` is omitted, the CLI SHALL use the active project id using the same local config behavior as other project-scoped deploy read commands.

Successful CLI output SHALL be JSON and SHALL wrap the gateway response without colliding with gateway fields. The JSON SHALL include `status`, `would_serve`, `diagnostic_status`, `match`, `summary`, normalized `request`, `warnings`, full `resolution`, and structured `next_steps`. Diagnostic misses SHALL exit 0 and use `status: "ok"`. CLI input errors and SDK/HTTP errors SHALL exit nonzero and use the existing CLI error envelope conventions.

The MCP server SHALL expose a read-only `deploy_diagnose_url` tool with `project_id`, either `url` or `host`/`path`, and optional `method`. The tool SHALL use `getSdk().deploy.resolve(...)` and shared SDK error mapping. Successful MCP responses SHALL include normalized request details, `would_serve`, `diagnostic_status`, `match`, a human-readable summary, structured warnings, deterministic next steps, structured machine-readable data when the MCP server shape supports it, and a fenced `json` block containing the full response as fallback.

CLI and MCP summaries SHALL distinguish host/static/SPA fallback diagnostics, route method misses, CAS object health failures, and CAS authorization failures when those fields are present. The full `resolution` JSON SHALL remain the source of truth for any fields not summarized by first-party prose.

#### Scenario: CLI diagnose prints structured JSON

- **WHEN** a user runs `run402 deploy diagnose --project prj_123 "https://example.com/assets/app.js?cache=1#hero"`
- **THEN** the CLI SHALL call `r.deploy.resolve({ project: "prj_123", url: "https://example.com/assets/app.js?cache=1#hero" })`
- **AND** stdout SHALL include `status: "ok"`, `would_serve`, `diagnostic_status`, `match`, a normalized `request`, `warnings`, full `resolution`, and structured `next_steps`
- **AND** stdout SHALL disclose the ignored query string and fragment in structured fields

#### Scenario: CLI host miss is not a process error

- **WHEN** the gateway returns a successful diagnostic body with `match: "host_missing"` and `result: 404`
- **THEN** the CLI SHALL print `status: "ok"` and `would_serve: false`
- **AND** SHALL NOT treat the diagnostic miss as a failed SDK call

#### Scenario: CLI route method miss gives method guidance

- **WHEN** the gateway returns `match: "route_method_miss"` and `allow: ["GET", "HEAD"]`
- **THEN** the CLI SHALL print `status: "ok"` and `would_serve: false`
- **AND** `next_steps` SHALL include route-method guidance that mentions the allowed methods or route method configuration

#### Scenario: MCP diagnostics map to SDK

- **WHEN** `deploy_diagnose_url` receives `{ "project_id": "prj_123", "url": "https://example.com/" }`
- **THEN** it SHALL call `getSdk().deploy.resolve({ project: "prj_123", url: "https://example.com/" })`
- **AND** the machine-readable output and fenced JSON SHALL preserve `match`, `result`, `fallback_state`, `route`, static manifest metadata, CAS diagnostics, response variant diagnostics, route/static diagnostics, and legacy immutable risk fields when returned

#### Scenario: CAS failure remains machine-readable

- **WHEN** the gateway returns a CAS authorization or health failure diagnostic
- **THEN** CLI and MCP SHALL preserve `authorization_result` and `cas_object` inside the machine-readable `resolution`
- **AND** their human-readable summaries SHALL direct the caller to inspect or redeploy the affected static asset instead of suggesting a cache purge

#### Scenario: Resolve surfaces are read-only

- **WHEN** CLI help or MCP tool descriptions are inspected
- **THEN** they SHALL describe resolve as authenticated diagnostics
- **AND** SHALL NOT imply that resolve fetches bytes, invalidates cache, mutates deploy state, or exposes internal CAS URLs

### Requirement: Documentation and sync cover deploy observability

The public repo SHALL update drift gates and documentation surfaces for deploy release observability and stable static asset identity.

`sync.test.ts` SHALL include the SDK resolve, CLI deploy diagnose/resolve, MCP `deploy_diagnose_url`, and OpenClaw deploy diagnose/resolve surface entries. Public docs SHALL describe release generation, static manifest SHA and metadata, `static_assets`, public URL diagnostics, diff target selectors, plan/diff type updates, stable-host CAS fields, response variants, route/static diagnostic fields, and known resolve match/authorization literals.

`documentation.md` SHALL include a checklist row for stable static asset identity and public URL diagnostics so future maintainers update SDK types, CLI/MCP surfaces, `llms*.txt`, skill files, README surfaces, and private-site docs when `/deploy/v2/resolve` or static asset observability changes.

#### Scenario: Sync test knows deploy URL diagnostics

- **WHEN** `npm run test:sync` runs
- **THEN** it SHALL fail if `deploy_diagnose_url` is missing from MCP registration, CLI/OpenClaw parity, or SDK capability mapping

#### Scenario: Docs mention stable-host resolve fields

- **WHEN** `npm run test:sync` runs
- **THEN** it SHALL fail if public docs omit the stable resolve literals `active_release_missing`, `route_function`, `route_static_alias`, and `route_method_miss`
- **AND** it SHALL fail if public docs omit `authorization_result`, `cas_object`, or `response_variant`

#### Scenario: Docs drift is detected

- **WHEN** a developer adds `static_assets` or stable-host resolve SDK types but forgets public docs
- **THEN** the sync/docs guard SHALL fail with an actionable message naming the missing surface when practical
