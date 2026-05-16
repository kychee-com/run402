## ADDED Requirements

### Requirement: Read-Only Wildcard Routes Can Be Acknowledged In Manifest

Route authoring SHALL support a durable acknowledgement for intentional read-only wildcard function routes.

A route entry MAY include `acknowledge_readonly: true` only when the route targets a function, the pattern is a final wildcard prefix such as `/share/*`, and the declared effective methods are GET/HEAD-compatible. When present on a valid read-only wildcard function route, this acknowledgement SHALL suppress or satisfy the `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS` confirmation requirement for that route only.

The acknowledgement SHALL NOT suppress unrelated warnings and SHALL NOT suppress the same warning for other routes. Invalid use of `acknowledge_readonly` SHALL fail before planning when practical.

#### Scenario: Read-only wildcard route acknowledgement is honored

- **WHEN** a manifest declares route `{ "pattern": "/share/*", "methods": ["GET"], "target": { "type": "function", "name": "share" }, "acknowledge_readonly": true }`
- **THEN** the SDK/CLI/MCP deploy path SHALL treat the read-only wildcard acknowledgement as applying to `/share/*`
- **AND** deploy warning confirmation SHALL NOT require a blanket `allowWarnings` solely for `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS` on that route

#### Scenario: Acknowledgement is route-scoped

- **WHEN** a manifest acknowledges `/share/*` but also contains an unacknowledged GET-only `/admin/*` function wildcard route
- **THEN** the deploy plan SHALL still require confirmation for `/admin/*`
- **AND** the acknowledgement for `/share/*` SHALL NOT suppress unrelated route or secret warnings

#### Scenario: Invalid acknowledgement fails locally

- **WHEN** a manifest sets `acknowledge_readonly: true` on an exact route, a static route target, or a function route that includes mutation methods
- **THEN** SDK or manifest-adapter validation SHALL reject the route before deploy planning when practical
- **AND** the error SHALL explain that `acknowledge_readonly` applies only to GET/HEAD wildcard function routes

### Requirement: Route Warning Docs Prefer Scoped Acknowledgement

Agent-facing route warning documentation SHALL describe scoped acknowledgement paths before broad warning bypasses.

For `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS`, docs SHALL explain three recovery options: add mutation methods, omit `methods` for an API prefix that accepts all supported methods, or set route-level `acknowledge_readonly: true` when the prefix is intentionally read-only. Docs SHALL mention `--allow-warning WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS` as a CLI-only escape hatch and SHALL reserve broad `--allow-warnings` / `allow_warnings` for reviewed exceptional cases.

#### Scenario: Agent sees safer read-only recovery

- **WHEN** an agent reads deploy warning guidance for `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS`
- **THEN** it SHALL see route-level acknowledgement as the durable fix for intentional read-only wildcard routes
- **AND** it SHALL not be steered first toward blanket `--allow-warnings`

