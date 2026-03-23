## Why

The MCP server detects 402 responses but cannot execute payments. When a tool hits a paywall, it returns "Payment Required" text and hopes the LLM figures it out externally. The CLI already handles this transparently via `setupPaidFetch()` — wrapping fetch with `@x402/fetch` (Base USDC) or `mppx.fetch` (Tempo pathUSD). The MCP should do the same: if the agent has a funded allowance, pay automatically and retry, just like the CLI does.

## What Changes

- Add a `paid-fetch` module to the MCP server (or core) that creates a payment-wrapping fetch using the local allowance private key, supporting both x402 and mpp rails
- Replace bare `apiRequest` calls with paid-fetch-aware requests in all tools that can encounter 402:
  - `set-tier` — currently returns informational payment text
  - `generate-image` — currently returns informational payment text
  - `deploy-function` — currently returns informational payment text
  - `invoke-function` — currently returns informational payment text
  - `provision` — currently treats 402 as a generic error via `formatApiError`
  - `bundle-deploy` — currently treats 402 as a generic error via `formatApiError`
- Remove the "Payment Required" informational text responses — tools should just pay and succeed, matching CLI behavior
- Fall back gracefully when no allowance is configured: return the existing informational 402 response so the tool still works for agents without a wallet

## Capabilities

### New Capabilities
- `mcp-paid-fetch`: Payment-wrapping fetch for the MCP server — reads the local allowance, branches on rail (x402 vs mpp), and returns a wrapped fetch that intercepts 402 responses, signs payment, and retries automatically

### Modified Capabilities

## Impact

- **`core/src/client.ts`** or new **`src/paid-fetch.ts`**: New module providing `setupPaidFetch()` for MCP context (no `process.exit`, returns null on missing allowance)
- **`src/tools/*.ts`**: Six tool handlers updated to use paid fetch instead of bare `apiRequest` when allowance is available
- **Dependencies**: `viem`, `@x402/fetch`, `@x402/evm`, and `mppx` are already in the project's dependency tree (used by CLI) — MCP server just needs to import them
- **No breaking changes**: Tools that currently work without an allowance continue to work — payment is only attempted when an allowance exists and a 402 is returned
