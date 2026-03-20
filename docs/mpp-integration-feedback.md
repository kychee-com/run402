# MPP Integration Feedback for the Tempo/mppx Team

From: Run402 (https://run402.com) — Postgres & static hosting for AI agents
Integration: dual-rail gateway accepting both x402 and MPP on every paid endpoint
SDK version: mppx@0.4.7
Date: 2026-03-20

---

## What went well

**Tempo faucet is incredible.** `tempo_fundAddress` is instant, no rate limits, no polling needed. Our x402 faucet on Base Sepolia requires 30s of polling and has a 1-per-day rate limit. The Tempo faucet made our `init mpp` flow 10x faster (300ms vs 30s). This is a huge deal for agent onboarding.

**Same wallet key on both chains.** This was the single most important architectural property. It meant we could add MPP as a rail switch (`run402 init mpp`) without touching wallet creation, SIWX auth, or any identity code. One key, two chains.

**`mppx/client` drop-in fetch.** `Mppx.create({ polyfill: false, methods: [tempo({ account })] }).fetch` was a clean drop-in replacement for our x402 `wrapFetchWithPayment`. The 402 challenge-response flow is handled transparently.

**Express middleware API.** `mppx.charge({ amount })` returning an Express middleware is the right abstraction for single-protocol servers.

---

## Bugs

### 1. `mppx/express` middleware hangs on mock/synthetic requests

**Severity: high** — caused a production outage during our deploy.

The Express middleware calls `Request.fromNodeListener(req, res)` (via `@remix-run/node-fetch-server`) which reads the request body as a stream. If you pass a minimal mock object (common for challenge pre-generation), it hangs forever waiting for body data that never arrives.

We tried to generate a `WWW-Authenticate` challenge for our 402 responses by calling `mppxInstance.charge({ amount })(mockReq, mockRes, next)` with a lightweight mock. This blocked **every request** to priced endpoints until the ALB timed out at 60s.

**Workaround:** Create a second Mppx instance from `mppx/server` (not `mppx/express`) and call the handler with a real Fetch `Request` object:

```typescript
const { Mppx: MppxServer } = await import("mppx/server");
const mppxCore = MppxServer.create(config);
const handler = mppxCore.charge({ amount });
const result = await handler(new Request("http://localhost/"));
if (result.status === 402) {
  return result.challenge.headers.get("www-authenticate");
}
```

**Suggestion:** Either make `fromNodeListener` resilient to incomplete request objects (e.g., treat missing body as empty), or document that the Express middleware must only be called with real Express requests.

---

## Wishlist

### 2. Public challenge generation API

We need to generate `WWW-Authenticate` challenges without going through middleware — to embed them in 402 responses that also contain x402 payment info. Currently this requires creating a separate `mppx/server` instance and calling it with a synthetic Fetch Request.

A dedicated method would be much cleaner:

```typescript
// Ideal API
const challenge = mppxInstance.createChallenge({ amount: "0.10" });
// Returns: 'Payment challenge="eyJ...", methods="tempo", amount="0.10", ...'
```

Or export it from the charge method:

```typescript
const { challengeHeader } = mppxInstance.charge.generateChallenge({ amount: "0.10" });
```

### 3. Wallet address extraction helper

After `mppx.charge()` calls `next()` (payment verified), we need the payer's wallet address to associate with the request. Currently we have to manually parse the credential:

```typescript
const token = authHeader.slice("Payment ".length);
const decoded = JSON.parse(Buffer.from(token, "base64").toString());
const source = decoded.source || ""; // "did:pkh:eip155:42431:0x..."
const address = source.split(":").pop();
```

A helper would be cleaner:

```typescript
import { Credential } from "mppx";
const address = Credential.extractAddress(authHeader);
// or: Credential.deserialize(token).address
```

The `Credential` type has `source?: string` but no convenience method to extract just the address. Also, `Credential` is not re-exported from `mppx/express`, so you need a separate `import { Credential } from "mppx"`.

### 4. pathUSD contract address constant

The pathUSD address `0x20c0000000000000000000000000000000000000` is used in multiple places (charge config, balance checks, faucet setup). Exporting it as a named constant would prevent typos:

```typescript
import { TEMPO_PATH_USD } from "mppx/tempo";
// or
import { tempo } from "mppx/server";
tempo.PATH_USD // "0x20c0000000000000000000000000000000000000"
```

### 5. Tempo chain definition for viem

We had to define the Tempo Moderato chain manually for balance checks:

```typescript
const tempoModerato = defineChain({
  id: 42431,
  name: "Tempo Moderato",
  nativeCurrency: { name: "pathUSD", symbol: "pathUSD", decimals: 6 },
  rpcUrls: { default: { http: ["https://rpc.moderato.tempo.xyz/"] } },
});
```

If `mppx` exported this (or contributed it to `viem/chains`), it would save every integrator from looking up chain IDs and RPC URLs.

---

## Documentation suggestions

### 6. Dual-protocol / coexistence guide

The docs cover the simple case well (mppx as the only payment middleware). But many servers will want to run MPP alongside x402 or other payment protocols. A "coexistence" section would help, covering:

- How to check for `Authorization: Payment` header before falling back to another protocol
- How to add `WWW-Authenticate` to an existing 402 response (the challenge generation problem from #2)
- How to extract the payer address after verification (the wallet extraction problem from #3)

### 7. Express middleware: document that mock requests hang

The Express middleware section should note that the middleware requires a real Node.js `IncomingMessage`/`ServerResponse` pair. Calling it with mock objects (common in testing and challenge pre-generation) will hang due to the `@remix-run/node-fetch-server` body stream behavior.

### 8. `secretKey` error message

When `MPP_SECRET_KEY` env var is not set and no `secretKey` is passed to `Mppx.create()`, the error message could explain what the key is for and how to generate one:

```
Error: secretKey is required. Generate one with: openssl rand -hex 32
Set it as MPP_SECRET_KEY env var or pass it to Mppx.create({ secretKey: "..." }).
The secret key is used to HMAC-bind payment challenges for stateless verification.
```

---

## Summary

MPP is a solid protocol and `mppx` is a well-designed SDK. The main pain point was the dual-protocol case — generating challenges programmatically and extracting wallet addresses after verification. The faucet UX is best-in-class. We'd love to see the challenge generation API (#2) and wallet extraction helper (#3) most.

Happy to discuss any of these in detail. Contact: info@kychee.com or POST /message/v1 on api.run402.com.
