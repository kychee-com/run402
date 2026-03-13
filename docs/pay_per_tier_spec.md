# Pay-Per-Tier Spec

## Overview

Replace per-operation x402 payments with a wallet-level tier system. An agent pays once for a tier (via x402), then uses EIP-4361 wallet signatures to authenticate all subsequent requests. Operations within the tier (project creation, deploys, forks, message, ping) are free — they draw from a shared resource pool.

## Identity Model

A wallet address is the agent's identity. Today, wallet ownership is proven by x402 payment signatures. After tier purchase, ownership is proven via EIP-4361 (signed messages) — no payment needed per request.

### EIP-4361 Auth Flow

Stateless, per-request signing. No sessions, no tokens to manage.

**Client (agent):**
```
// viem — already available in agent codebases
const message = `run402:${method}:${path}:${timestamp}`;
const signature = await account.signMessage({ message });

// Send as header
fetch(url, {
  headers: {
    "X-Run402-Wallet": walletAddress,
    "X-Run402-Signature": signature,
    "X-Run402-Timestamp": timestamp,
  },
});
```

**Server:**
1. Extract wallet, signature, timestamp from headers.
2. Reject if timestamp is older than 30 seconds (replay protection).
3. Recover signer address from signature using `verifyMessage` (viem/ethers).
4. Confirm recovered address matches `X-Run402-Wallet`.
5. Look up wallet's tier/account — reject if no active tier or lease expired.

No challenge roundtrip. No nonce state. 1 HTTP request, 1 response.

**Dependencies:** `siwe` or raw `verifyMessage` from viem/ethers on the server side. Nothing new on the client side.

## Tiers

Tiers are per-wallet, not per-project. A wallet has one active tier. All projects under that wallet share the tier's resource pool.

| | Prototype | Hobby | Team |
|---|---|---|---|
| Price | $0.10 | $5.00 | $20.00 |
| Lease | 7 days | 30 days | 30 days |
| Storage | 250 MB | 1 GB | 10 GB |
| API calls | 500K | 5M | 50M |
| Network | Testnet only | Mainnet or testnet | Mainnet or testnet |

Resource limits are pooled across all projects under the wallet. No per-project caps. No project count limit.

## Wallet Lifecycle

### 1. Faucet (pre-tier)

Agent gets testnet USDC to bootstrap. No wallet auth required — just an address.

```
POST /faucet/v1
{ "address": "0x..." }
→ { "transaction_hash": "0x...", "amount_usd_micros": 100000 }
```

### 2. Subscribe (x402 payment)

Agent pays for a tier via x402. This is the only x402 payment in the normal flow (besides generate-image and renewals).

```
POST /tiers/v1/subscribe
x-402-payment: <signed payment>
{ "tier": "hobby" }
→ 201
{
  "wallet": "0x...",
  "tier": "hobby",
  "lease_expires_at": "2026-04-12T...",
  "pool": {
    "storage_bytes": 1073741824,
    "storage_used_bytes": 0,
    "api_calls": 5000000,
    "api_calls_used": 0
  }
}
```

The x402 middleware resolves the price from the `tier` field in the body. Wallet address is extracted from the payment header. A billing account is created (or updated) for the wallet.

### 3. Create projects (EIP-4361 auth, free)

```
POST /projects/v1
X-Run402-Wallet: 0x...
X-Run402-Signature: 0x...
X-Run402-Timestamp: 1710360000
{ "name": "my-app" }
→ 201
{ "project_id": "prj_...", "anon_key": "...", "service_key": "..." }
```

No payment. Middleware verifies wallet signature, checks tier is active, creates project linked to wallet.

### 4. All other operations (EIP-4361 auth, free within tier)

These endpoints become free for wallets with an active tier:

- `POST /projects/v1` — create project
- `DELETE /projects/v1/:id` — archive project
- `POST /projects/v1/:id/renew` — removed (lease is per-wallet now)
- `POST /deployments/v1` — deploy static site
- `POST /deploy/v1` — bundle deploy (tier param removed)
- `POST /fork/v1` — fork app (tier param removed)
- `POST /message/v1` — send message
- `GET /ping/v1` — health probe
- `POST /subdomains/v1` — claim subdomain

Admin routes (`/projects/v1/admin/...`) continue to use service_key auth — these are project-scoped, not wallet-scoped.

### 5. Renew (x402 payment)

Lease expiry is per-wallet. Agent pays to extend.

```
POST /tiers/v1/renew
x-402-payment: <signed payment>
→ 200
{ "wallet": "0x...", "tier": "hobby", "lease_expires_at": "2026-05-12T..." }
```

Price = current tier price. Extends lease by the tier's lease duration from now.

### 6. Upgrade (x402 payment)

Agent pays the difference to move to a higher tier.

```
POST /tiers/v1/upgrade
x-402-payment: <signed payment>
{ "tier": "team" }
→ 200
{ "wallet": "0x...", "tier": "team", "lease_expires_at": "2026-04-12T...", "pool": { ... } }
```

Price = (new tier price) - (prorated remaining value of current tier). Lease duration resets to the new tier's lease period. Resource pool expands immediately.

### 7. Lease expiry

When a wallet's lease expires:
- All projects under the wallet are archived simultaneously.
- REST/storage/functions return 402 with a renew hint.
- Data is preserved — renewing restores access.

## Endpoints That Stay x402-Paid

These are not included in any tier — they cost per-call:

- `POST /generate-image/v1` — $0.03 per image (external API cost)

## Endpoint Changes Summary

| Current | New | Auth |
|---|---|---|
| `POST /projects/v1/create/:tier` | `POST /projects/v1` | EIP-4361 (free) |
| `POST /deploy/v1/:tier` | `POST /deploy/v1` | EIP-4361 (free) |
| `POST /fork/v1/:tier` | `POST /fork/v1` | EIP-4361 (free) |
| `POST /message/v1` (x402 $0.01) | `POST /message/v1` | EIP-4361 (free) |
| `GET /ping/v1` (x402 $0.001) | `GET /ping/v1` | EIP-4361 (free) |
| `PUT /agent/v1/contact` (x402) | `POST /agent/v1/contact` | EIP-4361 (free) |
| — | `POST /tiers/v1/subscribe` | x402 (tier price) |
| — | `POST /tiers/v1/renew` | x402 (tier price) |
| — | `POST /tiers/v1/upgrade` | x402 (price difference) |
| `POST /projects/v1/:id/renew` | removed | — |
| `POST /generate-image/v1` ($0.03) | unchanged | x402 |

## Auth Middleware Stack

Request arrives → check in order:

1. **x402 payment header present?** → x402 flow (tier purchase, generate-image, renewals)
2. **EIP-4361 headers present?** → verify signature, look up wallet's tier, check lease + resource limits
3. **apikey/service_key header?** → existing project-scoped auth (REST, storage, functions, admin routes)
4. **None?** → public endpoints only (health, apps listing, subdomain lookup)

## Migration

Existing projects without a wallet tier continue to work until their per-project lease expires. New behavior only applies to wallets that subscribe to a tier.

## Downgrade

Downgrade is allowed only if current resource usage fits within the lower tier's limits. If not, the request fails with a detailed error:

```json
{
  "error": "Cannot downgrade to prototype: resource usage exceeds tier limits",
  "current_usage": {
    "storage_bytes": 536870912,
    "api_calls_used": 1200000,
    "project_count": 4
  },
  "target_tier_limits": {
    "storage_bytes": 262144000,
    "api_calls": 500000
  },
  "over_limit": ["storage_bytes", "api_calls_used"]
}
```

## Metering

API call and storage metering must aggregate from per-project to per-wallet for pool enforcement. Per-project counters remain (for admin usage reports), but the pool check happens at the wallet level.

## Rate Limiting

Two layers:
- **Per-apikey** (existing): token bucket per project apikey, for REST/storage/functions. Unchanged.
- **Per-wallet**: aggregate rate limit across all projects owned by the wallet. Prevents circumventing per-apikey limits by spreading across many projects.
