## Why

The CLI's shared `setupPaidFetch()` registers both Base mainnet and Base Sepolia with the x402 client. The default x402 selector picks the first network in the server's `accepts[]` array — mainnet — where faucet-funded wallets have zero USDC. This silently breaks all paid CLI commands (tier set, deploy, image generate) for testnet wallets. The e2e test masks this by catching the 402 error as a passing condition. Meanwhile, `functions.mjs` works around this with a local `setupPaidFetch` that hardcodes sepolia-only, creating code duplication and inconsistency. The MPP rail has the same risk: Tempo has both mainnet and Moderato (testnet), but the current code doesn't select based on where funds exist.

## What Changes

- Unify all CLI paid commands behind a single `setupPaidFetch()` in `cli/lib/paid-fetch.mjs` that checks on-chain balances and selects the funded network
- Remove the duplicate `setupPaidFetch()` in `cli/lib/functions.mjs`
- For x402: check USDC balance on Base mainnet and Base Sepolia in parallel, register both networks, add an x402 policy that filters to funded networks
- For MPP: check pathUSD balance on Tempo mainnet and Tempo Moderato in parallel, configure mppx with the funded network
- Fail fast with a clear error ("no funds on any supported network") if no network has balance, instead of letting the facilitator return a cryptic rejection
- Apply the same balance-aware logic in the MCP server's `src/paid-fetch.ts`
- Fix the e2e test for `tier set` so it actually validates payment success instead of swallowing 402 errors

## Capabilities

### New Capabilities
- `balance-aware-network-selection`: Check on-chain balances at setup time and select the network where the wallet has funds, for both x402 (Base mainnet vs Sepolia) and MPP (Tempo mainnet vs Moderato) rails

### Modified Capabilities

## Impact

- `cli/lib/paid-fetch.mjs` — rewrite to add balance checks and x402 policy
- `cli/lib/functions.mjs` — remove local `setupPaidFetch`, use shared one
- `src/paid-fetch.ts` — same balance-aware logic for MCP server
- `cli-integration.test.ts` — fix tier set test to validate actual payment success
- `cli-e2e.test.mjs` — may need mock updates for balance check calls
- Two additional RPC calls per CLI invocation (~200ms, parallelized, one-time cost)
