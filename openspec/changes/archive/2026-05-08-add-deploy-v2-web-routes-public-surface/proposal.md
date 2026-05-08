## Why

The private gateway now supports deploy-v2 web routes: release manifests can map same-origin browser paths to functions, and release observability includes route inventory and diffs. The public SDK, CLI, MCP server, OpenClaw skill, and agent docs still expose only a loose forward-compatible `routes` placeholder, so agents cannot reliably declare, inspect, or explain this runtime.

## What Changes

- Add the concrete deploy manifest contract for `ReleaseSpec.routes?: ReleaseRoutesSpec`, where `ReleaseRoutesSpec` is `undefined | null | { replace: RouteSpec[] }` and `RouteSpec` means one route entry with a path pattern, optional HTTP methods, and a function target.
- Add public SDK types for route specs, targets, materialized route entries, route inventory, and route diffs.
- Include routes in deploy plan responses, release inventory, release diffs, MCP summaries, and CLI JSON/help surfaces.
- Document Phase 1 route matching and precedence semantics: exact paths, final `/*` prefix wildcards, query ignored for matching, exact-over-prefix, longest-prefix, method-compatible dynamic routes before static lookup, unsafe method mismatch as 405, and fail-closed dynamic routing.
- Document `run402.routed_http.v1` as the public same-origin function ingress contract for browser-routed traffic.
- Add typed routed HTTP function envelope exports and examples for function authors so agents can implement browser-facing handlers without guessing body/header/cookie encoding.
- Add route-specific warning and recovery guidance across SDK docs, CLI, MCP, and skills.
- Keep direct `/functions/v1/:name` behavior unchanged: it remains API-key protected and API-shaped.
- Update README, SDK docs, CLI docs, MCP/OpenClaw/skill references, and sync tests so agents learn the routes resource consistently.

## Capabilities

### New Capabilities

- `deploy-web-routes-client-surface`: Client-facing contract for declaring deploy-v2 web routes, receiving route warnings, inspecting materialized routes, and rendering route diffs across SDK, CLI, MCP, and OpenClaw.
- `routed-http-function-contract`: Public function event and response contract for same-origin browser requests routed by deploy-v2 routes.

### Modified Capabilities

- `deploy-observability-client-surface`: Extend existing deploy plan, release inventory, and release diff observability requirements to include route buckets and materialized route state.
- `sdk-public-type-surface`: Require all route-related public types to be exported from `@run402/sdk` and `@run402/sdk/node`.

## Impact

- SDK: `sdk/src/namespaces/deploy.types.ts`, `sdk/src/namespaces/deploy.ts`, `sdk/src/node/deploy-manifest.ts`, scoped deploy wrappers, public type exports, and SDK docs/tests.
- Functions library: `functions/src/index.ts` type exports for `RoutedHttpRequestV1`, `RoutedHttpResponseV1`, and small response helpers.
- CLI: `cli/lib/deploy-v2.mjs`, help snapshots, JSON output expectations, `cli/llms-cli.txt`, empty-manifest guard behavior, and route warning enhancement logic.
- MCP: deploy schemas/tools, release-observability formatters, raw deploy result rendering, route summary rendering, tool descriptions, and sync tests.
- OpenClaw and docs: `openclaw/SKILL.md`, root `SKILL.md`, `README.md`, `sdk/README.md`, `sdk/llms-sdk.txt`, `llms-mcp.txt`, and any doc-surface checks listed in `documentation.md`.
- Tests: deploy type/validation tests, manifest adapter tests, CLI e2e/help snapshots, MCP tool tests, scoped drift tests, sync tests, and public type export tests.
