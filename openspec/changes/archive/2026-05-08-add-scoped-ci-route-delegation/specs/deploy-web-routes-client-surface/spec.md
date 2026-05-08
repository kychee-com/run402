## MODIFIED Requirements

### Requirement: Public Interfaces Document Route Authoring

The CLI, MCP, OpenClaw skill, root skill, README, SDK README, SDK llms, CLI llms, and MCP llms SHALL document route authoring through the unified deploy primitive.

The documentation SHALL include at least one JSON manifest snippet with a route pattern, optional methods, and a function target. The documentation SHALL state that route activation is atomic with the rest of the release and that direct `/functions/v1/:name` invocation remains API-key protected.

CI deploy documentation SHALL state the scoped route rule. CI bindings without `route_scopes` SHALL NOT be able to ship non-null `routes`. CI bindings with explicit `route_scopes` SHALL be able to submit non-null `routes`, and the gateway SHALL reject added, removed, or changed route entries outside those scopes with `CI_ROUTE_SCOPE_DENIED`. CI restriction tests SHALL continue to reject route changes for unscoped CI bindings while allowing scoped route manifests to reach gateway planning.

Documentation SHALL include a complete JSON manifest example that deploys static `index.html`, a function named `api`, and a route `/api/*`. Documentation SHALL also include an exact-plus-prefix example for `/admin` and `/admin/*`, and a method-specific example where `POST /login` routes to a function while `GET /login` can serve static HTML.

Documentation SHALL explain `routes` omitted versus `routes: null` versus `routes: { replace: [] }`, public same-origin browser ingress, direct `/functions/v1/:name` remaining API-key protected, application auth responsibilities, CSRF guidance for cookie-authenticated unsafe methods, CORS/`OPTIONS` guidance, and the fact that Run402 does not add wildcard CORS.

#### Scenario: Agent docs include route shape
- **WHEN** an agent reads the deploy primitive documentation
- **THEN** it SHALL see `routes: { "replace": [...] }` as the supported shape
- **AND** it SHALL NOT see path-keyed route maps as recommended input

#### Scenario: CI docs explain scoped route delegation
- **WHEN** an agent reads CI deploy documentation
- **THEN** it SHALL learn that unscoped CI bindings cannot ship non-null `routes`
- **AND** it SHALL learn that route-scoped CI bindings can ship route changes inside delegated scopes
- **AND** it SHALL learn that route scopes limit route-table changes but do not reduce deployed function runtime authority

#### Scenario: Unscoped CI rejects non-null routes
- **WHEN** a CI deploy manifest is evaluated for a binding with no `route_scopes` and contains `routes: { "replace": [] }`
- **THEN** CI deploy validation SHALL reject it or the gateway SHALL reject it with a route-scope error
- **AND** the error SHALL explain that the binding has no delegated route authority

#### Scenario: Scoped CI route manifest reaches gateway authorization
- **WHEN** a CI deploy manifest is evaluated for a binding with delegated route scopes and contains `routes: { "replace": [...] }`
- **THEN** client preflight SHALL allow the route resource to proceed to gateway planning
- **AND** documentation SHALL state that the gateway compares added, removed, and changed route entries against the binding scopes
