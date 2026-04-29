## Why

GitHub issue: #153

The gateway now emits a canonical machine-readable envelope for Run402-originated non-2xx JSON errors. The public SDK, CLI, MCP server, and OpenClaw skill still treat most errors as either HTTP-status branches or legacy `error` / `message` strings. That loses the exact fields agents need to recover safely: stable `code`, retry semantics, mutation state, trace ids, and structured next actions.

This matters most during deploys and lifecycle/payment failures. An agent can only make a good retry decision if it knows both "might this succeed later?" (`retryable`) and "will the same request duplicate or corrupt state?" (`safe_to_retry`). English parsing is too fragile for that job.

## What Changes

- SDK errors preserve the gateway body exactly and expose optional convenience properties for canonical fields: `code`, `category`, `retryable`, `safeToRetry`, `mutationState`, `traceId`, `details`, and `nextActions`.
- SDK and deploy error translation branch on `body.code` when present, while continuing to accept legacy-only bodies and passthrough surfaces.
- CLI stderr keeps its existing outer `{ "status": "error", "http": ... }` envelope, forwards canonical and legacy body fields, prefers `message` for display, and always reasserts `status: "error"` after merging.
- MCP error formatting prefers the canonical envelope: stable code first, human message, compact context, trace id, and useful rendered `next_actions`.
- OpenClaw / agent-facing docs teach agents to branch on `code`, distinguish `retryable` from `safe_to_retry`, and use `mutation_state` before retrying mutating operations.

## Capabilities

### New Capabilities

- `run402-error-envelope`: Canonical machine-readable error handling across SDK, CLI, MCP, and OpenClaw.

### Modified Capabilities

- `run402-sdk`: SDK error hierarchy gains canonical envelope convenience fields and preserves legacy compatibility.
- `unified-deploy`: Deploy failure translation consumes canonical deploy errors and no longer depends on English messages.

## Impact

- **SDK**: `sdk/src/errors.ts`, `sdk/src/kernel.ts`, `sdk/src/namespaces/deploy.ts`, deploy types, SDK README.
- **CLI**: `cli/lib/sdk-errors.mjs`, deploy CLI error paths, CLI e2e coverage.
- **MCP**: `src/errors.ts`, deploy-specific tool error renderers, MCP error tests.
- **OpenClaw / docs**: `SKILL.md`, `openclaw/SKILL.md`, `cli/llms-cli.txt`, potentially `README.md` / `sdk/README.md`.
- **Tests**: SDK kernel tests, deploy translation tests, CLI stderr JSON tests, MCP formatter tests, docs validation.

## Non-Goals

- Do not remove legacy parsing.
- Do not wrap PostgREST-native `/rest/v1/*` errors, user function invocation responses, or external presigned upload target responses in the canonical envelope.
- Do not introduce a gateway-owned top-level `status` field into public client surfaces.
- Do not make `next_actions` executable without client-side validation of method, path, auth, and safety.
