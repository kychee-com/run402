## Why

The gateway now returns additional optional diagnostics from `GET /deploy/v2/resolve`, especially around stable-host static routing, CAS object health, and hostname-specific HTML variants. The SDK currently preserves these fields as unknown data, but agents and TypeScript consumers need explicit types, summaries, docs, and drift tests so they can reason about failures without scraping raw JSON.

## What Changes

- Widen the SDK deploy resolve type contract to model the new authorization, CAS health, HTML response variant, route/static diagnostic, and match literal fields while preserving unknown future strings and fields.
- Update deterministic deploy resolve summaries and MCP/CLI diagnose guidance so route method misses and CAS authorization/health failures produce specific categories and next steps.
- Add focused SDK tests for static CAS failure, HTML response variant diagnostics, and route/static diagnostic matches.
- Update public docs and agent references for the new fields and diagnostic behavior.
- Extend sync/type-contract drift tests so future resolve diagnostics added to docs or public types do not silently diverge.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `deploy-observability-client-surface`: Expand public deploy URL diagnostics to include stable-host CAS fields, response variants, route/static metadata, new match literals, and diagnostic summaries.
- `sdk-public-type-surface`: Ensure all public resolve diagnostic types and literal unions remain importable from `@run402/sdk` and `@run402/sdk/node`, with type-contract coverage for the widened response shape.

## Impact

- Affects SDK deploy resolve types and helper functions in `sdk/src/namespaces/deploy.types.ts`, plus root and Node SDK exports/type-contract tests if new named types are introduced.
- Affects `deploy.resolve()` unit tests and any scoped/root deploy resolve type assertions.
- Affects MCP `deploy_diagnose_url` summaries, CLI `run402 deploy diagnose` / `run402 deploy resolve` output guidance, OpenClaw parity, and `sync.test.ts` drift checks.
- Affects public documentation surfaces including `README.md`, root `SKILL.md`, `llms-mcp.txt`, and SDK/CLI docs where deploy URL diagnostics are described.
