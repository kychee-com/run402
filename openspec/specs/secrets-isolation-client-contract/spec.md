# secrets-isolation-client-contract Specification

## Purpose
TBD - created by archiving change add-secrets-isolation. Update Purpose after archive.
## Requirements
### Requirement: Deploy secret declarations are value-free

The public deploy contract SHALL represent secrets only as declared dependencies and declared deletions. `ReleaseSpec.secrets` SHALL accept `require?: string[]` and `delete?: string[]`; it SHALL NOT accept value-bearing `set` or `replace_all` fields in SDK types, CLI/MCP examples, or agent documentation.

#### Scenario: Deploy spec requires existing secrets

- **WHEN** a caller builds a deploy spec with `secrets.require: ["OPENAI_API_KEY"]`
- **THEN** the SDK, CLI, and MCP deploy surfaces SHALL accept the declaration without requiring or carrying the secret value

#### Scenario: Deploy spec deletes secrets

- **WHEN** a caller builds a deploy spec with `secrets.delete: ["OLD_API_KEY"]`
- **THEN** the SDK, CLI, and MCP deploy surfaces SHALL forward the key-only delete declaration to the gateway

#### Scenario: Require is dependency gate only

- **WHEN** docs describe `secrets.require[]`
- **THEN** they SHALL state that it asserts key existence before activation and does not carry values or define a per-function injection allowlist

#### Scenario: Old value-bearing deploy shape is rejected

- **WHEN** a caller provides `secrets.set` or `secrets.replace_all` to the SDK deploy primitive
- **THEN** the SDK SHALL fail before content upload or plan creation with a structured `INVALID_SPEC` deploy error that names the rejected field

#### Scenario: Secret key conflict is rejected

- **WHEN** the same key appears in both `secrets.require` and `secrets.delete`
- **THEN** the SDK SHALL reject the spec before upload or plan creation with a structured validation error

### Requirement: Secret values are written out-of-band

The public client surfaces SHALL teach and support the workflow where secret values are written through the secrets namespace before a deploy spec declares those keys in `secrets.require`.

#### Scenario: Agent sets a secret before requiring it

- **WHEN** an agent needs `OPENAI_API_KEY` for a function deploy
- **THEN** the docs and tools SHALL direct the agent to call `set_secret`, `run402 secrets set`, or `r.secrets.set` before deploying with `secrets.require: ["OPENAI_API_KEY"]`

#### Scenario: SDK uses shipped set-secret route

- **WHEN** `r.secrets.set(projectId, key, value)` is called
- **THEN** the SDK SHALL send `POST /projects/v1/admin/{projectId}/secrets/{key}` with body `{ value }`

#### Scenario: Compatibility shim receives legacy in-memory secret values

- **WHEN** `apps.bundleDeploy` receives legacy in-memory secret values
- **THEN** it SHALL pre-set those values through the secrets API and pass only `secrets.require` keys to `deploy.apply`

#### Scenario: CLI manifest contains secret values

- **WHEN** a CLI file or inline manifest contains legacy secret values under deploy secrets
- **THEN** the CLI SHALL fail with migration guidance instead of silently pre-setting values

#### Scenario: Legacy replace-all is rejected

- **WHEN** a compatibility surface receives `secrets.replace_all`
- **THEN** it SHALL fail with guidance that exact secret replacement is no longer representable in deploy specs

### Requirement: Secret listing is key-only

The public secret-listing contract SHALL NOT expose or document `value_hash` or any other value-derived verification signal. SDK types, CLI output, MCP output, and docs SHALL treat secret values as write-only.

#### Scenario: SDK lists secrets from new gateway shape

- **WHEN** `r.secrets.list(projectId)` receives an array of `{ key, created_at, updated_at }`
- **THEN** it SHALL return `{ secrets: [...] }` with key/timestamp metadata only

#### Scenario: SDK tolerates legacy list envelope

- **WHEN** `r.secrets.list(projectId)` receives a legacy `{ secrets: [...] }` envelope that includes `value_hash`
- **THEN** it SHALL normalize to `{ secrets: [...] }` and strip `value_hash` from every item

#### Scenario: MCP formats listed secrets

- **WHEN** the `list_secrets` MCP tool returns one or more secrets
- **THEN** the markdown table SHALL NOT contain a hash column or text instructing agents to verify values by hash

### Requirement: Deploy warnings are structured and actionable

The SDK SHALL define and export the gateway-exact `WarningEntry`, and deploy plan/apply surfaces SHALL preserve gateway warnings as structured arrays suitable for coding-agent branching.

#### Scenario: Plan response includes missing required secret warning

- **WHEN** the gateway returns a plan response with `warnings` containing `code: "MISSING_REQUIRED_SECRET"`
- **THEN** the SDK `PlanResponse` type SHALL expose the warning with gateway-exact `severity`, `requires_confirmation`, `message`, optional `affected`, optional `details`, and optional `confidence`

#### Scenario: Apply surfaces warnings before commit

- **WHEN** `r.deploy.apply(spec)` observes non-empty plan warnings
- **THEN** the SDK SHALL emit a `plan.warnings` event before content upload or commit

#### Scenario: Apply aborts on confirmation-required warning

- **WHEN** `r.deploy.apply(spec)` observes a warning with `requires_confirmation: true`
- **THEN** the SDK SHALL abort before content upload or commit unless the caller explicitly opts in to continuing

#### Scenario: Apply result carries warnings

- **WHEN** `r.deploy.apply(spec)` reaches ready after a plan with warnings that did not require confirmation or were explicitly allowed
- **THEN** `DeployResult.warnings` SHALL contain those plan warnings

#### Scenario: CLI and MCP display warning codes

- **WHEN** deploy warnings are present
- **THEN** CLI and MCP deploy outputs SHALL include the warning `code`, `message`, and affected keys so agents can decide the next action

### Requirement: CI deploys do not accept secret declarations

CI-session deploys SHALL continue to reject any `spec.secrets` field, including value-free `require` and `delete`, because CI credentials do not have secret-write or secret-existence authority in this release.

#### Scenario: CI deploy includes require keys

- **WHEN** a GitHub Actions OIDC deploy manifest includes `secrets.require`
- **THEN** the SDK/CLI CI preflight SHALL reject it before upload or plan creation with a message explaining that CI deploy manifests must omit secrets

#### Scenario: CI deploy includes legacy secret values

- **WHEN** a GitHub Actions OIDC deploy manifest includes `secrets.set`
- **THEN** the SDK/CLI SHALL explain that secret values do not belong in deploy manifests rather than only returning a generic CI-forbidden-secrets error

### Requirement: Agent-facing docs describe the new contract

Every public agent-facing documentation surface that mentions deploy secrets SHALL describe value-free deploy declarations and out-of-band secret setting, and SHALL avoid examples that place secret values in manifests.

#### Scenario: Documentation scan for removed fields

- **WHEN** the repository's docs and skill files are checked after this change
- **THEN** agent-facing docs SHALL NOT present deploy-manifest `secrets.set`, `secrets.replace_all`, or `value_hash` as supported behavior

#### Scenario: Documentation allows correct set-secret APIs

- **WHEN** drift checks scan agent-facing docs
- **THEN** they SHALL allow correct APIs such as `r.secrets.set`, `run402 secrets set`, and MCP `set_secret`

#### Scenario: Documentation links related agent DX follow-ups

- **WHEN** implementation notes mention related public issues
- **THEN** they SHALL identify #151 as the local manifest-validation follow-up and #198 as prior deploy-help drift context
