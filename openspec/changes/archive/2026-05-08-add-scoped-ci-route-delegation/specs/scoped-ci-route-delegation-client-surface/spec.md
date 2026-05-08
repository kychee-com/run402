## ADDED Requirements

### Requirement: SDK Models Scoped CI Route Delegation

The SDK SHALL model CI route delegation as an optional `route_scopes` field on CI binding creation and binding rows.

`CiCreateBindingInput` SHALL accept `route_scopes?: readonly string[]`. `CiBindingRow` SHALL include `route_scopes: string[]`. `CiDelegationValues` SHALL accept `route_scopes?: readonly string[]`, and `NormalizedCiDelegationValues` SHALL expose `route_scopes: string[]` as a sorted, deduped array.

The SDK SHALL validate route scopes before signing or creating a binding. A route scope SHALL be an absolute route pattern using the same public route pattern family as deploy routes: exact paths such as `/admin` or final-prefix wildcard paths such as `/admin/*`. Empty strings, non-strings, query strings, invalid percent encoding, bare `*`, bare `/*`, non-final wildcards, duplicate normalized patterns, and arrays beyond the route table limit SHALL be rejected with actionable local errors.

The SDK root entrypoint and Node entrypoint SHALL export every public route-scope type and helper that appears in method signatures or helper APIs.

#### Scenario: Create binding sends route scopes
- **WHEN** `ci.createBinding` is called with `route_scopes: ["/admin/*", "/admin"]`
- **THEN** the SDK SHALL send `route_scopes` in the `POST /ci/v1/bindings` body
- **AND** the values SHALL be normalized into deterministic order before canonical delegation signing

#### Scenario: Binding rows expose route scopes
- **WHEN** `ci.listBindings`, `ci.getBinding`, `ci.createBinding`, or `ci.revokeBinding` returns a binding row from the gateway
- **THEN** the typed result SHALL expose `route_scopes` as a string array

#### Scenario: Invalid route scope fails locally
- **WHEN** a caller attempts to sign or create a CI binding with `route_scopes: ["api/*"]`
- **THEN** the SDK SHALL reject the input before any gateway call
- **AND** the error SHALL explain that route scopes must be absolute paths such as `/api` or `/api/*`

### Requirement: Canonical Delegation Builders Preserve Scoped And Unscoped Bytes

The SDK SHALL keep `buildCiDelegationStatement(values)` and `buildCiDelegationResourceUri(values)` as the sole public source of canonical CI delegation bytes.

When `route_scopes` is omitted or empty, the builders SHALL produce the same Statement and Resource URI bytes as the existing unscoped CI delegation contract. When `route_scopes` is non-empty, the builders SHALL include the gateway-defined route-scope disclosure in the Statement and SHALL include `route_scopes` in the Resource URI after `allowed_events` and before nullable `expires_at` and `github_repository_id`.

The canonical Statement SHALL disclose that workflows can deploy route declarations only within the delegated public path scopes, and SHALL disclose that workflows cannot ship route changes outside those scopes. The canonical Resource URI SHALL encode route scopes with RFC 3986 escaping while keeping commas between array values literal.

#### Scenario: Unscoped canonical bytes remain stable
- **WHEN** a caller builds delegation bytes without `route_scopes`
- **THEN** the Statement SHALL still say CI cannot ship `spec.routes`
- **AND** the Resource URI SHALL NOT include a `route_scopes` parameter
- **AND** existing no-scope golden-vector tests SHALL continue to pass

#### Scenario: Scoped canonical bytes include route disclosure
- **WHEN** a caller builds delegation bytes with `route_scopes: ["/admin", "/admin/*"]`
- **THEN** the Statement SHALL include a route-scopes disclosure and a `Route scopes: /admin,/admin/*` line
- **AND** the Resource URI SHALL include `route_scopes=%2Fadmin,%2Fadmin%2F%2A` in the gateway-defined parameter order

### Requirement: CI Deploy Preflight Allows Scoped Routes And Preserves Other Restrictions

The SDK CI deploy preflight SHALL allow `ReleaseSpec.routes` when it is `undefined` or `null`. The SDK CI deploy preflight SHALL allow non-null `ReleaseSpec.routes` through to the gateway when CI credentials are active, because the gateway authorizes the route diff against the binding's `route_scopes`.

The SDK CI deploy preflight SHALL continue to reject `secrets`, `subdomains`, `checks`, unknown future top-level fields, `base` other than absent or exactly `{ release: "current" }`, non-null `manifest_ref`, and normalized CI specs that require the SDK's oversized-manifest `manifest_ref` escape hatch.

The CLI and MCP SHALL preserve gateway error envelopes for `CI_ROUTE_SCOPE_DENIED` and SHALL add actionable guidance explaining that the binding's route scopes do not cover one or more added, removed, or changed route entries.

#### Scenario: CI routes null is allowed
- **WHEN** a CI-marked deploy provider calls `deploy.apply` with `routes: null`
- **THEN** SDK preflight SHALL allow the request to proceed
- **AND** the gateway SHALL receive `routes: null` as preserve/carry-forward semantics

#### Scenario: CI routes replace reaches gateway
- **WHEN** a CI-marked deploy provider calls `deploy.apply` with `routes: { replace: [...] }`
- **THEN** SDK preflight SHALL NOT reject the routes property by presence
- **AND** the gateway SHALL remain responsible for route-scope authorization

#### Scenario: Non-route CI restrictions remain
- **WHEN** a CI-marked deploy provider calls `deploy.apply` with `secrets`, `subdomains`, `checks`, an unknown top-level field, non-current `base`, or non-null `manifest_ref`
- **THEN** SDK preflight SHALL reject before upload, content planning, or deploy planning

#### Scenario: Scope-denied gateway error is actionable
- **WHEN** the gateway returns `CI_ROUTE_SCOPE_DENIED`
- **THEN** CLI and MCP output SHALL preserve the error code
- **AND** the output SHALL tell the user to re-link with route scopes covering the changed routes or deploy locally with allowance-backed authority

### Requirement: CLI Links GitHub Actions With Optional Route Scopes

`run402 ci link github` SHALL expose a repeatable route-scope option that passes route scopes through the SDK canonical builders, Node signing helper, and `ci.createBinding`.

The CLI help SHALL describe the route-scope option, show exact and prefix examples, and state that omitting route scopes grants no CI route authority. Successful link output SHALL include `route_scopes` and SHALL keep the existing consent and revocation warnings. The generated workflow SHALL remain the existing `run402 deploy apply` workflow.

`run402 ci list` and `run402 ci revoke` SHALL preserve returned `route_scopes` in JSON output without CLI-specific reshaping.

#### Scenario: Link command creates scoped binding
- **WHEN** a user runs `run402 ci link github --route-scope /admin --route-scope /admin/*`
- **THEN** the CLI SHALL sign a delegation that includes those route scopes
- **AND** the SDK binding create request SHALL include `route_scopes`
- **AND** the success JSON SHALL include the normalized `route_scopes`

#### Scenario: Link command omits route scopes by default
- **WHEN** a user runs `run402 ci link github` without route-scope flags
- **THEN** the CLI SHALL create an unscoped CI binding
- **AND** existing CI route restrictions SHALL remain unchanged for that binding

### Requirement: MCP Exposes CI Binding Management As Thin SDK Wrappers

The MCP server SHALL expose CI binding management tools only where each tool is a direct shim over one SDK method. The tools SHALL include descriptions that explain route scopes and state that canonical delegation construction and signing belong to the SDK/Node helper or CLI setup flow.

At minimum, MCP SHALL provide thin wrappers for creating, listing, getting, and revoking CI bindings if CI binding management is exposed in MCP. The MCP server SHALL NOT add token-exchange tools, CI-specific deploy tools, or workflow-generation tools as part of this change.

#### Scenario: MCP create binding calls SDK
- **WHEN** `ci_create_binding` is called with `route_scopes` and `signed_delegation`
- **THEN** the handler SHALL call `getSdk().ci.createBinding(...)`
- **AND** it SHALL NOT rebuild or reinterpret the canonical delegation bytes

#### Scenario: MCP descriptions teach the boundary
- **WHEN** an agent inspects the MCP CI tool descriptions
- **THEN** the descriptions SHALL mention optional `route_scopes`
- **AND** they SHALL say to use SDK/Node signing or the CLI link flow to produce `signed_delegation`

### Requirement: Agent Documentation Teaches Scoped CI Routes Consistently

Public agent-facing documentation SHALL explain scoped CI route delegation consistently across SDK, CLI, MCP, OpenClaw, README, and llms surfaces.

Docs SHALL state that route scopes are exact or final-wildcard public path patterns, that `/admin/*` does not include `/admin`, and that both `/admin` and `/admin/*` are needed to delegate a dynamic area root and children. Docs SHALL state that route scopes authorize route-table changes only; deployed function code still runs with project runtime authority.

Docs SHALL replace any blanket claim that CI cannot ship routes with the scoped rule: unscoped CI cannot ship non-null routes, scoped CI may ship routes within delegated route scopes, and the gateway rejects out-of-scope route changes with `CI_ROUTE_SCOPE_DENIED`.

#### Scenario: CLI llms describe scoped routes
- **WHEN** an agent reads `cli/llms-cli.txt`
- **THEN** it SHALL learn how to pass route scopes when linking GitHub Actions
- **AND** it SHALL learn how to respond to `CI_ROUTE_SCOPE_DENIED`

#### Scenario: Root skill avoids stale route prohibition
- **WHEN** an agent reads `SKILL.md`
- **THEN** it SHALL NOT learn that all CI deploys must always omit `routes`
- **AND** it SHALL learn that route-scoped CI bindings can deploy scoped route changes
