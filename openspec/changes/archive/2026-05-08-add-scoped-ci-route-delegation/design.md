## Context

Private gateway commit `511b938c` adds scoped CI route delegation. CI bindings now have `route_scopes: text[]`, `POST /ci/v1/bindings` accepts optional `route_scopes`, binding reads return `route_scopes`, and CI deploy planning accepts non-null `spec.routes` only when the binding delegates explicit route patterns. The gateway remains authoritative for route-diff scope enforcement and returns `CI_ROUTE_SCOPE_DENIED` when added, removed, or changed routes fall outside those scopes.

The public repo already has the CI/OIDC client surface, deploy-v2 routes, and credential-driven CI deploy support. Today the public SDK and docs still encode the earlier policy: CI deploys cannot ship `spec.routes` at all. The public upgrade should preserve the current architecture: the SDK owns typed wire contracts and canonical bytes; CLI, MCP, and OpenClaw are thin interface adapters.

## Goals / Non-Goals

**Goals:**

- Model `route_scopes` as a polished SDK-first feature, not a CLI special case.
- Preserve existing unscoped CI behavior and canonical delegation bytes when scopes are omitted.
- Allow scoped CI deploy manifests to include non-null `routes` while keeping the gateway as final authority for scope diffs.
- Make route-scope validation pleasant enough for SDK consumers and agents to catch typos before signing.
- Keep CLI as a wrapper around SDK/Node helpers with clear help text and structured output.
- Keep MCP tools as direct SDK shims with precise descriptions, not a second implementation of signing, workflow generation, or deploy rules.
- Update docs and sync tests so agents learn the same contract everywhere.

**Non-Goals:**

- No gateway/database implementation; private commit `511b938c` is the source of truth for server behavior.
- No public CI support for secrets, subdomains, checks, non-current base releases, manifest refs, domains, lifecycle, billing, contracts, or faucet calls.
- No raw subject, wildcard, PR deploy, or soft repository-id CLI UX.
- No separate GitHub Action package.
- No MCP workflow-file writer unless a later proposal decides MCP should own local filesystem setup. The CLI remains the setup path for generated workflow YAML.
- No SDK-side route-diff simulator that tries to decide whether a proposed route table is in scope; that is gateway-authoritative because it depends on the base release.

## Decisions

### D1. Route scopes live in the CI SDK namespace and exports

Add `route_scopes?: readonly string[]` to `CiCreateBindingInput`, `route_scopes: string[]` to `CiBindingRow`, and `route_scopes?: readonly string[]` to `CiDelegationValues`. `NormalizedCiDelegationValues` should always contain a sorted, deduped `route_scopes: string[]` so all downstream code has a stable shape.

Export route-scope-related types and helpers from both `@run402/sdk` and `@run402/sdk/node`, following the existing public type surface rules. Keep the wire field name `route_scopes` because the gateway and canonical Resource URI use snake_case.

Alternatives considered:

- Use `routeScopes` in SDK inputs and map to `route_scopes`: rejected for now because every current CI binding field follows the gateway's snake_case contract, and canonical builder values need exact field names.
- Put route-scope helpers under deploy routes: rejected because the scope is a CI binding property and affects delegation signing.

### D2. Canonical delegation builders must be byte-compatible in both modes

When `route_scopes` is omitted or empty, `buildCiDelegationStatement` and `buildCiDelegationResourceUri` must produce the existing v1.36 bytes exactly. That preserves existing tests, old bindings, and agent expectations.

When scopes are present, builders must match the gateway:

- Statement adds a third "The workflows can" bullet for route declarations within the delegated public path scopes.
- Statement changes the "cannot" sentence so it no longer says `spec.routes` is always forbidden, and instead says route changes outside delegated scopes are forbidden.
- Statement adds a `Route scopes: ...` line.
- Resource URI inserts `route_scopes=<sorted,encoded,comma-literal-values>` after `allowed_events` and before nullable `expires_at` / `github_repository_id`.

Add golden-vector tests for both no-scope backward compatibility and scoped output.

Alternatives considered:

- Always include an empty `route_scopes=` URI parameter: rejected because private gateway deliberately preserves old bytes when route scopes are absent.
- Let callers construct their own Statement/Resource URI for scoped bindings: rejected because byte drift fails verification and is exactly what the SDK should prevent.

### D3. SDK validation catches shape errors, gateway enforces diff authorization

Add `validateCiRouteScopes(scopes)` or equivalent internal validation that uses the same public route pattern constraints already exposed by deploy route validation: absolute paths, exact path or final `/*` prefix wildcard, no bare `/*`, no query strings, no invalid percent encoding, no duplicates after normalization, non-empty strings, sorted/deduped output, and table-limit-sized arrays.

SDK validation should reject invalid route-scope syntax before signing or creating a binding. It should not try to prove that a future `spec.routes.replace` diff is fully covered by scopes, because that depends on the active/base release. In CI deploy preflight:

- `spec.routes === undefined` remains allowed.
- `spec.routes === null` is allowed as carry-forward/preserve semantics.
- Non-null `spec.routes` is allowed through the client preflight and left for the gateway to validate against the binding's `route_scopes`.
- `secrets`, `subdomains`, `checks`, unknown future top-level fields, non-current `base`, and non-null `manifest_ref` remain client-side rejects.
- Oversized CI specs that require `manifest_ref` remain client-side rejects.

Alternatives considered:

- Client-side route-diff authorization: rejected as duplicative and stale-prone.
- Continue rejecting all route property presence in CI: rejected because it blocks the new gateway feature and creates public/private drift.

### D4. CLI adds one narrow setup flag and stays SDK-backed

Add a repeatable flag to `run402 ci link github`, likely:

```txt
--route-scope <pattern>   Delegate CI route changes for this exact or final-wildcard path pattern; repeatable
```

`cli/lib/ci.mjs` should parse repeatable flags, pass `route_scopes` into `signCiDelegation` and `ci.createBinding`, and include `route_scopes` in successful JSON output. Help text should show examples such as `--route-scope /admin --route-scope /admin/*` and explain that omitting the flag grants no route authority.

Generated workflow behavior does not need to change. It still calls `run402 deploy apply`, and CI deploy preflight/gateway enforcement decide whether the manifest's routes are allowed.

Alternatives considered:

- A separate `run402 ci routes allow` command: rejected because scopes are part of the binding's signed delegation and must be present at creation time.
- A comma-separated `--route-scopes` flag only: rejected because repeatable flags compose better with shell agents and avoid comma escaping ambiguity.

### D5. MCP exposes direct SDK shims, not setup orchestration

Add MCP tools only where the wrapper remains thin:

- `ci_create_binding`: validates input with Zod and calls `getSdk().ci.createBinding(...)`.
- `ci_list_bindings`: calls `getSdk().ci.listBindings(...)`.
- `ci_get_binding`: calls `getSdk().ci.getBinding(...)`.
- `ci_revoke_binding`: calls `getSdk().ci.revokeBinding(...)`.

Each tool description should explain the intended boundary: use the SDK/CLI canonical builders and Node signing helper to produce `signed_delegation`; the MCP tool does not build or sign delegation bytes itself. This keeps MCP honest and still lets agents manage bindings if they already have a signed delegation.

Do not add MCP token-exchange or CI deploy wrapper tools. Existing `deploy` remains the deploy primitive.

Alternatives considered:

- `ci_link_github` MCP that infers git remotes and writes workflow YAML: rejected for this change because it would duplicate CLI setup logic and broaden MCP beyond a thin shim.
- MCP signing helper: rejected because the Node SDK helper already owns local allowance signing.

### D6. Documentation and tests enforce the new teaching

Docs must update every place that currently says CI cannot ship routes. The new wording should be precise: unscoped CI bindings cannot ship non-null `spec.routes`; scoped bindings can, but the gateway rejects out-of-scope additions, removals, and changes with `CI_ROUTE_SCOPE_DENIED`.

Sync tests should move from "CI docs reject routes" to "CI docs mention route scopes and preserve the no-scope restriction." CLI help tests should guard the new flag. SDK tests should guard canonical bytes and public exports. MCP tests should guard descriptions and thin wrapper behavior if MCP tools are added.

## Risks / Trade-offs

- **Canonical byte drift** -> Mitigate with no-scope and scoped golden-vector tests copied from private gateway expectations.
- **Agents think route scopes grant broad app safety** -> Mitigate docs and CLI output: route scopes only limit route-table changes; deployed function code still has runtime authority.
- **Client preflight allows a route manifest that gateway later rejects** -> Accept this trade-off because the gateway is the only reliable diff authority; improve CLI error guidance for `CI_ROUTE_SCOPE_DENIED`.
- **MCP scope creep** -> Mitigate by adding only direct SDK binding wrappers and leaving workflow creation to CLI.
- **Existing docs/tests assert routes are always forbidden in CI** -> Update the archived web-routes spec delta and sync tests in the same implementation.

## Migration Plan

1. Update SDK CI types, normalization, validation, canonical builders, Node signing helper, and CI deploy preflight.
2. Update CLI parsing/help/output for route scopes and update deploy CI error guidance.
3. Add MCP binding wrappers only after SDK tests are green, so they can remain simple shims.
4. Update OpenClaw and docs.
5. Run build, focused unit tests, CLI/MCP tests, `npm run test:sync`, and `npm run test:skill`.

Rollback is straightforward before publish: revert public changes. After publish, route-scoped bindings are additive; unscoped behavior remains unchanged, so rollback risk is mostly documentation/CLI availability rather than API incompatibility.

## Open Questions

- Should the public CLI flag be `--route-scope` only, or also accept a convenience comma-separated `--route-scopes` alias?
- Should MCP include `ci_get_binding` even though the canonical sync surface currently tracks only link/list/revoke? It is a direct SDK method and useful for inspecting returned `route_scopes`.
