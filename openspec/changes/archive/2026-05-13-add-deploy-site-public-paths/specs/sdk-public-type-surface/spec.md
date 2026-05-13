## ADDED Requirements

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
