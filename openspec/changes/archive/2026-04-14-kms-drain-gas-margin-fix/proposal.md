# Proposal: kms-drain-gas-margin-fix

**Status:** Ready to implement
**Parent:** kms-wallet-contracts (closeout finding)
**Severity:** Low — cannot lose user funds; non-custodial delete refuses while balance > dust. Users just retry after a nanoEther top-up.

## Problem

Under EIP-1559, `submitDrainCall` fails intermittently with
`insufficient funds for gas * price + value` when the base fee ticks up
between the gas-estimation build and the final signed-transaction build.

Observed on base-sepolia 2026-04-14 during the kms-wallet-contracts E2E
closeout:

```
have 599667399067838 want 599668728156616
```

Delta: 1,329,088,778 wei (~1.33 gwei). The drain tried to send
`balance - gas * maxFeePerGas`, where `maxFeePerGas` was the value
returned from the FIRST `estimateFeesPerGas()` call. By the time the
SECOND `buildSignedTransaction` (with the refined `drainValue`) ran,
viem had refetched `estimateFeesPerGas()` and the base fee had risen
slightly, so the tx's final `value + gas*maxFeePerGas` exceeded balance.

## Current code

`packages/gateway/src/services/contract-call.ts:235-236`:

```ts
// Recompute the actual drain value: balance - estimated gas cost
const drainValue = balance - built.estimatedGasCostWei;
```

`packages/gateway/src/services/contract-call-tx.ts:121`:

```ts
const estimatedGasCostWei = gas * feeData.maxFeePerGas!;
```

`feeData.maxFeePerGas` is fetched fresh on each `buildSignedTransaction`
call, so the value seen by the caller is stale by the time the second
build broadcasts.

## Fix

Multiply `estimatedGasCostWei` by 1.2 (20% safety margin) when computing
`drainValue`. This leaves a small amount of dust (< 1000 wei threshold
usually, always below the wallet delete dust gate) in the wallet after
a successful drain — acceptable trade-off:

- **Upside:** drain broadcasts reliably even if base fee pops up to ~20%
  between the two builds. Base fee changes of up to 12.5% per block are
  allowed by EIP-1559; on chains with busy blocks (mainnet peaks) the
  margin must be comfortably above the worst-case inter-block delta.
- **Downside:** every drain leaves a few hundred gwei in the wallet.
  The follow-up `DELETE /wallets/:id` still succeeds because the
  post-drain residual is below the `DUST_WEI` threshold (1000 wei)
  exposed by `wallet-deletion.ts`.

One-line change in `contract-call.ts`:

```ts
const gasReservation = (built.estimatedGasCostWei * BigInt(120)) / BigInt(100);
const drainValue = balance - gasReservation;
```

## Alternatives considered

1. **Thread `maxFeePerGas` through both builds** so they use identical
   fee data. Rejected — more invasive, requires changing the
   `buildSignedTransaction` signature, and doesn't help if `gas` itself
   varies between estimates (it shouldn't for a plain value transfer,
   but EIP-1559 also permits priority-fee fluctuation). The safety
   margin is robust against wider variance.
2. **Retry loop** — catch "insufficient funds" and retry with a higher
   margin. Rejected — the first attempt has already spent the tx build
   and the broadcast failed, but in principle each retry costs nothing.
   Simpler to just reserve up front.
3. **Two-pass re-estimation with live fee** — call
   `estimateFeesPerGas` immediately before broadcasting, adjust value
   down if necessary, re-sign. Rejected — re-signing with a different
   value is a second KMS call ($0.000005 per sign) and roughly doubles
   the drain latency. The static safety margin is cheaper.

## Verification

- Unit test reproducing the failure mode (contract-call.test.ts): mock
  `buildSignedTransaction` to return a `estimatedGasCostWei` that when
  added to the would-be drainValue exceeds balance on the second
  build. Assert drain succeeds after the fix (i.e. the 20% reservation
  kept the final value + actual gas ≤ balance).
- Re-run `scripts/kms-e2e-full.mjs` against `api.run402.com` — drain
  phase must now 202 instead of 502. Wallet's post-drain residual must
  be < DUST_WEI so the subsequent delete succeeds.

## Out of scope

- The orphan wallet `cwlt_61afd2501c6a46d7b14cdc59` from the closeout
  run remains on base-sepolia with ~0.0006 ETH. Once this fix ships,
  the 90-day lifecycle will auto-drain it to the recovery address and
  delete it. No manual intervention needed.
