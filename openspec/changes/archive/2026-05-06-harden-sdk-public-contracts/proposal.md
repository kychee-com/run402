## Why

Coding agents consume the SDK by reading and compiling against its published contract, but the current public surface is easier to use than it is to mechanically trust. Public method signatures reference types that are not exported from the package root, and several local validation failures still throw plain `Error` despite the documented `Run402Error` contract.

## What Changes

- Export every public SDK option, input, result, event, and helper type used by namespace method signatures from both `@run402/sdk` and `@run402/sdk/node`.
- Add contract tests or generated assertions that fail when a new public namespace type is introduced without a root export.
- Convert SDK-originated local validation and provider-capability failures from plain `Error` to structured `Run402Error` subclasses, usually `LocalError`.
- Add regression tests that fail when public SDK code introduces a new plain `throw new Error(...)` path except for explicitly documented internal-only helpers.
- Preserve existing runtime behavior and method signatures except for error class shape becoming more structured.

## Capabilities

### New Capabilities
- `sdk-public-type-surface`: The package root and Node entrypoint expose the complete public TypeScript type contract needed by coding agents.
- `sdk-structured-local-errors`: Public SDK operations throw structured `Run402Error` subclasses for SDK-originated local failures.

### Modified Capabilities

None.

## Impact

- Affected package entrypoints: `sdk/src/index.ts`, `sdk/src/node/index.ts`, generated declarations under `sdk/dist`.
- Affected namespaces: all SDK namespaces with public input/result types, with special attention to `allowance`, `blobs`, `billing`, `email`, and `projects` local validation paths.
- Affected tests and CI: public type export contract tests, local error contract tests, and existing doc snippet checks.
- No new runtime dependencies are expected.
