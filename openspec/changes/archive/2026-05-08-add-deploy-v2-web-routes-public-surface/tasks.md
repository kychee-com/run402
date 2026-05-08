## 1. SDK Route Contract

- [x] 1.1 Rename the top-level routes resource type to `ReleaseRoutesSpec`; reserve `RouteSpec` for one route entry.
- [x] 1.2 Add `RouteHttpMethod`, `ROUTE_HTTP_METHODS`, `FunctionRouteTarget`, `RouteTarget`, `RouteSpec`, `ReleaseRoutesSpec`, `RouteEntry`, `MaterializedRoutes`, `RoutesDiff`, and `RouteChangeEntry`.
- [x] 1.3 Preserve `routes: null` through manifest normalization and normalized plan requests.
- [x] 1.4 Treat `routes: { replace: [] }` as meaningful deploy content in SDK and CLI empty-manifest guards.
- [x] 1.5 Add structural route validation and route-specific local error messages.
- [x] 1.6 Add route fields to `PlanResponse`, `PlanDiffEnvelope`, `ReleaseInventory`, `ReleaseToReleaseDiff`, and `normalizePlanResponse()`.
- [x] 1.7 Export route types from `@run402/sdk` and `@run402/sdk/node`.
- [x] 1.8 Export routed HTTP envelope types, and `text`/`json`/`bytes`/`isRequest` helpers, from `@run402/functions`.
- [x] 1.9 Preserve CI deploy restrictions by rejecting `spec.routes` by property presence, including `routes: null` and `routes: { replace: [] }`.

## 2. CLI And MCP Surfaces

- [x] 2.1 Update `run402 deploy apply` help and manifest documentation to show a complete static site + `api` function + `/api/*` route manifest.
- [x] 2.2 Update `run402 deploy release <get|active|diff>` help text and JSON expectations to preserve full route inventory, route diffs, and inventory warnings.
- [x] 2.3 Update MCP deploy schemas/tool descriptions so agents can provide route manifests through the unified `deploy` tool.
- [x] 2.4 Update MCP release summary renderers to include route counts for inventory and added/removed/changed counts for release diffs.
- [x] 2.5 Preserve CI deploy restriction behavior and error messaging that forbids `spec.routes` by property presence.
- [x] 2.6 Add `routes` to the MCP deploy schema using the same method enum and target shape as the SDK.
- [x] 2.7 Add route-specific warning guidance for CLI and MCP errors.
- [x] 2.8 Add raw deploy result JSON to MCP deploy success output.
- [x] 2.9 Update CLI empty-manifest detection so `{ routes: { replace: [] } }` is accepted.

## 3. Routed HTTP Documentation

- [x] 3.1 Document route authoring in `README.md`, `SKILL.md`, `openclaw/SKILL.md`, `cli/llms-cli.txt`, `llms-mcp.txt`, `sdk/README.md`, and `sdk/llms-sdk.txt`.
- [x] 3.2 Document `run402.routed_http.v1` request envelope fields, including method, public URL, path, raw query, headers, cookies, body encoding, and route context.
- [x] 3.3 Document `run402.routed_http.v1` response envelope fields, including status, headers, cookies, body encoding, redirect behavior, and HEAD behavior.
- [x] 3.4 Document routed HTTP limits and defaults: 6 MiB request/response body caps, no default wildcard CORS, no shared dynamic cache, and `private, no-store` when no cache header is supplied.
- [x] 3.5 Keep direct `/functions/v1/:name` documentation unchanged except to clarify that it remains API-key protected.
- [x] 3.6 Document exact route matching, prefix wildcard behavior, method matching, static precedence, 405 behavior, and fail-closed behavior.
- [x] 3.7 Document CSRF, cookie, CORS, and spoofed forwarding-header guidance for routed browser ingress.
- [x] 3.8 Add one complete function-handler example using `RoutedHttpRequestV1` and `RoutedHttpResponseV1`.
- [x] 3.9 Add route warning guidance tables with meaning, why it matters, and how to recover for known route warning codes.

## 4. Tests And Drift Guards

- [x] 4.1 Add SDK deploy validation tests for `routes: null`, `{ replace: [] }`, valid function targets, and invalid path-keyed route maps.
- [x] 4.2 Add Node manifest adapter tests for route normalization and actionable route shape errors.
- [x] 4.3 Add SDK public type export tests for route spec, route inventory, and route diff types.
- [x] 4.4 Add CLI help/e2e tests covering route manifest examples and release JSON that includes routes.
- [x] 4.5 Add MCP tool tests covering route counts in release inventory and release diff summaries.
- [x] 4.6 Extend `sync.test.ts` so SDK, CLI, MCP, OpenClaw, README, SKILL.md, and llms docs mention routes consistently.
- [x] 4.7 Test `normalizeReleaseSpec()` preserves `routes: null`.
- [x] 4.8 Test CLI accepts `routes: { replace: [] }` as non-empty.
- [x] 4.9 Test CLI and MCP reject path-keyed route maps with an actionable example.
- [x] 4.10 Test invalid route methods, empty methods, unsupported target types, missing target names, and unknown route fields.
- [x] 4.11 Test CI rejects `spec.routes` by property presence, including `routes: null`.
- [x] 4.12 Compile SDK route docs snippets against `@run402/sdk` and `@run402/sdk/node`.
- [x] 4.13 Compile routed HTTP function docs snippets against `@run402/functions`.
- [x] 4.14 Test MCP deploy success includes raw result JSON and route diff data.

## 5. Verification

- [x] 5.1 Run focused SDK unit tests for deploy types, deploy validation, manifest normalization, scoped deploy wrappers, and public type exports.
- [x] 5.2 Run focused CLI tests for deploy help, deploy argv handling, release observability, and CI route restriction messaging.
- [x] 5.3 Run focused MCP tests for deploy and deploy release tools.
- [x] 5.4 Run `npm run test:sync` and `npm run test:skill`.
- [x] 5.5 Run `npm test` if the focused suites pass cleanly.
