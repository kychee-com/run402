## Why

The real entry point to run402 is not a human typing commands. It is a human telling an agent *"build me something cool using run402.com"* — and an agent that may know nothing about run402 working from a cold start. Every line of the documented onboarding (`init` → `tier set` → `provision` → `deploy apply`) is an **agent** action, not a human one. Vision Principle #11 names the bar exactly: *"The agent never has to leave the loop… every response, above all every error, carrying the exact next action… an agent should reach a deployed, verified result using only what we hand back."* The metric is **friction, not frugality** — fewest surprises, not fewest commands.

Today the agent leaves the loop on the very first wall. Three grounded gaps:

1. **The bootstrap path drops the next action.** `next_actions[]` is the canonical, surface-wide "what to do next" field (style.md §Errors), but in the CLI it is populated in **44 of 401** `fail()` calls. The gap is concentrated exactly on the cold-start path: `cli/lib/config.mjs` — the shared chokepoint every command flows through — is **0 of 5**, emitting prose `hint`s (`"Run: run402 projects provision"`) instead of typed actions. `tier.mjs` (0/3), `projects.mjs` (0/24), and `init.mjs` (0/1) are also uninstrumented, while `deploy-v2.mjs` (28/39, from the CI effort) already proves the pattern ships.

2. **Success and failure speak different shapes.** `run402 init` emits `next_step` (a singular string); failures emit `next_actions[]` (a typed array). An agent must handle two shapes for one concept, violating style.md's "one spelling, surface-wide (errors *and* successes)."

3. **The paid bootstrap verbs are not retry-safe.** An agent's natural mode is to re-run on a fresh session or after a crash. `projects.provision` and `tier.set` send **no `Idempotency-Key`** (only `sdk/src/namespaces/contracts.ts` does), despite the platform accepting it on every paid POST (style.md) and durable-side-effects doctrine mandating a deterministic key on every intent. A mid-call retry duplicate-bills a project or double-charges a tier renewal.

A live probe of `api.run402.com` (2026-06-24) confirmed the relay works where the gateway populates the field (`POST /tiers/v1/prototype` → 402 with `next_actions:[{type:"submit_payment",auth:"x402"}]`; `GET/POST /projects/v1` → 402 with `{type:"authenticate",auth:"SIWX"}`) but is **not uniformly enforced**: `POST /apply/v1/plans` (no auth) → 401 with `next_actions:[]`, and `POST /faucet/v1` → 400 with `next_actions:[]`. So the doctrine is aspirational at the wire, and the public SDK must synthesize on empty relays the way it already does for `WRITE_AUTH` (`sdk/src/errors.ts:587`).

## What Changes

- Instrument the **cold-start bootstrap path** so every client-side failure an agent hits before a deployed result carries a non-empty, typed `next_actions[]` naming the exact command. Scope is the curated chokepoint set, not all 401 calls: `config.mjs` (5), `tier.mjs` (3), the `provision` path in `projects.mjs`, and `init.mjs` (1).
- Extend the `next_actions` action-type enum with the bootstrap verbs it lacks (`create_project`, `initialize_wallet`; `renew_tier` already exists) and add an optional `command` field carrying the literal CLI invocation for CLI-resolvable actions.
- Unify `run402 init` success output: emit `next_actions[]`; retain `next_step` as a back-compat string mirror of the first action's command.
- Make the paid bootstrap verbs retry-safe: thread an optional `idempotencyKey` through `projects.provision` and `tier.set` in the SDK and `--idempotency-key` at the CLI, sending the platform-accepted `Idempotency-Key` header.
- Make the SDK relay self-healing: when a gateway non-2xx arrives with an empty `next_actions[]` on a known code (e.g. `AUTH_REQUIRED`), the SDK SHALL synthesize the canonical action, mirroring the existing `WRITE_AUTH` synthesis.
- No new noun or verb (no `up`): the canonical act-verb stays `deploy apply`. No breaking changes to existing success payloads.

## Capabilities

### New Capabilities

- `agent-cold-start-bootstrap`: The end-to-end contract that an agent knowing only `run402 deploy apply` can reach a deployed result by following returned `next_actions[]`, with retry-safe paid bootstrap verbs and a self-healing SDK relay.

### Modified Capabilities

- `cli-output-shape`: the stderr error envelope and the `init` setup-command output gain typed `next_actions[]` (the field-shape mechanics; the new capability owns the bootstrap-specific behavior).

## Impact

- **CLI**: `cli/lib/config.mjs`, `cli/lib/tier.mjs`, `cli/lib/projects.mjs`, `cli/lib/init.mjs`, `cli/lib/sdk-errors.mjs` (`fail()` already accepts `next_actions`).
- **SDK**: `sdk/src/namespaces/projects.ts`, `sdk/src/namespaces/tier.ts`, `sdk/src/errors.ts` (synthesis), root type exports for the extended action-type union.
- **Docs/skills**: `cli/llms-cli.txt` (Output Contract + bootstrap chain), root `SKILL.md`, `openclaw/SKILL.md`, and any surface flagged by `documentation.md`.
- **Tests**: `cli/lib/*.test.mjs` for the instrumented failures, SDK unit tests for idempotency-header attachment and synthesis, `npm run test:sync`, `npm run test:skill`.
- **Out of scope (cross-repo follow-up)**: the gateway-side empty `next_actions[]` on `POST /apply/v1/plans` 401 and validation 400s is a run402-private fix; this change mitigates it in the public SDK and files the gateway gap separately.
- **Design decision — resolved (2026-06-24): chain only.** `deploy apply` stays release-scoped and *emits* bootstrap next_actions (the chain); the agent runs each idempotent step. The *converge* alternative (provision + subscribe + deploy in one call, bounded by the allowance) is deferred — it is a strict superset that can be added later as an opt-in on this change's substrate without a breaking change, and only when there is real signal that the extra round-trips hurt. See design.md for the full trade-off and revisit trigger.
