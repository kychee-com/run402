## ADDED Requirements

### Requirement: Static Activation Failures Surface Immediately

`r.deploy.apply()` and `r.deploy.resume()` SHALL stop polling promptly when an operation snapshot indicates an activation failure that cannot be repaired by waiting or automatic retry.

For `activation_pending` snapshots, the SDK SHALL inspect structured error metadata. If the error is marked non-recoverable, marked unsafe to retry, or has a known static spec/config violation code, the SDK SHALL throw a `Run402DeployError` immediately with the operation id, plan id, phase, resource, retryability, safe-to-retry metadata, and gateway body preserved.

The SDK SHALL NOT emit `deploy.retry` for static activation failures unless they satisfy the existing deploy-safe-retry allowlist. The SDK SHALL continue polling `activation_pending` only when the snapshot lacks terminal error metadata or explicitly indicates a recoverable platform retry.

#### Scenario: Tier-ineligible function activation failure throws immediately

- **WHEN** an operation snapshot has `status: "activation_pending"` and an error for `FUNCTION_ACTIVATE_FAILED` caused by tier-ineligible function configuration
- **THEN** `r.deploy.apply()` SHALL throw a `Run402DeployError` without waiting until the poll timeout
- **AND** the thrown error SHALL preserve `operation_id`, `phase: "activate"`, `resource`, and gateway error details

#### Scenario: Recoverable activation pending still polls

- **WHEN** an operation snapshot has `status: "activation_pending"` but no terminal error metadata and the gateway indicates activation may retry
- **THEN** the SDK SHALL continue the existing bounded polling behavior
- **AND** timeout behavior SHALL remain governed by the deploy poll timeout

#### Scenario: Static activation failure is not safe-race retried

- **WHEN** an activation failure has `retryable: true` but is not in the deploy safe-retry allowlist and is not `safe_to_retry: true` for an auto-rebasable base race
- **THEN** `r.deploy.apply()` SHALL throw the error
- **AND** it SHALL NOT re-plan or re-commit the same release spec automatically

