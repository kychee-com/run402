## ADDED Requirements

### Requirement: Deploy secret declarations are value-free

The public deploy contract SHALL represent secrets only as declared dependencies and declared deletions. `ReleaseSpec.secrets` SHALL accept `require?: string[]` and `delete?: string[]`; it SHALL NOT accept value-bearing `set` or `replace_all` fields in SDK types, CLI/MCP examples, or agent documentation.

#### Scenario: Deploy spec requires existing secrets

- **WHEN** a caller builds a deploy spec with `secrets.require: ["OPENAI_API_KEY"]`
- **THEN** the SDK, CLI, and MCP deploy surfaces SHALL accept the declaration without requiring or carrying the secret value

#### Scenario: Deploy spec deletes secrets

- **WHEN** a caller builds a deploy spec with `secrets.delete: ["OLD_API_KEY"]`
- **THEN** the SDK, CLI, and MCP deploy surfaces SHALL forward the key-only delete declaration to the gateway

#### Scenario: Old value-bearing deploy shape is rejected

- **WHEN** a caller provides `secrets.set` or `secrets.replace_all` to the SDK deploy primitive
- **THEN** the SDK SHALL fail before content upload or plan creation with a structured `INVALID_SPEC` deploy error that names the rejected field

### Requirement: Secret values are written out-of-band

The public client surfaces SHALL teach and support the workflow where secret values are written through the secrets namespace before a deploy spec declares those keys in `secrets.require`.

#### Scenario: Agent sets a secret before requiring it

- **WHEN** an agent needs `OPENAI_API_KEY` for a function deploy
- **THEN** the docs and tools SHALL direct the agent to call `set_secret`, `run402 secrets set`, or `r.secrets.set` before deploying with `secrets.require: ["OPENAI_API_KEY"]`

#### Scenario: Compatibility shim receives legacy secret values

- **WHEN** a legacy compatibility surface receives secret values from an older bundle-deploy shape
- **THEN** it SHALL NOT place those values in `ReleaseSpec`; it SHALL either pre-set them through the secrets API and require the keys, or fail with an actionable error telling the agent to set secrets first

### Requirement: Secret listing is key-only

The public secret-listing contract SHALL NOT expose or document `value_hash` or any other value-derived verification signal. SDK types, CLI output, MCP output, and docs SHALL treat secret values as write-only.

#### Scenario: SDK lists secrets

- **WHEN** `r.secrets.list(projectId)` resolves
- **THEN** the typed secret summaries SHALL include the secret key and non-sensitive metadata only, with no `value_hash` property

#### Scenario: MCP formats listed secrets

- **WHEN** the `list_secrets` MCP tool returns one or more secrets
- **THEN** the markdown table SHALL NOT contain a hash column or text instructing agents to verify values by hash

### Requirement: Deploy warnings are structured

The SDK SHALL define and export `WarningEntry`, and deploy plan/apply surfaces SHALL preserve gateway warnings as structured arrays suitable for coding-agent branching.

#### Scenario: Plan response includes missing required secret warning

- **WHEN** the gateway returns a plan response with `warnings` containing `code: "MISSING_REQUIRED_SECRET"`
- **THEN** the SDK `PlanResponse` type SHALL expose the warning with `severity`, `message`, `affected`, `requires_confirmation`, and `details`

#### Scenario: Apply caller receives plan warnings

- **WHEN** `r.deploy.apply(spec)` observes non-empty plan warnings
- **THEN** the SDK SHALL surface those warnings in deploy progress events and in the final `DeployResult` when the deploy reaches ready

#### Scenario: CLI and MCP display warning codes

- **WHEN** deploy warnings are present
- **THEN** CLI and MCP deploy outputs SHALL include the warning `code`, `message`, and affected keys so agents can decide the next action

### Requirement: Agent-facing docs describe the new contract

Every public agent-facing documentation surface that mentions deploy secrets SHALL describe value-free deploy declarations and out-of-band secret setting, and SHALL avoid examples that place secret values in manifests.

#### Scenario: Documentation scan for removed fields

- **WHEN** the repository's docs and skill files are checked after this change
- **THEN** agent-facing docs SHALL NOT present `secrets.set`, `secrets.replace_all`, or `value_hash` as supported deploy/listing behavior

#### Scenario: Documentation links related agent DX follow-ups

- **WHEN** implementation notes mention related public issues
- **THEN** they SHALL identify #151 as the local manifest-validation follow-up and #198 as prior deploy-help drift context
