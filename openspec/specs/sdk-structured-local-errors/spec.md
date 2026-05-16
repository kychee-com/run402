# sdk-structured-local-errors Specification

## Purpose
TBD - created by archiving change harden-sdk-public-contracts. Update Purpose after archive.
## Requirements
### Requirement: Public Local Failures Use Run402Error
Public SDK operations SHALL throw a `Run402Error` subclass for SDK-originated local failures, including argument validation failures, unsupported credential-provider capability failures, local filesystem failures, and local byte-source normalization failures.

#### Scenario: Local validation fails before a request
- **WHEN** a public SDK method rejects invalid caller input before issuing a network request
- **THEN** the thrown error SHALL satisfy `isRun402Error(error) === true`
- **AND** the error SHALL expose a stable `kind`, `code`, `message`, and `context`

#### Scenario: Credential provider lacks an optional capability
- **WHEN** a public SDK method requires an optional `CredentialsProvider` method that is not implemented
- **THEN** the thrown error SHALL be a structured `Run402Error` subclass, normally `LocalError`

### Requirement: Error Serialization Remains Agent-Readable
Structured local SDK failures SHALL serialize through `JSON.stringify(error)` with useful diagnostic fields.

#### Scenario: Agent serializes a local error
- **WHEN** an agent catches and JSON stringifies a local SDK failure
- **THEN** the serialized object SHALL include `name`, `kind`, `message`, `status`, `code`, and `context`
- **AND** `status` SHALL be `null` for failures that did not receive an HTTP response

### Requirement: Plain Error Drift Guard
The SDK test suite SHALL include a regression guard that fails on new public SDK `throw new Error(...)` paths unless each occurrence is explicitly allowlisted as internal-only with a justification.

#### Scenario: New plain Error in public namespace code
- **WHEN** a public SDK namespace method introduces `throw new Error(...)`
- **THEN** the regression guard SHALL fail in CI

#### Scenario: Internal-only helper remains plain
- **WHEN** an internal-only helper keeps a plain `Error` that cannot escape as a public SDK operation failure
- **THEN** the regression guard SHALL allow it only through a narrow allowlist with an explanation

### Requirement: Existing Error Guards Continue To Work
The existing identity-free error guards SHALL continue to narrow structured local and remote failures across duplicate SDK copies and runtime realms.

#### Scenario: Agent branches on caught local failure
- **WHEN** an agent catches a structured local SDK failure and calls `isLocalError(error)` or switches on `error.kind`
- **THEN** the branch SHALL work without using `instanceof`

### Requirement: Deploy Tier Preflight Uses Structured Local Errors

Local deploy preflight failures for tier limits SHALL use structured `Run402Error` failures rather than plain `Error` values or ad hoc CLI-only JSON.

When SDK or CLI deploy preflight rejects a manifest because a function timeout, memory value, schedule interval, or scheduled-function count exceeds the active tier limits, the error SHALL serialize with `kind`, `code`, `message`, `status: null`, and `context`. The `code` SHALL be `BAD_FIELD` unless a more specific structured local code is introduced and documented. The serialized body or details SHALL include the field path, supplied value, tier name, and relevant limit.

#### Scenario: Timeout preflight serializes field details

- **WHEN** a deploy preflight rejects `functions.api.config.timeoutSeconds: 20` for a tier whose max is 10
- **THEN** JSON serialization of the error SHALL include `code: "BAD_FIELD"` and `status: null`
- **AND** it SHALL include details with `field: "functions.api.config.timeoutSeconds"`, `value: 20`, `tier`, and `tier_max: 10`

#### Scenario: Local error maps through CLI reporter

- **WHEN** `run402 deploy apply` receives a structured local tier-preflight error from SDK code
- **THEN** the CLI error reporter SHALL preserve the structured code and details in stderr
- **AND** it SHALL exit before deploy planning or content upload

### Requirement: Tier Limit Source Is Visible In Diagnostics

Structured tier-preflight errors SHALL identify where the limit came from when practical.

The error details SHALL include a limit source such as `tier_status`, `tier_quote`, `local_static_fallback`, or `gateway_error` when available. This allows agents to decide whether to refresh tier state, upgrade the tier, or report a stale-client bug.

#### Scenario: Agent can distinguish stale fallback

- **WHEN** preflight uses a local static fallback because live tier-limit metadata is unavailable
- **THEN** the structured error details SHALL identify `limit_source: "local_static_fallback"`
- **AND** the hint SHALL suggest refreshing tier status or relying on gateway validation if the limit seems stale

