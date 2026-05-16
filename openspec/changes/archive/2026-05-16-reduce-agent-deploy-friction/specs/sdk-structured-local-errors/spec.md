## ADDED Requirements

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

