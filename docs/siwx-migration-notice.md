# SIWX Migration Notice — for MCP/CLI Maintainer

## What changed

Custom `X-Run402-Wallet`, `X-Run402-Signature`, `X-Run402-Timestamp` headers have been **replaced** by the standard `SIGN-IN-WITH-X` header (CAIP-122 / EIP-4361) from the x402 ecosystem.

## Breaking change

The old `X-Run402-Wallet/Signature/Timestamp` headers are **no longer accepted**. All wallet-auth endpoints now require the `SIGN-IN-WITH-X` header.

**Affected endpoints** (all wallet-auth):
- `POST /projects/v1`
- `POST /deploy/v1`
- `POST /fork/v1`
- `POST /deployments/v1`
- `POST /message/v1`
- `GET /ping/v1`
- `GET /tiers/v1/status`
- `POST /agent/v1/contact`

## New client flow

1. Install: `npm install @x402/extensions`
2. Create a CAIP-122 message with domain, URI, nonce, timestamps
3. Sign it with the wallet (EVM via EIP-191 or Solana via Ed25519)
4. Base64-encode the payload and send as `SIGN-IN-WITH-X` header

```typescript
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import type { CompleteSIWxInfo } from "@x402/extensions/sign-in-with-x";

async function createAuthHeader(endpoint: string, signer: any): Promise<string> {
  const url = new URL(endpoint);
  const now = new Date();
  const info: CompleteSIWxInfo = {
    domain: url.hostname,
    uri: endpoint,
    statement: "Sign in to Run402",
    version: "1",
    nonce: crypto.randomUUID(),
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    chainId: "eip155:84532",  // or "eip155:8453" for mainnet
    type: "eip191",
  };
  const payload = await createSIWxPayload(info, signer);
  return encodeSIWxHeader(payload);
}

// Usage:
const header = await createAuthHeader("https://api.run402.com/projects/v1", walletSigner);
fetch("https://api.run402.com/projects/v1", {
  method: "POST",
  headers: {
    "SIGN-IN-WITH-X": header,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name: "my-project" }),
});
```

## Solana support

SIWX natively supports Solana wallets. Use `type: "ed25519"` and a Solana chainId:

```typescript
const info: CompleteSIWxInfo = {
  // ...same fields...
  chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",  // Solana mainnet
  type: "ed25519",
};
```

## Reference

- x402 SIWX docs: https://docs.x402.org/extensions/sign-in-with-x
- npm: `@x402/extensions` (already installed in run402-mcp as a peer of @x402/core)
- CAIP-122 spec: https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-122.md
