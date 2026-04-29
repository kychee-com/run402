## 1. SDK error hierarchy

- [x] 1.1 Add canonical envelope projections to `Run402Error`: `code`, `category`, `retryable`, `safeToRetry`, `mutationState`, `traceId`, `details`, `nextActions`
- [x] 1.2 Keep `Run402Error.body` as the exact parsed response body; do not synthesize a public top-level `status` field
- [x] 1.3 Prefer `message` over `error` when constructing display messages, while preserving legacy fallback behavior
- [x] 1.4 Add SDK tests proving canonical fields are preserved on `body`, projected on the error instance, and absent/undefined for legacy-only bodies
- [x] 1.5 Add SDK tests proving passthrough string / non-envelope bodies still produce useful `ApiError` / `PaymentRequired` / `Unauthorized` instances

## 2. Deploy error translation

- [x] 2.1 Extend `GatewayDeployError` / deploy translation to accept canonical `details`, `safe_to_retry`, `mutation_state`, `trace_id`, and `next_actions`
- [x] 2.2 Ensure deploy branching recognizes `MIGRATION_FAILED`, `MIGRATION_CHECKSUM_MISMATCH`, `PLAN_NOT_FOUND`, `OPERATION_NOT_FOUND`, and `MIGRATE_GATE_ACTIVE` from `code`, not English text
- [x] 2.3 Preserve legacy top-level deploy fields: `phase`, `resource`, `operation_id`, `plan_id`, `fix`, `logs`, `rolled_back`, `retryable`
- [x] 2.4 Add tests for old deploy shape, new canonical deploy shape, mixed shape, terse `{ code }` shape, and commit failures surfaced as canonical envelopes
- [x] 2.5 Confirm `Run402DeployError` still exposes existing deploy accessors while also exposing inherited canonical projections

## 3. CLI error output

- [x] 3.1 Update `cli/lib/sdk-errors.mjs` to forward canonical fields (`code`, `category`, `retryable`, `safe_to_retry`, `mutation_state`, `trace_id`, `details`, `next_actions`) when present
- [x] 3.2 Continue forwarding legacy fields used today: `hint`, `retry_after`, `retry_after_seconds`, `expires_at`, `renew_url`, `usage`, lifecycle fields, `admin_required`, deploy fields, payment fields, storage fields
- [x] 3.3 Preserve CLI outer `status: "error"` after merging any gateway body
- [x] 3.4 Prefer `message` for display, falling back to `error`
- [x] 3.5 Handle `Run402DeployError` instances with `status === null` by emitting structured JSON rather than only `message`
- [x] 3.6 Add CLI tests proving canonical fields forward, `status` remains `"error"`, HTML/text `body_preview` behavior is unchanged, and deploy errors keep structured fields

## 4. MCP error formatting

- [x] 4.1 Update `src/errors.ts` so `formatApiError` prefers canonical `code` and `message`
- [x] 4.2 Render canonical scalar context when present: `code`, `category`, `retryable`, `safe_to_retry`, `mutation_state`, `trace_id`
- [x] 4.3 Render `next_actions` compactly, especially `authenticate`, `submit_payment`, `renew_tier`, `check_usage`, `retry`, `resume_deploy`, `edit_request`, and `edit_migration`
- [x] 4.4 Branch special guidance on `code` before HTTP status, while keeping current status-based fallback guidance for legacy and passthrough bodies
- [x] 4.5 Update deploy-specific MCP renderers to include canonical `trace_id`, `safe_to_retry`, `mutation_state`, `details`, and `next_actions`
- [x] 4.6 Add MCP tests proving canonical formatting, trace id rendering, next action rendering, and legacy fallback behavior

## 5. OpenClaw and agent-facing docs

- [x] 5.1 Update `SKILL.md`, `openclaw/SKILL.md`, and `cli/llms-cli.txt` to teach agents to branch on `code`, not English text
- [x] 5.2 Document `retryable` vs `safe_to_retry` semantics
- [x] 5.3 Document `mutation_state` values: `none`, `not_started`, `committed`, `rolled_back`, `partial`, `unknown`
- [x] 5.4 Document the safe policy for unknown mutating 5xx with `safe_to_retry: false`: inspect or poll before retrying
- [x] 5.5 Add examples for lifecycle/payment/deploy errors using canonical envelopes

## 6. Validation

- [x] 6.1 Run targeted SDK tests: `node --test --import tsx sdk/src/kernel.test.ts sdk/src/namespaces/deploy.test.ts`
- [x] 6.2 Run MCP formatter tests: `node --test --import tsx src/errors.test.ts`
- [x] 6.3 Run CLI/e2e tests covering error JSON: `npm run test:e2e`
- [x] 6.4 Run full suite: `npm test`
- [x] 6.5 Run OpenSpec validation: `openspec validate adopt-run402-error-envelope`
