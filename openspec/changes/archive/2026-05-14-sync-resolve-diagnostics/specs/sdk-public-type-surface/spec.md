## ADDED Requirements

### Requirement: SDK public exports include stable-host resolve diagnostic types

The SDK package root SHALL export every public type introduced for stable-host deploy resolve diagnostics. The Node entrypoint SHALL re-export the same isomorphic type surface.

At minimum, public exports SHALL include `DeployResolveAuthorizationResult`, `KnownDeployResolveAuthorizationResult`, `DeployResolveCasObject`, and `DeployResolveResponseVariant` in addition to the existing deploy resolve option, response, summary, warning, next-step, match, fallback, route-match, method, and static cache-class types.

`DeployResolveAuthorizationResult` SHALL be future-safe and allow unknown string values without type errors. `KnownDeployResolveAuthorizationResult` SHALL include `"authorized"`, `"not_public"`, `"not_applicable"`, `"manifest_missing"`, `"target_missing"`, `"active_release_missing"`, `"path_error"`, `"missing_cas_object"`, `"unfinalized_or_deleting_cas_object"`, `"size_mismatch"`, and `"unauthorized_cas_object"`.

If implementation-specific helper types are added for route/static diagnostic fields, response variant kinds, or response variant `varies_by` values, those types SHALL also be exported from both entrypoints whenever they appear in a public SDK method signature, exported helper signature, or exported response shape.

#### Scenario: Agent imports stable-host resolve types from root

- **WHEN** a TypeScript consumer imports `DeployResolveAuthorizationResult`, `KnownDeployResolveAuthorizationResult`, `DeployResolveCasObject`, and `DeployResolveResponseVariant` from `@run402/sdk`
- **THEN** the imports SHALL compile without using deep package paths

#### Scenario: Agent imports stable-host resolve types from Node entrypoint

- **WHEN** a TypeScript consumer imports `DeployResolveAuthorizationResult`, `DeployResolveCasObject`, and `DeployResolveResponseVariant` from `@run402/sdk/node`
- **THEN** the imports SHALL compile without also importing from `@run402/sdk`

#### Scenario: Authorization result stays future-safe

- **WHEN** TypeScript code assigns an unknown string to `DeployResolveAuthorizationResult`
- **THEN** the assignment SHALL compile
- **AND** `KnownDeployResolveAuthorizationResult` SHALL still narrow to the documented known literals

### Requirement: Type drift guards cover stable-host resolve diagnostics

The SDK type-contract test suite SHALL fail when stable-host deploy resolve diagnostic fields are dropped from `DeployResolveResponse` or when the public package entrypoints stop exporting their named helper types.

The drift guard SHALL assert that `DeployResolveResponse` exposes optional or nullable `authorization_result`, `cas_object`, `response_variant`, `allow`, `route_pattern`, `target_type`, `target_name`, and `target_file` fields. It SHALL also assert that `KnownDeployResolveMatch` includes `active_release_missing`, `route_function`, `route_static_alias`, and `route_method_miss`, while `DeployResolveMatch` remains future-safe.

#### Scenario: Missing stable-host response field

- **WHEN** `DeployResolveResponse` no longer exposes `cas_object`
- **THEN** the type-contract test SHALL fail in CI

#### Scenario: Missing stable-host match literal

- **WHEN** `KnownDeployResolveMatch` omits `route_method_miss`
- **THEN** the type-contract test SHALL fail in CI

#### Scenario: Future match strings remain accepted

- **WHEN** TypeScript code assigns an unknown string to `DeployResolveMatch`
- **THEN** the type-contract test SHALL compile
- **AND** consumers SHALL NOT need an SDK release merely because the gateway adds a new resolve match literal
