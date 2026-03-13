# Run402 API Style Guide

Rules for every endpoint. No exceptions — fix violations before merging.

## URL Structure

Version goes last, Supabase-style: `/<resource>/v1`.

```
/projects/v1
/tiers/v1/subscribe/:tier
/faucet/v1
/billing/v1/accounts/:wallet
/subdomains/v1
/deployments/v1
```

Admin routes: `/<resource>/v1/admin`.

```
/projects/v1/admin/:id/sql
/projects/v1/admin/:id/functions
/billing/v1/admin/accounts/:wallet/credit
```

Supabase-compatible proxy routes already follow this pattern:

```
/auth/v1/signup
/auth/v1/token
/rest/v1/*
/storage/v1/object/:bucket/*
/functions/v1/:name
```

No other prefixes. No `/x402/...`.

## Fields

snake_case everywhere. Request bodies, response bodies, query params.

```json
{ "project_id": "...", "lease_expires_at": "...", "amount_usd_micros": 5000000 }
```

## Status Codes

| Code | When |
|------|------|
| 200  | Queries, updates, actions on existing resources |
| 201  | Resource creation (project, function, deployment, subdomain, secret, published version) |
| 204  | Success with no response body (beacons, logout) |
| 400  | Bad input |
| 401  | Missing or invalid auth |
| 402  | Payment required (x402, expired lease, budget exceeded) |
| 403  | Valid auth but insufficient permissions |
| 404  | Resource not found |
| 409  | Conflict (duplicate) |
| 429  | Rate limited |

## Responses

No wrapping. Return the object directly.

```json
{ "project_id": "abc", "anon_key": "...", "service_key": "..." }
```

Lists use a key matching the resource name:

```json
{ "functions": [...] }
{ "subdomains": [...] }
{ "secrets": [...] }
```

## Errors

Always `{ "error": "Human-readable message" }`. Optional extra fields for actionable context:

```json
{ "error": "API call limit exceeded", "usage": { "api_calls": 500, "limit": 500 } }
{ "error": "Lease expired", "renew_url": "/tiers/v1/renew/prototype" }
```

## Auth

Four mechanisms, never mixed:

| Mechanism | Header | Grants |
|-----------|--------|--------|
| anon_key  | `apikey: <jwt>` | REST, storage, functions, auth — scoped to one project |
| service_key | `Authorization: Bearer <jwt>` | Admin routes for the project that issued the key |
| admin_key | `x-admin-key: <key>` | Global admin operations (faucet, pin, billing credits) |
| bearer token | `Authorization: Bearer <access_token>` | End-user session after auth signup/login |

## Paid Endpoints (x402)

Tier subscription endpoints (`/tiers/v1/subscribe/:tier`, `/tiers/v1/renew/:tier`, `/tiers/v1/upgrade/:tier`) and image generation (`/generate-image/v1`) require x402 payment.

All other operational endpoints (projects, deploys, forks, sites, messages) use EIP-4361 wallet auth and are free with an active tier subscription.

Every endpoint category has a free GET that returns info:

```
GET  /tiers/v1          → { tiers, prices, auth }
GET  /projects/v1       → { tiers, prices }
POST /projects/v1       → 201, creates the resource (wallet auth)
```

All paid POST routes support `Idempotency-Key` header for safe retries.

## EIP-4361 Wallet Auth

Endpoints that are free with tier use wallet signature headers:
- `X-Run402-Wallet`: wallet address
- `X-Run402-Signature`: signature of `run402:{unix_timestamp}`
- `X-Run402-Timestamp`: unix timestamp (seconds, 30s freshness)

## HTTP Verbs

- **GET** — read, list, pricing info
- **POST** — create, actions (renew, publish, fork)
- **DELETE** — remove
- **PATCH** — partial update

Don't use PUT. POST handles upserts fine.
