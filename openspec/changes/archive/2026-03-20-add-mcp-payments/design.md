## Context

The CLI already solves 402 payment transparently: `cli/lib/paid-fetch.mjs` reads the local allowance, branches on `rail` (x402 vs mpp), wraps native `fetch` with a payment interceptor, and returns a fetch function that auto-signs and retries on 402. The MCP server uses a different request path (`core/src/client.ts` → `apiRequest`) which detects 402 but just returns `{ is402: true }` for the tool handler to deal with. Today, four MCP tools return "Payment Required" informational text; two others (`provision`, `bundle-deploy`) treat 402 as a generic error.

The allowance file (`~/.config/run402/allowance.json`) contains the private key and rail config. It's already read by MCP tools for SIWX auth headers. The payment libraries (`viem`, `@x402/fetch`, `@x402/evm`, `mppx`) are already in the dependency tree via the CLI.

## Goals / Non-Goals

**Goals:**
- MCP tools that hit 402 automatically pay and retry, matching CLI behavior
- Support both x402 (Base mainnet + Sepolia) and mpp (Tempo) rails
- Graceful fallback: if no allowance exists, return the current informational 402 response
- Minimal surface area: one new module, targeted changes to `apiRequest` or tool handlers

**Non-Goals:**
- Changing the CLI's payment code — reuse it or mirror it, don't refactor it
- Adding new MCP tools for wallet management (allowance create/fund already exist)
- Supporting payment rails beyond x402 and mpp
- Changing the allowance file format

## Decisions

### 1. Where to put the paid-fetch logic: new `src/paid-fetch.ts` in MCP server

**Rationale**: The CLI's `paid-fetch.mjs` uses `process.exit` on missing allowance and is a `.mjs` file tied to CLI conventions. Core is pure data — no viem/payment deps. A new `src/paid-fetch.ts` mirrors the CLI's logic but returns `null` on missing allowance (MCP convention), and lives where the MCP build can import it.

**Alternative considered**: Putting it in `core/` — rejected because core currently has no viem/x402/mppx dependency and adding heavy crypto deps to the shared core would bloat the dependency tree for all consumers.

**Alternative considered**: Importing CLI's `paid-fetch.mjs` directly — rejected because it calls `process.exit(1)` on missing allowance, and mixing .mjs/.ts imports across packages is fragile.

### 2. Integration point: wrap `apiRequest` with a `paidApiRequest` helper

**Rationale**: Rather than modifying `apiRequest` in core (which would add a payment dependency to core), create a `paidApiRequest` function in the MCP server that:
1. Calls `setupPaidFetch()` once (lazy, cached)
2. If paid fetch is available, patches `globalThis.fetch` temporarily for the duration of the `apiRequest` call so the x402/mpp interceptor can do its job
3. If no allowance, falls through to bare `apiRequest`

This keeps core untouched. Tools swap `apiRequest` → `paidApiRequest` for calls that can hit 402.

**Alternative considered**: Passing a custom fetch to `apiRequest` — rejected because `apiRequest` doesn't accept a custom fetch parameter and changing core's interface is out of scope.

**Alternative considered**: Having each tool call `setupPaidFetch` and manage the fetch wrapper itself — rejected because it duplicates setup logic across 6+ tools.

### 3. Fallback behavior when no allowance is configured

If `setupPaidFetch()` returns `null` (no allowance file), `paidApiRequest` falls back to bare `apiRequest`. Tools that get `is402: true` from the fallback path continue to return their existing "Payment Required" informational text. This preserves backward compatibility for MCP clients that don't have a funded wallet.

### 4. Lazy initialization of paid fetch

`setupPaidFetch()` dynamically imports `viem`, `@x402/fetch`, `@x402/evm`, and `mppx` — these are heavy modules. The paid fetch is initialized once on first use and cached for the lifetime of the MCP server process. This avoids startup cost for tools that never hit 402.

## Risks / Trade-offs

- **[Risk] globalThis.fetch patching is not concurrency-safe** → The MCP server processes one tool call at a time (stdio transport is serial), so concurrent patching is not a concern. If the server ever moves to a concurrent transport, this would need a per-request fetch parameter instead.

- **[Risk] Payment succeeds but tool post-processing fails** → The payment is non-reversible. This is the same risk the CLI has. Mitigation: the paid fetch wrapper retries the original request with the payment proof, so the server response after payment is the same success response the tool expects.

- **[Risk] mppx or @x402/fetch not installed** → These are already in `package.json` for the CLI. Since MCP and CLI share the same `node_modules`, the imports will resolve. If someone installs just the MCP package standalone, the dynamic imports will throw — caught and treated as "no payment available" (same as missing allowance).
