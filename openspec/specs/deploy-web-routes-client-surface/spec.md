# deploy-web-routes-client-surface Specification

## Purpose
TBD - created by archiving change add-deploy-v2-web-routes-public-surface. Update Purpose after archive.
## Requirements
### Requirement: Deploy Spec Exposes Concrete Web Routes

The SDK SHALL model deploy-v2 web routes as a release resource. `ReleaseSpec.routes` SHALL have type `ReleaseRoutesSpec`, where `ReleaseRoutesSpec` is `undefined | null | { replace: RouteSpec[] }`. `RouteSpec` SHALL mean one route entry, not the top-level routes resource.

`undefined` and `null` SHALL carry forward the base release's materialized routes. `{ replace: [] }` SHALL clear all routes. `{ replace: [...] }` SHALL replace the route table for the new release.

`RouteSpec` SHALL include `pattern: string`, optional `methods?: readonly RouteHttpMethod[]`, and `target: RouteTarget`. `RouteHttpMethod` SHALL be one of `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, or `OPTIONS`. `RouteTarget` SHALL support `{ type: "function", name: string }` and `{ type: "static", file: string }`. `ROUTE_HTTP_METHODS` SHALL expose the supported method constants for SDK, CLI, and MCP validation code.

Function route methods omitted SHALL mean all supported methods. Function route `methods: []` SHALL be invalid. `GET` SHALL also match `HEAD` unless future gateway behavior changes. A method-specific function route SHALL only win for compatible methods, so a `POST /login` route can coexist with static `GET /login` content.

Static route targets SHALL be exact static file route targets. Static route targets SHALL use exact route patterns only. Static route targets SHALL require explicit `methods` of `["GET"]` or `["GET", "HEAD"]`; both SHALL materialize as effective `GET` plus `HEAD`. Static route targets SHALL serve a materialized same-release static site file without redirecting, rewriting, invoking a function, or falling through to SPA fallback on matched target errors.

Static target `file` values SHALL be materialized static-site file paths, not URL paths or rewrite destinations. Static target files SHALL be relative to the static site root, use `/` as the only path separator, not start with `/`, not contain `?` or `#`, not contain empty, `.` or `..` path segments, not contain backslashes, not end in `/`, and refer to existing materialized static files. Directory shorthand SHALL NOT be supported.

The SDK and Node manifest adapter SHALL reject malformed route resources before planning: path-keyed route maps, route resources that are neither `null` nor `{ replace: [...] }`, non-array `replace`, route entries missing `pattern` or `target`, non-string `pattern`, `methods` that are not arrays, `methods: []`, duplicate method strings within a route entry, unsupported method strings, missing `target.type`, target types other than `"function"` or `"static"`, missing function target name, non-string function target names, missing static target file, non-string static target files, target shorthands such as `{ function: "api" }`, and unknown route-entry or target-object fields.

Route semantic validation SHALL remain gateway-authoritative where it depends on final materialized state: pattern syntax normalization, duplicate normalized pattern/effective-method pairs, pattern length, table limits, target existence after materialization, static route target file existence, static-shadowing warnings, static route target warnings, method/static fallback warnings, carried-forward target warnings, and public-routed-function warnings.

#### Scenario: Manifest replaces routes with a function target

- **WHEN** a deploy manifest contains `routes: { "replace": [{ "pattern": "/api/*", "target": { "type": "function", "name": "api" } }] }`
- **THEN** the Node manifest adapter SHALL normalize the manifest into `ReleaseSpec.routes` with the same replace entry
- **AND** the deploy plan request SHALL send the `routes` resource to the gateway

#### Scenario: Manifest replaces routes with a static route target

- **WHEN** a deploy manifest contains `routes: { "replace": [{ "pattern": "/events", "methods": ["GET"], "target": { "type": "static", "file": "events.html" } }] }`
- **THEN** the Node manifest adapter SHALL normalize the static target without converting it to a function target
- **AND** the deploy plan request SHALL send the static route target to the gateway

#### Scenario: Static route target requires exact pattern

- **WHEN** a route contains `{ "pattern": "/docs/*", "methods": ["GET"], "target": { "type": "static", "file": "docs/index.html" } }`
- **THEN** SDK validation SHALL reject it before planning when practical
- **AND** the error SHALL explain that static route targets require exact path patterns

#### Scenario: Static route target requires GET-compatible methods

- **WHEN** a static route target omits `methods` or uses `["POST"]` or `["HEAD"]`
- **THEN** SDK validation SHALL reject it before planning when practical
- **AND** the error SHALL explain that static route targets support only `["GET"]` or `["GET", "HEAD"]` and that either form materializes effective GET plus HEAD

#### Scenario: Static target file is a materialized file path

- **WHEN** a static target declares `file: "/events.html"`, `file: "page.html?slug=events"`, `file: "../events.html"`, `file: "a//b.html"`, `file: "a\\b.html"`, or `file: "events/"`
- **THEN** SDK validation SHALL reject it before planning when practical
- **AND** the error SHALL explain that `target.file` is a relative materialized static-site file path

#### Scenario: Same-pattern mixed-method routes are valid

- **WHEN** a route table contains `GET /login` targeting static file `login.html`
- **AND** the same route table contains `POST /login` targeting function `login_submit`
- **THEN** the SDK SHALL preserve both route entries
- **AND** docs SHALL explain that method-compatible routes win without falling through to static HTML for unsafe method mismatches

### Requirement: Public Interfaces Document Route Authoring

The CLI, MCP, OpenClaw skill, root skill, README, SDK README, SDK llms, CLI llms, and MCP llms SHALL document route authoring through the unified deploy primitive.

The documentation SHALL lead with the golden manifest shape agents should write: static site files, functions, and one explicit `routes: { replace: [...] }` table. It SHALL say that ordinary static files do not need route entries: Run402 serves materialized static files after route miss. It SHALL include JSON manifest snippets with narrow function route methods and exact static route targets. The documentation SHALL state that route activation is atomic with the rest of the release and that direct `/functions/v1/:name` invocation remains API-key protected.

Documentation SHALL include:

- a complete manifest that deploys static `index.html`, a function named `api`, and a route `/api/*`;
- an exact-plus-prefix function example for `/admin` and `/admin/*`;
- a method-specific example where `POST /login` routes to a function while `GET /login` can serve static HTML or an exact static route target;
- a static route target example such as `/events` targeting `events.html`.
- a URL diagnostic example using `run402 deploy diagnose --project prj_123 https://example.com/events --method GET` after deployment.

Documentation SHALL explain `routes` omitted versus `routes: null` versus `routes: { replace: [] }`, public same-origin browser ingress, direct `/functions/v1/:name` remaining API-key protected, application auth responsibilities, CSRF guidance for cookie-authenticated unsafe methods, CORS/`OPTIONS` guidance, and the fact that Run402 does not add wildcard CORS.

Documentation SHALL explain that static route targets are exact route entries to already-materialized static files. They are not redirects, rewrites, query transforms, directory indexes, SPA fallbacks, or function invocations.

Documentation SHALL explicitly warn against common agent mistakes: routing every static file, using broad method lists by default, using wildcard static route targets such as `/docs/*`, using leading slash static files such as `/events.html`, using directory shorthand such as `events/`, creating one static route target per page for large sites, using wildcard function routes that shadow static assets, treating deploy resolve/diagnose as fetch/cache invalidation, parsing MCP prose instead of structured output, hard-coding cache policy strings, and confusing omitted/null routes with `routes: { replace: [] }`.

#### Scenario: Agent docs include static route target shape

- **WHEN** an agent reads deploy route documentation
- **THEN** it SHALL see `target: { "type": "static", "file": "events.html" }` as a supported exact static route target shape
- **AND** it SHALL learn that `target.file` has no leading slash, query, fragment, or traversal segments

#### Scenario: Agent docs keep function route security guidance

- **WHEN** an agent reads function route documentation
- **THEN** it SHALL learn that function routes are public same-origin browser ingress
- **AND** direct `/functions/v1/:name` remains API-key protected

### Requirement: Public Docs Explain Route Matching And Precedence

Public SDK, CLI, MCP, OpenClaw, and skill docs SHALL explain route matching and precedence semantics.

The docs SHALL state that exact patterns look like `/admin`, prefix wildcard patterns look like `/admin/*`, and `/admin/*` does not match `/admin`, `/admin/`, `/admin.css`, or `/administrator`. `/admin` and `/admin/` SHALL be documented as trailing-slash equivalents for exact matching.

The docs SHALL state that the query string is ignored for matching and forwarded to routed functions in the public `req.url`. Exact routes SHALL beat prefix routes. The longest prefix SHALL win among prefix routes. Method-compatible route entries SHALL beat ordinary static lookup and SPA fallback. Static lookup and SPA fallback SHALL happen only after route miss. Unsafe method mismatch SHALL return `405`, not SPA HTML. Matched function routes and matched static route targets SHALL fail closed and SHALL NOT fall back to static files or SPA fallback if the target cannot be served.

#### Scenario: Static route target is terminal

- **WHEN** docs explain a static route target `/events` targeting `events.html`
- **THEN** they SHALL state that a matched static route target serves `events.html` at browser-visible URL `/events`
- **AND** they SHALL state that Run402 does not redirect or rewrite the browser URL
- **AND** they SHALL state that matched target errors do not fall through to SPA fallback

#### Scenario: Method-specific static and function routes are documented

- **WHEN** docs explain method-specific routes
- **THEN** they SHALL show `POST /login` routing to a function while `GET /login` can serve static HTML or a static route target
- **AND** they SHALL state that fallback happens only when there is no method-compatible route entry

### Requirement: Route Warning Recovery Is First-Class

SDK docs, CLI warning enhancement, MCP warning output, and skills SHALL include route-specific recovery guidance with meaning, why it matters, and how to recover.

Known route warning guidance SHALL cover `PUBLIC_ROUTED_FUNCTION`, `ROUTE_TARGET_CARRIED_FORWARD`, `ROUTE_SHADOWS_STATIC_PATH`, `WILDCARD_ROUTE_SHADOWS_STATIC_PATHS`, `METHOD_SPECIFIC_ROUTE_ALLOWS_GET_STATIC_FALLBACK`, `ROUTE_TABLE_NEAR_LIMIT`, and `ROUTES_NOT_ENABLED` when the gateway returns it.

Known static route target warning guidance SHALL cover `STATIC_ALIAS_SHADOWS_STATIC_PATH`, `STATIC_ALIAS_RELATIVE_ASSET_RISK`, `STATIC_ALIAS_DUPLICATE_CANONICAL_URL`, `STATIC_ALIAS_EXTENSIONLESS_NON_HTML`, and `STATIC_ALIAS_TABLE_NEAR_LIMIT` when the gateway returns it.

For static route target warnings, guidance SHALL tell callers to inspect the route pattern, target file, direct public static paths, `static_public_paths` when returned, resolve diagnostics, and active release routes before confirming. Guidance SHALL say that static route targets are intentional route-table aliases; whether the target file URL is directly reachable depends on the release's `site.public_paths` mode and declarations.

#### Scenario: Static route target warning includes recovery

- **WHEN** a plan warning includes `STATIC_ALIAS_RELATIVE_ASSET_RISK`
- **THEN** CLI and MCP output SHALL explain that relative asset URLs may resolve differently at the alias URL
- **AND** next actions SHALL include inspecting the target HTML and confirming only when the alias is intentional

#### Scenario: Static route target table warning includes cap guidance

- **WHEN** a plan warning includes `STATIC_ALIAS_TABLE_NEAR_LIMIT`
- **THEN** docs SHALL explain that static route targets currently count toward the route table limit
- **AND** guidance SHALL suggest consolidating manual aliases or waiting for framework-scale Web Output support

### Requirement: MCP and CLI Surface Route Observability Summaries

MCP and CLI release-observability surfaces SHALL include route counts in human-readable summaries and preserve full route details in JSON output.

MCP release tools SHALL include route counts in the summary table for `deploy_release_get`, `deploy_release_active`, and `deploy_release_diff`. CLI release commands SHALL print the gateway response losslessly in JSON and update help text to mention route inventory, static route targets, and route diffs.

The MCP `deploy` tool SHALL include a final raw deploy result JSON block after the human-readable progress/success summary so agents can inspect `diff.routes`, static route targets, route warnings, release ids, operation ids, and URLs without parsing event text.

#### Scenario: Inventory exposes static route target

- **WHEN** `deploy_release_active` receives a release inventory with route target `{ "type": "static", "file": "events.html" }`
- **THEN** the human-readable summary SHALL count the route
- **AND** the fenced JSON SHALL include the full static target unchanged

#### Scenario: Release diff preserves static route target

- **WHEN** `deploy_release_diff` receives a diff that adds or changes a static route target
- **THEN** the human-readable summary SHALL count the route change
- **AND** the fenced JSON SHALL preserve the target type and target file

### Requirement: Sync Tests Guard Route Surface Alignment

The sync test suite SHALL require every public interface that teaches deploy resources to mention function routes and static route targets consistently.

The guard SHALL cover SDK types/docs, CLI docs/help, MCP tool docs, OpenClaw skill docs, root SKILL.md, README, and deploy release observability renderers where practical.

#### Scenario: Static route target docs drift is detected

- **WHEN** a developer adds `StaticRouteTarget` to SDK types but forgets CLI, MCP, or skill documentation
- **THEN** the sync test suite SHALL fail with an actionable message naming the missing surface when practical

#### Scenario: Static alias renderer drift is detected

- **WHEN** route fields can contain static targets but MCP release summaries or raw JSON blocks drop the `file` field
- **THEN** the relevant MCP or sync test SHALL fail

### Requirement: Static route docs distinguish route-only aliases from direct public paths

Public route documentation SHALL distinguish static route targets from `site.public_paths`.

Docs SHALL state that `site.public_paths` is the preferred surface for ordinary clean static URLs such as `/events -> events.html`. Static route targets SHALL be documented as route-table entries for exact, method-aware static aliases, such as static `GET /login` coexisting with function `POST /login`.

Docs SHALL state that a static route target's `target.file` is a release static asset path, not a public path, URL, CAS hash, rewrite destination, or redirect target. In explicit public path mode, a static route target can serve a private release asset at the route URL without making the asset filename directly reachable.

#### Scenario: Clean static URL docs prefer public paths

- **WHEN** public docs explain how to serve `events.html` at `/events`
- **THEN** they SHALL show `site.public_paths` as the preferred ordinary static URL authoring surface
- **AND** they SHALL NOT require a `routes.replace` static target for that simple case

#### Scenario: Method-aware static alias remains route based

- **WHEN** public docs explain static `GET /login` plus function `POST /login`
- **THEN** they SHALL use route entries for the method-aware behavior
- **AND** they SHALL state that fallback happens only when no method-compatible route entry matches

#### Scenario: Static route target can reference private asset

- **WHEN** docs explain a static route target `/events` with `target.file: "events.html"`
- **THEN** they SHALL state that `events.html` is a release static asset path
- **AND** they SHALL state that `/events.html` is not publicly reachable in explicit mode unless separately declared in `site.public_paths`

### Requirement: Static route warning guidance uses public path vocabulary

Static route warning guidance SHALL refer to direct public static paths, route-only static aliases, and release static asset paths using distinct wording.

Guidance for duplicate canonical URL and shadowing warnings SHALL tell callers to inspect `static_public_paths`, active routes, and resolve diagnostics when available. It SHALL NOT imply that every release static asset path is directly public.

#### Scenario: Duplicate canonical guidance handles explicit mode

- **WHEN** docs describe `STATIC_ALIAS_DUPLICATE_CANONICAL_URL`
- **THEN** they SHALL explain that the warning applies when another direct public path is reachable
- **AND** they SHALL avoid saying that the target asset filename is always public

#### Scenario: Shadowing guidance points to public path inventory

- **WHEN** docs describe route/static shadowing warnings
- **THEN** they SHALL tell callers to inspect active routes and `static_public_paths`
- **AND** they SHALL distinguish the route pattern from the backing `asset_path`
