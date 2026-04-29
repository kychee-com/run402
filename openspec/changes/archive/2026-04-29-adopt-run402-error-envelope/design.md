## Context

Run402-originated errors now have a stable envelope:

```json
{
  "error": "legacy-compatible string",
  "message": "Human-readable message.",
  "code": "PROJECT_FROZEN",
  "category": "lifecycle",
  "retryable": false,
  "safe_to_retry": true,
  "mutation_state": "none",
  "trace_id": "trc_...",
  "details": {},
  "next_actions": []
}
```

Existing route-specific top-level fields still appear where they already existed: `hint`, `retry_after`, `retry_after_seconds`, `usage`, lifecycle fields, payment fields, deploy fields, and storage fields. Passthrough boundaries remain raw: PostgREST-native errors, user function invocation responses, and external presigned upload responses are not force-wrapped.

The public repo already has the right architecture for this. The SDK is the kernel; CLI and MCP are edge translators. The migration should tighten that contract rather than adding more per-tool special cases.

## Decisions

### 1. Preserve raw body; add convenience fields

`Run402Error.body` remains the exact parsed response body. The SDK does not normalize the body into a new public object, and it does not add a top-level `status` field. Convenience fields are read-only projections from `body` when it is an object with canonical keys.

This keeps older gateway versions and passthrough errors working while making the new envelope pleasant to consume:

```ts
catch (err) {
  if (err instanceof Run402Error && err.code === "PROJECT_FROZEN") {
    // stable branch
  }
}
```

### 2. Prefer code over English everywhere

Branching logic should check canonical `code` first. `message` is display text only. `error` remains the legacy fallback for older bodies and for passthrough surfaces that do not have canonical fields.

This affects:

- SDK status subclasses: status still decides `PaymentRequired` / `Unauthorized` / `ApiError`, but any finer branching uses `code`.
- Deploy translation: deploy codes such as `MIGRATION_FAILED`, `MIGRATION_CHECKSUM_MISMATCH`, `PLAN_NOT_FOUND`, `OPERATION_NOT_FOUND`, and `MIGRATE_GATE_ACTIVE` are recognized from `code`.
- MCP guidance: special next-step text should key off `code` before HTTP status.

### 3. Retry semantics are two-dimensional

`retryable` and `safe_to_retry` answer different questions:

| Field | Meaning |
|-------|---------|
| `retryable` | The same request may succeed later. |
| `safe_to_retry` | Repeating the same request should not duplicate or corrupt a mutation. |
| `mutation_state` | The gateway's knowledge of mutation progress: `none`, `not_started`, `committed`, `rolled_back`, `partial`, or `unknown`. |

The safe default for mutating operations is:

```
if retryable && safe_to_retry:
  retry directly
else if mutation_state in ["committed", "partial", "unknown"]:
  inspect/poll/reconcile before retrying
else:
  require a more specific next_action or user/operator choice
```

### 4. CLI keeps its own envelope

The CLI's outer JSON shape is intentionally stable:

```json
{ "status": "error", "http": 403, "...gateway fields": "..." }
```

When gateway bodies contain a `status` field, the CLI still overwrites it with `"error"` after merging. This is already done today and remains a required compatibility behavior.

### 5. MCP renders for agents, not humans only

MCP error text should be compact but machine-helpful:

```text
Error deploying release: Project is frozen. (HTTP 402)
Code: PROJECT_FROZEN
Category: lifecycle
Retryable: false
Safe to retry: true
Mutation state: none
Trace: trc_abc
Next actions:
- renew_tier: Renew the project tier.
- check_usage: Inspect usage and lifecycle state.
```

Unknown `next_actions` are still rendered in a compact JSON block. Rendering is not execution; clients must validate method/path/auth/safety before executing any action in a future change.

### 6. Deploy errors bridge old and new shapes

Deploy translation must accept:

- Old top-level deploy fields: `code`, `phase`, `resource`, `operation_id`, `plan_id`, `fix`, `logs`, `rolled_back`, `retryable`.
- New canonical fields: `code`, `category`, `retryable`, `safe_to_retry`, `mutation_state`, `trace_id`, `details`, `next_actions`.
- Mixed bodies where deploy-specific fields remain top-level and richer deploy context lives under `details`.

`Run402DeployError` should keep its existing `phase`, `resource`, `operationId`, `planId`, `fix`, `logs`, and `rolledBack` accessors while also inheriting canonical projections from `Run402Error`.

## Risks / Trade-offs

- **Over-formatting MCP output**: too much JSON makes tool errors noisy. Mitigation: render canonical scalar fields as one-line context; only put `details` / unknown action objects in fenced JSON when needed.
- **False confidence around `next_actions`**: agents may treat suggested actions as executable. Mitigation: docs and spec explicitly say next actions are advisory until a validated execution layer exists.
- **Passthrough confusion**: PostgREST errors still look different. Mitigation: keep legacy fallback paths and document that canonical fields are optional.
- **Deploy duplication of retry fields**: `Run402DeployError.retryable` already exists. Mitigation: keep it, add canonical `safeToRetry` / `mutationState` projections, and prefer body values when present.

## Open Questions

- What exact object shape will each `next_actions[]` entry use long term: `{ action, label, ... }`, `{ type, ... }`, or route-oriented `{ method, path, body }`? For this change, render defensively and avoid execution.
- Should SDK convenience field names include both snake_case and camelCase aliases? Recommendation: camelCase public properties only, raw snake_case remains available on `body`.
- Should deploy-specific `details.phase` / `details.resource` override top-level legacy `phase` / `resource`? Recommendation: top-level deploy fields win for compatibility; `details` fills missing fields.
