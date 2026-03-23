## Context

The CLI `init` command (`cli/lib/init.mjs`) is a composite setup flow that sequences: config dir creation, allowance creation, faucet funding, tier check, and project count — outputting a human-readable summary. The MCP server already has individual tools for each step (`allowance_create`, `request_faucet`, `tier_status`, `check_balance`) but no single-call equivalent.

The MCP's existing tool pattern: each tool in `src/tools/` exports a Zod schema and an async handler returning `{ content: [{type: "text", text: string}], isError?: boolean }`. Tools use `core/` modules for state and `src/errors.ts` for error formatting.

## Goals / Non-Goals

**Goals:**
- Add a single `init` MCP tool that bootstraps an agent in one call
- Match CLI behavior: idempotent, creates allowance if missing, funds if unfunded, reports tier + project count
- Support rail selection (`x402` or `mpp`) like `run402 init mpp`
- Use the same state files as CLI (`allowance.json`, `keystore.json`)
- Update sync test to reflect MCP parity

**Non-Goals:**
- No on-chain balance reads via viem — MCP avoids that dependency. Use the billing API and faucet API instead.
- No interactive polling (the CLI polls on-chain for up to 30s) — MCP returns immediately after the faucet request
- Not adding `status`, `projects:info`, `projects:use`, or `projects:keys` to MCP in this change

## Decisions

### 1. Single composite tool (not just documentation)

The `init` tool performs real work — it creates the allowance and calls the faucet API — rather than telling the LLM to call existing tools in sequence. This matches the CLI's behavior where `init` is a single command, not a script.

**Alternative**: A "guide" tool that returns instructions for the LLM to call other tools. Rejected because it increases round-trips and the LLM might skip steps.

### 2. Reuse existing core modules directly

The handler calls `readAllowance()`, `saveAllowance()`, `loadKeyStore()`, `getAllowanceAuthHeaders()`, and `apiRequest()` from core — the same functions the individual MCP tools use. No new abstractions.

**Alternative**: Call the existing MCP tool handlers internally. Rejected because handler signatures include MCP response wrapping; calling core directly is simpler and avoids double-wrapping.

### 3. Faucet via API, not on-chain

The CLI uses viem to read on-chain USDC balance and poll after faucet. The MCP tool calls `POST /faucet/v1` (same as `request_faucet` tool) and `GET /billing/v1/accounts/:wallet` for balance. No viem dependency needed.

For MPP rail, the tool calls the Tempo RPC faucet (`tempo_fundAddress`) via a plain fetch POST, same as the CLI does, but skips the on-chain balance read.

### 4. Rail stored in allowance.json

The CLI stores `rail` in `allowance.json`. The MCP tool does the same — if `rail` param is provided and differs from stored value, update it. This keeps the two interfaces interoperable on the same state file.

### 5. Tool name: `init`

Matches the CLI command name and the SURFACE entry ID. Simple and clear.

## Risks / Trade-offs

- **[Faucet without balance confirmation]** The MCP tool fires the faucet request but doesn't poll for on-chain confirmation like the CLI. The returned summary says "faucet requested" rather than "funded with X USDC". → Acceptable: the LLM can call `check_balance` later if needed. The billing API balance updates within seconds.

- **[MPP faucet is a raw RPC call]** The Tempo faucet uses a JSON-RPC call to `https://rpc.moderato.tempo.xyz/`. This is the same approach as the CLI. → Low risk: it's a simple POST.

- **[Allowance key generation without viem]** The existing `allowance_create` tool uses Node crypto + `@noble/hashes` (already a dependency) instead of viem's `generatePrivateKey`. The `init` tool reuses this same approach. → No new dependency needed.
