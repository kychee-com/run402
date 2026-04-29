## ADDED Requirements

### Requirement: SDK preserves and projects canonical error envelopes

The SDK SHALL accept both canonical Run402 error envelopes and legacy/passthrough error bodies. When an HTTP response body is a JSON object containing canonical fields, every thrown `Run402Error` subclass SHALL preserve the parsed body exactly on `error.body` and SHALL expose read-only convenience projections:

- `code` from `body.code`
- `category` from `body.category`
- `retryable` from `body.retryable`
- `safeToRetry` from `body.safe_to_retry`
- `mutationState` from `body.mutation_state`
- `traceId` from `body.trace_id`
- `details` from `body.details`
- `nextActions` from `body.next_actions`

The SDK SHALL NOT require these fields to exist. For legacy-only bodies and passthrough surfaces, these convenience properties SHALL be `undefined` unless the corresponding canonical field is present. The SDK SHALL NOT synthesize a gateway top-level `status` field.

HTTP status SHALL continue to select the existing subclasses (`PaymentRequired`, `Unauthorized`, `ApiError`, etc.); canonical `code` SHALL be used for finer-grained branching.

#### Scenario: Canonical fields are preserved and projected

- **WHEN** the gateway returns HTTP 403 with body `{ "error": "frozen", "message": "Project is frozen.", "code": "PROJECT_FROZEN", "category": "lifecycle", "retryable": false, "safe_to_retry": true, "mutation_state": "none", "trace_id": "trc_123", "details": { "project_id": "prj_1" }, "next_actions": [{ "action": "renew_tier" }] }`
- **THEN** the SDK throws `Unauthorized`
- **AND** `err.body` is exactly the parsed body
- **AND** `err.code === "PROJECT_FROZEN"`
- **AND** `err.category === "lifecycle"`
- **AND** `err.retryable === false`
- **AND** `err.safeToRetry === true`
- **AND** `err.mutationState === "none"`
- **AND** `err.traceId === "trc_123"`
- **AND** `err.details` and `err.nextActions` expose the corresponding body values

#### Scenario: Legacy body still works

- **WHEN** an older gateway returns HTTP 500 with body `{ "error": "internal" }`
- **THEN** the SDK throws `ApiError`
- **AND** `err.body` is `{ "error": "internal" }`
- **AND** `err.code`, `err.traceId`, and `err.nextActions` are `undefined`

#### Scenario: Passthrough body is not forced into the envelope

- **WHEN** a PostgREST-native response returns HTTP 400 with body `{ "message": "relation does not exist", "code": "42P01" }`
- **THEN** the SDK preserves that body exactly
- **AND** downstream formatters may show the PostgREST `code`
- **AND** the SDK does not require Run402-specific `category`, `mutation_state`, or `next_actions`

### Requirement: CLI forwards canonical fields inside its existing error envelope

The CLI SHALL continue to write structured errors to stderr using its existing outer envelope `{ "status": "error", "http": ... }`. When an SDK error contains an object body, the CLI SHALL merge gateway fields into that envelope and then reassert `status: "error"` so a gateway-provided body field cannot overwrite the CLI sentinel.

The CLI SHALL forward canonical fields when present: `code`, `category`, `retryable`, `safe_to_retry`, `mutation_state`, `trace_id`, `details`, and `next_actions`. It SHALL continue forwarding legacy fields used by callers today, including `hint`, `retry_after`, `retry_after_seconds`, `expires_at`, `renew_url`, `usage`, lifecycle fields, `admin_required`, payment fields, deploy fields, and storage fields.

For display fields, the CLI SHALL prefer `message` and fall back to `error`. For non-JSON bodies, existing `body_preview` behavior SHALL remain unchanged.

#### Scenario: Canonical gateway body is forwarded

- **WHEN** an SDK call throws an HTTP-backed `Run402Error` whose body contains `code`, `category`, `safe_to_retry`, `mutation_state`, `trace_id`, `details`, and `next_actions`
- **THEN** the CLI stderr JSON contains those fields
- **AND** it contains `http` with the HTTP status
- **AND** it contains `status: "error"`

#### Scenario: Gateway body status cannot overwrite CLI status

- **WHEN** the gateway body contains `{ "status": "degraded", "message": "Service degraded" }`
- **THEN** the CLI stderr JSON contains `"status": "error"`
- **AND** downstream scripts can continue branching on the CLI sentinel

#### Scenario: Non-JSON body preview is unchanged

- **WHEN** an API call returns HTTP 502 with an HTML response body
- **THEN** the CLI stderr JSON contains `body_preview` with the first 500 characters
- **AND** no JSON parser stack or tokenization error is leaked

### Requirement: MCP formatting prefers canonical envelopes

MCP tool error formatting SHALL prefer canonical envelope fields when present. The returned error text SHALL include the human message, HTTP status when available, stable `code`, compact canonical context (`category`, `retryable`, `safe_to_retry`, `mutation_state`), and `trace_id` when present so users can report it.

MCP formatters SHALL render `next_actions` when useful, especially actions named `authenticate`, `submit_payment`, `renew_tier`, `check_usage`, `retry`, `resume_deploy`, `edit_request`, and `edit_migration`. Rendering a next action SHALL NOT execute it.

For legacy bodies and passthrough errors, MCP formatting SHALL keep existing fallback behavior based on `message`, `error`, HTTP status, `hint`, `retry_after`, `renew_url`, `usage`, lifecycle fields, and existing status-code guidance.

#### Scenario: MCP renders canonical context and trace id

- **WHEN** an MCP tool catches a `Run402Error` with canonical body `{ "message": "Project is frozen.", "code": "PROJECT_FROZEN", "category": "lifecycle", "retryable": false, "safe_to_retry": true, "mutation_state": "none", "trace_id": "trc_abc" }`
- **THEN** the returned text includes `Project is frozen.`
- **AND** it includes `PROJECT_FROZEN`
- **AND** it includes `lifecycle`
- **AND** it includes `Retryable: false`
- **AND** it includes `Safe to retry: true`
- **AND** it includes `Mutation state: none`
- **AND** it includes `trc_abc`

#### Scenario: MCP renders useful next actions

- **WHEN** an MCP tool catches a canonical body whose `next_actions` contains `renew_tier` and `check_usage`
- **THEN** the returned text includes a next-actions section
- **AND** both action names are visible to the agent
- **AND** the formatter does not execute either action

#### Scenario: MCP keeps legacy fallback formatting

- **WHEN** an MCP tool catches an error body `{ "error": "Rate limited", "retry_after": 30 }` without canonical fields
- **THEN** the returned text includes `Rate limited`
- **AND** it includes the retry-after guidance already used by existing tools

### Requirement: Deploy error translation accepts old and canonical shapes

Deploy-specific SDK handling SHALL understand both the legacy deploy error shape and the canonical Run402 envelope.

Legacy deploy fields SHALL remain supported at top level: `code`, `phase`, `resource`, `operation_id`, `plan_id`, `fix`, `logs`, `rolled_back`, and `retryable`.

Canonical fields SHALL also be preserved and projected: `category`, `safe_to_retry`, `mutation_state`, `trace_id`, `details`, and `next_actions`. Deploy-specific context MAY appear in either top-level legacy fields or in canonical `details`; top-level legacy fields SHALL win when both are present, and `details` SHALL fill missing deploy context.

Deploy handling SHALL branch on `code`, not English text. It SHALL recognize at least `MIGRATION_FAILED`, `MIGRATION_CHECKSUM_MISMATCH`, `PLAN_NOT_FOUND`, `OPERATION_NOT_FOUND`, and `MIGRATE_GATE_ACTIVE` from canonical or legacy bodies.

#### Scenario: Commit failure arrives as canonical envelope

- **WHEN** a deploy commit response fails with `{ "message": "Migration failed.", "code": "MIGRATION_FAILED", "category": "deploy", "retryable": false, "safe_to_retry": true, "mutation_state": "rolled_back", "trace_id": "trc_dep", "details": { "phase": "migrate", "resource": "database.migrations.001_init", "operation_id": "op_1", "plan_id": "plan_1", "rolled_back": true } }`
- **THEN** the SDK throws `Run402DeployError`
- **AND** `err.code === "MIGRATION_FAILED"`
- **AND** `err.phase === "migrate"`
- **AND** `err.resource === "database.migrations.001_init"`
- **AND** `err.operationId === "op_1"`
- **AND** `err.planId === "plan_1"`
- **AND** `err.rolledBack === true`
- **AND** `err.traceId === "trc_dep"`
- **AND** `err.safeToRetry === true`
- **AND** `err.mutationState === "rolled_back"`

#### Scenario: Legacy deploy error still translates

- **WHEN** a deploy plan response fails with `{ "code": "MIGRATION_CHECKSUM_MISMATCH", "message": "Migration checksum mismatch", "phase": "migrate", "operation_id": "op_2", "plan_id": "plan_2", "retryable": false }`
- **THEN** the SDK throws `Run402DeployError`
- **AND** the existing deploy accessors expose code, phase, operation id, plan id, and retryability
- **AND** canonical-only properties that are absent from the body remain `undefined`

#### Scenario: Terse deploy code does not require English text

- **WHEN** the gateway returns `{ "code": "PLAN_NOT_FOUND" }`
- **THEN** deploy translation branches on the code
- **AND** the SDK synthesizes a useful fallback message
- **AND** no English parsing is required

### Requirement: Agent docs define safe retry behavior

Agent-facing docs SHALL teach consumers to branch on `code`, not English `message` or `error` text. The docs SHALL define:

- `retryable`: the same request may succeed later
- `safe_to_retry`: repeating the same request should not duplicate or corrupt a mutation
- `mutation_state`: gateway-known mutation progress, one of `none`, `not_started`, `committed`, `rolled_back`, `partial`, or `unknown`

For unknown mutating 5xx responses with `safe_to_retry: false`, docs SHALL instruct agents to inspect, poll, or reconcile state before retrying.

#### Scenario: Agent handles safe retry directly

- **WHEN** an agent sees `retryable: true`, `safe_to_retry: true`, and a stable idempotency key for a mutating operation
- **THEN** docs allow the agent to retry the same request

#### Scenario: Agent avoids blind retry after unknown mutation state

- **WHEN** an agent sees HTTP 500 for a mutating operation with `mutation_state: "unknown"` and `safe_to_retry: false`
- **THEN** docs instruct the agent to inspect/poll/reconcile before retrying
