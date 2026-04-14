## Context

Run402 has zero on-chain capabilities beyond receiving x402 USDC payments. Products that need to write to a smart contract — kysigned recording signature events, future products minting NFTs or anchoring data — have no path through run402 today.

The kysigned spec (v0.3.0, F4) requires a platform wallet calling `recordEmailSignature`, `recordWalletSignature`, and `recordCompletion` on Base mainnet for every envelope, and explicitly puts "wallet custody / KMS key management for the platform wallet" in the run402 column of the cost table. Today this responsibility exists only on paper.

This change adds three layered capabilities: (a) KMS-backed Ethereum wallets per project (private keys never leave AWS KMS), (b) a generic write-call API that signs via KMS and broadcasts to a chain, and (c) a complete rental + lifecycle model that prevents abandoned wallets from costing run402 money forever.

Strict scope: this is a **custodial signing layer for the platform itself**, not a user wallet system. End-user wallet signing (Method B in kysigned) stays client-side via the user's own browser wallet. This feature signs from the platform's identity, not the user's.

## Goals

- Provision AWS KMS-backed Ethereum wallets per project with a guarantee that the private key material never exists outside KMS
- Generic write-call API: caller supplies ABI fragment + args per call, no contract registry, no aliases
- At-cost gas billing + flat per-sign markup, both visible as separate ledger entries
- Wallet rental model that doesn't bleed run402 on abandoned wallets, AND doesn't cause user fund loss
- Funds-rescue path so that suspension/deletion never causes on-chain loss for users who set a recovery address
- Mainnet support (Base first; chain registry is config-only for adding more)
- Full surface parity: gateway → MCP → CLI → OpenClaw → docs, all updated atomically and verified at ship time
- New pricing disclosed on every public pricing surface — no exception, enforced by smoke check

## Non-Goals

- Custodial message signing (`personal_sign`, `signTypedData`) — feature signs **transactions** only
- Private-key export — no endpoint, no admin override, ever
- Multi-sig / threshold signing / MPC
- Auto top-up of native-token (ETH) balance — funding is manual, only alerts are automatic
- Cross-chain bridging or swaps
- Contract deployment
- ABI registry, contract aliases, human-friendly contract names
- Nonce-management heroics, replace-by-fee, mempool monitoring — submit, wait, surface failure honestly
- L1 Ethereum mainnet at launch (architecture supports it; only Base mainnet ships in MVP)
- Generic per-action SKU pricing — KMS sign fee is the only markup, and it's specific to KMS calls

## Decisions

### DD-1: KMS key spec — `ECC_SECG_P256K1` with usage `SIGN_VERIFY`

**Decision:** Each wallet is one AWS KMS key with spec `ECC_SECG_P256K1` and key usage `SIGN_VERIFY`. Public key fetched via `kms:GetPublicKey`. Ethereum address derived as `keccak256(uncompressed_public_key[1:])[12:]` (drop the `0x04` prefix byte, take last 20 bytes of keccak hash). Signing uses `kms:Sign` with `MessageType=DIGEST` and `SigningAlgorithm=ECDSA_SHA_256`, returning a DER-encoded signature that we convert to Ethereum's `(r, s, v)` form by parsing and computing recovery id via candidate-address comparison.

**Alternatives considered:**
- *Per-project shared KMS key with HD derivation:* Requires master seed in KMS as a generic AES key + custom derivation logic outside KMS. The seed itself is exportable in many configurations, breaking the "never leaves KMS" guarantee. Also: not BIP-32 compatible because secp256k1 ECDSA in KMS doesn't expose the scalar.
- *KMS symmetric key wrapping a BIP-32 HD wallet:* Cleaner UX (one key, many addresses) but the wrapped seed exists in plaintext in memory during use. Defeats the no-export guarantee.
- *Self-managed secp256k1 keys in AWS Secrets Manager:* Faster, cheaper, but plaintext-in-memory at sign time. Worst option for the security posture we promised.

**Rationale:** `ECC_SECG_P256K1` is the only KMS option that gives true "private key never leaves the HSM" for Ethereum signing. The DER → `(r,s,v)` conversion is a known pattern (used by Fireblocks, AWS sample code, several open-source libraries). One key per wallet is more expensive than HD derivation but is the only path that honors our security promise.

**Risks:** KMS sign latency is ~50-100ms — slow compared to a local key. *Mitigation:* the spec already requires status polling for confirmation, so the user-perceived latency is dominated by chain confirmation time, not KMS.

**Rollback:** N/A — this is a foundational decision; reversing it means abandoning the "key never leaves KMS" guarantee.

### DD-2: viem for transaction building, ethers.js avoided

**Decision:** Use `viem` (already a run402 dependency via `@x402/evm` and `mppx`) for transaction building, ABI encoding, and RPC interaction. Do NOT add `ethers.js` as a second EVM library.

**Alternatives considered:**
- *ethers.js:* More mature, larger community, but adds a 200KB+ dependency that duplicates everything viem already does in our codebase.
- *Hand-rolled transaction encoding:* Considered briefly for DEC educational purposes; rejected because RLP encoding bugs are nightmare-class.

**Rationale:** Single EVM library reduces bundle size, simplifies upgrades, avoids version-skew bugs between two libraries holding mutually incompatible transaction representations. viem also has first-class support for unsigned transactions (`prepareTransactionRequest` + `serializeTransaction`), which is exactly what we need to build a tx, sign it externally via KMS, and broadcast it.

**Rollback:** N/A — single-library decision.

### DD-3: Chain registry as a TypeScript const, not a database table

**Decision:** Supported chains live in `packages/gateway/src/services/chain-config.ts` as a frozen const. Each entry: `{ chain_id, name, rpc_url_secret, native_token, block_explorer, chainlink_eth_usd_feed_address }`. Adding a chain is a code change + redeploy + new secret for the RPC URL. Initial set: `base-mainnet` and `base-sepolia` (the latter for E2E tests).

**Alternatives considered:**
- *Database table `internal.chains`:* Allows runtime chain addition without redeploy. Overkill — chain additions are rare events (months apart), need code review (RPC URL trust), and are inherently coupled to test infrastructure. A DB row doesn't solve any real problem.
- *Per-project chain whitelist:* Future capability; not needed in MVP because we only support 1-2 chains.

**Rationale:** YAGNI. Chain additions are rare and high-trust; a code change forces review. A database table just creates the illusion of dynamism without any of the benefit.

**Rollback:** Remove the chain entry from the const. Existing wallets on that chain become unusable until re-added; deployment guard (see scenario "Chain in use cannot be silently removed") prevents accidental deletion.

### DD-4: Daily rent debit via UTC midnight cron, idempotent on `(wallet_id, today_utc_date)`

**Decision:** A background job runs at UTC midnight (and is safe to invoke at any time after — it's idempotent). For each `active` wallet where `last_rent_debited_on < today_utc`, the job atomically:
1. Begins a transaction
2. `SELECT FOR UPDATE` the project's billing_accounts row
3. If `available_usd_micros >= 40000`, decrements by 40000, inserts a `kms_wallet_rental` ledger entry, sets `last_rent_debited_on = today_utc` on the wallet
4. Otherwise, transitions ALL of the project's `active` wallets to `suspended` with `suspended_at = NOW()`
5. Commits

The job is invoked by the existing run402 background-task scheduler (the same one that runs the contract-call status reconciler — see DD-7). It is also invoked on-demand by the gateway boot sequence so a long restart doesn't skip a day.

**Alternatives considered:**
- *Per-project timezone:* Each project sets a `billing_timezone`; rent debits at midnight in that TZ. More accurate but adds a column, a TZ library, and complexity to test. Almost no user benefit.
- *Hourly debit ($0.04/24 per hour):* Smoother but spreads ledger entries over 24x more rows. Harder to read in the UI.
- *Monthly debit on day-of-creation anniversary:* Big surprise charge once a month, harder to reason about for the user, edge cases on Feb 29.

**Rationale:** UTC midnight + daily is what cloud billing does (AWS, GCP, Stripe metered billing). Predictable, simple, easy to reason about. Per-project TZ buys nothing real.

**Risks:** A user in US Pacific sees their daily debit at 4-5pm local. Acceptable — it's a $0.04 line item, not a "you owe $1.20" event.

**Rollback:** Disable the job; wallets stop accruing rent and stay in their last status.

### DD-5: Suspension is project-wide, not per-wallet

**Decision:** When a project's cash balance can't cover rent for any one of its active wallets, ALL of the project's active wallets transition to `suspended` simultaneously. Reactivation likewise reactivates all of them at once on the next daily job run after a top-up.

**Alternatives considered:**
- *Per-wallet suspension based on debit order:* Smaller wallet count gets to keep operating while the rest suspend. Complex (which order?), error-prone (race conditions on partial debits), and gives a false sense of "we're still partially working."
- *Reserve N days of rent at creation as escrow:* The 30-day prepay creation gate already does most of this; adding an explicit escrow column duplicates the cash-balance check.

**Rationale:** Suspension is binary at the project level. If you can't afford one wallet, you can't afford to selectively keep some — your account is in arrears, period. This also makes the user's mental model dead simple: top up → everything works; out of cash → everything stops.

**Rollback:** Per-wallet suspension would require schema changes (per-wallet `suspended_at`); not a quick rollback.

### DD-6: Drain endpoint reuses contract_call infrastructure

**Decision:** `POST /contracts/v1/wallets/:id/drain` is implemented as a special case of `contract_call`. The drain transaction is built as a value-transfer (not a contract method invocation) but recorded in `internal.contract_calls` with `function_name = "<drain>"` and `args_json = { destination, drained_wei }`. Same KMS signing path, same broadcast logic, same status reconciliation, same `kms_sign_fee` ledger entry. The only special-case is the request validator, which (a) bypasses the cash-balance suspension check when the wallet is `suspended`, and (b) refuses to drain a `deleted` wallet (HTTP 410).

**Alternatives considered:**
- *Separate code path for drains:* Duplicates 80% of contract_call. Two places to maintain reconciliation logic, two places to handle KMS errors.
- *Drain via the generic contract_call endpoint with `function_name = "transfer"` and a special ABI:* Would require the user to construct the transfer themselves. Bad UX. Also: native transfers are not contract calls — they're zero-data transactions. Conflating them is wrong.

**Rationale:** Drain is operationally identical to a contract call (build tx → KMS sign → broadcast → wait for receipt → record). Special-casing only the validator preserves a single signing path and makes audit easier (every signing event is in `contract_calls`).

**Rollback:** Remove the endpoint and the validator branch. Existing drain records remain in `contract_calls` for audit.

### DD-7: Status reconciliation via single shared background job

**Decision:** One background job — `contractCallReconciler` — runs every 30 seconds and:
1. Polls every `pending` contract_call older than 5 seconds for its receipt
2. Updates `confirmed`/`failed` + writes the gas ledger entries
3. Also runs the daily rent debit job (DD-4), the 90-day deletion sweep (DD-9), and the warning email schedule (DD-10) — all gated on "have I run this today?" checks so they're idempotent at the 30-second cadence

**Alternatives considered:**
- *Webhook from chain provider:* Alchemy/Infura support tx notification webhooks. Faster but requires per-chain webhook setup, exposes a public webhook endpoint, and only some providers support it. Polling works on every chain.
- *Separate cron jobs per task:* More processes to manage, more failure modes, more deployment surface.

**Rationale:** Polling is universally supported, has no inbound exposure surface, and at 30-second cadence is well within the user's expectation for "submitted a tx, when does it confirm?" (Base block time ~2s; ~15 polling intervals to confirm). One job, multiple guarded tasks, single deployment unit.

**Risks:** Job crash means status update lag. *Mitigation:* the job is idempotent; on next run it picks up where it left off. Health check on the gateway includes job liveness.

**Rollback:** Make the job a no-op; submitted calls stay `pending` until manual intervention.

### DD-8: KMS sign fee = 5 USD-micros, separate ledger entry

**Decision:** Every `contract_call` (including drain) records two ledger entries on confirmation: `contract_call_gas` (variable, at-cost) and `kms_sign_fee` (fixed, -5 USD-micros = $0.000005). Both written in the same transaction as the call status update so they can never be missed.

**Alternatives considered:**
- *Roll the sign fee into `contract_call_gas`:* Hides the markup in "gas" and conflicts with our "gas is at-cost, 0% markup" public commitment.
- *Bill sign fee at submission instead of confirmation:* Charges users for failed RPC submissions (no on-chain consumption). Unfair.

**Rationale:** Transparent line items beat hidden markup. Users see exactly what they pay for. The "gas at-cost, sign fee is the markup" story is honest and easy to defend.

**Rollback:** Drop the sign fee → bill at cost → revert pricing in docs. Not actually a rollback because pricing is published.

### DD-9: 90-day deletion + funds rescue lifecycle

**Decision:** When a wallet's `suspended_at` is older than 90 days:
1. **If on-chain balance ≤ 1000 wei (dust):** call `kms:ScheduleKeyDeletion` (7-day window), set `status='deleted'`, `deleted_at=NOW()`, clear `kms_key_id`. Done.
2. **If balance > dust AND `recovery_address` is set:** build + KMS-sign + broadcast a drain transaction sending `(balance - estimated_gas)` to the recovery address. Wait for receipt (the next reconciler tick will pick it up). Once confirmed, schedule key deletion as in case 1. Send confirmation email.
3. **If balance > dust AND `recovery_address` is null:** schedule key deletion immediately (after the day-60/75/88 warnings have been sent). Funds become permanently inaccessible. Send a final "your funds are lost" notification.

**Alternatives considered:**
- *Sweep abandoned funds to a "run402 unclaimed funds" wallet:* Custodial holding pattern. Legally complex, requires ongoing reconciliation, creates a target for compromise. Skipped.
- *Never delete; keep paying AWS forever:* Bleeds run402 indefinitely on every abandoned wallet. Defeats the rental model.
- *Deactivate (disable) the KMS key but never schedule deletion:* AWS still bills $1/month for disabled keys. Same problem as above.

**Rationale:** This balances three goals: (a) run402 doesn't bleed money on abandoned wallets, (b) users with the foresight to set a recovery address never lose funds, (c) users without a recovery address get three warning emails over 30 days plus a final "lost funds" notification — they can recover anytime by topping up cash.

**Risks:** A user with funds and no recovery address who never reads run402 emails loses money. *Mitigation:* warning cadence (60/75/88 days), CLI/MCP nudges to set a recovery address, prominent disclosure in the billing page.

**Rollback:** Disable the deletion job; wallets stay in `suspended` indefinitely.

### DD-10: Warning emails tracked via `last_warning_day` integer

**Decision:** New nullable column `last_warning_day INT` on `contract_wallets`. The reconciler computes "days since `suspended_at`" each tick; if it has just crossed 60, 75, or 88 AND `last_warning_day < {60|75|88}`, it sends the warning email and updates the column. Reactivation clears the column. Re-suspension restarts from 0.

**Alternatives considered:**
- *Three boolean columns (`warned_60`, `warned_75`, `warned_88`):* More storage, harder to reason about.
- *JSONB `warnings_sent`:* Overkill for an integer-keyed schedule.
- *Separate `wallet_warnings` table:* New table for what is fundamentally a single integer per wallet.

**Rationale:** Single integer captures "highest warning sent so far." Reset is one UPDATE. Idempotent across reconciler ticks.

**Rollback:** Drop the column; warnings stop firing but no data loss.

### DD-11: Chainlink ETH/USD price feed read via the same contract layer

**Decision:** ETH→USD price for gas accounting is read from the Chainlink ETH/USD price feed contract on Base (`0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70`) via `POST /contracts/v1/read`. The reconciler caches the result for 5 minutes. The same code path that handles user contract reads handles our internal price reads — recursive elegance, no separate price-oracle code to maintain.

**Alternatives considered:**
- *External API (Coingecko, CoinMarketCap):* Adds an outbound dependency, requires an API key, has rate limits, and is itself off-chain (defeats the point of "we're on-chain anyway").
- *Hard-coded fallback price:* Used to bootstrap on first call; we'll do this only as a last-resort fallback (return cached or hardcoded if Chainlink read fails) so a Chainlink outage doesn't block all gas accounting.

**Rationale:** Chainlink is the canonical on-chain price source. Reading via our own `contract_read` endpoint is delightfully self-referential and means we test our own read API every time we accrue a gas charge.

**Rollback:** Switch to a hardcoded fallback price; gas accounting is approximate but still works.

### DD-12: 30-day prepay creation gate enforced at the route, not the service

**Decision:** The `POST /contracts/v1/wallets` route handler checks `available_usd_micros >= 1200000` BEFORE calling the wallet provisioning service. The service itself does NOT check — it trusts its caller. This keeps the service unit-testable without billing fixtures.

**Alternatives considered:**
- *Service-layer check:* Tighter coupling between provisioning and billing; harder to unit test.
- *Database trigger:* Postgres-only, harder to debug.

**Rationale:** Standard layer separation. The route is the policy enforcement point; the service is the mechanism. Tests for the service mock the billing check; tests for the route exercise it for real.

**Rollback:** Remove the route check; wallets can be created without prepay (they'll be suspended on day 1).

## Risks / Trade-offs

**KMS cost runaway on abandoned wallets without recovery addresses:** A user creates 50 wallets, never funds them with rent, abandons them for 90 days. Run402 pays AWS $1/month × 50 × 3 months = $150 before the deletion job kicks in. *Mitigation:* the 30-day prepay creation gate ($1.20 minimum) means abandonment requires the user to first top up at least $1.20 per wallet they create. Real abandonment costs them at least $60 to set up. Combined with the daily debit eating their balance fast, the worst-case window is 90 days × $1/month × N abandoned wallets, but the user already paid for 30 of those days.

**KMS sign latency dominates simple-call latency:** A `POST /contracts/v1/call` returns 202 with `tx_hash` after the KMS sign + RPC submit. KMS sign is ~50-100ms; RPC submit is ~100-200ms. Total response time ~300ms vs ~50ms for a local-key signer. *Acceptable:* the user is going to wait 2+ seconds for chain confirmation anyway.

**Chainlink price feed staleness:** A 5-minute cache on ETH→USD means gas billing can be off by up to 5 minutes' worth of ETH price movement. At 2% daily volatility this is ~0.07% per 5 minutes — invisible noise on a $0.05 gas charge.

**Backward-compatibility risk:** The contract_calls and contract_wallets tables are new; the only existing-table change is adding new ledger kinds to the allowed enum on `allowance_ledger`. *Mitigation:* All existing E2E tests run unchanged in the backward-compat phase.

**IAM blast radius:** The gateway IAM role gains broad KMS permissions (CreateKey, Sign, ScheduleKeyDeletion). A compromised gateway could create or destroy KMS keys at will. *Mitigation:* the role does NOT get `kms:Decrypt`, so even with compromise, key material cannot be exfiltrated. Tagging requires every key be tagged `run402:project_id`, and the daily reconciler validates tag presence — orphaned keys get flagged.

**90-day deletion window vs. user vacation:** A user goes on a 3-month sabbatical; their wallet suspends on day 2; they return to find it deleted. *Mitigation:* warning emails on day 60/75/88, plus reactivation is automatic on top-up, plus the recovery address auto-drain rescues the funds (if set).

**Pricing-disclosure drift:** A future PR adds a new pricing surface (a use-case page, a localization) without updating the KMS pricing. *Mitigation:* the spec's "Pricing appears nowhere else" scenario requires a grep audit in the Ship & Verify phase. Should also be added to the release-checklist memory.

## Migration Plan

Additive change. No data transformation required.

1. **Database migration (server.ts startup, v1.20):**
   - `CREATE TABLE IF NOT EXISTS internal.contract_wallets (...)` with all columns from the proposal Impact section + indexes on `(project_id)`, `(status)`, `(suspended_at)`.
   - `CREATE TABLE IF NOT EXISTS internal.contract_calls (...)` with all columns + unique index on `(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.
   - `ALTER TABLE internal.allowance_ledger` (or whichever ledger table holds the kind enum) — extend the allowed kinds enum to include `kms_wallet_rental`, `kms_sign_fee`, `contract_call_gas`. If the ledger uses a TEXT column with no enum, this is a no-op DB-side and only affects application validators.

2. **AWS / Secrets Manager (manual one-time):**
   - Create secret `run402/base-mainnet-rpc-url` (Alchemy or Base public RPC)
   - Create secret `run402/base-sepolia-rpc-url` (for E2E)
   - Verify the gateway IAM role has the KMS permissions enumerated in the proposal

3. **CDK update (`infra/lib/pod-stack.ts`):**
   - Add KMS permissions to the gateway role
   - Add the two RPC URL secrets to the task definition env

4. **Stripe / billing setup:** None — billing reuses the existing `allowance_ledger` and `billing_accounts` cash balance.

5. **Deploy gateway:** All new routes are additive; existing routes unchanged. Backward-compat sweep runs as part of CI.

6. **Provision the kysigned platform wallet (manual one-time, post-deploy):** Use the new `run402 contracts provision-wallet` CLI to create the kysigned project's wallet. Fund it with ETH on Base (kysigned operator handles this). Update kysigned's config to reference the wallet ID + address. This step is owned by kysigned, not by this run402 plan, but is documented here for traceability.

7. **Cross-document update:** Edit `docs/products/kysigned/kysigned-spec.md` line 94 (Costs section) to cite the actual $0.04/day + $0.000005/sign pricing. This is the cross-document scenario in the spec.
