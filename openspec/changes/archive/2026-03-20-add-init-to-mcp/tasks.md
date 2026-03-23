## 1. Tool Implementation

- [x] 1.1 Create `src/tools/init.ts` with `initSchema` (optional `rail` param) and `handleInit` handler
- [x] 1.2 Implement allowance creation/reuse logic (reuse pattern from `allowance-create.ts`: Node crypto + `@noble/hashes`)
- [x] 1.3 Implement rail switching (update `allowance.json` rail field when param differs from stored value)
- [x] 1.4 Implement x402 faucet request via `apiRequest("/faucet/v1", ...)` with funded/lastFaucet update
- [x] 1.5 Implement mpp faucet request via plain fetch to Tempo RPC (`tempo_fundAddress`)
- [x] 1.6 Implement tier status check via `apiRequest("/tiers/v1/status", ...)` with allowance auth headers
- [x] 1.7 Implement project count from `loadKeyStore()`
- [x] 1.8 Build markdown summary response (table with config, address, network, rail, balance, tier, projects, next step)

## 2. Registration

- [x] 2.1 Import `initSchema` and `handleInit` in `src/index.ts`
- [x] 2.2 Register the `init` tool with description via `server.tool()`

## 3. Sync Test Update

- [x] 3.1 Update SURFACE entry in `sync.test.ts`: change `init` row from `mcp: null` to `mcp: "init"`

## 4. Unit Tests

- [x] 4.1 Create `src/tools/init.test.ts` following existing test pattern (mock fetch, temp keystore)
- [x] 4.2 Test: creates allowance when none exists
- [x] 4.3 Test: reuses existing allowance
- [x] 4.4 Test: requests x402 faucet when unfunded
- [x] 4.5 Test: requests mpp faucet when rail is mpp
- [x] 4.6 Test: skips faucet when already funded
- [x] 4.7 Test: handles faucet failure gracefully (non-fatal)
- [x] 4.8 Test: includes tier status in summary
- [x] 4.9 Test: includes project count in summary
- [x] 4.10 Test: rail switching updates allowance.json
- [x] 4.11 Test: idempotent — second call doesn't duplicate state

## 5. Verification

- [x] 5.1 Run `npm test` — all tests pass including sync test
- [x] 5.2 Run `npm run build` — TypeScript compiles without errors
