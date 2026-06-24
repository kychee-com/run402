## 1. Evidence & contract surface

- [x] 1.1 Probe `api.run402.com` to confirm whether the gateway populates `next_actions[]` on non-2xx (result recorded in design.md: populated for tier/projects, empty for `apply/v1/plans` 401 and `faucet/v1` 400).
- [x] 1.2 Extend the `next_actions` action-type union with `create_project`, `initialize_wallet`, `deploy`; add an optional `command` field for CLI-resolvable actions. Export `NextAction` / `NextActionType` from the SDK root (`sdk/src/errors.ts`, `sdk/src/index.ts`).
- [x] 1.3 Confirm `fail()` already serializes `next_actions` (`cli/lib/sdk-errors.mjs`) and the gateway relay path (`errors.ts:113` → `mergeStructuredErrorFields`) is unchanged.

## 2. CLI bootstrap next_actions — Tier 1 (the chokepoint)

- [x] 2.1 `cli/lib/config.mjs`: `resolveProjectId` / `resolveProject` `NO_ACTIVE_PROJECT` → `create_project` (`run402 projects provision`).
- [x] 2.2 `cli/lib/config.mjs`: malformed-allowance (`BAD_ALLOWANCE_FILE`) → `initialize_wallet` (`run402 init`); existing `hint` kept.
- [x] 2.3 `cli/lib/config.mjs`: `allowanceAuthHeaders` `NO_ALLOWANCE` early-exit → `initialize_wallet`.
- [x] 2.4 Remaining `config.mjs` `fail()` (`PROJECT_NOT_FOUND`) → `create_project`. All 5 carry a typed action; shared helpers in `cli/lib/next-actions.mjs`.

## 3. CLI bootstrap next_actions — Tier 2 (chain hops)

- [x] 3.1 `cli/lib/tier.mjs`: `set` with no tier arg → `renew_tier` (`run402 tier set <tier>`).
- [x] 3.2 `cli/lib/projects.mjs`: `provision` with no allowance → `initialize_wallet` (inherited from the `config.mjs` `allowanceAuthHeaders` chokepoint it calls).
- [x] 3.3 `cli/lib/init.mjs`: evaluated — its single `fail()` is `RAIL_SWITCH_REQUIRES_CONFIRM` (pass `--switch-rail`), not a bootstrap-chain step; no canonical bootstrap action applies and the message already names the exact remedy. Left as-is by intent.

## 4. init success → next_actions

- [x] 4.1 `cli/lib/init.mjs`: emit `next_actions[]` (first action = computed next step, with `command`).
- [x] 4.2 Retain `next_step` as a back-compat string mirror of `next_actions[0].command`.

## 5. Retry-safe paid bootstrap verbs (Idempotency-Key)

- [x] 5.1 `sdk/src/namespaces/projects.ts` + `projects.types.ts`: optional `idempotencyKey` on `provision`; send `Idempotency-Key` header when present.
- [x] 5.2 `sdk/src/namespaces/tier.ts`: optional `idempotencyKey` on `set` (caller-supplied only — SDK does not auto-derive, since it cannot distinguish a retry from a deliberate second renewal; design.md refinement).
- [x] 5.3 CLI: `run402 projects provision --idempotency-key <k>` (auto-derives `provision:<name>` from `--name` when omitted) and `run402 tier set <tier> --idempotency-key <k>`.

## 6. Self-healing SDK relay

- [x] 6.1 `sdk/src/errors.ts`: when a gateway non-2xx arrives with empty `next_actions[]` on a known code (`AUTH_REQUIRED`), synthesize the canonical `authenticate` action (extends the existing `WRITE_AUTH` synthesis). Never overrides gateway-authored actions.
- [x] 6.2 Gateway-side empty-`next_actions` gap (`/apply/v1/plans` 401, validation 400s) flagged as a run402-private follow-up (background task `task_e954553f`).

## 7. Tests

- [x] 7.1 CLI unit tests (`cli-bootstrap-next-actions.test.mjs`): each Tier-1/Tier-2 failure asserts a non-empty typed `next_actions[]` with the expected `type` and `command`.
- [x] 7.2 `init` test (`cli-e2e.test.mjs`): stdout carries `next_actions[]` and `next_step === next_actions[0].command`.
- [x] 7.3 SDK tests: `provision`/`tier.set` attach `Idempotency-Key` (and omit when absent); relay synthesis fills empty `next_actions` on `AUTH_REQUIRED` and preserves populated ones.
- [x] 7.4 Registered `cli-bootstrap-next-actions.test.mjs` in the `test` + `test:e2e` package.json allowlist.
- [x] 7.5 `npm test` green (SKILL + sync + unit + CLI e2e + docs); skills index regenerated via `scripts/build-agent-skills-index.mjs`.

## 8. Docs & skills

- [x] 8.1 `cli/llms-cli.txt`: extended `next_actions` type list, documented the cold-start chain, documented `--idempotency-key`.
- [x] 8.2 `SKILL.md` + `openclaw/SKILL.md`: teach "follow `next_actions`" over a memorized sequence; new types listed.
- [x] 8.3 `sdk/llms-sdk.txt`: updated `provision` + `tier.set` signatures with `idempotencyKey`. (Per `documentation.md`, the affected surfaces are these four; MCP `llms-mcp.txt` unaffected — no MCP tool changed.)

## 9. Design decision (resolved)

- [x] 9.1 Decided chain vs. converge for `deploy apply` (2026-06-24): **chain only**. `deploy apply` stays release-scoped and emits `next_actions`; converge is deferred as a possible future opt-in on this change's idempotent substrate, to be proposed only on real round-trip-cost signal. Recorded in proposal.md + design.md.
