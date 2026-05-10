## Why

The private gateway now exposes stable static asset identity for deploy-v2, tracked by public issue https://github.com/kychee-com/run402/issues/248. Static releases materialize a canonical `run402.static_manifest.v1`, release inventory exposes static manifest identity, plan and release diffs include `static_assets`, and `GET /deploy/v2/resolve` gives authenticated public URL diagnostics for project-owned stable hosts.

The private repo also shipped exact static route targets as a closely adjacent route-table widening: route targets can now be `{ type: "static", file }` as well as `{ type: "function", name }`. The public SDK, MCP, CLI, OpenClaw, and package-facing docs still teach function-only routes and do not expose public URL diagnostics or static asset observability fields.

This change closes the downstream public-client handoff without changing gateway behavior.

## What Changes

- Add SDK deploy types for stable public URL diagnostics, static manifest metadata, static cache classes, static asset diff counters, route-aware diagnostic context, and future-safe diagnostic literals.
- Add URL-first `r.deploy.resolve({ project, url, method? })` plus lower-level `r.deploy.resolve({ project, host, path?, method? })`, backed by `GET /deploy/v2/resolve`, plus scoped-client support.
- Add `release_generation`, `static_manifest_sha256`, and `static_manifest_metadata` to release inventory types.
- Add `static_assets` to deploy plan, plan diff, deploy diff, and release-to-release diff types.
- Widen `RouteTarget` from function-only to `FunctionRouteTarget | StaticRouteTarget`.
- Add public CLI and MCP diagnostics surfaces: primary `run402 deploy diagnose --project <id> <url> [--method GET]`, lower-level `run402 deploy resolve --url/--host/--path`, and MCP tool `deploy_diagnose_url`.
- Add deterministic shared diagnostics with normalized request data, `would_serve`, `diagnostic_status`, full structured response, structured warnings, and match-specific recovery steps.
- Treat route-aware diagnostics as a gateway contract gate: expose route-aware known match literals and docs only when the private endpoint/OpenAPI can actually emit route matches, static route target matches, and method mismatch.
- Update OpenClaw parity, `sync.test.ts`, SDK type export contracts, help/docs, skills, README surfaces, and llms references.
- Preserve existing deploy apply, release get/active/diff, operation list/events/resume, and legacy deploy compatibility behavior.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `deploy-observability-client-surface`: add stable public URL diagnostics, static manifest metadata, release generation, and `static_assets` diff observability.
- `deploy-web-routes-client-surface`: widen route targets to exact static route targets and document their authoring, matching, validation, and warning behavior.
- `sdk-public-type-surface`: require all new deploy resolve, static manifest, static asset diff, and static route target types to be exported from both SDK entrypoints.

## Impact

- **SDK**: `sdk/src/namespaces/deploy.types.ts`, `sdk/src/namespaces/deploy.ts`, `sdk/src/scoped.ts`, root and Node exports, type-contract tests, deploy tests, and docs snippets.
- **MCP**: new `src/tools/deploy-diagnose-url.ts`, `src/index.ts` registration, deploy route schema widening, release/resolve renderers, MCP tests, `llms-mcp.txt`, and `SKILL.md`.
- **CLI/OpenClaw**: `cli/lib/deploy-v2.mjs`, dispatch/help/e2e tests, `cli/llms-cli.txt`, `cli/README.md` if needed, and `openclaw/SKILL.md` / `openclaw/README.md`.
- **Sync/docs**: `sync.test.ts` `SURFACE` and `SDK_BY_CAPABILITY`, route/static-asset drift guards, `README.md`, `sdk/README.md`, `sdk/llms-sdk.txt`, `llms.txt` where the wayfinder references deploy observability, `AGENTS.md` if deploy primitive details change, and `documentation.md`.
- **Private coordination**: private `site/openapi.json`, `site/llms-full.txt`, `site/updates.txt`, and human changelog are already updated. Public docs should match those endpoint names and response semantics.
- **Testing**: focused SDK request/type tests, scoped wrapper tests, CLI help/e2e tests, MCP handler tests, `npm run test:sync`, `npm run test:skill`, and build/type-check targets for touched packages.
