## Context

`run402 status` is the agent-first one-shot account summary. Today its JSON ([cli/lib/status.mjs](../../../cli/lib/status.mjs)) carries overlapping framings of one wallet (`wallet` + `allowance` blocks with a duplicate `address`), a stale `funded` boolean that reads like money, two balances at different nesting levels (top-level `wallet_balance_usd_micros` vs nested `billing.available_usd_micros`), and wallet identity fields `name`/`label` whose keys don't convey local-selector vs server-display. The same `name`/`label` pair is repeated in `r.whoami()` ([sdk/src/index.ts](../../../sdk/src/index.ts)), the MCP `status` tool ([src/tools/status.ts](../../../src/tools/status.ts)), and `wallets list`/`current` ([cli/lib/wallets.mjs](../../../cli/lib/wallets.mjs)).

The on-chain balance reader is already rail-aware: for `x402` it sums USDC on Base mainnet + Base Sepolia; for `mpp` it reads pathUSD on Tempo Moderato ([cli/lib/status.mjs](../../../cli/lib/status.mjs) `readWalletBalanceUsdMicros`). `rail` is already a top-level field. So the multi-rail handling exists — it is just under-described in the output.

## Goals / Non-Goals

**Goals:**
- One self-describing wallet identity object across every surface: `local_label` (local selector) + `server_label` (server-synced display, the wire term).
- A single `balances` object that is unambiguous under every rail and funding source.
- Remove redundancy (`allowance` block, `funded`) and cross-surface naming drift.
- Make the rail/token story legible without adding rail-branching logic.

**Non-Goals:**
- No change to on-disk storage (`meta.json` keeps `name`/`label`) or the credential provider's internal `WalletIdentity` shape — renames happen only at the output edge.
- No change to the balance *sources* or the rail-aware reader logic.
- No gateway/server change.
- Not introducing a Stripe "rail" — Stripe remains a funding source for `prepaid_credit`.

## Decisions

**1. Field names `local_label` / `server_label` (not `local_name` / `server_name`).**
`label` is the term the entire stack already uses for the server-side display name: the `/wallets/v1/:address/label` endpoint, `getLabel`/`setLabel`, and `meta.json`. Coining `server_name` would create a fourth name for a field everything else calls `label` — the exact cross-surface drift this change removes. Symmetric `local_label` pairs with it.
- *Alternative — asymmetric `local_name` + `server_label`:* most semantically precise (the local thing is a selector/name, the server thing a label), but rejected because the user wants a symmetric, wire-aligned pair.
- *Alternative — keep `name`/`label`:* rejected; the unclear keys are the problem.

**2. Rename only at the output edge; keep internal names.**
`meta.json` (`name`, `address`, `label`, `created`) and the provider's `WalletIdentity` keep `name`/`label`; `status`, `whoami`, `wallets list`/`current`, and MCP map to `local_label`/`server_label` when emitting. This avoids an on-disk migration and keeps the blast radius in the presentation layer. The output contract need not match internal field names.

**3. Rename consistently across all user-facing outputs.**
`status`, `whoami` (+ `WhoAmI` type), MCP `status`, `wallets list`, and `wallets current`. A partial rename would re-introduce the drift the change exists to remove. This is broader than the literal `status` ask and is the one scope call worth confirming at review.

**4. One-level `balances` object with a `token` label.**
`balances: { on_chain_usd_micros, on_chain_token, prepaid_credit_usd_micros, held_usd_micros }`. One level deep (no per-rail nested object) keeps the token beside its number without the deep nesting that made `billing.available_usd_micros` annoying. `on_chain_token` (`"USDC"` | `"pathUSD"`) is technically derivable from `rail` but kept as decode-help so the number is never read as plain USD when it is pathUSD.

**5. Drop `funded`; drop the `allowance` block.**
`funded` is a stale local boolean superseded by an `on_chain_usd_micros` reading. The `allowance` block only added a duplicate `address`. Removing both is the core de-duplication.

**6. Empty-state moves to `wallet: null`.**
With the `allowance` block gone, the no-allowance case returns `{ wallet: null, hint: "Run: run402 init" }` — the wallet is now the primary inspected resource, consistent with the `cli-output-shape` nullable-resource convention.

**7. Align `run402 init` in the same release.**
`init`'s summary shares the same wallet + balance concepts as `status`, so it adopts the identical `wallet: { local_label, server_label, address }` and `balances: { … }` shapes, replacing `allowance: { address, funded }` and `balance: { symbol, usd_micros }`. `init` already computes the on-chain balance; it gains a best-effort `billing.checkBalance` call so `prepaid_credit`/`held` are populated when an account exists (usually `null` at first-time setup). Leaving `init` on the old shape would strand the largest secondary surface on the exact naming this change removes.

## Risks / Trade-offs

- **Breaking the agent-facing JSON + `WhoAmI` type** → Ship behind the next lockstep version bump; update `cli/llms-cli.txt`, `documentation.md`, and site `llms.txt` in the same change; update all tests in lockstep so `sync`/e2e catch any missed surface.
- **Internal (`name`/`label`) vs output (`local_label`/`server_label`) divergence may confuse maintainers** → A short comment at each mapping edge; recorded here as the deliberate trade-off for zero migration.
- **Offline loses the `funded` signal** (`on_chain_usd_micros` is `null` when the RPC is unreachable) → Acceptable: a `null` reading already communicates "unknown," which is more honest than a stale boolean.
- **Larger surface area** (`init` aligned in the same change, plus `wallets list`/`current`) → All renamed surfaces ship together so `sync`/e2e tests catch any missed one; pre-launch means no external consumers to migrate.

## Migration Plan

- No data migration — on-disk schema unchanged.
- Consumer migration: rename parsed keys (`name`→`local_label`, `label`→`server_label`; read `balances.*` instead of `wallet_balance_usd_micros`/`billing.*`; drop `allowance`/`funded`). Document in the changelog/llms surfaces.
- Rollback: revert the output-edge mapping commits; no state to unwind.

## Open Questions

- None outstanding. Resolved at review: the consistency rename includes `wallets list`/`current` (Decision 3) and `run402 init` is aligned in the same release (Decision 7). Breaking changes are acceptable — pre-launch, no external consumers.
