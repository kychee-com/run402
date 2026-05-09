## Why

`r.deploy.apply()` currently throws when the gateway reports a safe deploy race such as `BASE_RELEASE_CONFLICT`, even when the structured error says `safe_to_retry: true`. Coding agents then have to hand-roll the same retry loop, interpret platform-owned race metadata, and re-run the deploy manually despite the SDK already owning the plan/upload/commit/poll flow.

Run402's agent DX is strongest when callers express deploy intent once and the SDK absorbs known-safe platform contention with visible, bounded recovery. GitHub issue #225 captures a real May 2026 trace where a manual second invocation succeeded immediately after an avoidable base-release race.

## What Changes

- Add a deploy-specific automatic retry policy to `r.deploy.apply()` for explicitly allowlisted, gateway-marked safe retry errors.
- Start with `BASE_RELEASE_CONFLICT`; include `OPTIMISTIC_LOCK_CONFLICT` only if the public SDK/gateway contract confirms that code is emitted for deploy races.
- Require `safe_to_retry === true`; do not retry solely because `retryable === true`, HTTP status is 5xx, or the generic SDK retry helper would retry.
- For `BASE_RELEASE_CONFLICT`, restart the full apply pipeline from planning with the original `ReleaseSpec`, not a blind replay of the stale plan or operation.
- Add caller control through an `ApplyOptions` retry budget, including an explicit opt-out.
- Emit structured retry events through the existing `onEvent` path so CLI/MCP/operator logs show when the SDK handled a safe race.
- Preserve final structured error metadata when retries are exhausted, including the number of attempts observed.
- Keep low-level `plan`, `upload`, `commit`, `resume`, and generic `withRetry()` semantics unchanged.
- No breaking changes to existing deploy result shapes or successful `deploy.apply()` calls.

## Capabilities

### New Capabilities

- `deploy-safe-retry-client-contract`: Public SDK/CLI/MCP/scoped-client contract for bounded, visible, deploy-specific automatic retries on gateway-confirmed safe release races.

### Modified Capabilities

- None.

## Impact

- **SDK**: `sdk/src/namespaces/deploy.ts`, `sdk/src/namespaces/deploy.types.ts`, `sdk/src/scoped.ts`, root type exports, deploy tests, retry/error metadata tests where needed.
- **CLI/MCP**: Existing `run402 deploy apply` and MCP `deploy` event streams should surface retry events through their existing event renderers; help/docs may mention default retry behavior and opt-out if exposed at the edge.
- **Docs/skills**: `sdk/README.md`, `sdk/llms-sdk.txt`, `cli/llms-cli.txt`, root `SKILL.md`, `openclaw/SKILL.md`, and any surfaces flagged by `documentation.md` that describe `deploy.apply` failure recovery.
- **Sync/tests**: `npm run test:sync`, deploy SDK unit tests, CLI help/e2e tests if flags are added, MCP deploy tests if retry rendering changes, and `npm run test:skill` for agent guidance updates.
- **Open question for implementation**: if a caller pins an explicit `base.release_id`, automatic retry may violate that intent by re-planning against a newer base. The design must settle whether pinned-base specs are excluded from auto-retry or retried only under a narrower condition.
