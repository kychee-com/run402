---
title: "Resource limits"
description: "Native MCP reference — limits."
order: 50
---

## Resource limits

| | Prototype | Hobby | Team |
|---|---|---|---|
| Lease | none (free tier) | 30 days | 30 days |
| Storage | 250 MB | 1 GB | 10 GB |
| API calls | 500K | 5M | 50M |
| Functions | 5 | 25 | 100 |
| Function timeout | 10s | 30s | 60s |
| Function memory | 128 MB | 256 MB | 512 MB |
| Secrets | 10 | 50 | 200 |
| Scheduled fns | 1 / 15min | 3 / 5min | 10 / 1min |

Deploy preflights literal unified-deploy timeout, memory, cron interval, and scheduled-count values before plan/upload when caps are known; failures are structured `BAD_FIELD` errors with field/value/tier/limit details.

Project rate limit: 100 req/sec. Exceeding returns 429 with `retry_after`. Each project runs in its own Postgres schema; cross-schema access is blocked.

## Project lifecycle (~104-day soft delete)

The lifecycle state machine lives on `internal.organizations`. The grace clock ticks per **organization** — every project on the same organization inherits the same `organization_lifecycle_state`. The live data plane keeps serving the whole time; only the owner's control plane gets gated:

| State | When | What happens |
|---|---|---|
| `active` | — | Full read/write |
| `past_due` | day 0 | Site, REST, email keep serving. Owner gets first email. |
| `frozen` | +14d | Control plane returns 403 with `lifecycle_state` / `entered_state_at` / `next_transition_at`. Site still serves. Subdomain reserved. |
| `dormant` | +44d | Scheduled functions pause. |
| `purged` | +104d | Cascade: schemas dropped, Lambdas deleted, mailboxes tombstoned. Subdomains become available again 14 days later. |

Setting a tier (`await r.tier.set("hobby")` in a `run` snippet) at any point during grace reactivates the **organization** inline and clears every project's timers in one transaction. Each `r.projects.list()` entry exposes:

- `effective_status` — derived for serving / UX (`active` / `past_due` / `frozen` / `dormant` / `archived` / `deleted`). When a single project is moderate-archived or user-deleted, this differs from the organization lifecycle.
- `organization_lifecycle_state` — the raw per-organization state; identical across all projects on the same organization.
- `lease_perpetual` — staff escape hatch on the owning organization. When `true`, the organization never advances past `active`. Staff toggle it with `r.admin.org(orgId).pinLease()` / `unpinLease()`.

Staff moderation actions are independent of lifecycle and scoped to a single project: `r.admin.archiveProject(projectId)` and `r.admin.reactivateProject(projectId)`.

## Idempotent migrations

Deploy migration entries declare exactly one of `id` or `name`. Use `id` for immutable versioned migrations: same id+SQL noops, same id+different SQL fails with `MIGRATION_CHECKSUM_MISMATCH`, and real revisions need a new id. Use `name` for generated/idempotent SQL; the SDK compiles `<name>_<sha256(sql)[0:16]>` before calling the gateway, so changed content applies once and unchanged re-ups noop. SQL declared with `name` MUST be idempotent because it re-runs when content changes.

`CREATE TABLE IF NOT EXISTS` only handles "already exists" — it won't add new columns. For evolving schemas, wrap `ALTER TABLE` in a `DO` block:

```sql
CREATE TABLE IF NOT EXISTS items (id serial PRIMARY KEY, title text NOT NULL);
DO $$ BEGIN
  ALTER TABLE items ADD COLUMN priority int DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
```

Safe to re-run on every deploy.

## SQL guardrails

The SQL endpoint blocks: `CREATE EXTENSION`, `COPY ... PROGRAM`, `ALTER SYSTEM`, `SET search_path`, `CREATE/DROP SCHEMA`, `GRANT/REVOKE`, `CREATE/DROP ROLE`. Use the expose manifest for access control instead of `GRANT`.

## Payment Handling

Three payment rails, one 402 handshake:

- x402 (default): USDC on Base. Prototype = Base Sepolia testnet (free from faucet). Hobby/team = Base mainnet.
- MPP on Tempo: pathUSD on Tempo Moderato (testnet) / Tempo (mainnet). Same wallet key as x402. Switch rails via `run402 init mpp` in the user's shell.
- MPP on Bitcoin Lightning: sats, mainnet. `run402 init lightning` asks Run402 to mint the agent a budgeted wallet on its own Hub (its pairing is a one-time secret, so it is a CLI step); tiers and image generation are then paid in sats and x402 stays the fallback. `r.billing.createLightningTopup(...)` mints an invoice any wallet can pay to top up the organization instead.

The MCP server handles all signing automatically. When a paid call cannot be covered, the `run` result is the SDK's `PaymentRequired` error with its `next_actions` — guide the user through funding, then run the same snippet again.

For real-money tiers, two paths to fund:
- Path A — fund the agent wallet: human sends USDC on Base mainnet to the address `status` reports. Agent pays autonomously via x402 from then on. Or in sats: `r.billing.createLightningTopup(...)` returns a Lightning invoice the human pays from any wallet.
- Path B — card-funded allowance: create or pick the organization, then `r.billing.createCheckout(...)` with `product: "tier"` returns a Stripe URL the human pays once.

Suggest $10 to your human for two Hobby projects, or $20 for one Team plus renewal buffer.

## Troubleshooting

| You see | Likely cause / fix |
|---|---|
| `402 payment_required` setting a tier | The organization's allowance falls short and the wallet is empty. Run `await r.wallets.faucet()` (testnet) or fund with real USDC. If the user gave you a promo code, `await r.vouchers.redeem(code)` adds it to the allowance instead. |
| `403` with `lifecycle_state: frozen` | Project past lease + 14 days. `await r.tier.set("<tier>")` reactivates instantly. |
| `403 admin_required` | The call is staff only (e.g., `r.admin.org(id).pinLease()`, `r.admin.archiveProject`, `r.admin.reactivateProject`). Use a staff wallet; project owners can't toggle these on their own. |
| `403 NOT_AUTHORIZED` on a control-plane action | Org-owned control plane: the wallet authenticated, but its principal lacks the org role/grant for this action — not a payment or lease issue. `details` carries `required_role` / `required_capability` / `reason`. Obtain a covering org membership/role or per-project grant; high-stakes ops (delete, transfer, membership change) need an active `owner` membership. Returned as 403 even when the project doesn't exist (existence isn't leaked), so also re-check the `project_id`. |
| `409 LAST_OWNER` removing or demoting a member | An org must keep at least one active `owner`. The change would remove or demote the last one. Promote another member to `owner` first (`await r.org(orgId).members.setRole(principalId, { role: "owner" })`), then retry. |
| `409 PROJECT_HAS_PENDING_TRANSFER` on an owner-side mutation | A pending project transfer is freezing the control plane. `details.transfer_id` carries the id; `next_actions[]` has the cancel route. `await r.admin.transfers.cancel(transferId)` unblocks it, or `r.admin.transfers.preview(transferId)` shows what's pending. The freeze auto-clears 72h after init. |
| Empty `[]` from `r.projects.rest` for anon | Table not in manifest with `expose: true`. Declare it under `database.expose` in `deploy`, or `await r.projects.applyExpose(projectId, manifest)`. |
| `403 forbidden_function` calling an RPC | Function not in the manifest's `rpcs[]`. Add `{ name, signature, grant_to: ["authenticated"] }` and re-apply. |
| `409 reserved` claiming a subdomain | Original owner's grace period — subdomain held until +118 days from lease expiry. |
| `429 rate_limited` | 100 req/sec project cap. Back off using `retry_after`. |
| CDN serves old bytes | Use the immutable `cdn_url` from `r.assets.put`, or `await r.assets.waitFresh(...)` on a mutable URL. |
| `422 relation already exists` on redeploy | Wrap migrations in `CREATE TABLE IF NOT EXISTS` + `DO`-block `ALTER TABLE`. |
| `insufficient_funds` right after faucet | Wait for the faucet tx to confirm (~5s on Base Sepolia) before setting the tier. |
