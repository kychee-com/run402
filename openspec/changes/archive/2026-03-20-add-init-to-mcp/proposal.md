## Why

The MCP server is missing the `init` capability — the single-call setup flow that the CLI provides via `run402 init`. Today an LLM using the MCP must discover and sequence 3-5 individual tools (`allowance_create`, `request_faucet`, `allowance_status`, `tier_status`, `check_balance`) to bootstrap a new agent. A single `init` tool matches the CLI's one-command onboarding and reduces round-trips for the most common first interaction.

## What Changes

- Add a new MCP tool `init` that performs the same idempotent setup flow as `cli/lib/init.mjs`:
  1. Ensure config directory exists
  2. Create allowance if none exists (or return existing)
  3. Request faucet if balance is zero (x402 rail only — no on-chain polling, just fire the API call)
  4. Check tier status
  5. Report project count from local keystore
  6. Return a single markdown summary with next-step guidance
- The tool accepts an optional `rail` parameter (`"x402"` | `"mpp"`) to match the CLI's `init mpp` variant
- Update `sync.test.ts` SURFACE array to set `mcp: "init"` for the `init` capability
- No on-chain balance reads (no viem dependency in MCP) — the tool calls the Run402 faucet API and billing API instead

## Capabilities

### New Capabilities
- `mcp-init`: The MCP `init` tool — single-call agent bootstrap that creates allowance, funds it, checks tier, and reports status

### Modified Capabilities

## Impact

- **New file**: `src/tools/init.ts` (schema + handler)
- **Modified**: `src/index.ts` (register the tool)
- **Modified**: `sync.test.ts` (update SURFACE entry for `init` from `mcp: null` to `mcp: "init"`)
- **Dependencies**: No new dependencies — reuses existing core modules (`allowance.ts`, `keystore.ts`, `allowance-auth.ts`, `client.ts`) and existing MCP helpers (`errors.ts`, `allowance-auth.ts`)
