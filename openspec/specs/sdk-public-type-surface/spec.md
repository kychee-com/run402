# sdk-public-type-surface Specification

## Purpose
TBD - created by archiving change harden-sdk-public-contracts. Update Purpose after archive.
## Requirements
### Requirement: Complete Root Type Exports
The SDK package root SHALL export every TypeScript type that appears in public SDK namespace method signatures, constructor options, return values, event payloads, or helper APIs.

#### Scenario: Agent imports namespace result and option types from root
- **WHEN** a TypeScript consumer imports public namespace types such as blob, email, billing, auth, contracts, function, project, deploy, and CI option/result types from `@run402/sdk`
- **THEN** the import SHALL compile without using deep package paths

#### Scenario: New namespace type is added
- **WHEN** a public SDK method signature is changed to reference a new exported interface or type alias
- **THEN** the package root export contract SHALL require that type to be importable from `@run402/sdk`

### Requirement: Node Entrypoint Type Parity
The Node SDK entrypoint SHALL re-export the complete isomorphic public type surface and SHALL additionally export Node-only public helper types.

#### Scenario: Agent uses only the Node entrypoint
- **WHEN** a TypeScript consumer imports isomorphic public SDK types plus `NodeRun402Options`, `NodeRun402`, `DeployDirOptions`, `FileSetFromDirOptions`, or `SignCiDelegationOptions` from `@run402/sdk/node`
- **THEN** the imports SHALL compile without also importing from `@run402/sdk`

### Requirement: Type Export Drift Guard
The SDK test suite SHALL include a mechanical contract that fails when public namespace method types are not exportable from package entrypoints.

#### Scenario: Missing root export
- **WHEN** a public namespace type is present in source declarations but omitted from `sdk/src/index.ts`
- **THEN** the type export contract test SHALL fail in CI

#### Scenario: Missing Node re-export
- **WHEN** a public isomorphic type is exported from `@run402/sdk` but omitted from `@run402/sdk/node`
- **THEN** the type export contract test SHALL fail in CI

### Requirement: Agent References Stay Aligned
Agent-facing SDK documentation examples SHALL continue to compile against the package entrypoints, and reference tables SHOULD be derived from or checked against the same public type surface when practical.

#### Scenario: Documentation uses a public type
- **WHEN** a TypeScript fenced SDK documentation snippet imports or references a public SDK type
- **THEN** the existing documentation snippet check SHALL compile it against the package entrypoints
