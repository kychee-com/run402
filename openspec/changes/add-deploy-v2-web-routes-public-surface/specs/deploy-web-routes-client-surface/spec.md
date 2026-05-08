## ADDED Requirements

### Requirement: Deploy Spec Exposes Concrete Web Routes

The SDK SHALL model deploy-v2 web routes as a release resource. `ReleaseSpec.routes` SHALL have type `ReleaseRoutesSpec`, where `ReleaseRoutesSpec` is `undefined | null | { replace: RouteSpec[] }`. `RouteSpec` SHALL mean one route entry, not the top-level routes resource.

`undefined` and `null` SHALL carry forward the base release's materialized routes. `{ replace: [] }` SHALL clear all routes. `{ replace: [...] }` SHALL replace the route table for the new release.

`RouteSpec` SHALL include `pattern: string`, optional `methods?: readonly RouteHttpMethod[]`, and `target: RouteTarget`. `RouteHttpMethod` SHALL be one of `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, or `OPTIONS`. Phase 1 `RouteTarget` SHALL support only `{ type: "function", name: string }`. `ROUTE_HTTP_METHODS` SHALL expose the supported method constants for SDK, CLI, and MCP validation code.

Methods omitted SHALL mean all supported methods. `methods: []` SHALL be invalid. `GET` SHALL also match `HEAD` in Phase 1 unless future gateway behavior changes. A method-specific dynamic route SHALL only win for compatible methods, so a `POST /login` route can coexist with static `GET /login` content. Target names SHALL be materialized release function names, not file names or handler export names.

The SDK and Node manifest adapter SHALL reject malformed route resources before planning: path-keyed route maps, route resources that are neither `null` nor `{ replace: [...] }`, non-array `replace`, route entries missing `pattern` or `target`, non-string `pattern`, `methods` that are not arrays, `methods: []`, unsupported method strings, missing `target.type`, target types other than `"function"`, missing function target name, target shorthands such as `{ function: "api" }`, and unknown route-entry or target-object fields.

Route semantic validation SHALL remain gateway-authoritative: pattern syntax normalization, duplicate normalized patterns, pattern length, table limits, target function existence after materialization, static-shadowing warnings, method/static fallback warnings, carried-forward target warnings, and public-routed-function warnings.

#### Scenario: Manifest replaces routes

- **WHEN** a deploy manifest contains `routes: { "replace": [{ "pattern": "/api/*", "target": { "type": "function", "name": "api" } }] }`
- **THEN** the Node manifest adapter SHALL normalize the manifest into `ReleaseSpec.routes` with the same replace entry
- **AND** the deploy plan request SHALL send the `routes` resource to the gateway

#### Scenario: Null routes carries forward

- **WHEN** a deploy manifest contains `routes: null`
- **THEN** `normalizeDeployManifest()` SHALL preserve `spec.routes === null`
- **AND** `normalizeReleaseSpec()` SHALL include `routes: null` in the plan request
- **AND** docs SHALL state that the gateway carries forward base routes

#### Scenario: Empty replace clears routes

- **WHEN** a deploy manifest contains `routes: { "replace": [] }`
- **THEN** the SDK SHALL preserve an empty replace array
- **AND** docs SHALL state that this clears dynamic routes

#### Scenario: Empty replace is deployable content

- **WHEN** a CLI manifest contains only `project_id` and `routes: { "replace": [] }`
- **THEN** the CLI SHALL NOT reject it as an empty manifest
- **AND** the SDK SHALL send the routes resource to the gateway

#### Scenario: Empty methods are rejected

- **WHEN** a route contains `methods: []`
- **THEN** SDK validation SHALL reject it before planning
- **AND** the error SHALL say to omit `methods` to allow all supported methods

#### Scenario: Path-keyed placeholder is rejected

- **WHEN** TypeScript or JSON manifest input uses the old path-keyed shape `routes: { "/api/*": { "function": "api" } }`
- **THEN** SDK validation SHALL reject the shape before the plan request
- **AND** the error SHALL point users toward `routes: { replace: [{ pattern, target: { type: "function", name } }] }`

#### Scenario: Target shorthand is rejected

- **WHEN** a route target uses `{ "function": "api" }`
- **THEN** SDK validation SHALL reject it before planning
- **AND** the error SHALL say to use `{ "type": "function", "name": "api" }`

### Requirement: Public Interfaces Document Route Authoring

The CLI, MCP, OpenClaw skill, root skill, README, SDK README, SDK llms, CLI llms, and MCP llms SHALL document route authoring through the unified deploy primitive.

The documentation SHALL include at least one JSON manifest snippet with a route pattern, optional methods, and a function target. The documentation SHALL state that route activation is atomic with the rest of the release and that direct `/functions/v1/:name` invocation remains API-key protected.

CI deploy documentation SHALL continue to state that CI manifests cannot ship `routes`, and CI restriction tests SHALL continue to reject `spec.routes` by property presence.

Documentation SHALL include a complete JSON manifest example that deploys static `index.html`, a function named `api`, and a route `/api/*`. Documentation SHALL also include an exact-plus-prefix example for `/admin` and `/admin/*`, and a method-specific example where `POST /login` routes to a function while `GET /login` can serve static HTML.

Documentation SHALL explain `routes` omitted versus `routes: null` versus `routes: { replace: [] }`, public same-origin browser ingress, direct `/functions/v1/:name` remaining API-key protected, application auth responsibilities, CSRF guidance for cookie-authenticated unsafe methods, CORS/`OPTIONS` guidance, and the fact that Run402 does not add wildcard CORS.

#### Scenario: Agent docs include route shape

- **WHEN** an agent reads the deploy primitive documentation
- **THEN** it SHALL see `routes: { "replace": [...] }` as the supported shape
- **AND** it SHALL NOT see path-keyed route maps as recommended input

#### Scenario: CI docs preserve restriction

- **WHEN** an agent reads CI deploy documentation
- **THEN** it SHALL learn that `spec.routes` is forbidden in CI deploys
- **AND** the reason SHALL be that routes are broader trust changes requiring local allowance-backed authority

#### Scenario: CI rejects route property presence

- **WHEN** a CI deploy manifest contains `routes: null` or `routes: { "replace": [] }`
- **THEN** CI deploy validation SHALL reject it by property presence
- **AND** the error SHALL explain that Phase 1 routes require local allowance-backed authority

### Requirement: Public Docs Explain Route Matching And Precedence

Public SDK, CLI, MCP, OpenClaw, and skill docs SHALL explain Phase 1 route matching and precedence semantics.

The docs SHALL state that exact patterns look like `/admin`, prefix wildcard patterns look like `/admin/*`, and `/admin/*` does not match `/admin`, `/admin/`, `/admin.css`, or `/administrator`. `/admin` and `/admin/` SHALL be documented as trailing-slash equivalents for exact matching.

The docs SHALL state that the query string is ignored for matching and forwarded to routed functions as `rawQuery`. Exact routes SHALL beat prefix routes. The longest prefix SHALL win among prefix routes. Method-compatible dynamic routes SHALL beat static assets. Static lookup and SPA fallback SHALL happen only after route miss. Unsafe method mismatch SHALL return `405`, not SPA HTML. Matched dynamic routes SHALL fail closed and SHALL NOT fall back to static files if the target invocation fails.

#### Scenario: Exact and prefix pair is documented

- **WHEN** docs explain an `/admin` dynamic area
- **THEN** they SHALL show both `/admin` and `/admin/*`
- **AND** they SHALL state that `/admin/*` alone does not match `/admin`

#### Scenario: Method-specific static fallback is documented

- **WHEN** docs explain method-specific routes
- **THEN** they SHALL show `POST /login` routing to a function while `GET /login` can serve static HTML
- **AND** they SHALL state that fallback happens only when there is no method-compatible dynamic route

#### Scenario: Route failure is fail-closed

- **WHEN** a method-compatible dynamic route matches a request
- **THEN** docs SHALL state that target errors return platform/function errors
- **AND** docs SHALL state that Run402 does not continue to static lookup for that matched request

### Requirement: Route Warning Recovery Is First-Class

SDK docs, CLI warning enhancement, MCP warning output, and skills SHALL include route-specific recovery guidance with meaning, why it matters, and how to recover.

Known route warning guidance SHALL cover `PUBLIC_ROUTED_FUNCTION`, `ROUTE_TARGET_CARRIED_FORWARD`, `ROUTE_SHADOWS_STATIC_PATH`, `WILDCARD_ROUTE_SHADOWS_STATIC_PATHS`, `METHOD_SPECIFIC_ROUTE_ALLOWS_GET_STATIC_FALLBACK`, `ROUTE_TABLE_NEAR_LIMIT`, and `ROUTES_NOT_ENABLED` when the gateway returns it.

For `PUBLIC_ROUTED_FUNCTION`, guidance SHALL say that the route makes the target function public same-origin browser ingress, direct `/functions/v1/:name` remains API-key protected, and callers should rerun with `allowWarnings` or `--allow-warnings` only after reviewing application auth, CSRF, and CORS behavior.

For `ROUTE_SHADOWS_STATIC_PATH` and `WILDCARD_ROUTE_SHADOWS_STATIC_PATHS`, guidance SHALL tell callers to inspect affected route/static path details, inspect live routes with release observability, and retry with warning confirmation only when shadowing is intentional.

For `ROUTES_NOT_ENABLED`, guidance SHALL preserve the gateway code and explain that deploy-v2 web routes are not enabled for the project or environment; callers should deploy without `routes` or request enablement, and direct `/functions/v1/:name` remains protected and is not a browser-route substitute.

#### Scenario: Public route warning includes security recovery

- **WHEN** a plan warning includes `PUBLIC_ROUTED_FUNCTION`
- **THEN** CLI and MCP output SHALL include security-oriented next actions for app auth, CSRF, CORS/`OPTIONS`, and explicit warning confirmation

#### Scenario: Static shadow warning includes inspection recovery

- **WHEN** a plan warning includes `ROUTE_SHADOWS_STATIC_PATH`
- **THEN** CLI and MCP output SHALL include a hint about intentional dynamic shadowing
- **AND** next actions SHALL include inspecting the affected warning details and active release routes

### Requirement: MCP and CLI Surface Route Observability Summaries

MCP and CLI release-observability surfaces SHALL include route counts in human-readable summaries and preserve full route details in JSON output.

MCP release tools SHALL include route counts in the summary table for `deploy_release_get`, `deploy_release_active`, and `deploy_release_diff`. CLI release commands SHALL print the gateway response losslessly in JSON and update help text to mention route inventory and route diffs.

The MCP `deploy` tool SHALL include a final raw deploy result JSON block after the human-readable progress/success summary so agents can inspect `diff.routes`, route warnings, release ids, operation ids, and URLs without parsing event text.

#### Scenario: MCP active release summary counts routes

- **WHEN** `deploy_release_active` receives a release inventory with `routes.entries.length === 2`
- **THEN** the human-readable summary SHALL include `routes | 2`
- **AND** the fenced JSON SHALL include the full `routes` object

#### Scenario: MCP release diff summary counts route buckets

- **WHEN** `deploy_release_diff` receives a diff with one added route and one changed route
- **THEN** the human-readable summary SHALL include route added/removed/changed counts
- **AND** the fenced JSON SHALL include the full route diff entries

#### Scenario: CLI release command preserves routes JSON

- **WHEN** `run402 deploy release active --project prj_123` returns route inventory from the SDK
- **THEN** stdout SHALL include `{ "status": "ok", "release": ... }`
- **AND** the nested release object SHALL include the full `routes` object unchanged

#### Scenario: MCP deploy success includes raw result JSON

- **WHEN** the MCP `deploy` tool succeeds
- **THEN** the output SHALL include a `Raw Deploy Result` fenced JSON block
- **AND** that JSON SHALL include route diff data and warnings when the SDK result includes them

### Requirement: Sync Tests Guard Route Surface Alignment

The sync test suite SHALL require every public interface that teaches deploy resources to mention routes consistently.

The guard SHALL cover SDK types/docs, CLI docs/help, MCP tool docs, OpenClaw skill docs, root SKILL.md, README, and deploy release observability renderers where practical.

#### Scenario: Route docs drift is detected

- **WHEN** a developer adds route SDK types but forgets CLI or skill documentation
- **THEN** the sync test suite SHALL fail with an actionable message naming the missing surface

#### Scenario: Release renderer drift is detected

- **WHEN** route fields exist in SDK release inventory types but MCP release summaries omit route counts
- **THEN** the relevant MCP or sync test SHALL fail
