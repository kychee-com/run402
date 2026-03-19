# MPP Support Plan

## Summary

MPP (Machine Payments Protocol) uses the same 402->sign->retry pattern as x402, but with `mppx` SDK on the Tempo L1 blockchain instead of `@x402/fetch` on Base. The same Ethereum private key works on both — Tempo is EVM-compatible and `mppx` uses `privateKeyToAccount` from viem.

**Minimal product: `run402 init mpp`** — keep the same wallet, fund on Tempo, swap the payment SDK.

**Design principle: KISS.** Either x402 or MPP, not both at the same time. The `rail` field in allowance.json is the switch. No dual-rail complexity for v1.

---

## Tempo Chain Details

| | Mainnet | Testnet (Moderato) |
|---|---|---|
| Chain ID | 4217 | 42431 |
| RPC | `https://rpc.tempo.xyz` | `https://rpc.moderato.tempo.xyz` |
| Explorer | `https://explore.mainnet.tempo.xyz` | `https://explore.tempo.xyz` |
| viem import | `tempo` from `viem/chains` | `tempoModerato` from `viem/chains` |
| viem extension | `tempoActions()` from `viem/tempo` | same |
| Currency symbol | USD | USD |

**Critical differences from Base:**
- **No native gas token.** Transaction fees are paid in TIP-20 stablecoins (pathUSD). No ETH needed.
- **Stablecoin addresses are the same on testnet and mainnet:**
  - pathUSD: `0x20c0000000000000000000000000000000000000`
  - AlphaUSD: `0x20c0000000000000000000000000000000000001`
  - BetaUSD: `0x20c0000000000000000000000000000000000002`
  - ThetaUSD: `0x20c0000000000000000000000000000000000003`
- **Sub-second finality, 10k+ TPS**
- **viem native support** since v2.43.0

> **NOTE:** `tempoTestnet` in viem points to the deprecated Andantino testnet (chain ID 42429). Use `tempoModerato` for the active testnet.

---

## Tempo Testnet Faucet

The Tempo faucet is a **JSON-RPC call** — no web UI, no wallet connection needed. This maps perfectly to our current faucet flow.

```bash
curl -X POST https://rpc.moderato.tempo.xyz/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tempo_fundAddress","params":["0xYOUR_ADDRESS"],"id":1}'
```

**Response:** array of 4 transaction hashes (one per token).
**Gives:** 1M of each testnet stablecoin (pathUSD, AlphaUSD, BetaUSD, ThetaUSD).

### Tested (2026-03-19)

We tested the faucet directly. Results:

**1. Instant response.** The RPC call returns immediately with 4 tx hashes. No waiting.

**2. No rate limit.** Called twice in a row for the same address — both succeeded. Balance went from 1M to 2M pathUSD. No cooldown, no per-IP or per-address restriction observed.

**3. Balance is immediately available.** After the faucet call, `balanceOf` returned the updated balance on the very next RPC call. No polling needed — sub-second finality means the balance is confirmed by the time the faucet response arrives.

**4. Works for any address.** Tested with an arbitrary address (0x...dEaD) — worked fine. No prior account or wallet connection required.

**5. Token details confirmed:**
- pathUSD at `0x20c0000000000000000000000000000000000000`
- 6 decimals (same as USDC)
- Token name: "PathUSD"
- 1M pathUSD = `0xe8d4a51000` raw (1,000,000 * 10^6)

**6. Chain ID confirmed:** `0xa5bf` = 42431 (Tempo Moderato testnet)

### What this means for implementation

- **No polling loop needed.** Today's `init` polls for up to 30s waiting for on-chain confirmation. With Tempo, the balance is available immediately after the faucet call. We can skip the polling loop entirely.
- **No rate limit means no need for our own faucet proxy.** The CLI can call `tempo_fundAddress` directly without going through our gateway. This eliminates the need for a `POST /faucet/v1` endpoint for Tempo. **However:** we might still want a proxy to add our own rate limiting in the future, or to shield the RPC URL from changing. Decision: **start with direct calls (zero gateway work), add proxy later if needed.**
- **1M pathUSD per call is fine.** It's testnet money. Our current Base Sepolia faucet gives a much smaller amount and we had to manage rate limits carefully. With Tempo, agents get plenty of testnet funds and we don't have to worry about it.
- **The `init mpp` flow is simpler than `init x402`** because we skip polling and faucet rate limit concerns.

### Remaining faucet questions

- [ ] **Will Tempo add rate limits later?** This is a public testnet faucet. They may add limits as adoption grows. If that happens, we fall back to proxying through our gateway with a pre-funded wallet (same pattern as today's Base Sepolia faucet).
- [ ] **Do we call the faucet only when balance is 0?** Or always? Since there's no rate limit and it's testnet, we could call it every `init mpp` for simplicity. But that's wasteful. **Recommendation:** only call when balance is 0 (same as today).

---

## The `rail` Field

### Design: either/or, stored in allowance.json

```json
{
  "address": "0x12ab...89ef",
  "privateKey": "0x...",
  "created": "2026-03-19T12:00:00.000Z",
  "funded": true,
  "lastFaucet": "2026-03-19T12:00:00.000Z",
  "rail": "mpp"
}
```

- `rail` is `"x402"` (default if missing, backward-compatible) or `"mpp"`.
- `run402 init` -> x402 (current behavior, no change).
- `run402 init mpp` -> sets `rail: "mpp"`.
- Every command that reads the allowance checks `rail` to decide behavior.

### What happens when you already have a Base wallet and run `init mpp`?

This is the key DX question. Options:

**(a) Reuse the same key, just switch the rail and fund on Tempo.**
- `init mpp` reads existing allowance.json, sees the key, sets `rail: "mpp"`, calls Tempo faucet.
- The address is the same on both chains (same key = same address).
- Previous Base balance is not lost, just not used while in MPP mode.
- Switching back with `run402 init` (or `run402 init x402`) restores x402 mode.
- **Simplest. Recommended for v1.**

**(b) Warn and ask for confirmation.**
- "You have an existing x402 allowance with 5.00 USDC on Base Sepolia. Switch to MPP? (y/n)"
- More polite, but adds interactive prompts (our CLI currently avoids those — JSON output, no prompts).

**(c) Separate config files.**
- `allowance.json` for x402, `allowance-mpp.json` for MPP. Active one determined by a `rail` field in a separate config.
- More complex. Violates KISS.

**Recommendation:** Option (a). Same key, same file, flip the rail. The key works on both chains. If you want x402 back, run `init` again (or `init x402`).

### Open questions — rail switching

- [ ] **Should `init mpp` print the Base balance as a reminder?** e.g. "Note: your Base Sepolia balance of 5.00 USDC is still available if you switch back with `run402 init`."
- [ ] **Should we add `run402 init x402` as an explicit command?** Or is plain `run402 init` sufficient to mean "x402 mode"?
- [ ] **Does the MCP server need to know about the rail?** Currently it doesn't handle payment directly, but it does use `getAllowanceAuthHeaders()`. If SIWX chainId changes (see below), the MCP server's auth headers would also change.

---

## SIWX Auth — Chain ID Question

Today, SIWX auth hardcodes `chainId: 84532` (Base Sepolia):

```typescript
// core/src/allowance-auth.ts
const message = formatSIWEMessage({
  // ...
  chainId: 84532, // Base Sepolia
  // ...
});
const payload = {
  // ...
  chainId: "eip155:84532",
  // ...
};
```

### Resolved — auth chainId

**Keep Base Sepolia.** Verified: the gateway's `wallet-auth.ts` does NOT validate chainId. It checks domain, expiry, issuedAt, and signature only (uses `@x402/extensions/sign-in-with-x` `parseSIWxHeader` + `verifySIWxSignature`). The client can keep `chainId: "eip155:84532"` regardless of payment rail. **Zero auth changes needed for MPP.**

---

## CLI Changes

### `cli/lib/init.mjs` — add `mpp` subcommand

```
run402 init         # existing flow: x402, Base Sepolia
run402 init mpp     # new flow: MPP, Tempo testnet
```

When `mpp` is passed:
1. Create config dir (same)
2. Create or reuse wallet key (same `generatePrivateKey` / `privateKeyToAccount`)
3. Set `"rail": "mpp"` in allowance.json
4. Check pathUSD balance on Tempo via viem (`tempoModerato` chain, pathUSD contract)
5. If zero, fund via Tempo faucet (`tempo_fundAddress` RPC or proxied through our gateway)
6. Check tier status (same SIWX auth)
7. Show projects, suggest next step

**Balance check code sketch:**
```javascript
const { createPublicClient, http } = await import("viem");
const { tempoModerato } = await import("viem/chains");
const client = createPublicClient({ chain: tempoModerato, transport: http() });

const PATH_USD = "0x20c0000000000000000000000000000000000000";
// pathUSD uses the same ERC-20 balanceOf ABI
const raw = await client.readContract({
  address: PATH_USD,
  abi: USDC_ABI, // same ABI — balanceOf is standard ERC-20
  functionName: "balanceOf",
  args: [allowance.address],
});
```

### `cli/lib/paid-fetch.mjs` — branch on rail

```javascript
export async function setupPaidFetch() {
  if (!existsSync(ALLOWANCE_FILE)) {
    console.error(JSON.stringify({ status: "error", message: "No agent allowance found. Run: run402 init" }));
    process.exit(1);
  }
  const allowance = readAllowance();
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(allowance.privateKey);

  if (allowance.rail === "mpp") {
    const { Mppx, tempo } = await import("mppx/client");
    const mppx = Mppx.create({
      polyfill: false, // don't replace globalThis.fetch — we have non-paid requests
      methods: [tempo({ account })], // creates both charge + session methods
    });
    return mppx.fetch; // drop-in fetch replacement, handles 402 → sign → retry
  }

  // default: x402
  const { createPublicClient, http } = await import("viem");
  const { baseSepolia } = await import("viem/chains");
  const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { toClientEvmSigner } = await import("@x402/evm");
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  client.register("eip155:84532", new ExactEvmScheme(signer));
  return wrapFetchWithPayment(fetch, client);
}
```

### Resolved questions — CLI (from reading mppx@0.4.7 source)

- [x] **What is `mppx.fetch` exactly?** YES, it's a drop-in `fetch` replacement. From the source: `Mppx.create()` returns `{ fetch, rawFetch, methods, transport, createCredential }`. The `fetch` property wraps `globalThis.fetch` and auto-handles 402 responses. Same `(url, init?) => Promise<Response>` signature.
- [x] **`polyfill: true` mode.** By default `polyfill` is `true` — `Mppx.create()` replaces `globalThis.fetch` automatically. Set `polyfill: false` to only get `mppx.fetch` without replacing global. **For our CLI: use `polyfill: false`** and return `mppx.fetch` explicitly. We make non-paid requests (SIWX auth, faucet) that shouldn't be intercepted.
- [x] **`maxDeposit` parameter.** This is a sessions parameter, not for one-time charges. `tempo()` on the client creates both `charge` and `session` methods. For one-time payments (our use case), no deposit is needed. The `charge` method sends a direct token transfer, no channel/deposit involved.
- [x] **Does `mppx/client` handle the case where the server returns a non-MPP 402?** From the source: the HTTP transport checks `response.status === 402` then tries to parse a `WWW-Authenticate` header for the challenge. If the 402 doesn't have a valid MPP challenge, it would fail to extract the challenge. **This means: the gateway MUST return MPP-format 402s for the client to work.**
- [ ] **Does mppx work with Node.js 22?** Peer dep is `viem >= 2.46.2`. Our CLI has `viem ^2.47.1` — compatible. mppx itself uses ESM + modern JS. Should work. Need to test.
- [ ] **`cli/lib/allowance.mjs` balance command.** Currently shows Base mainnet + Base Sepolia + billing balance. MPP mode should show Tempo balance instead. Need to branch.

### `cli/lib/allowance.mjs` — balance changes

```javascript
// Today:
const [mainnetUsdc, sepoliaUsdc, billingRes] = await Promise.all([
  readUsdcBalance(mainnetClient, USDC_MAINNET, w.address),
  readUsdcBalance(sepoliaClient, USDC_SEPOLIA, w.address),
  fetch(`${API}/billing/v1/accounts/${w.address.toLowerCase()}`),
]);

// MPP mode: replace with Tempo balance
const [tempoPathUsd, billingRes] = await Promise.all([
  readTokenBalance(tempoClient, PATH_USD, w.address),
  fetch(`${API}/billing/v1/accounts/${w.address.toLowerCase()}`),
]);
```

---

## Gateway Changes

### `packages/gateway/src/middleware/x402.ts`

Today this middleware:
1. Intercepts requests to paid endpoints (`POST /tiers/v1/:tier`, `POST /generate-image/v1`)
2. Checks for x402 payment headers (`x-payment`, `payment-signature`, `x-402-payment`)
3. If present: verifies on-chain via x402 facilitator
4. If not: checks allowance ledger, debits if sufficient
5. If neither: returns 402 with payment challenge

**For MPP support, this middleware needs to also:**
1. Check for MPP payment credential (`Authorization: Payment ...` header)
2. If present: verify via `mppx/server`
3. Issue MPP-compatible 402 challenges (in addition to or instead of x402 challenges)

### Resolved questions — gateway (from reading mppx@0.4.7 source)

- [x] **Does `mppx/server` work with Express?** YES. There's a dedicated `mppx/express` export. It provides `Mppx.create()` that returns handlers as Express `RequestHandler` middleware, and a `payment()` function that wraps any intent into Express middleware. It internally converts Express `req`/`res` to standard `Request` via `Request.fromNodeListener()`.
- [x] **How does `mppx.charge()` interact with Express `req`?** The `mppx/express` middleware handles conversion. Usage is exactly:
  ```ts
  import { Mppx, tempo } from "mppx/express";
  const mppx = Mppx.create({ methods: [tempo.charge(...)], secretKey: "..." });
  app.post("/endpoint", mppx.charge({ amount: "0.03" }), handler);
  ```
- [x] **Settlement.** `mppx/server` handles verification end-to-end. The server `verify()` function for charge intents supports two modes: (1) `push` mode: client sends tx hash, server fetches receipt and verifies transfer logs on-chain. (2) `pull` mode: client sends signed tx, server broadcasts it and waits for confirmation. Either way, **mppx verifies the on-chain transfer** — we don't need to do it ourselves.
- [x] **Seller wallet on Tempo.** The `recipient` in `tempo.charge()` just receives the transfer. The server-side verify reads on-chain logs to confirm the transfer landed. The recipient doesn't need to be funded. Same address as our existing seller wallet works (`0x059D...`).
- [x] **402 response format.** MPP uses `WWW-Authenticate` headers for challenges (IETF HTTP Authentication standard). The server's `compose()` function can merge multiple method challenges into a single 402 response with multiple `WWW-Authenticate` headers. The client parses the `WWW-Authenticate` header to find a challenge matching its configured method.
- [x] **`secretKey` is required.** The server's `Mppx.create()` requires a `secretKey` for HMAC-bound stateless challenge verification. Add `MPP_SECRET_KEY` to our env vars / Secrets Manager.
- [x] **`testnet: true`** flag exists on `tempo.charge()` server-side parameters. This resolves the chain to Tempo Moderato (42431) instead of mainnet (4217).

### Remaining gateway questions

- [ ] **Do we support both x402 AND MPP on the gateway simultaneously?** Even if the CLI is either/or, the gateway serves all clients. The gateway should probably accept both. mppx's `compose()` merges multiple challenges into one 402 response — but it's designed for multiple MPP methods (tempo + stripe), not for mixing MPP with x402. **We likely need to keep the x402 code path alongside the MPP path, dispatching based on which payment header is present** (`Authorization: Payment ...` for MPP, `x-payment` for x402).
- [ ] **Allowance ledger bypass.** Today, the allowance ledger is an alternative to x402 (pre-funded balance). In MPP mode, do we still offer the allowance ledger as a fallback? Or is MPP the only payment path? **Leaning:** keep the allowance ledger as a third rail — it's orthogonal to the payment protocol.
- [ ] **Express version.** mppx has `express >= 5` as a peer dep. Check what version our gateway uses. If Express 4, this is a problem.

### Gateway code sketch (using mppx/express — verified from source)

```typescript
import { Mppx, tempo } from "mppx/express";

const PATH_USD = "0x20c0000000000000000000000000000000000000";

const mppx = Mppx.create({
  methods: [tempo.charge({
    currency: PATH_USD,
    recipient: process.env.SELLER_WALLET_ADDRESS,
    testnet: true, // use Tempo Moderato (42431) instead of mainnet (4217)
  })],
  secretKey: process.env.MPP_SECRET_KEY, // required — HMAC-bound stateless challenge verification
});

// Express middleware — just slot it into the route chain:
app.post("/generate-image/v1",
  mppx.charge({ amount: "0.03" }), // returns 402 with WWW-Authenticate or calls next()
  handleGenerateImage,              // only reached if payment verified
);

app.post("/tiers/v1/:tier",
  mppx.charge({ amount: "5.00" }),
  handleTierSet,
);
```

This is dramatically simpler than the current x402 middleware (~410 lines). `mppx/express`:
- Converts Express req/res to standard `Request` via `Request.fromNodeListener()`
- Returns 402 with `WWW-Authenticate` header if no credential
- Verifies on-chain payment (push mode: checks tx receipt logs, pull mode: broadcasts signed tx)
- Sets `Payment-Receipt` header on success
- Calls `next()` to proceed to the route handler

**Note:** Upgrade gateway to Express 5 (currently 4.18.2). mppx peer dep is `express >= 5`.

### Dual-rail pattern (tested in POC — `demos/mpp-test/`)

The dual-rail pattern is simple: x402 check middleware runs first, MPP middleware runs second.

```typescript
app.get("/premium",
  // 1. x402 check — if x402 header present, verify and respond (skip MPP)
  (req, res, next) => {
    const x402 = req.headers["x-payment"] || req.headers["payment-signature"];
    if (x402) {
      // verify x402 on-chain, then:
      return res.json({ data: "premium content" });
    }
    next();
  },
  // 2. MPP middleware — handles 402 challenge + verification
  mppx.charge({ amount: "0.03" }),
  // 3. Only reached if MPP payment verified
  (req, res) => {
    res.json({ data: "premium content" });
  },
);
```

Tested end-to-end (2026-03-19):
- `npx mppx http://localhost:3402/premium` → paid 0.10 pathUSD on Tempo testnet → `{"data":"premium content","paid_via":"mpp"}`
- `curl -H "x-payment: proof" http://localhost:3402/premium` → `{"data":"premium content","paid_via":"x402"}`
- `curl http://localhost:3402/premium` → 402 with `WWW-Authenticate: Payment ...` header

The 402 response contains the MPP challenge in the `WWW-Authenticate` header. x402 clients that don't understand MPP will see a standard 402 and can retry with their own headers. The middleware dispatches based on which header arrives.

---

## Dependencies

### CLI (`cli/package.json`)

| Today | Add for MPP |
|-------|-------------|
| `@x402/fetch` ^2.6.0 | `mppx` ^0.4.7 |
| `@x402/evm` ^2.6.0 | (included — mppx uses viem/tempo directly) |
| `viem` ^2.47.1 | `viem` >= 2.46.2 (mppx peer dep; our ^2.47.1 is fine) |

### Open questions — dependencies

- [ ] **What version of mppx is available?** Check `npm info mppx`.
- [ ] **Does mppx depend on viem internally?** If so, do versions conflict?
- [ ] **Package size.** mppx is new — how big is it? Does it pull in heavy dependencies? The CLI currently has a lean dependency tree.
- [ ] **Can we make x402 deps optional?** If rail is `mpp`, we never import `@x402/fetch` or `@x402/evm`. Dynamic imports already handle this (we use `await import()`). But the packages are still installed. Could use optional deps or peer deps to avoid bloat. **Probably not worth the complexity for v1.**

### Gateway (`packages/gateway/package.json`)

| Today | Add for MPP |
|-------|-------------|
| x402 facilitator deps | `mppx` |

---

## Security

### Private key reuse across chains

The same private key controls funds on both Base and Tempo. This is standard in EVM — the same key works on Ethereum, Base, Arbitrum, Tempo, etc.

**Risk:** If the key is compromised, funds on ALL chains are at risk. This is not new — it's the same risk as today (key controls Base mainnet + Sepolia).

### Open questions — security

- [ ] **Key rotation.** If a user switches from x402 to MPP, should we recommend rotating the key? Probably not — same risk profile. But document it.
- [ ] **Allowance.json permissions.** Already mode 0600 with atomic writes. No change needed.
- [ ] **Tempo testnet faucet gives 1M pathUSD.** That's fake money, but could a bug cause the CLI to accidentally use mainnet? Check that testnet/mainnet separation is solid. Today we hardcode `baseSepolia` chain. For MPP we'd hardcode `tempoModerato`. Same pattern.
- [x] **mppx key handling.** Verified from source: mppx uses viem's `signTransaction` and `sendCallsSync` locally. The private key never leaves the process. In `pull` mode, a signed tx (not the key) is sent to the server. In `push` mode, the client broadcasts the tx itself and sends only the tx hash. Safe.
- [ ] **Sessions and locked funds.** Sessions lock funds in a payment channel. If the process crashes, the channel has an expiry — funds are recoverable after timeout. But we don't use sessions for v1 (one-time charges only), so this is deferred.

---

## Backwards Compatibility

### Allowance.json

- Missing `rail` field -> default to `x402`. All existing allowance.json files continue to work.
- Adding `rail: "mpp"` is a non-breaking additive change.
- Older CLI versions that don't know about `rail` will ignore it and keep using x402. This is safe.

### Gateway

- If we keep the gateway accepting both x402 and MPP, no backwards compatibility issue.
- If we switch the gateway to MPP-only, all existing x402 agents break. **Don't do this.**

### MCP server

- The MCP server (`src/index.ts`) uses `getAllowanceAuthHeaders()` for auth. If we change the SIWX chainId based on rail, the MCP server needs to read the rail too. If we keep chainId as Base Sepolia regardless, no MCP change needed.

### OpenClaw skill

- Re-exports from CLI. Inherits changes automatically. No separate work needed.

### npm publishing

- `run402` (CLI) and `run402-mcp` (MCP server) are separate npm packages.
- CLI gets `mppx` dependency. MCP server doesn't need it (no payment in MCP server).
- Users on old CLI versions are unaffected — `run402 init` still works, `rail` field absent = x402.

### Open questions — backwards compatibility

- [ ] **sync.test.ts.** The sync test checks CLI commands. Adding `init mpp` as a subcommand — does the sync test need updating? It checks for command parity between CLI/OpenClaw. If `init mpp` is a subcommand of `init`, it might not need a new entry.
- [ ] **E2E tests.** The existing `cli-e2e.test.mjs` tests x402 flows. We need a parallel set for MPP. Or parameterize the existing tests by rail.
- [ ] **llms.txt.** The `site/llms.txt` documents all tools and endpoints. Needs updating to mention MPP support.

---

## Testability

### Local development

- [ ] **Can we test MPP end-to-end with Tempo testnet?** Faucet gives 1M pathUSD. Gateway on Tempo testnet. CLI in MPP mode. Should work.
- [ ] **Do we need a local Tempo node?** Probably not — testnet is public. Same as how we use Base Sepolia today (public RPC, no local node).
- [ ] **Mock mppx in unit tests?** Our test pattern mocks `globalThis.fetch`. Does mppx use `globalThis.fetch` internally, or does it have its own transport? If it uses `globalThis.fetch`, our existing mock pattern works.
- [ ] **Can we run both x402 and MPP tests in CI?** Yes — one test suite with `rail: "x402"`, another with `rail: "mpp"`. Both hit public testnets.

### E2E test plan

1. `run402 init mpp` — creates wallet, funds via Tempo faucet, sets rail
2. `run402 allowance status` — shows Tempo balance
3. `run402 tier set prototype` — pays with MPP on Tempo
4. `run402 projects provision` — provisions DB (payment via MPP)
5. `run402 image generate` — micropayment via MPP
6. Switch back: `run402 init` — rail back to x402, Base balance still there

### Open questions — testability

- [ ] **Tempo testnet reliability.** Is it stable enough for CI? Base Sepolia occasionally has issues. What's Tempo testnet uptime?
- [ ] **Faucet in CI.** If there's a rate limit on `tempo_fundAddress`, CI runs could fail. We'd need our own faucet proxy with a funded wallet (same as today's `POST /faucet/v1`).
- [ ] **Test isolation.** Each test run creates a new wallet and funds it. With Tempo faucet giving 1M, we don't need to worry about running out. But rate limits could be an issue.

---

## DX Summary

### User journey: new agent, MPP mode

```
$ npm i -g run402
$ run402 init mpp

  Config     ~/.config/run402
  Allowance  0xA1b2...C3d4 (created)
  Network    Tempo Moderato (testnet)
  Balance    0 pathUSD — requesting faucet...
  Balance    1000000.00 pathUSD (funded)
  Rail       mpp
  Tier       (none)

  Next: run402 tier set prototype

$ run402 tier set prototype

  Tier set to prototype (expires 2026-04-18)
  Payment: 0.00 pathUSD via MPP on Tempo testnet

$ run402 deploy --manifest app.json
  ...
```

### User journey: existing x402 agent switches to MPP

```
$ run402 init mpp

  Config     ~/.config/run402
  Allowance  0xA1b2...C3d4 (existing)
  Network    Tempo Moderato (testnet)
  Note       Base Sepolia balance: 5.00 USDC (available if you switch back)
  Balance    0 pathUSD — requesting faucet...
  Balance    1000000.00 pathUSD (funded)
  Rail       mpp (was: x402)
  Tier       prototype (expires 2026-04-18)

  Ready to deploy. Run: run402 deploy --manifest app.json
```

### Switching back

```
$ run402 init

  Config     ~/.config/run402
  Allowance  0xA1b2...C3d4 (existing)
  Network    Base Sepolia
  Balance    5.00 USDC
  Rail       x402 (was: mpp)
  Tier       prototype (expires 2026-04-18)

  Ready to deploy. Run: run402 deploy --manifest app.json
```

---

## Protocol Comparison

| | x402 | MPP |
|---|---|---|
| 402 challenge body | Payment details (payTo, amount, network) | Challenge object (challengeId, amount, recipient) |
| Client retry header | `x-payment` / `payment-signature` | `Authorization: Payment ...` |
| Verification | x402 facilitator checks on-chain (Base) | mppx server verifies credential (Tempo) |
| Chain | Base mainnet (8453) / Sepolia (84532) | Tempo mainnet (4217) / Moderato (42431) |
| Currency | USDC | pathUSD |
| Gas token | ETH (for on-chain tx fees) | **None — fees paid in stablecoins** |
| SDK (client) | `@x402/fetch` + `@x402/evm` | `mppx/client` |
| SDK (server) | x402 facilitator middleware | `mppx/server` |
| Wallet | `privateKeyToAccount` (viem) | `privateKeyToAccount` (viem) — **same** |
| Sessions | No (one-shot per request) | Yes (open channel, stream micropayments) |
| Finality | ~2s (Base) | Sub-second (Tempo) |

---

## Implementation Order

### Phase 1: CLI — `run402 init mpp` + paid-fetch

1. Add `mppx` to `cli/package.json`
2. Add `rail` field to `AllowanceData` in `core/src/allowance.ts`
3. Implement `init mpp` in `cli/lib/init.mjs` (Tempo faucet, pathUSD balance check, set rail)
4. Update `cli/lib/paid-fetch.mjs` to branch on `rail`
5. Update `cli/lib/allowance.mjs` balance/status to show Tempo balance in MPP mode

### Phase 2: Gateway — accept MPP payments

1. Add `mppx` to `packages/gateway/package.json`
2. Add MPP verification path to payment middleware (inspect header, route to x402 or MPP verifier)
3. Fund seller wallet on Tempo testnet (same address, just needs pathUSD for... actually recipient doesn't need funds)
4. Start with `POST /generate-image/v1` (narrowest paid endpoint)
5. Extend to `POST /tiers/v1/:tier`

### Phase 3: Polish + docs

1. `run402 status` shows rail + correct chain balance
2. Update llms.txt, README, SKILL.md
3. sync.test.ts updates
4. E2E tests for MPP flow
5. Consider Tempo faucet proxy in gateway for rate limit control

---

## Sessions (Future — Not v1)

MPP supports sessions — "OAuth for money." An agent opens a session with a spending cap, then streams micropayments without a separate on-chain tx per request. This would be ideal for:
- High-frequency SQL queries
- Streaming function invocations
- Real-time subscriptions

Not needed for v1. Current per-request 402 flow works fine. Revisit when we have high-frequency use cases.

---

## Open Questions Master List

### Resolved (from mppx@0.4.7 source + faucet testing)

1. ~~**What is the exact `mppx.fetch` API?**~~ YES — drop-in `fetch` replacement. Same `(url, init?) => Promise<Response>` signature. Use `polyfill: false` to avoid replacing global fetch.
2. ~~**Does `mppx/server` work with Express?**~~ YES — dedicated `mppx/express` export with `Mppx.create()` returning Express `RequestHandler` middleware.
3. ~~**Tempo faucet rate limits?**~~ No rate limit observed. Called twice in a row, both succeeded. Balance stacks (1M -> 2M). Instant confirmation, no polling needed.
4. ~~**Does mppx send the private key over the network?**~~ NO — signs locally via viem. In `push` mode sends tx hash only. In `pull` mode sends signed tx only.
5. ~~**Settlement verification?**~~ mppx server handles it end-to-end — parses on-chain transfer logs to verify payment.
6. ~~**Seller wallet needs funding?**~~ NO — recipient just receives transfers. Same address (`0x059D...`) works on Tempo.

### Must answer before building

1. ~~**Express version compatibility.**~~ Upgrade gateway to Express 5. We're on 4.18.2, mppx needs >= 5. No reason to stay on 4. Do this as a prerequisite step.
2. ~~**Dual-rail gateway architecture.**~~ Resolved: the 402 response includes BOTH x402 body (payTo, amount, network) AND MPP `WWW-Authenticate` header. Clients pick the one they understand. On retry, dispatch by checking which header arrived: `Authorization: Payment ...` → mppx verifier, `x-payment`/`payment-signature` → x402 verifier. Small plumbing, not a design question.
3. ~~**SIWX chainId in MPP mode.**~~ Keep Base Sepolia. The gateway does NOT validate chainId — it checks domain, expiry, issuedAt, and signature only (`wallet-auth.ts`). So the client can keep `chainId: "eip155:84532"` regardless of payment rail. Zero auth changes needed.

### Should answer before building

4. Should `init mpp` with existing wallet show the Base balance as a note?
5. Should we add explicit `run402 init x402` or is plain `run402 init` enough?
6. Does the MCP server need rail awareness?

### Can defer

7. Sessions (streaming micropayments)
8. Mainnet MPP (we start on testnet, same as x402)
13. Tempo explorer links in CLI output
14. mppx package size / dependency audit
15. Key rotation guidance

---

## References

- [MPP payments | Stripe Documentation](https://docs.stripe.com/payments/machine/mpp)
- [Introducing the Machine Payments Protocol](https://stripe.com/blog/machine-payments-protocol)
- [Stripe's MPP vs. x402](https://defiprime.com/stripe-mpp-vs-x402)
- [MPP Developer Docs](https://mpp.dev/overview)
- [MPP Agent Quickstart](https://mpp.dev/quickstart/agent)
- [MPP Server Quickstart](https://mpp.dev/quickstart/server)
- [Tempo Mainnet Announcement](https://tempo.xyz/blog/mainnet)
- [Tempo GitHub](https://github.com/tempoxyz/tempo)
- [Tempo Docs](https://docs.tempo.xyz/)
- [Tempo Faucet](https://docs.tempo.xyz/quickstart/faucet)
- [Tempo Connection Details](https://docs.tempo.xyz/quickstart/connection-details)
- [Tempo Tooling | Chainstack](https://docs.chainstack.com/docs/tempo-tooling)
- [tempo_fundAddress RPC | Chainstack](https://docs.chainstack.com/reference/tempo-tempo-fundaddress)
- [MPP + Privy Integration](https://docs.privy.io/recipes/agent-integrations/mpp)
- [Viem Tempo Getting Started](https://viem.sh/tempo)
