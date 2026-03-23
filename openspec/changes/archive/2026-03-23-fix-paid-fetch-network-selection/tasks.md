## 1. Balance check utility

- [x] 1.1 Add a `checkUsdcBalance(publicClient, tokenAddress, walletAddress)` helper to `cli/lib/paid-fetch.mjs` (reuse the USDC_ABI pattern from `cli/lib/allowance.mjs`)
- [x] 1.2 Add token contract addresses as constants (Base mainnet USDC, Base Sepolia USDC, Tempo pathUSD) — consolidate from existing duplicates in `init.mjs` and `allowance.mjs`

## 2. CLI paid-fetch.mjs — x402 balance-aware selection

- [x] 2.1 In `setupPaidFetch()` x402 branch: create both mainnet and sepolia public clients, check USDC balance on both in parallel
- [x] 2.2 Register both networks with the x402 client, then register a policy that filters `accepts[]` to networks with non-zero balance
- [x] 2.3 If the policy would filter out all networks (zero balance everywhere), throw with an actionable error message including balances and funding guidance

## 3. CLI paid-fetch.mjs — MPP balance-aware selection

- [x] 3.1 In `setupPaidFetch()` MPP branch: check pathUSD balance on Tempo Moderato
- [x] 3.2 Configure mppx `tempo()` with the funded network (verified: mppx network selection is server-driven via chainId in www-authenticate, client just needs balance check for fail-fast)
- [x] 3.3 If no Tempo network has balance, throw with an actionable error message

## 4. Remove functions.mjs duplicate

- [x] 4.1 Delete the local `setupPaidFetch()` function from `cli/lib/functions.mjs`
- [x] 4.2 Import `setupPaidFetch` from `./paid-fetch.mjs` in `cli/lib/functions.mjs`
- [x] 4.3 Verify functions deploy still passes e2e tests

## 5. MCP server paid-fetch.ts

- [x] 5.1 Apply the same balance-aware x402 policy logic to `src/paid-fetch.ts` `setupPaidFetch()`
- [x] 5.2 Apply the same MPP balance-aware logic to `src/paid-fetch.ts` (MCP server degrades gracefully — no process.exit, returns null on failure)
- [x] 5.3 Add fail-fast error when no network has funds

## 6. Tests

- [x] 6.1 Fix `cli-integration.test.ts` tier set test: remove the catch that swallows "Payment required" — the test should validate actual payment success
- [x] 6.2 Add unit tests for the balance-aware policy in `cli/lib/paid-fetch.mjs` (mock RPC balance calls, verify correct network is selected)
- [x] 6.3 Update `src/paid-fetch.test.ts` for the new balance-check behavior
- [x] 6.4 Run full test suite (`npm test`) and verify all tests pass
