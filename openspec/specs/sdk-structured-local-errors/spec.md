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
