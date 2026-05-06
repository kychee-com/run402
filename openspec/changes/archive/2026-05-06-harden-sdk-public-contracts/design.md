## Context

The SDK is the canonical code-facing surface for Run402. It is intentionally agent-friendly in several places already: `Run402Error` has structural guards and `toJSON()`, `ScopedRun402` removes repeated project-id threading, and the documentation is type-checked through `sdk/scripts/check-doc-snippets.ts`.

Two contract gaps remain. First, many namespace option/result types are exported from their source modules but not from the package root entrypoints, even though public method signatures expose them through declarations. Second, public SDK methods still contain plain `throw new Error(...)` local validation paths, which contradicts the documented “all failures throw `Run402Error`” model that agents use for branching and serialization.

## Goals / Non-Goals

**Goals:**

- Make `@run402/sdk` and `@run402/sdk/node` sufficient import targets for all public SDK types an agent needs.
- Preserve the current method names, argument shapes, and runtime behavior while improving type and error accessibility.
- Ensure future namespace additions fail CI if their public types are not exported.
- Ensure future local validation/provider-capability failures fail CI if they use plain `Error` instead of a `Run402Error` subclass.

**Non-Goals:**

- Do not redesign namespace APIs or change snake_case gateway result fields.
- Do not remove backwards-compatible aliases.
- Do not introduce new runtime dependencies.
- Do not change gateway error envelopes or HTTP behavior.

## Decisions

### Export complete namespace type barrels from the public entrypoints

The package root will re-export public types from namespace modules, including option and result interfaces from `projects`, `blobs`, `functions`, `secrets`, `subdomains`, `domains`, `sites`, `service`, `tier`, `allowance`, `ai`, `auth`, `sender-domain`, `billing`, `apps`, `email`, `contracts`, `admin`, `deploy`, and `ci`.

The Node entrypoint will continue to re-export the isomorphic surface plus Node-only helper types (`NodeRun402Options`, `NodeRun402`, `DeployDirOptions`, `FileSetFromDirOptions`, `SignCiDelegationOptions`). Agents should not need deep imports such as `@run402/sdk/dist/namespaces/...`.

Alternative considered: export only a smaller blessed subset. That keeps the root file shorter but leaves agents guessing which public signatures are safe to name. Complete exports are noisier but more robust.

### Add a public type contract that compiles against package entrypoints

The implementation will add or extend a type-level contract test that imports representative public namespace types from `@run402/sdk` and `@run402/sdk/node`. Prefer a generated or mechanically discoverable check if practical; otherwise keep an explicit exhaustive import list close to the root export list and make it part of `npm test`.

Alternative considered: rely on documentation snippets. Snippets catch examples, not the full type surface, so they are not enough for this contract.

### Convert SDK local failures to `Run402Error` subclasses

Public SDK methods will throw `LocalError` for SDK-originated validation and provider-capability failures, unless a more specific existing `Run402Error` subclass already applies (`ProjectNotFound`, `Run402DeployError`, `ApiError`, etc.). Existing local messages should remain recognizable, but the thrown object must carry `kind`, `context`, `code`, and `toJSON()`.

Internal-only helper failures may remain plain errors only when they cannot escape through a public SDK operation and are explicitly allowlisted in the regression test.

Alternative considered: wrap plain errors at the kernel boundary. That misses synchronous validation before requests and loses precise contexts. Throwing structured errors at the source is clearer for agents.

### Add a no-plain-public-error guard

The implementation will add a test or script that scans public SDK source for `throw new Error(...)` and fails unless the occurrence is on a narrow, documented allowlist. The allowlist should include a justification and should not cover namespace public methods.

Alternative considered: rely on reviewer discipline. This is exactly the kind of small regression agents and humans both miss; a guard is cheap and useful.

## Risks / Trade-offs

- **Risk: Root exports become long and manually maintained** -> Mitigation: keep exports grouped by namespace and back them with a contract test that fails on drift.
- **Risk: Existing consumers catch `Error` and inspect `message` only** -> Mitigation: `Run402Error` still extends `Error`; preserve message text where practical.
- **Risk: The plain-error scan catches private/internal implementation details** -> Mitigation: use a narrow allowlist with comments and require public namespace methods to use `Run402Error`.
- **Risk: A generated type-surface check is overbuilt** -> Mitigation: start with an exhaustive import/assignability test if generation is not straightforward; the requirement is mechanical enforcement, not a specific mechanism.

## Migration Plan

1. Add missing public type exports to `sdk/src/index.ts`.
2. Mirror the exported type surface through `sdk/src/node/index.ts`.
3. Convert plain local validation/provider errors in public SDK namespaces to `LocalError`.
4. Add type export and no-plain-error contract tests to the normal SDK/repo test path.
5. Run SDK doc snippet checks and the repo test target that covers SDK units.

Rollback is straightforward: revert the export and error conversion patch. Since `LocalError` extends `Error`, behavioral rollback should only be needed if a consumer unexpectedly depends on exact constructor identity of plain errors.

## Open Questions

None.
