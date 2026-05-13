# sdk-public-type-surface Specification

## Purpose
TBD - created by archiving change harden-sdk-public-contracts. Update Purpose after archive.
## Requirements
### Requirement: Complete Root Type Exports

The SDK package root SHALL export every TypeScript type that appears in public SDK namespace method signatures, constructor options, return values, event payloads, or helper APIs.

Route-related deploy types SHALL be included in this contract. At minimum, the root entrypoint SHALL export `RouteHttpMethod`, `ROUTE_HTTP_METHODS`, `RouteTarget`, `FunctionRouteTarget`, `StaticRouteTarget`, `RouteSpec`, `ReleaseRoutesSpec`, `RouteEntry`, `MaterializedRoutes`, `RoutesDiff`, and `RouteChangeEntry`.

Stable static asset identity deploy types SHALL be included in this contract. At minimum, the root entrypoint SHALL export `StaticCacheClass`, `KnownStaticCacheClass`, `StaticManifestMetadata`, `StaticAssetsDiff`, `DeployResolveOptions`, `ScopedDeployResolveOptions`, `DeployResolveResponse`, `DeployResolveRouteMatch`, `DeployResolveMethod`, `DeployResolveMatch`, `KnownDeployResolveMatch`, `DeployResolveFallbackState`, `KnownDeployResolveFallbackState`, `KnownDeployResolveResult`, `NormalizedDeployResolveRequest`, `DeployResolveSummary`, `DeployResolveWarning`, and `DeployResolveNextStep`.

Static public path authoring and observability types SHALL be included in this contract. At minimum, the root entrypoint SHALL export `PublicStaticPathSpec`, `SitePublicPathsSpec`, `StaticReachabilityAuthority`, and `StaticPublicPathInventoryEntry`.

`ReleaseRoutesSpec`, `StaticRouteTarget`, `StaticManifestMetadata`, `StaticAssetsDiff`, and `DeployResolveResponse` SHALL NOT be buried under deep deploy paths. If compatibility aliases are kept, they SHALL alias the deploy-specific names rather than replace them. `StaticCacheClassSource` SHALL NOT be required as a public export unless the implementation needs an opaque alias for `cache_class_sources` keys; docs SHALL NOT require agents to interpret cache-class source keys as a closed vocabulary.

The root entrypoint SHALL also export any public deploy resolve helper functions, including static-hit and route-hit type guards and the deterministic summary helper when added. If static manifest metadata remains nullable, the root entrypoint MAY export `EMPTY_STATIC_MANIFEST_METADATA` and `normalizeStaticManifestMetadata(...)`.

Routed HTTP handler envelope types SHALL live in `@run402/functions`, not the SDK root, because those types are consumed inside deployed functions rather than by external deploy clients.

#### Scenario: Agent imports deploy resolve types from root

- **WHEN** a TypeScript consumer imports `DeployResolveOptions`, `DeployResolveResponse`, `DeployResolveRouteMatch`, `DeployResolveSummary`, `DeployResolveWarning`, `DeployResolveNextStep`, `DeployResolveMatch`, `KnownDeployResolveMatch`, `DeployResolveFallbackState`, and `KnownDeployResolveResult` from `@run402/sdk`
- **THEN** the imports SHALL compile without using deep package paths

#### Scenario: Agent imports static asset types from root

- **WHEN** a TypeScript consumer imports `StaticRouteTarget`, `StaticManifestMetadata`, and `StaticAssetsDiff` from `@run402/sdk`
- **THEN** the imports SHALL compile without using deep package paths

#### Scenario: Static route target is part of public route union

- **WHEN** a TypeScript consumer narrows `RouteTarget` on `target.type === "static"`
- **THEN** TypeScript SHALL expose `target.file`
- **AND** the consumer SHALL NOT need a private deep import or local duplicate type

### Requirement: Node Entrypoint Type Parity

The Node SDK entrypoint SHALL re-export the complete isomorphic public type surface and SHALL additionally export Node-only public helper types.

Route-related deploy types, stable static asset identity types, and deploy resolve helpers exported from `@run402/sdk` SHALL also be exported from `@run402/sdk/node`.

#### Scenario: Agent imports deploy resolve types from Node entrypoint

- **WHEN** a TypeScript consumer imports `DeployResolveOptions`, `ScopedDeployResolveOptions`, `DeployResolveResponse`, `DeployResolveRouteMatch`, `DeployResolveSummary`, `StaticManifestMetadata`, or `StaticAssetsDiff` from `@run402/sdk/node`
- **THEN** the imports SHALL compile without also importing from `@run402/sdk`

#### Scenario: Agent imports static route types from Node entrypoint

- **WHEN** a TypeScript consumer imports `StaticRouteTarget` and `RouteTarget` from `@run402/sdk/node`
- **THEN** the imports SHALL compile without also importing from `@run402/sdk`

### Requirement: Type Export Drift Guard

The SDK test suite SHALL include a mechanical contract that fails when public namespace method types are not exportable from package entrypoints.

The drift guard SHALL include route-related deploy types, public URL diagnostics types, deploy resolve helpers, static manifest metadata types, and static asset diff types.

#### Scenario: Missing root export

- **WHEN** `Deploy.resolve` references `DeployResolveResponse` but `sdk/src/index.ts` omits it from root exports
- **THEN** the type export contract test SHALL fail in CI

#### Scenario: Missing Node re-export

- **WHEN** an isomorphic deploy type is exported from `@run402/sdk` but omitted from `@run402/sdk/node`
- **THEN** the type export contract test SHALL fail in CI

#### Scenario: Missing static asset export

- **WHEN** `ReleaseInventory`, `PlanResponse`, or `ReleaseToReleaseDiff` reference `StaticManifestMetadata` or `StaticAssetsDiff`
- **THEN** the public type export test SHALL require those types to be importable from package entrypoints

### Requirement: Agent References Stay Aligned

Agent-facing SDK documentation examples SHALL continue to compile against the package entrypoints, and reference tables SHOULD be derived from or checked against the same public type surface when practical.

Route examples in SDK documentation SHALL import only from package entrypoints and SHALL use the concrete `{ replace: RouteSpec[] }` shape. Public URL diagnostic examples SHALL import only from package entrypoints and SHALL lead with the URL-first `r.deploy.resolve({ project, url, method? })` shape.

#### Scenario: Documentation uses deploy resolve

- **WHEN** SDK documentation includes a TypeScript example for `r.deploy.resolve`
- **THEN** the example SHALL compile using imports from `@run402/sdk` or `@run402/sdk/node`
- **AND** it SHALL NOT import from deep source paths

#### Scenario: Documentation uses static route aliases

- **WHEN** SDK documentation includes a TypeScript example for static route aliases
- **THEN** the example SHALL compile using `StaticRouteTarget`, `RouteSpec`, or `ReleaseRoutesSpec` from `@run402/sdk` or `@run402/sdk/node`
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

### Requirement: SDK public exports include static public path types

The SDK package root SHALL export every public type introduced for static public path authoring, inventory, and diagnostics. The Node entrypoint SHALL re-export the same type surface.

At minimum, public exports SHALL include `PublicStaticPathSpec`, `SitePublicPathsSpec`, `StaticReachabilityAuthority`, and `StaticPublicPathInventoryEntry`. If implementation-specific normalized public path types appear in public method signatures or return values, those types SHALL also be exported from both entrypoints.

The drift guard SHALL include these types so future public deploy-contract additions do not require deep imports from `sdk/src/namespaces`.

#### Scenario: Agent imports public path authoring types from root

- **WHEN** a TypeScript consumer imports `SitePublicPathsSpec` and `PublicStaticPathSpec` from `@run402/sdk`
- **THEN** the imports SHALL compile without using deep package paths
- **AND** the same imports SHALL compile from `@run402/sdk/node`

#### Scenario: Agent imports static public path inventory types from root

- **WHEN** a TypeScript consumer imports `StaticPublicPathInventoryEntry` and `StaticReachabilityAuthority` from `@run402/sdk`
- **THEN** the imports SHALL compile without using deep package paths
- **AND** the same imports SHALL compile from `@run402/sdk/node`

#### Scenario: Type drift guard covers public path exports

- **WHEN** a public path type appears in a public deploy method signature or return shape
- **THEN** the SDK public type export tests SHALL fail if `sdk/src/index.ts` or `sdk/src/node/index.ts` stops exporting it
