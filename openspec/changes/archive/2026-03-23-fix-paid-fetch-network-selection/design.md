## Context

The CLI and MCP server both have `setupPaidFetch()` functions that create x402/MPP payment wrappers. The CLI has two copies — a shared one in `cli/lib/paid-fetch.mjs` (used by `tier.mjs` and `image.mjs`) and a local one in `cli/lib/functions.mjs` (sepolia-only). The shared one registers both Base mainnet and Base Sepolia, but the x402 default selector picks the first entry in the server's `accepts[]` — which is mainnet. Faucet-funded wallets have zero mainnet USDC, so the EIP-3009 authorization is signed for mainnet, the facilitator can't settle it, and the server returns 402 again.

The MCP server has a parallel implementation in `src/paid-fetch.ts` that also registers both networks without balance awareness.

## Goals / Non-Goals

**Goals:**
- Single `setupPaidFetch()` in CLI — all paid commands use the same code path
- Balance-aware network selection: check on-chain balances at setup, pick the funded network
- Fail fast with a clear error when no supported network has funds
- Same logic in MCP server's `src/paid-fetch.ts`
- Fix the broken e2e test for `tier set`

**Non-Goals:**
- Changing the x402 protocol or `@x402/fetch` library
- Adding network selection UI (the whole point is it's automatic)
- Handling mid-session balance changes (setup-time check is sufficient)
- Adding mainnet support to the faucet or changing faucet behavior

## Decisions

### 1. Check balances at setup time, use x402 `registerPolicy` for filtering

**Decision**: Read USDC balances on both networks during `setupPaidFetch()`, then register an x402 policy that filters `accepts[]` to only funded networks.

**Why**: The x402 `registerPolicy` API is synchronous, so balance must be known beforehand. A one-time parallel RPC call at setup (~200ms) is acceptable. The alternative — patching the selector itself — would couple us to x402 internals.

**Alternative considered**: Only register the funded network (don't register mainnet if balance is 0). This works but is less transparent — a policy makes the filtering explicit and doesn't affect scheme registration.

### 2. Fail fast when no network is funded

**Decision**: If the policy filters out all networks (no balance anywhere), throw immediately with a descriptive error like `"No USDC balance on any supported network (Base: 0, Base Sepolia: 0). Fund your wallet or request faucet."` rather than letting the x402 client throw a generic `"No network/scheme registered"` error.

**Why**: Users need actionable guidance, not x402 internals.

### 3. Remove functions.mjs local setupPaidFetch

**Decision**: Delete the inline `setupPaidFetch()` in `cli/lib/functions.mjs` and import from `cli/lib/paid-fetch.mjs`.

**Why**: The local copy exists because the shared version didn't work on testnet. With balance-aware selection, the shared version handles testnet correctly. One code path = one place to fix bugs.

### 4. MPP: pass network config to mppx based on balance

**Decision**: For MPP rail, check pathUSD balance on both Tempo mainnet and Tempo Moderato (testnet) in parallel. Configure `mppx` with the funded network. The `mppx` `tempo()` method accepts chain configuration — pass the appropriate one.

**Why**: Same principle as x402. The current MPP code path doesn't specify which Tempo network, defaulting to whatever mppx chooses. Making it explicit and balance-aware prevents the same class of bug.

### 5. Shared balance-check utility

**Decision**: Extract USDC/pathUSD balance reading into a small helper (reuse the `USDC_ABI` + `readContract` pattern already in `cli/lib/allowance.mjs` and `cli/lib/init.mjs`). Use it in `setupPaidFetch()` for both rails.

**Why**: This pattern is already duplicated across `allowance.mjs`, `init.mjs`, and `functions.mjs`. Centralizing it reduces copy-paste and keeps token addresses consistent.

## Risks / Trade-offs

- **[Two extra RPC calls per invocation]** → Parallelized, ~200ms one-time cost. Acceptable for CLI. Cached in MCP server (setupPaidFetch runs once).
- **[Balance can change between check and payment]** → Unlikely in a CLI session. If it happens, the facilitator rejects and the user gets a clear error. Not worth adding real-time checks for.
- **[mppx API may not support explicit network selection]** → Need to verify the `tempo()` config API. If it doesn't support it, we may need to configure the chain directly. Mitigation: check mppx docs/source before implementing.
