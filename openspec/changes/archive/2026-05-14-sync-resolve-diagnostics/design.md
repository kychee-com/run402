## Context

`GET /deploy/v2/resolve` is the read-only deploy diagnostic path used by SDK `deploy.resolve`, CLI `run402 deploy diagnose` / `resolve`, MCP `deploy_diagnose_url`, and agent docs. The SDK already preserves unknown gateway fields through `DeployResolveResponse`, but the current named contract only models the earlier host/static/SPA fallback payload. The gateway now emits stable-host diagnostics for CAS object health, hostname-specific HTML response variants, route/static matching, and authorization outcomes.

The implementation should stay SDK-centered: CLI, MCP, and OpenClaw surfaces should continue to call the SDK and reuse `normalizeDeployResolveRequest` plus `buildDeployResolveSummary`. This keeps the endpoint wiring, response typing, and summary behavior consistent across all first-party interfaces.

## Goals / Non-Goals

**Goals:**

- Model the new optional resolve diagnostics in public SDK types without losing unknown future values.
- Teach deterministic summary/next-step helpers about route method misses and CAS authorization or health failures.
- Add representative unit/type/sync coverage for the widened response shape and docs.
- Update agent-facing docs so callers branch on structured fields instead of parsing prose.

**Non-Goals:**

- No gateway or API behavior changes; this syncs the client contract to fields already returned by the API.
- No new CLI command, MCP tool, SDK method, or deploy mutation flow.
- No attempt to fetch static bytes, inspect private CAS URLs, purge caches, or verify CDN freshness through deploy resolve.
- No patch/minor publish as part of the OpenSpec implementation itself; publishing remains a follow-up release workflow after tests pass.

## Decisions

1. Keep `DeployResolveResponse` structurally future-safe.

   Add explicit optional fields and helper literal unions for known values, while retaining the existing `[key: string]: unknown` escape hatch and `LiteralUnion` patterns. This lets TypeScript users see stable fields such as `authorization_result`, `cas_object`, and `response_variant` without making a future gateway literal a breaking SDK change. The alternative, closed unions, would catch typos but would force unnecessary SDK releases for additive gateway diagnostics.

2. Represent nested diagnostics with named public types when they are useful to consumers.

   Define named shapes for authorization result, CAS object health, response variant, and route/static diagnostic fields if the response would otherwise grow hard to understand inline. Export any named public types from both `@run402/sdk` and `@run402/sdk/node`. The alternative, only inlining everything inside `DeployResolveResponse`, is simpler internally but gives downstream docs/tests fewer contract points and makes type-contract drift easier to miss.

3. Keep summary logic pure and shared.

   Extend `buildDeployResolveSummary` and its private category/next-step helpers so CLI and MCP get the same diagnosis for route method misses, CAS object missing/unfinalized/size mismatch, and unauthorized CAS objects. The alternative, formatting special cases separately in CLI and MCP, would drift quickly and would make OpenClaw/agent docs harder to keep aligned.

4. Test with gateway-shaped fixtures rather than live resolve calls.

   Add mocked SDK resolve fixtures for static CAS failure, HTML response variant, and route/static diagnostics. Update type-contract and sync/docs tests for the literal and documentation drift. Live gateway behavior remains integration-test territory because ordinary unit tests should not depend on production feature rollout or release state.

## Risks / Trade-offs

- Future gateway naming differs slightly from the issue description -> Preserve unknown fields/literals and only branch summaries on documented stable names; unrecognized failures still produce an inspect-payload next step.
- Optional fields are over-modeled as required -> Keep every additive diagnostic field optional or nullable unless the current response contract guarantees it for all resolve bodies.
- Human summaries lag raw JSON -> Sync tests should require docs to mention the stable literals and fields, while CLI/MCP always include the full raw `resolution` JSON.
- Type additions create export churn -> Prefer a small set of named nested types and update the existing public type export guards in the same change.

## Migration Plan

1. Update SDK deploy resolve types and summary helpers.
2. Add mocked unit/type tests around the new response fixtures and summary branches.
3. Update CLI/MCP docs and agent references; verify sync/type-contract tests.
4. Run the normal build, unit, sync, and skill/doc checks.
5. After merge, publish through the existing run402 release workflow as the issue requests.
