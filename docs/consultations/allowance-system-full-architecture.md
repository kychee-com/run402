# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-08T17:28:18.652128
**Completed**: 2026-03-08T18:09:06.871579
**Status**: completed

---

Here’s the design I’d ship.

## Recommendation in one line

Build **Run402 Allowance** as a **wallet-bound billing account + append-only internal ledger**, keep **x402 as the agent auth/proof protocol** on paid requests, and use Stripe **only to credit the ledger**, not to grant entitlements.

The key idea: **same wallet identity across all 3 paths**.

- **Faucet**: same wallet, testnet x402
- **Allowance**: same wallet, x402-signed request, off-chain debit from DB
- **Native x402**: same wallet, real on-chain settlement

That preserves the mental model for agents.

---

# 1. Full architecture

## 1.1 Core principles

1. **Tiers remain the product**
   - Prototype / Hobby / Team are the SKUs forever.
   - Allowance is just a funding rail.

2. **Wallet remains the agent identity**
   - Agents still send x402 payment headers on paid requests.
   - The gateway decides which rail funds the request.

3. **Stripe is not the source of truth**
   - Stripe only creates successful funding events.
   - Postgres is the source of truth for allowance balance.

4. **No Stripe or chain lookups on the hot auth path unless needed**
   - Allowance auth should be a Postgres transaction.
   - Native x402 continues using facilitator/on-chain flow.

5. **No cached balance for authorization**
   - Dashboard can cache briefly.
   - Payment authorization must read/write DB transactionally.

---

## 1.2 First code change: make prices machine-readable

Your `TIERS.price` string should stop being authoritative.

Add a machine field:

```ts
prototype: {
  priceDisplay: "$0.10",
  priceUsdMicros: 100_000,
  ...
}
```

I recommend **integer micro-USD** (`1 USD = 1_000_000`) rather than cents because:

- it matches USDC’s 6 decimals
- it future-proofs x402 micropayments
- it avoids float bugs

If you want minimum complexity, cents are acceptable today because your current SKUs are cent-denominated. But `usd_micros` is the better long-term choice.

---

## 1.3 Components

```text
Human -> funding page -> Gateway -> Stripe Checkout
                                   |
                                   v
                             Stripe webhook
                                   |
                                   v
                    billing_topups + allowance_ledger + billing_accounts

Agent -> paid API + x402 header -> x402 verifier -> rail resolver
                                                  /             \
                                    Allowance rail (Postgres)   Native x402 rail (facilitator/Base)
                                                  \             /
                                                   charge authorization
                                                          |
                                                          v
                                                    route handler
                                                   capture / release
```

AWS-wise, this fits your current stack:

- **Aurora Postgres**: billing tables
- **ECS gateway**: billing API + x402 rail resolver + Stripe webhook
- **EventBridge scheduled ECS task**: expired hold reaper, low-balance alerts, optional auto-top-up jobs
- **S3/CloudFront**: funding dashboard

---

## 1.4 Required DB schema

I’d make these **required** for launch.

### `billing_accounts`
Wallet-bound allowance account.

Key fields:

- `id uuid pk`
- `status enum('active','suspended','closed')`
- `currency text default 'USD'`
- `available_usd_micros bigint not null default 0`
- `held_usd_micros bigint not null default 0`
- `funding_policy enum('allowance_only','wallet_only','allowance_then_wallet') default 'allowance_only'`
- `low_balance_threshold_usd_micros bigint default 5_000_000`
- `primary_contact_email text null`
- `last_low_balance_alert_at timestamptz null`
- `created_at`, `updated_at`

Notes:

- `available_usd_micros` can be allowed to go negative only for disputes/admin reversals.
- For normal spend, authorization still requires enough available balance.

### `billing_account_wallets`
Maps wallet addresses to billing accounts.

Key fields:

- `wallet_address text pk` (normalized lowercase)
- `billing_account_id uuid fk`
- `status enum('active','revoked')`
- `role enum('spender','primary')`
- `created_at`

Why this table matters:
- lets you support wallet rotation later
- keeps `billing_account_id` canonical
- avoids making wallet string itself the only identity

For now: one active wallet per account is fine.

### `allowance_ledger`
Append-only balance ledger.

Key fields:

- `id uuid pk`
- `billing_account_id uuid fk`
- `direction enum('credit','debit')`
- `kind enum('stripe_topup','manual_credit','manual_debit','purchase_debit','chargeback_debit','adjustment_credit','adjustment_debit','hold_place','hold_release')`
- `amount_usd_micros bigint not null`
- `balance_after_available_usd_micros bigint not null`
- `balance_after_held_usd_micros bigint not null`
- `reference_type text`
- `reference_id text`
- `idempotency_key text unique`
- `metadata jsonb`
- `created_at`

This is the audit trail.

### `billing_topups`
Top-up attempts and Stripe linkage.

Key fields:

- `id uuid pk`
- `billing_account_id uuid fk`
- `wallet_address text`
- `status enum('initiated','paid','credited','failed','expired','disputed','reversed')`
- `funded_usd_micros bigint not null`  
  (how much allowance gets credited)
- `charged_usd_cents integer not null`  
  (what Stripe charged; separate if tax/fees ever matter)
- `stripe_customer_id text null`
- `stripe_checkout_session_id text unique null`
- `stripe_payment_intent_id text unique null`
- `stripe_invoice_id text null`
- `payer_email text null`
- `terms_version text not null`
- `terms_accepted_at timestamptz not null`
- `billing_country text null`
- `livemode boolean not null`
- `metadata jsonb`
- `created_at`, `paid_at`, `credited_at`

### `charge_authorizations`
Unified record of paid request authorization, across both rails.

Key fields:

- `id uuid pk`
- `wallet_address text not null`
- `billing_account_id uuid null`
- `rail enum('allowance','x402')`
- `sku text not null`
- `amount_usd_micros bigint not null`
- `status enum('held','captured','released','failed','expired')`
- `idempotency_key text unique not null`
- `payment_header_hash text not null`
- `x402_nonce text null`
- `x402_receipt_id text null`
- `tx_hash text null`
- `metadata jsonb`
- `expires_at timestamptz null`
- `created_at`, `captured_at`, `released_at`

This table gives you:
- idempotency
- replay protection
- unified activity history
- route handler capture/release

### `stripe_webhook_events`
Idempotent Stripe processing.

Key fields:

- `stripe_event_id text pk`
- `type text`
- `livemode boolean`
- `payload jsonb`
- `received_at`
- `processed_at null`
- `processing_error null`

---

## 1.5 Optional DB tables for launch+1

### `funding_sources`
Saved cards/payment methods for auto-top-up.

### `auto_topup_policies`
Threshold or scheduled recurring top-up settings.

### `billing_access_tokens`
If you want humans to manage allowance without controlling the agent wallet.

---

## 1.6 API surface

Rename the public surface from `/v1/stripe/*` to `/v1/billing/*`.

### Public / dashboard / human-facing

- `POST /v1/billing/checkouts`
  - create one-time Stripe Checkout Session for allowance top-up

- `GET /v1/billing/accounts/:wallet`
  - funding state for dashboard
  - allowance balance, policy, maybe recent top-ups/spend

- `GET /v1/billing/accounts/:wallet/history`
  - recent allowance ledger + charge activity

- `GET /v1/wallets/:wallet/usdc-balance?network=base`
  - Base mainnet USDC balance via RPC

- `POST /v1/billing/portal`
  - optional; only if you keep saved PM / recurring top-up management

- `POST /v1/billing/funding-links`
  - optional but recommended; returns a human-safe funding URL for a wallet

### Internal/admin

- `POST /admin/v1/billing/accounts/:wallet/credit`
- `POST /admin/v1/billing/accounts/:wallet/debit`
- `POST /admin/v1/billing/accounts/:wallet/status`
- `POST /admin/v1/billing/accounts/:wallet/reassign-wallet`
  - support-only, audited, not self-serve

### Webhooks

- `POST /v1/webhooks/stripe`

---

## 1.7 Stripe one-time top-up flow

### Create checkout

1. Human opens funding page for a wallet.
2. Frontend calls `POST /v1/billing/checkouts` with:
   - wallet
   - amount
   - optional email
   - success/cancel URL
   - optional `savePaymentMethod`
   - optional `fundingToken`

3. Backend:
   - validates wallet / token
   - gets or creates `billing_account`
   - creates `billing_topups` row with `status='initiated'`
   - gets or creates Stripe customer for that billing account
   - creates Checkout Session in `mode: "payment"`

Important metadata to include on **all** Stripe objects you can:

- `billing_account_id`
- `wallet_address`
- `billing_topup_id`
- `run402_kind = allowance_topup`
- `terms_version`

Put that on:
- Customer metadata
- Checkout Session metadata
- PaymentIntent metadata
- Invoice metadata (if using invoice creation)

### Webhook crediting

Credit the allowance on:

- `checkout.session.completed` **when** `payment_status = 'paid'`
- also support `checkout.session.async_payment_succeeded` if you ever enable async methods

Processing:

- insert Stripe event into `stripe_webhook_events`
- look up `billing_topups`
- if not already credited:
  - append `allowance_ledger` credit
  - increment `billing_accounts.available_usd_micros`
  - mark `billing_topups.status = 'credited'`

Handle reversals:

- `charge.dispute.created` -> append reversal debit, maybe suspend account
- `charge.dispute.closed` -> if won, reverse the reversal
- `checkout.session.expired` -> mark top-up expired, no credit

### Important design rule

**Never** authorize spending by asking Stripe about the customer/session/subscription on the hot path.  
Stripe only creates credits. Postgres authorizes debits.

---

## 1.8 Allowance spend flow at x402 layer

## Important security note

Your current helper:

```ts
extractWalletFromPaymentHeader(header)
```

is fine for **parsing/logging**, but **must not be used alone for authorization**.

The new system must verify:

- x402 signature
- expiry
- nonce / replay protection
- request method/path/body hash
- amount
- seller/payee matches Run402

Only then should you trust the wallet.

### Recommended structure

Use **two layers**:

### A. x402 verification middleware
- verifies the payment envelope
- attaches `verifiedPayment` to request context

### B. paid-route wrapper (`withChargeAuthorization`)
- computes the SKU price
- resolves rail
- creates hold/capture
- calls handler
- captures or releases

This is better than a pure global bypass hook because some paid operations are mutating and need hold/capture semantics.

### Rail resolution logic

Given:
- verified wallet
- price quote
- billing account funding policy

do:

1. If `wallet_only` -> native x402
2. If `allowance_only` -> allowance or fail
3. If `allowance_then_wallet`:
   - use allowance if sufficient
   - else try native x402

**Do not split a single charge across both rails.**  
If allowance has $3 and the charge is $5, either:
- fail, or
- charge full $5 on wallet if fallback is enabled

Never do $3 allowance + $2 wallet. It complicates everything.

### Allowance path

- lock `billing_accounts` row `FOR UPDATE`
- if enough available balance:
  - decrement available
  - increment held
  - create `charge_authorizations(status='held', rail='allowance')`
- handler runs
- on success:
  - capture authorization
  - decrement held
  - append `allowance_ledger(kind='purchase_debit')`
- on failure:
  - release hold
  - move held back to available

### Native x402 path

- use existing facilitator / on-chain verification
- record `charge_authorizations(status='captured', rail='x402')`
- no allowance ledger movement

### Response headers I would add

- `X-Run402-Settlement-Rail: allowance | x402`
- `X-Run402-Allowance-Remaining: ...` (only for allowance path)

And for insufficient funds:

```json
{
  "error": "insufficient_allowance",
  "required_usd_micros": "5000000",
  "available_allowance_usd_micros": "2000000",
  "funding_policy": "allowance_only",
  "topup_url": "https://run402.com/fund?t=..."
}
```

That’s perfect for the agent-to-human handoff.

---

# 2. Linking Stripe checkout to the agent wallet

## Short answer

**Yes, reuse the `metadata["wallet_address"]` pattern — but not as the canonical link.**

Canonical link should be:

- **Postgres `billing_account_id`**
- wallet mapping in `billing_account_wallets`

Stripe metadata becomes redundant/supportive.

## What to do

When creating the session:

- create/find `billing_account`
- create/find Stripe customer for that account
- store:
  - `billing_account_id`
  - `wallet_address`
  - `billing_topup_id`

on:
- Stripe customer metadata
- Checkout Session metadata
- PaymentIntent metadata

Also change `client_reference_id`:
- use `billing_topup_id` or `billing_account_id`
- **not** just the wallet

That gives you wallet rotation flexibility later.

## Best UX: signed funding link

I strongly recommend adding an optional **funding link/token** flow:

- agent asks for money
- Run402 returns `https://run402.com/fund?t=...`
- token encodes wallet + optional suggested amount + expiry
- human clicks link, no copy/paste wallet error

This is cleaner than relying on `?wallet=0x...` forever.

---

# 3. Non-refundable service balance: legal basis and architecture

Not legal advice, but the architecture should clearly behave like **single-merchant prepaid service credits**, not general stored value.

## What “non-refundable” means architecturally

It should mean:

- no self-serve refund API
- no withdrawal API
- no transfer API
- no conversion to USDC
- no cash redemption
- no interest/yield
- no spending outside Run402

It does **not** mean “the DB makes refunds impossible.”  
You still need admin-only reversal capability for:

- duplicate charges
- chargeback handling
- court/legal requirements
- customer support exceptions

## What to track

Track these on each top-up:

- `terms_version`
- `terms_accepted_at`
- `payer_email`
- `billing_country` / region if available
- `beneficiary_wallet_address`
- Stripe IDs
- immutable spend history after funding

This is useful for:
- disputes
- revenue recognition
- “except where required by law” cases

## What to explicitly NOT build

To stay on the safer closed-loop side, do **not** build:

1. balance transfer between wallets/accounts
2. cash-out to card/bank/USDC
3. allowance usable at third-party merchants/MCPs
4. generic “pay any x402 endpoint with Run402 balance”
5. P2P sending/gifting
6. interest/yield/rewards framed as financial return
7. a “combined money wallet” UI that blurs allowance and on-chain USDC

Also: I’d strongly prefer **no expiry on allowance balance**.  
Expiring service credits creates more legal edge cases than it solves.

## Accounting implication

Top-ups are effectively **deferred revenue / service credit liability** until spent.  
Your ledger makes that tractable.

---

# 4. Architecture for testing

## Yes: have an admin credit endpoint

But make it a **real production-grade ledger adjustment**, not a fake test mode.

Recommended:

- `POST /admin/v1/billing/accounts/:wallet/credit`
- `POST /admin/v1/billing/accounts/:wallet/debit`

These should:
- append ledger entries
- update account balances transactionally
- require `ADMIN_KEY` / internal auth
- require `idempotency_key`
- require `reason`

## What not to do

Do **not** build:

- `if TEST_MODE then skip billing logic`
- direct `UPDATE billing_accounts SET balance = 100`

If you need “set balance to X” in tests, do it as:
- create fresh account, then admin credit
- or admin debit/credit delta to target value

## How CI should use it

### Fast PR tests
- deterministic test wallet
- signed x402 headers from fixture key
- admin credit allowance
- hit same paid endpoints as prod
- verify hold/capture/release

### Stripe integration tests
- Stripe test mode
- webhook fixtures / Stripe CLI
- one end-to-end top-up test
- use Test Clocks for recurring top-ups later

### Chain smoke tests
- keep Base Sepolia faucet/native x402 smoke tests
- run nightly, not on every PR

That gives you:
- deterministic allowance tests
- non-divergent production logic
- some real chain coverage

---

# 5. The x402 bypass question: Option A vs B

## My recommendation: **Option A**

### Option A
Agent sends x402 header -> server verifies signed intent -> DB balance debited -> access granted.

### Why A is right

1. **Simple**
   - no treasury/hot wallet complexity
   - no gas cost
   - no on-chain reconciliation burden

2. **Legally cleaner**
   - keeps allowance clearly closed-loop
   - avoids looking like fiat->crypto conversion infrastructure

3. **Operationally better**
   - no hot wallet risk
   - no nonce management
   - fewer failure modes

4. **Not the same problem as subscriptions**
   - subscription bypass changed the product into an entitlement
   - allowance keeps per-SKU pricing and x402-shaped auth intact
   - only settlement rail changes

That distinction matters a lot.

## Why I would not do Option B now

If Run402 is the merchant, having Run402’s hot wallet “pay” Run402’s seller address is mostly circular and just burns complexity.

It only really makes sense if:
- you’re sponsoring payments to third-party merchants, or
- you’re intentionally building a separate treasury-backed crypto payment abstraction

That is a very different product and a much touchier compliance posture.

## Best compromise

Architect the system as if there are pluggable rails:

- `AllowanceRail`
- `NativeX402Rail`

and do **not** implement `TreasurySponsoredX402Rail` now.

---

# 6. What to do with existing Stripe code

## Keep

### Keep the Stripe client/bootstrap
- secret/publishable key config
- webhook signature verification machinery if you have it
- maybe portal helper if you plan recurring top-ups soon

## Modify

### `stripe-subscriptions.ts` -> replace with billing funding service
Replace with something like:

- `getOrCreateStripeCustomerForBillingAccount()`
- `createAllowanceCheckout()`
- `handleStripeWebhook()`
- `createBillingPortal()` (optional)
- `createRecurringTopupCheckout()` (later)

### `routes/stripe.ts` -> replace with `/v1/billing/*`
Stripe should become an implementation detail, not the public API shape.

### `site/subscribe/index.html`
Rename to `/fund` or `/billing` if possible.  
`/subscribe` is now misleading.

## Delete

Delete all subscription-entitlement logic:

- `getWalletSubscription()`
- subscription cache
- `/v1/stripe/subscription/:wallet`
- `/v1/stripe/cache/clear`
- subscription bypass in `middleware/x402.ts`
- subscription aggregate metering branch
- daily Stripe lease sync
- subscription tier override in `routes/projects.ts`
- monthly/annual toggle UI

## File-by-file

| Existing file | Action |
|---|---|
| `services/stripe-subscriptions.ts` | Replace entirely |
| `routes/stripe.ts` | Replace with `routes/billing.ts` + webhook route |
| `middleware/x402.ts` | Remove subscription bypass, add rail resolver |
| `middleware/metering.ts` | Remove subscription branch |
| `services/leases.ts` | Delete Stripe sync; add hold reaper/alerts jobs |
| `routes/projects.ts` | Remove subscription tier override |
| `site/subscribe/index.html` | Convert into funding dashboard |

Also: archive old Stripe Hobby/Team subscription products/prices.

---

# 7. Dual-balance dashboard

## What it should show

Two cards, side by side:

### A. Run402 Allowance
- available balance
- held balance if any
- low-balance threshold
- spend policy
- recent top-up
- top-up CTA
- recurring top-up status if enabled

### B. Wallet USDC (Base mainnet)
- current on-chain USDC balance
- network label
- last refreshed timestamp
- funding instructions for native path

## Important UX rule

**Do not show a combined “total balance.”**

These are different things:

- **Allowance** = closed-loop Run402 service credit
- **Wallet USDC** = external on-chain asset

Show them separately forever.

## Spend policy

Store and display one of:

- `allowance_only` — **recommended default**
- `wallet_only`
- `allowance_then_wallet`

I would default to **`allowance_only`** whenever allowance exists, because the whole point is budget control.  
Wallet fallback should be explicit opt-in.

## Low-balance alerts

Trigger when allowance falls below threshold.

For MVP:
- email `primary_contact_email`
- throttle via `last_low_balance_alert_at`

Later:
- webhook
- dashboard banner
- projected renewal warnings

## Data sources

- Allowance card -> Postgres via `/v1/billing/accounts/:wallet`
- Wallet card -> Base USDC `balanceOf` via backend RPC endpoint
- Projects list -> existing `/v1/wallets/:wallet/projects`

## One auth caveat

If your current dashboard is just `?wallet=0x...`, I would **not** expose editable billing settings publicly by wallet alone.

At minimum:
- top-up page can be public
- balance/history/settings should be behind either:
  - proper human auth, or
  - a management magic link/token from Stripe email

That matters more once you show allowance balance and saved-card settings.

---

# 8. Recurring top-ups

## Yes, but only as funding

You can absolutely reuse Stripe subscriptions **as recurring top-ups**, not as entitlements.

That means:

- subscription/invoice payment succeeds
- allowance gets credited
- nothing is provisioned automatically
- no tier is granted by subscription status

## Two distinct patterns

### Pattern 1: scheduled recurring top-up
Example:
- `$10/week`
- `$50/month`

This **can use Stripe subscriptions**.

Use:
- dedicated Stripe product/prices like `Run402 Allowance recurring top-up`
- metadata:
  - `run402_kind=recurring_topup`
  - `billing_account_id`
  - `wallet_address`
  - `topup_usd_micros`

Credit allowance on `invoice.paid`.

This is the clean reuse of Stripe subscriptions.

### Pattern 2: threshold auto-top-up
Example:
- “when balance < $5, charge $20”

This should **not** use subscriptions.  
Use:
- saved payment method
- off-session PaymentIntent
- internal scheduler/job

This is usually the better long-term UX, but it’s more work.

## My rollout advice

- **Launch**: one-time top-ups only
- **Next**: scheduled recurring top-ups via Stripe subscriptions
- **Later**: threshold auto-top-up with saved PMs

That keeps semantics clean.

---

# 9. Practical rollout plan

## Phase 1
- add machine-readable tier prices
- add billing tables
- implement one-time Stripe top-ups + webhook crediting
- implement allowance rail + route wrapper
- kill subscription bypass code
- ship dashboard with two balances

## Phase 2
- low-balance emails
- spend policy UI
- recent billing history
- management token / magic-link auth

## Phase 3
- recurring scheduled top-ups
- optional saved cards / threshold auto-top-up
- optional wallet rotation support UI (admin-only first)

---

# Final call on the big decisions

- **Use Option A**
- **Keep x402 headers mandatory on paid requests**
- **Use Postgres as the balance authority**
- **Reuse Stripe metadata, but make `billing_account_id` canonical**
- **Delete all subscription entitlement logic**
- **Use admin ledger credits for CI/support**
- **Keep recurring subscriptions only as recurring top-ups, not access grants**

If you want, I can turn this into:
1. a concrete SQL migration,
2. TypeScript interfaces/services (`authorizeCharge`, `captureAuthorization`, `createAllowanceCheckout`),
3. and a route-by-route refactor plan for your current codebase.

---
**Tokens**: 4,015 input, 65,317 output, 69,332 total
