# Auto-Reload: Threshold-Based Allowance Top-Ups

## Context

Run402's allowance system is fully built — humans fund an agent's wallet via Stripe one-time top-ups, and the agent spends from the prepaid balance. What's missing is the "$5/week" story: automatic, recurring funding so the human sets it and forgets it.

The approach is **threshold-based off-session charges** (not Stripe subscriptions). "When my agent's balance drops below $X, charge $Y to my saved card, up to $Z/month." This is better product: only charges when the agent is active, doesn't waste money during idle periods.

## Files to Modify

| File | Change |
|------|--------|
| `packages/gateway/src/server.ts` | Schema migration (new columns on billing_accounts, billing_topups) + register background checker |
| `packages/gateway/src/services/billing.ts` | Extend BillingAccount interface + rowToAccount(), add auto-reload trigger in debitAllowance() |
| `packages/gateway/src/services/stripe-billing.ts` | Add `setup_future_usage` to checkout, save payment method on webhook, handle payment_intent.succeeded/failed |
| `packages/gateway/src/services/auto-reload.ts` | **NEW** — core auto-reload logic |
| `packages/gateway/src/routes/billing.ts` | New auto-reload config + payment-methods endpoints |
| `packages/gateway/src/services/telegram.ts` | Add auto-reload notification helpers |
| `site/billing/index.html` | Auto-reload settings UI section |

## Implementation Steps

### 1. Schema Migration (`server.ts`)

Add columns to `billing_accounts` (same ALTER TABLE pattern as tier columns at line 916):

```sql
ALTER TABLE internal.billing_accounts ADD COLUMN IF NOT EXISTS auto_reload_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE internal.billing_accounts ADD COLUMN IF NOT EXISTS auto_reload_amount_usd_micros BIGINT NOT NULL DEFAULT 5000000;
ALTER TABLE internal.billing_accounts ADD COLUMN IF NOT EXISTS auto_reload_monthly_cap_usd_micros BIGINT NOT NULL DEFAULT 20000000;
ALTER TABLE internal.billing_accounts ADD COLUMN IF NOT EXISTS auto_reload_month_charged_usd_micros BIGINT NOT NULL DEFAULT 0;
ALTER TABLE internal.billing_accounts ADD COLUMN IF NOT EXISTS auto_reload_month_reset_at TIMESTAMPTZ;
ALTER TABLE internal.billing_accounts ADD COLUMN IF NOT EXISTS auto_reload_consecutive_failures INT NOT NULL DEFAULT 0;
ALTER TABLE internal.billing_accounts ADD COLUMN IF NOT EXISTS auto_reload_last_attempt_at TIMESTAMPTZ;
ALTER TABLE internal.billing_accounts ADD COLUMN IF NOT EXISTS auto_reload_paused_reason TEXT;
ALTER TABLE internal.billing_accounts ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE internal.billing_accounts ADD COLUMN IF NOT EXISTS stripe_default_payment_method_id TEXT;
```

Add source column to `billing_topups`:
```sql
ALTER TABLE internal.billing_topups ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
```

Existing `low_balance_threshold_usd_micros` (default $1) is reused as the reload trigger threshold.

### 2. Extend BillingAccount Interface (`services/billing.ts`)

Add the new columns to the `BillingAccount` interface and `rowToAccount()` mapper. Both are in `billing.ts`. The same mapper is used in `wallet-tiers.ts` — update there too.

### 3. Save Payment Method on Checkout (`services/stripe-billing.ts`)

In `createAllowanceCheckout()`, add `payment_intent_data: { setup_future_usage: 'off_session' }` to the Checkout Session. This tells Stripe to save the card for future off-session use.

In `handleStripeWebhookEvent()`, after crediting the topup on `checkout.session.completed`:
- Retrieve the PaymentIntent to get the payment_method ID
- Store `stripe_default_payment_method_id` and `stripe_customer_id` on the billing account
- Reset `auto_reload_consecutive_failures` to 0 (successful manual top-up clears failure state)

Also: use the local `stripe_customer_id` column in `getOrCreateStripeCustomer()` before falling back to Stripe API search (perf improvement).

### 4. Auto-Reload Service (`services/auto-reload.ts` — NEW)

Key functions:

**`maybeTriggerAutoReload(accountId, currentBalance)`** — fire-and-forget check called after debit. If conditions met (enabled, below threshold, has payment method, under monthly cap, not recently attempted), calls `executeAutoReload` via `setImmediate()`.

**`executeAutoReload(accountId)`** — the core:
1. Acquire advisory lock: `SELECT pg_try_advisory_xact_lock(hashtext($1))` — skip if already held
2. Re-read account (balance may have changed)
3. Reset monthly counter if month boundary passed
4. Check monthly cap has room (cap the amount if partial room)
5. Create `billing_topups` record with `source = 'auto_reload'`
6. Create Stripe off-session PaymentIntent (`customer`, `payment_method`, `off_session: true`, `confirm: true`)
7. On success: credit allowance via `creditFromTopup()`, update monthly counter, reset failure counter, Telegram notify
8. On failure: increment `auto_reload_consecutive_failures`, pause after 3 failures, Telegram notify

**`checkAndReloadAccounts()`** — background sweep every 60s. Finds accounts where: `auto_reload_enabled = true AND available < threshold AND has payment method AND not paused AND last attempt > 30s ago`. Calls `executeAutoReload` for each. Pattern: same as `startLeaseChecker()` / `stopLeaseChecker()`.

**`updateAutoReloadConfig(accountId, config)` / `getAutoReloadConfig(accountId)`** — CRUD for settings.

### 5. Trigger in debitAllowance (`services/billing.ts`)

After the COMMIT at line 344, before the return:

```typescript
// Non-blocking auto-reload check
if (newAvailable < Number(row.low_balance_threshold_usd_micros) && row.auto_reload_enabled) {
  setImmediate(() => {
    maybeTriggerAutoReload(row.id, newAvailable).catch(err =>
      console.error(`Auto-reload trigger failed: ${err}`)
    );
  });
}
```

Zero latency impact on the x402 hot path — runs after response is sent.

### 6. Extend Webhook Handler (`services/stripe-billing.ts`)

Add two new event types:
- `payment_intent.succeeded` (source=auto_reload) → credit allowance, update monthly counter
- `payment_intent.payment_failed` (source=auto_reload) → increment failures, maybe pause

Both identified by `metadata.source === 'auto_reload'` and `metadata.topup_id`.

### 7. API Routes (`routes/billing.ts`)

```
GET  /billing/v1/accounts/:wallet/auto-reload       → current config
PUT  /billing/v1/accounts/:wallet/auto-reload       → update config
POST /billing/v1/accounts/:wallet/auto-reload/pause  → pause
POST /billing/v1/accounts/:wallet/auto-reload/resume → resume
GET  /billing/v1/accounts/:wallet/payment-methods    → saved cards (from Stripe)
```

No auth for v1 (same as existing billing endpoints — wallet address in URL is the identifier).

### 8. Dashboard UI (`site/billing/index.html`)

Add "Auto-Reload" section between the top-up buttons and transaction history:
- Status indicator (active / paused / no card)
- Enable/disable toggle
- Threshold field ("Reload when balance drops below $X")
- Amount field ("Add $Y each time")
- Monthly cap field ("Maximum $Z per month")
- Monthly usage progress bar
- Saved card display (brand + last4) with remove button
- Extend ledger kindMap: `auto_reload_credit: 'Auto-Reload'`

### 9. Telegram Notifications (`services/telegram.ts`)

Add `notifyAutoReload()`, `notifyAutoReloadFailure()`, `notifyAutoReloadDisabled()`.

## Race Condition Prevention

- **Advisory lock** per billing account during reload execution
- **Debounce** via `auto_reload_last_attempt_at` (skip if < 30s ago)
- **Idempotent topups** — each reload creates a topup record before charging
- **Webhook idempotency** via `stripe_webhook_events` table

## Defaults

| Setting | Default | Meaning |
|---------|---------|---------|
| Threshold | $1.00 (existing column) | Trigger reload when balance drops below $1 |
| Reload amount | $5.00 | Add $5 each time |
| Monthly cap | $20.00 | Max $20/month in auto-reloads |
| Enabled | false | Must be explicitly turned on |

## Verification

1. **Type-check + lint**: `npx tsc --noEmit -p packages/gateway && npm run lint`
2. **Manual test**: Admin credit a wallet, enable auto-reload with $2 threshold, admin debit to below threshold, verify Stripe PaymentIntent created and allowance credited
3. **Billing E2E**: Extend `test/billing-e2e.ts` with auto-reload config CRUD test
4. **Dashboard**: Open `/billing?wallet=0x...`, verify auto-reload section renders, toggle works
5. **Deploy + health check**: `/deploy`, verify `curl https://api.run402.com/health`
