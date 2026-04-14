# Tasks: kms-drain-gas-margin-fix

## 1. TDD — regression test

- [x] 1.1 Write failing unit test in `contract-call.test.ts` — `submitDrainCall` asserts the second build's value equals `balance - 1.2×gasCost`. RED: vanilla impl fails. [code]

## 2. Implementation

- [x] 2.1 Apply 20% safety margin in `submitDrainCall` at `contract-call.ts:236` — compute `gasReservation = (estimatedGasCostWei * 120n) / 100n` and subtract from balance. [code]
- [x] 2.2 Update `nothing_to_drain` guard to use reserved (margined) value; add `reserved_gas_cost_wei` to the 409 body. [code]
- [x] 2.3 **Extension (discovered during prod E2E):** relax DELETE gate at `routes/contracts.ts` — if the wallet has a confirmed drain in `internal.contract_calls`, accept balances up to `POST_DRAIN_RESIDUAL_WEI` (0.0001 ETH). Fresh wallets still gated at 1000-wei dust. [code]

## 3. Verification

- [x] 3.1 Full gateway unit suite passes — 1128/1128. [code]
- [x] 3.2 `npx tsc --noEmit -p packages/gateway` clean on all new code. [code]
- [x] 3.3 Re-ran `scripts/kms-e2e-full.mjs` against `api.run402.com` post-deploy. **Drain confirmed on-chain in 28s** (tx `0x94e5644bbad27f8797d913c63f1dc37fbe2bbf65b52f85721228d4f9e376f6d7`). Call id `ccall_4f21b31f039d4acc88509a14`. [code]
- [x] 3.4 **DELETE after drain — confirmed 200** on `cwlt_223fb3961d8c41f1a232ffd5` with 49843475866 wei residual. `kms_deletion_completes_at: 2026-04-21T16:32:53.156Z`. Lifecycle closes end-to-end. [code]

## 4. Ship

- [x] 4.1 Commit + push. CI deploy-gateway.yml runs #24410183960 + #24410631426 → success. [ship]
- [x] 4.2 Prod smoke — drain + delete both 200 on a freshly-provisioned wallet. [ship]

## 5. Archive

- [x] 5.1 Move change to `openspec/changes/archive/` — done via `git mv`. [manual]

## Implementation Log

### 2026-04-14 — landed in two commits

**Commit 1** (`3aec2df`): 20% gas-margin on drain value + 2 regression tests.
Fixed the 502 "insufficient funds" error observed on base-sepolia during
kms-wallet-contracts closeout (`have 599667399067838 want 599668728156616`).

**Commit 2** (`6e63898`): DELETE gate accepts post-drain residual up to
0.0001 ETH. Discovered during prod E2E verification of commit 1: drain
succeeded but DELETE 409'd because the margin residual (49843475866 wei
≈ 50 gwei) exceeded the strict 1000-wei DUST_WEI threshold. Fix: if the
wallet has a `confirmed` drain in `internal.contract_calls`, DELETE uses
a larger POST_DRAIN_RESIDUAL_WEI threshold. Fresh wallets still strict.

**Full prod lifecycle verified 2026-04-14 17:32 UTC:**
- Provision: `cwlt_223fb3961d8c41f1a232ffd5` (base-sepolia)
- Fund: 0.0005 ETH from `agentdb/faucet-treasury-key`
- On-chain call: USDC.approve → confirmed in 26s
- Drain: 202 + confirmed in 28s (tx `0x94e5644b...`)
- Delete: 200 with 49.8 gwei residual tolerated
