# Learn x402: Wallets, Chains, and Payments

## Wallets

A wallet **is** just a private key + public key (address). That's it — no other attributes. The same key pair works on **every** EVM chain: Ethereum mainnet, Base mainnet, Base Sepolia, Arbitrum, Polygon, etc. Your address is always `0x6B859F...` everywhere.

But **balances are per-chain**. Each chain is a separate blockchain with its own ledger. So the same wallet can have:
- 100 USDC on Base mainnet (real money)
- 0.25 USDC on Base Sepolia (funny money)
- 0 USDC on Ethereum mainnet

Think of it like having the same account number at different banks — same identity, different balances.

## What is Sepolia?

Sepolia is a **testnet** — a copy of the Ethereum/Base network where the tokens have zero real-world value. Developers use it to test without risking real money. "Base Sepolia" is the testnet version of Base (Coinbase's L2 chain).

- **Base mainnet** = real money, chain ID `8453`
- **Base Sepolia** = test money, chain ID `84532`

The faucet gives out test USDC on Base Sepolia — it's worthless, just for testing.

## What is `eip155:*`?

`eip155` is the standard identifier (CAIP-2) for EVM-compatible chains. The number after the colon is the chain ID:
- `eip155:8453` = Base mainnet
- `eip155:84532` = Base Sepolia
- `eip155:1` = Ethereum mainnet

`eip155:*` is a wildcard pattern meaning "I can pay on any EVM chain." The problem we hit: our server advertises two payment options (mainnet first, then Sepolia). The x402 client matched the wildcard to the **first** one (mainnet), tried to pay with mainnet USDC, but the wallet only had Sepolia USDC. Balance: 0 on mainnet → payment rejected.

Fix: `eip155:84532` — "I can only pay on Base Sepolia." Now it skips the mainnet option and picks Sepolia.

## What does the facilitator do?

The x402 payment flow has three parties:

1. **Client** (the agent) — signs an off-chain authorization: "I permit you to take 0.10 USDC from my wallet"
2. **Server** (run402 API) — receives the signed authorization, forwards it to the facilitator
3. **Facilitator** (Coinbase CDP) — the trusted middleman that:
   - Verifies the signature is valid
   - Checks the wallet actually has enough USDC (`balanceOf` — this is where "insufficient balance: 0 < 100" came from)
   - Executes the on-chain transfer (moves USDC from the agent's wallet to the seller's wallet)
   - Returns a receipt to the server

The facilitator exists so the server doesn't need its own blockchain node or gas to process payments. Coinbase runs it as infrastructure for the x402 protocol.

---

## Base as L2 Ethereum

Base is a **Layer 2 (L2)** chain built on top of Ethereum. Built by Coinbase, launched in 2023.

### What's an L2?

Ethereum mainnet (L1) is secure but slow and expensive — ~15 transactions/second, fees can spike to $50+ during congestion. L2s solve this by processing transactions off the main chain, then periodically posting compressed proofs back to Ethereum.

You get Ethereum's security guarantees but with:
- Much cheaper fees (fractions of a cent on Base)
- Much faster transactions (~2 seconds)
- Same developer tools, same Solidity contracts, same wallet addresses

### How Base works specifically

Base is an **Optimistic Rollup** — it uses the OP Stack (built by Optimism). The idea:

1. Transactions happen on Base's own chain
2. Batches of transactions are compressed and posted to Ethereum L1 as calldata
3. There's a "challenge period" — anyone can dispute a fraudulent batch by submitting a fraud proof
4. If nobody challenges within the window (~7 days), the batch is considered final

"Optimistic" because it assumes transactions are valid unless someone proves otherwise.

### Why Base matters for us

We use Base because:
- **USDC is native on Base** — Circle (USDC issuer) officially supports it, so the USDC contract is first-class, not a bridged token
- **Coinbase ecosystem** — the x402 protocol and CDP facilitator are Coinbase products, so Base has the best integration
- **Cheap enough for micropayments** — a $0.10 database provision payment wouldn't make sense if the gas fee was $5. On Base, gas is ~$0.001

### Other major L2s

Base isn't the only one:
- **Optimism** — same OP Stack, the original
- **Arbitrum** — different rollup tech (Nitro), currently the largest L2 by TVL
- **zkSync, StarkNet, Scroll** — use zero-knowledge proofs instead of fraud proofs ("ZK Rollups") — mathematically prove correctness rather than relying on challenge periods

All of them solve the same problem: make Ethereum usable for real applications without sacrificing security.

---

## x402 Implementation Options

### Networks / Chains

x402 uses CAIP-2 identifiers (`eip155:<chainId>`). You can accept payment on any EVM chain:

| Network | ID | USDC | Real money? |
|---|---|---|---|
| Base mainnet | `eip155:8453` | `0x833589fCD6...` | Yes |
| Base Sepolia | `eip155:84532` | `0x036CbD5384...` | No (testnet) |
| Ethereum mainnet | `eip155:1` | `0xA0b86991c6...` | Yes |
| Arbitrum | `eip155:42161` | `0xaf88d065e7...` | Yes |

Our server already advertises both Base mainnet and Sepolia. You'd just add more entries to the `networks` array in `middleware/x402.ts` to accept more chains.

### Payment schemes

Only **ExactEvmScheme** ships in the SDK. It supports two token transfer methods under the hood:
- **EIP-3009** (`transferWithAuthorization`) — the default for USDC, which natively supports it
- **Permit2** — universal fallback for any ERC-20 token

The architecture is pluggable — you could implement a `SolanaScheme` for Solana payments, but nobody has shipped one in the SDK yet. Solana support exists in the protocol spec and in the extensions (for auth), just not for payments.

### Facilitator options

The facilitator is the middleman that verifies and settles payments:

1. **Coinbase CDP (what we use)** — hosted, fee-free for USDC on Base. Simplest option. Just pass your CDP API keys.

2. **Self-hosted facilitator** — `x402Facilitator` class lets you run verification and settlement in-process. You'd need your own RPC node and gas to submit transactions. More control, no dependency on Coinbase.

3. **Third-party facilitators** — the ecosystem is growing:
   - **Stripe** just launched x402 payments on Base
   - **PayAI Network** — Solana-first facilitator
   - **Cloudflare** announced x402 support

### Server middleware

Only **Express** middleware ships (`@x402/express`). But the core exposes an `HTTPAdapter` interface, so you could write adapters for Fastify, Hono, etc.

### Extensions (things we could add)

The `@x402/extensions` package has:
- **Bazaar** — service discovery (lets agents find your API automatically via MCP)
- **Sign In With X (SIWx)** — wallet-based authentication (EVM + Solana)
- **Gas Sponsoring** — for edge-case token approvals (see below)
- **Payment Identifier** — unique IDs per payment for tracking/reconciliation

### Gas: who pays and when

**Agents don't need ETH for gas. The facilitator covers it.**

Here's what actually happens in the x402 payment flow:

1. Agent **signs a message off-chain** — it never submits an on-chain transaction. The client-side code (`ExactEvmScheme.createPaymentPayload()`) only calls `signTypedData()` or `signTransaction()` — never `sendTransaction()`.
2. Server forwards the signed authorization to the **Coinbase CDP facilitator**.
3. Facilitator **submits the on-chain transaction and pays the gas** — it calls `writeContract()` and `sendRawTransaction()` using its own signer and its own ETH.

The agent only needs USDC. Zero ETH. This is already how our production system works — the openclaw E2E test proved it: fresh wallet, faucet gives only USDC, no ETH anywhere, payment goes through.

**So what's the "Gas Sponsoring" extension?**

It's for an edge case: **Permit2 token approvals for non-USDC tokens**. Some ERC-20 tokens require a one-time `approve()` transaction before Permit2 can move them. Normally the client would need ETH to submit that approval on-chain. The gas sponsoring extensions solve this in two ways:

- **EIP-2612 Gas Sponsoring** — for tokens that support EIP-2612 `permit()`. The client signs a gasless permit off-chain, and the facilitator submits it atomically with the payment.
- **ERC-20 Approval Gas Sponsoring** — for tokens that don't support EIP-2612. The client signs (but does not broadcast) a raw `approve()` transaction. The facilitator broadcasts it and pays the gas.

**USDC doesn't need either of these** — it supports EIP-3009 (`transferWithAuthorization`) natively, which requires no prior approval at all. The authorization IS the permission to transfer.

**Coinbase CDP pricing**: 1,000 free settlements/month, then $0.001 per transaction after that. Gas costs on Base are ~$0.001 per transaction, so Coinbase effectively absorbs them.

### What would make sense for us

For going to production with real money, we'd:
1. Keep CDP facilitator (it's free for USDC on Base, and it handles gas)
2. Switch the test to register `eip155:8453` (Base mainnet) for real payments
3. Optionally keep Sepolia for the openclaw test / dev workflow
4. No need to add gas sponsoring — already handled by the facilitator for USDC

---

## Stripe and Cloudflare

### Stripe as x402 facilitator

Stripe is acting as an **alternative facilitator** to Coinbase CDP. When an agent pays via x402, instead of Coinbase settling the USDC transfer, Stripe does it — but with Stripe's full fintech stack behind it:

- **PaymentIntents API** — the same API Stripe uses for traditional payments, now accepting USDC on Base
- **Compliance/reporting** — tax reporting, refunds, dispute handling, 1099s — all the stuff Coinbase CDP doesn't do
- **Fiat off-ramp** — Stripe can convert USDC to USD and deposit to your bank account, so you don't need to manage crypto at all
- **Dashboard** — Stripe's existing analytics, webhooks, customer management

Currently in **preview** (requires contacting Stripe to enable). No public pricing yet.

**Value to us?** Significant when we go to production with real money. Coinbase CDP is great for the protocol mechanics, but Stripe solves the *business* side: how do you report taxes on agent payments? How do you handle refunds? How do you get the money into your bank account? We could swap the facilitator from CDP to Stripe without changing any client-side code — the agent doesn't know or care which facilitator settles the payment.

To request access: [Stripe x402 documentation](https://docs.stripe.com/payments/machine/x402) — the docs say to contact Stripe to enable "Machine payments" for your account. Start there or reach out via [Stripe Support](https://support.stripe.com/contact).

**Status**: Applied for Machine Payments approval on 2026-03-01. Pending.

### Cloudflare as infrastructure

Cloudflare is doing something different — they're not a facilitator. They provide **infrastructure for running x402-gated services**:

- **Workers middleware** — `paymentMiddleware` for Cloudflare Workers, same concept as our Express middleware but for their serverless platform
- **Payment-gated proxy template** — an open-source template that sits in front of any origin server and adds x402 paywalls. You could gate downloads, API calls, or web crawls without modifying your backend at all.
- **Agent framework integration** — x402 built into their Cloudflare Agents SDK, so agents running on Workers can both pay and get paid natively

They also co-founded the **x402 Foundation** with Coinbase to govern the protocol as an open standard.

**Value to us?** Less direct than Stripe. We already run our own Express server on ECS. But if we ever wanted to:
- Put a CDN/proxy in front of the API (Cloudflare already does this well)
- Gate static assets (like dataset downloads) without routing through our server
- Run edge workers that interact with x402 services

The proxy template is interesting — imagine gating `llms.txt` or documentation behind a micropayment. But that's a future idea, not a current need.

### Comparison

| | Coinbase CDP (current) | Stripe | Cloudflare |
|---|---|---|---|
| **Role** | Facilitator | Facilitator | Infrastructure/proxy |
| **What it does** | Settles USDC on-chain | Settles USDC + fiat off-ramp + compliance | Serverless middleware + edge proxy |
| **Fees** | 1k free/month, then $0.001 | Unknown (preview) | Workers pricing |
| **Value to us now** | Already using it | High when going to prod (tax, refunds, fiat) | Low (we run our own server) |
| **Switching cost** | N/A | Swap facilitator config, no client changes | Would need to migrate off ECS |

**Stripe is the one to watch.** When we're ready for real money, swapping from CDP to Stripe gives us compliance, fiat settlement, and a dashboard — with zero changes to the agent experience.

---

## x402 Extensions

### Bazaar — Service Discovery

Think of it as the **Yellow Pages for AI agents**. Right now, an agent needs to know `https://api.run402.com` exists before it can use it. Bazaar solves that.

**How it works:**
1. When a server registers with the CDP facilitator and enables the Bazaar extension, it automatically gets listed in a searchable directory
2. The server declares metadata about each endpoint: what it does, what inputs it takes, what it returns, and what it costs
3. Agents can browse the Bazaar to find services — "I need a database" → discovers run402 → pays and provisions

There's also an **MCP server for Bazaar** that plugs into Claude Desktop, Cursor, and VS Code — agents discover tools via MCP, pay via x402, and get results in one flow. 251+ live services are already listed.

**Server-side example:**
```typescript
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

// Add to resource config in middleware/x402.ts:
"POST /v1/projects": {
  accepts: networks.map(n => ({ scheme: "exact", price: "$0.10", network: n, payTo: SELLER_ADDRESS })),
  extensions: {
    ...declareDiscoveryExtension({
      input: { name: "my-project" },
      inputSchema: { properties: { name: { type: "string" } }, required: ["name"] },
      output: { project_id: "prj_...", anon_key: "eyJ...", service_key: "eyJ..." }
    })
  }
}
```

### Sign In With X (SIWx) — Wallet-Based Auth

**Problem it solves:** Right now, after an agent pays for a project, it authenticates with JWT keys (`anon_key`, `service_key`). SIWx would let an agent authenticate using the **same wallet it paid with** — no separate auth step.

**How it works:**
1. Server sends a challenge: "Sign this message to prove you own wallet `0x6B85...`"
2. Client signs it with their private key (off-chain, no gas)
3. Server verifies the signature and checks: "Has this wallet paid before? Yes → grant access"

It's like OAuth but with no password, no email, no account creation. Your wallet IS your identity.

**How it differs from our JWT auth:** Our current flow is: pay → get project credentials (JWT) → use JWTs for everything. With SIWx, the flow would be: pay → wallet is remembered → sign a challenge to re-authenticate. No JWT management needed. But our JWT system works well for the multi-role access pattern (anon vs authenticated vs service), so SIWx would be a complement, not a replacement.

### Payment Identifier — Idempotency Keys

**Problem it solves:** What if a network hiccup causes the client to submit the same payment twice? Without deduplication, you'd charge them double.

**How it works:**
1. Server declares it supports (or requires) payment identifiers
2. Client generates a unique ID per payment: `pay_7d5d747be160e280504c099d984bcfe0`
3. Client includes the ID in the payment payload
4. Server/facilitator checks: "Have I seen this ID before? Yes → return cached result, don't re-charge"

It's exactly like Stripe's idempotency keys.

---

## TODOs

### TODO: Bazaar — Make run402 discoverable (HIGH priority, LOW effort)

Add the Bazaar discovery extension to `packages/gateway/src/middleware/x402.ts` so agents can find us automatically. See implementation plan below.

### TODO: Payment Identifier — Prevent double-charging (HIGH priority, LOW effort)

Register the payment identifier extension on the server so duplicate payment submissions return cached results instead of creating duplicate projects.

### TODO: SIWx — Wallet-based auth (MEDIUM priority, MEDIUM effort — later)

Interesting for a future "wallet as identity" model. Would need a storage layer to track which wallets have paid. Not urgent — JWTs work fine today.

### TODO: Stripe Machine Payments (HIGH priority — when approved)

**Status**: Applied for Machine Payments approval on 2026-03-01. Pending.

When approved, swap the facilitator from CDP to Stripe for compliance, fiat off-ramp, and dashboard.

---

## Bazaar Implementation Plan

**Goal:** Make run402 discoverable by agents via the x402 Bazaar directory.

### Step 1: Add Bazaar extension to resource config

**File:** `packages/gateway/src/middleware/x402.ts`

Import `declareDiscoveryExtension` from `@x402/extensions/bazaar` and add `extensions` to each resource config entry. Declare input/output schemas for:
- `POST /tiers/v1/:tier` — no input, output: `{ wallet, action, tier, lease_expires_at }`
- `POST /generate-image/v1` — input: `{ prompt, aspect? }`, output: `{ image, content_type }`

### Step 2: Register Bazaar server extension

**File:** `packages/gateway/src/middleware/x402.ts`

Register `bazaarResourceServerExtension` on the `x402ResourceServer` instance so metadata is automatically enriched on 402 responses:
```typescript
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";

const server = new x402ResourceServer(facilitatorClient);
server.registerExtension(bazaarResourceServerExtension);
```

### Step 3: Verify listing

After deploying, check the Bazaar directory to confirm run402 endpoints appear. The CDP facilitator should automatically catalog them when it processes the first 402 response with Bazaar metadata.

### Step 4: Test with MCP

Install the [x402-discovery-mcp](https://glama.ai/mcp/servers/@rplryan/x402-discovery-mcp) server in Claude Desktop and verify an agent can discover and use run402 without being told the URL.

---

## Sources

- [x402.org — Official site](https://www.x402.org/)
- [GitHub — coinbase/x402](https://github.com/coinbase/x402)
- [x402 V2 Launch](https://www.x402.org/writing/x402-v2-launch)
- [InfoQ — x402 Major Upgrade](https://www.infoq.com/news/2026/01/x402-agentic-http-payments/)
- [Cloudflare x402 blog](https://blog.cloudflare.com/x402/)
- [Cloudflare x402 Agents docs](https://developers.cloudflare.com/agents/x402/)
- [Stripe x402 documentation](https://docs.stripe.com/payments/machine/x402)
- [Stripe taps Base for AI agent x402](https://crypto.news/stripe-taps-base-ai-agent-x402-payment-protocol-2026/)
- [Coinbase x402 Foundation announcement](https://www.coinbase.com/blog/coinbase-and-cloudflare-will-launch-x402-foundation)
- [Coinbase — Introducing x402 Bazaar](https://www.coinbase.com/developer-platform/discover/launches/x402-bazaar)
- [Coinbase Developer Docs — x402 Bazaar](https://docs.cdp.coinbase.com/x402/bazaar)
- [x402 Bazaar Discovery Layer](https://x402.gitbook.io/x402/core-concepts/bazaar-discovery-layer)

- [x402.org — Official site](https://www.x402.org/)
- [GitHub — coinbase/x402](https://github.com/coinbase/x402)
- [x402 V2 Launch](https://www.x402.org/writing/x402-v2-launch)
- [InfoQ — x402 Major Upgrade](https://www.infoq.com/news/2026/01/x402-agentic-http-payments/)
- [Cloudflare x402 blog](https://blog.cloudflare.com/x402/)
- [Cloudflare x402 Agents docs](https://developers.cloudflare.com/agents/x402/)
- [Stripe x402 documentation](https://docs.stripe.com/payments/machine/x402)
- [Stripe taps Base for AI agent x402](https://crypto.news/stripe-taps-base-ai-agent-x402-payment-protocol-2026/)
- [Coinbase x402 Foundation announcement](https://www.coinbase.com/blog/coinbase-and-cloudflare-will-launch-x402-foundation)
