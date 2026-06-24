# Design

## Framing: friction, not frugality

The instinct to collapse onboarding into a single `npx run402 deploy` (or a new `up` verb) optimizes the wrong variable. It is a *frugality* move (fewest commands); the doctrine optimizes *friction* (fewest surprises — vision.md, agent-response-design.md). For an agent, an extra command costs almost nothing; an ambiguous failure costs the whole task. So the target is not "four become one" — it is "four that chain themselves," where each command's output hands the agent the next exact command.

A new noun/verb (`up`) is rejected outright: Principle #11 mandates "one canonical way to act," which is already `deploy apply`. Repo-local state files are rejected too: the `~/.config/run402` keystore is the durable per-machine memory the CLI already auto-discovers, and `Idempotency-Key` (durable-side-effects doctrine) covers retry-safety. Two shipped mechanisms already cover what a third would.

## The cold-start journey (target state)

```
  Human: "build me something cool using run402.com"
     │  (the ONLY human act; on testnet the budget is the free faucet)
     ▼
  Agent knows ONE verb (deploy apply) and follows the chain:

  deploy apply ─► no allowance   next_actions:[{type:initialize_wallet, command:"run402 init"}]
       ▲                                                                          │
       │  retry                                       agent reads, runs init ◄─────┘
  init ─► (free faucet)          next_actions:[{type:renew_tier, command:"run402 tier set prototype"}]
       ▼
  tier set prototype  (Idempotency-Key)  ─► next_actions:[{type:create_project, command:"run402 projects provision"}]
       ▼
  projects provision  (Idempotency-Key)  ─► writes prj_ to ~ keystore
       ▼
  deploy apply ─► 201 release    next_actions:[{type:retry?, …}] / verify  ✓
```

The agent never possessed the sequence. It knew one verb and read what came back. That is the whole design.

## Evidence (live probe, api.run402.com, 2026-06-24)

| Request | HTTP | `next_actions` |
|---|---|---|
| `POST /tiers/v1/prototype` | 402 | `[{type:submit_payment, auth:x402, why}]` ✓ |
| `GET /projects/v1` | 402 | `[{type:authenticate, auth:SIWX, why}]` ✓ |
| `POST /projects/v1` | 402 | `[{type:authenticate, auth:SIWX, why}]` ✓ |
| `POST /apply/v1/plans` (no auth) | 401 | `[]` ✗ empty — on the deploy endpoint |
| `POST /faucet/v1` | 400 | `[]` ✗ empty |

Conclusion: the gateway envelope schema is clean where populated, but "required on every non-2xx" (style.md) is **aspirational, not enforced**. The public SDK must synthesize on empty relays for known codes — it already does this for `WRITE_AUTH` at `sdk/src/errors.ts:587-590`.

## Where next_actions is authored (three populations)

| Failure location | Author | Repo |
|---|---|---|
| client-side (bad flag, no allowance, no project) | CLI `fail()` | **public** — the 44/401, our main scope |
| gateway omitted on a known code | SDK synthesizes | **public** — existing pattern |
| request reached gateway & failed | gateway → SDK parse (`errors.ts:113`) → CLI relay (`sdk-errors.mjs`) | **private**, relayed |

This is why the bootstrap fix is overwhelmingly a public-repo change: the walls a cold agent hits first short-circuit in `config.mjs` before any HTTP request. agent-response-design.md's cost-boundary rule ("fix at the cheapest layer that fully solves it") points to the CLI edge.

## The curated cut (not all 401)

The Curated lens forbids instrumenting all 357 remaining `fail()` calls "to be safe." Leverage is the cold-path subset:

- **Tier 1 — `config.mjs` (5 calls, shared chokepoint).** Highest blast radius: nearly every command resolves a project/allowance through it. This *is* "self-describing to enter."
- **Tier 2 — `tier.mjs` (3) + `provision` in `projects.mjs` + `init.mjs` (1).** The chain hops.
- **Tier 3 — the ~337 deep-validation tail.** Off the cold path; instrument opportunistically, never as a blocking chore. `log()`/note any deliberate omission.

## Sub-decisions

### Action-type enum extension

The gateway enum (style.md) is `retry | authenticate | submit_payment | renew_tier | check_usage | resume_deploy | edit_request | edit_migration | contact_support`. It has `renew_tier` (covers `tier set`) but **no bootstrap verbs**. Add `create_project` and `initialize_wallet`. Add an optional `command` field (the literal CLI invocation) so CLI-resolvable client-side actions carry the exact string, alongside the gateway's `{type, method, path, auth, why}` for wire actions. One vocabulary, superset shape.

### Idempotency-key derivation

`tier set` is **not** naturally idempotent — re-running renews/extends the lease and charges again — so an `Idempotency-Key` genuinely prevents double-charge on retry. `provision` without a key duplicate-creates.

Both verbs forward a **caller-supplied** key (`idempotencyKey` in the SDK, `--idempotency-key` at the CLI). The implementation revealed that the SDK **cannot auto-derive** a correct key: a key represents one *payment/creation intent*, and only the caller knows that boundary — a deliberate second renewal must use a fresh key, which an SDK-side derivation (tier name, wallet, time window) cannot distinguish from a retry. So:

- **`tier set`:** caller-supplied only; the SDK never auto-derives. Agents pass `--idempotency-key` for retry safety.
- **`provision`:** caller-supplied; the **CLI** auto-derives `provision:<name>` from `--name` when present (a named project is a stable intent, so re-running `provision --name X` collapses onto the same project). An explicit key always wins; an unnamed provision stays un-keyed (each call is a new project on purpose).

Gateway remains authoritative on collision semantics.

## The open decision: chain vs. converge

Both are blessed by Principle #11 ("never leave the loop" + "atomic declarative apply") and both ride on the retry-safe foundation in this change. Recorded as **open**; does not block the foundation.

```
  CHAIN (this change's default)              CONVERGE (possible follow-up)
  ─────────────────────────────              ─────────────────────────────
  deploy apply stays release-scoped;         deploy apply reads project/tier
  emits next_actions for missing             intent from the manifest and
  preconditions; agent runs each             provisions + subscribes + deploys
  (idempotent)                               in one call, bounded by allowance

  + robust, incremental, ships now           + the "one call, live resources" story
  + works for a zero-knowledge agent         − only safe ON TOP of idempotent
  − one round-trip per missing precond         provision/tier (this change)
```

**Decision (2026-06-24): chain only.** `deploy apply` stays release-scoped and emits `next_actions`; the agent runs each idempotent bootstrap step. Converge is *not* built now — it is a strict superset that can be added later as an opt-in (a `--bootstrap` flag or manifest-declared `project`/`tier` intent) on top of this change's idempotent substrate, with no breaking change. **Revisit trigger:** real signal that the N-turns-vs-1 cost is hurting agents (bootstrap latency, token cost, or off-script drift). Until then, converge's atomic multi-op complexity and manifest-schema surface are not worth paying speculatively.

## Out of scope / cross-repo

- Gateway populating `next_actions[]` on `POST /apply/v1/plans` 401 and validation 400s → **run402-private** follow-up (server-authored population). This change mitigates via SDK synthesis.
- Any new top-level verb (`up`), any convergent multi-resource apply — explicitly deferred.
