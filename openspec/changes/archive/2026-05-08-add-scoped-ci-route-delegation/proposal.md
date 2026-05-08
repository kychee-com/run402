## Why

The gateway now lets GitHub Actions CI bindings delegate route changes only within explicit `route_scopes`, but the public SDK still models CI as unable to ship any `routes` resource. That mismatch makes the safest route-deploy workflow unavailable to agents and forces a bad choice between local full-authority deploys and CI deploys with no route updates.

## What Changes

- Add first-class SDK support for scoped CI route delegation: `route_scopes` on binding create/list/get/revoke rows, canonical delegation Statement/Resource URI bytes, route-scope validation helpers, CI deploy preflight, and typed error guidance for `CI_ROUTE_SCOPE_DENIED`.
- Keep the SDK as the beautiful primary DX: external consumers should be able to compose `ci.createBinding`, canonical builders, Node signing helpers, and credential-driven `deploy.apply` without learning hidden CLI-only behavior.
- Extend CLI as a thin wrapper over the SDK with clear help text, including a repeatable route-scope flag for `run402 ci link github` and deploy guidance that explains scoped routes in CI.
- Add MCP wrappers only where they can remain thin SDK shims with useful descriptions: binding create/list/get/revoke and route-scope-aware deploy errors. Do not fork deploy behavior or reimplement canonical delegation logic at the MCP layer.
- Update OpenClaw as CLI parity and update agent docs so scoped CI routes are taught consistently across SDK, CLI, MCP, OpenClaw, README, and llms surfaces.
- Preserve no-scope behavior: existing CI bindings without `route_scopes` still cannot ship non-null `spec.routes`, and old canonical delegation bytes remain unchanged when route scopes are omitted.
- No breaking changes to existing local deploys, unscoped CI deploys, or release web-route authoring.

## Capabilities

### New Capabilities
- `scoped-ci-route-delegation-client-surface`: Public SDK, CLI, MCP, OpenClaw, and docs support for optional route-scoped CI bindings and route-scope-aware CI deploys.

### Modified Capabilities
- `deploy-web-routes-client-surface`: CI route documentation and validation must change from "CI always rejects routes" to "CI accepts non-null routes only for bindings with explicit delegated route scopes, with gateway-authoritative scope enforcement."

## Impact

- **SDK**: `sdk/src/namespaces/ci.types.ts`, `sdk/src/namespaces/ci.ts`, `sdk/src/node/ci.ts`, root and `/node` exports, CI deploy preflight, deploy error guidance, and SDK tests.
- **CLI**: `cli/lib/ci.mjs`, `cli/lib/deploy-v2.mjs`, help snapshots/e2e tests, workflow/link output, and JSON output shape for route-scoped bindings.
- **MCP**: CI binding tool files and `src/index.ts` registrations if thin wrappers can be kept SDK-native; deploy warning/error descriptions where route-scope errors are surfaced.
- **OpenClaw**: CLI re-export coverage and skill guidance.
- **Docs**: `README.md`, `SKILL.md`, `openclaw/SKILL.md`, `cli/llms-cli.txt`, SDK docs/llms when present, and any sync/doc tests that guard interface alignment.
- **Tests**: SDK canonical-builder golden vectors, CI preflight and deploy tests, CLI help/e2e tests, MCP description/tool tests if MCP wrappers are added, `npm run test:sync`, `npm run test:skill`, and build.
