# Tasks: kms-drain-gas-margin-fix

## 1. TDD — regression test

- [ ] 1.1 Write failing unit test in `contract-call.test.ts` — `submitDrainCall` against a wallet whose post-estimate balance is exactly `balance - estimatedGasCostWei`; after the fix, the drain should still succeed (not spend the entire balance on the final tx). Mock to simulate base-fee increase between first and second build. [code]

## 2. Implementation

- [ ] 2.1 Apply 20% safety margin in `submitDrainCall` at `contract-call.ts:236` — compute `gasReservation = (estimatedGasCostWei * 120n) / 100n` and subtract from balance. [code]
- [ ] 2.2 Update the `nothing_to_drain` guard check to use the reserved (margined) value, not the raw gas cost. [code]

## 3. Verification

- [ ] 3.1 Full gateway unit suite passes (1126 tests + any new ones). [code]
- [ ] 3.2 `npx tsc --noEmit -p packages/gateway` clean. [code]
- [ ] 3.3 Re-run `scripts/kms-e2e-full.mjs` against `api.run402.com` — drain phase 202 + delete 200. [code]

## 4. Ship

- [ ] 4.1 Commit + push. CI deploy-gateway.yml must succeed. [ship]
- [ ] 4.2 Smoke: after deploy, re-run the drain on the orphan `cwlt_61afd2501c6a46d7b14cdc59` from the closeout session. Expected: 202 + confirmed on-chain + delete 200. [ship]

## 5. Archive

- [ ] 5.1 Move change to `openspec/changes/archive/` with date suffix. [manual]

## Implementation Log

_(populated during implement)_
