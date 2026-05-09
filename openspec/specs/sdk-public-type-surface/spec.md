# sdk-public-type-surface Specification

## Purpose
TBD - created by archiving change harden-sdk-public-contracts. Update Purpose after archive.
## Requirements
### Requirement: Complete Root Type Exports

The SDK package root SHALL export every TypeScript type that appears in public SDK namespace method signatures, constructor options, return values, event payloads, or helper APIs.

Route-related deploy types SHALL be included in this contract. At minimum, the root entrypoint SHALL export `RouteHttpMethod`, `ROUTE_HTTP_METHODS`, `RouteTarget`, `FunctionRouteTarget`, `RouteSpec`, `ReleaseRoutesSpec`, `RouteEntry`, `MaterializedRoutes`, `RoutesDiff`, and `RouteChangeEntry`.

`ReleaseRoutesSpec` SHALL NOT be buried under deep deploy paths. If an `HttpMethod` compatibility alias is kept, it SHALL alias `RouteHttpMethod` rather than replace the route-specific name.

Routed HTTP handler envelope types SHALL live in `@run402/functions`, not the SDK root, because those types are consumed inside deployed functions rather than by external deploy clients.

#### Scenario: Agent imports namespace result and option types from root

- **WHEN** a TypeScript consumer imports public namespace types such as blob, email, billing, auth, contracts, function, project, deploy, and CI option/result types from `@run402/sdk`
- **THEN** the import SHALL compile without using deep package paths

#### Scenario: New namespace type is added

- **WHEN** a public SDK method signature is changed to reference a new exported interface or type alias
- **THEN** the package root export contract SHALL require that type to be importable from `@run402/sdk`

#### Scenario: Route types are exported from root

- **WHEN** a TypeScript consumer imports `RouteHttpMethod`, `ROUTE_HTTP_METHODS`, `FunctionRouteTarget`, `RouteTarget`, `RouteSpec`, `ReleaseRoutesSpec`, `RouteEntry`, `MaterializedRoutes`, `RoutesDiff`, or `RouteChangeEntry` from `@run402/sdk`
- **THEN** the imports SHALL compile without using deep package paths

### Requirement: Node Entrypoint Type Parity

The Node SDK entrypoint SHALL re-export the complete isomorphic public type surface and SHALL additionally export Node-only public helper types.

Route-related deploy types exported from `@run402/sdk` SHALL also be exported from `@run402/sdk/node`.

#### Scenario: Agent uses only the Node entrypoint

- **WHEN** a TypeScript consumer imports isomorphic public SDK types plus `NodeRun402Options`, `NodeRun402`, `DeployDirOptions`, `FileSetFromDirOptions`, or `SignCiDelegationOptions` from `@run402/sdk/node`
- **THEN** the imports SHALL compile without also importing from `@run402/sdk`

#### Scenario: Agent imports route types from Node entrypoint

- **WHEN** a TypeScript consumer imports `RouteHttpMethod`, `ROUTE_HTTP_METHODS`, `FunctionRouteTarget`, `RouteTarget`, `RouteSpec`, `ReleaseRoutesSpec`, `RouteEntry`, `MaterializedRoutes`, `RoutesDiff`, or `RouteChangeEntry` from `@run402/sdk/node`
- **THEN** the imports SHALL compile without also importing from `@run402/sdk`

### Requirement: Type Export Drift Guard

The SDK test suite SHALL include a mechanical contract that fails when public namespace method types are not exportable from package entrypoints.

The drift guard SHALL include route-related deploy types when web routes are added to public method signatures or return types.

#### Scenario: Missing root export

- **WHEN** a public namespace type is present in source declarations but omitted from `sdk/src/index.ts`
- **THEN** the type export contract test SHALL fail in CI

#### Scenario: Missing Node re-export

- **WHEN** a public isomorphic type is exported from `@run402/sdk` but omitted from `@run402/sdk/node`
- **THEN** the type export contract test SHALL fail in CI

#### Scenario: Missing route export

- **WHEN** `ReleaseRoutesSpec`, `RouteSpec`, or route inventory/diff types are referenced by public deploy types but omitted from a package entrypoint
- **THEN** the public type export test SHALL fail

### Requirement: Agent References Stay Aligned

Agent-facing SDK documentation examples SHALL continue to compile against the package entrypoints, and reference tables SHOULD be derived from or checked against the same public type surface when practical.

Route examples in SDK documentation SHALL import only from package entrypoints and SHALL use the concrete `{ replace: RouteSpec[] }` shape.

#### Scenario: Documentation uses a public type

- **WHEN** a TypeScript fenced SDK documentation snippet imports or references a public SDK type
- **THEN** the existing documentation snippet check SHALL compile it against the package entrypoints

#### Scenario: Documentation uses route types

- **WHEN** SDK documentation includes a TypeScript example for route manifests or route inventory
- **THEN** the example SHALL compile using imports from `@run402/sdk` or `@run402/sdk/node`
- **AND** it SHALL NOT import from deep source paths

### Requirement: Interface-Parity SDK Types Are Exported

Any SDK method added or widened so CLI and MCP no longer need direct Run402 gateway calls SHALL expose its public option and result types from both `@run402/sdk` and `@run402/sdk/node`.

#### Scenario: Blob upload session types are exported
- **WHEN** low-level blob upload session methods are added for resumable CLI upload support
- **THEN** their input, part, status, and completion result types SHALL be importable from `@run402/sdk`
- **AND** the same types SHALL be importable from `@run402/sdk/node`

#### Scenario: Generic billing identifier types are exported
- **WHEN** SDK billing reads accept either wallet or email identifiers
- **THEN** the identifier, balance, history, and option/result types SHALL be importable from package entrypoints

#### Scenario: Interface refactor uses public package paths
- **WHEN** CLI, MCP, docs, or tests refer to new SDK types
- **THEN** they SHALL import from `@run402/sdk`, `@run402/sdk/node`, or existing local SDK build entrypoints
- **AND** they SHALL NOT import from deep namespace source paths
