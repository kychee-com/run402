## Context

Run402's billing system is wallet-centric with two payment rails (x402 on-chain, allowance for prepaid balance). Tier subscriptions require wallet signature + x402 payment. Email sending has hard tier caps (prototype 10/day, hobby 50/day, team 500/day). For credit-card-only app owners and for products that need to send more emails than tier allows, both these pieces are missing.

This feature adds three parallel capabilities to the existing billing infrastructure without breaking any existing wallet-based paths:
1. Email-based billing account identity (Stripe-only)
2. Stripe tier checkout (credit card as an alternative to x402)
3. Email packs (prepaid bundles that activate only when using a custom sender domain, protecting `mail.run402.com` shared reputation)

The feature is strictly **T1** — app owner pays run402 for infrastructure. T2 (run402 intermediating between apps and their end users) is deferred. See `docs/ideas.md`.

## Goals

- Enable credit-card-only app owner billing (email identity + Stripe tier)
- Enable email sending above tier caps via prepaid packs (requires custom sender domain)
- Zero regressions on existing wallet-based billing
- Protect `mail.run402.com` shared SES reputation from abuse

## Non-Goals

- Generic per-action charge mechanism (no `chargeAction(sku)` abstraction — only the specific `email_pack` SKU)
- Per-contract-call SKU (kysigned spec line 75 explicitly excludes this)
- Invoicing / PDF statements / recurring Stripe subscriptions
- Multiple pack sizes (only $5 / 10,000 emails — simplicity)
- Pack expiration (never expire)
- Bumping tier email hard caps (stay at 10/50/500 as baseline)
- T2 customer accounts / marketplace billing (deferred)

## Decisions

### DD-1: `topup_type` column on billing_topups (not new table)

**Decision:** Add `topup_type TEXT NOT NULL DEFAULT 'cash'` and `funded_email_credits INT NOT NULL DEFAULT 0` columns to existing `billing_topups` table. Cash topups are unchanged (type='cash', funded_usd_micros=X, funded_email_credits=0). Pack topups use type='email_pack', funded_usd_micros=0, funded_email_credits=10000.

**Alternatives considered:**
- *Separate `email_pack_topups` table:* Would duplicate Stripe checkout session tracking (session_id, payment_intent_id, payer_email, livemode). Two webhook dispatch paths.
- *Pure cash model:* Packs just credit $5 to `available_usd_micros`, email sends debit $0.0005 each. Loses pack semantics (can't show "10,000 emails remaining"), makes rollback hard if we change pack pricing.

**Rationale:** Single source of truth for all Stripe-funded top-ups. Clean separation between cash credits (which could change policy later) and email credits (which never expire). The `topup_type` column pattern is a minimal extension — existing queries filtering by cash topups just add `WHERE topup_type = 'cash'`.

**Risks:** Existing billing code may not set `topup_type` explicitly when inserting. Mitigation: DEFAULT 'cash' on the column + thorough backward-compat tests.

**Rollback:** Drop the new columns, revert the pack purchase endpoint. Existing cash topups are untouched.

### DD-2: Platform billing mailbox (`billing@mail.run402.com`)

**Decision:** Create a platform-owned mailbox at `billing@mail.run402.com` for all billing-related notifications (verification, auto-recharge failures, future invoices/low balance warnings). One-time SES setup, owned by run402 itself (not any project).

**Alternatives considered:**
- *Skip verification email:* Auto-recharge failures would have nowhere to go.
- *Require project for email account:* Breaks the user flow — billing must exist before projects.

**Rationale:** Billing is a platform concern. A dedicated mailbox gives us a clean audit trail, enables future notifications, and separates platform email traffic from project email.

**Risks:** Rate limit abuse could damage `mail.run402.com` reputation. Mitigation: strict rate limits (see DD-3).

**Rollback:** Disable billing notifications, keep the mailbox alive for future use.

### DD-3: Three-tier rate limiting on billing mailbox

**Decision:** Three independent rate limits on verification emails:
1. **Per-email cooldown:** 60 seconds between requests to the same email address
2. **Per-IP:** 10 requests per IP per hour
3. **Global:** 500 requests per hour, 2000 per day platform-wide

No lifetime cap per email — users can retry as many times as they want, just not too fast and not too many from one IP.

**Alternatives considered:**
- *Lifetime cap (e.g., 3 tries ever):* Punishes legitimate users who lose verification emails.
- *Only per-IP:* Vulnerable to distributed abuse.
- *Only global:* Legitimate users block each other.

**Rationale:** Three layers catch the common attacks: rapid retries (cooldown), single-attacker abuse (per-IP), and distributed platform-wide DoS (global). Verification is a rare event (once per new billing account), so these limits never affect legitimate users.

**Risks:** Global limit could cause a "temporarily unavailable" error for legitimate users during an attack. Acceptable because (a) attack is rare and (b) auto-retry after 1 hour is fine for a signup flow.

**Rollback:** Increase or remove limits if they prove too restrictive.

### DD-4: Match wallet tier behavior for Stripe tier checkout

**Decision:** Stripe tier checkout supports subscribe, renew, upgrade, AND downgrade — same logic as existing `setTier()` function for wallet-based subscriptions. On downgrade, check if storage fits in new tier; if yes, apply with prorated refund to `available_usd_micros`.

**Alternatives considered:**
- *Subscribe/renew/upgrade only:* Forces email accounts to contact support for downgrades. Inconsistent with wallet accounts.

**Rationale:** Consistency between wallet and email payment paths. Users expect the same tier behavior regardless of how they pay. Reuse existing `setTier()` logic internally — only the Stripe checkout wrapper is new.

**Rollback:** Remove downgrade path, reject with 400 error.

### DD-5: Cash-denominated ledger entries for pack purchases

**Decision:** Email pack purchases create ledger entries with `amount_usd_micros = 5000000` (the $5 paid), `kind = 'email_pack_purchase'`, and metadata `{ "email_credits_added": 10000 }`. Individual email consumption (decrement counter) does NOT create ledger entries — audit trail is in `internal.email_messages` from Feature #2.

**Alternatives considered:**
- *Zero-amount entries with email_credits in metadata:* Ledger totals would miss pack revenue when summing cash amounts.
- *New `email_credits_delta` column on ledger:* Unnecessary complexity for a single SKU.
- *Per-email ledger entries:* High volume (potentially 10,000 rows per pack) with no audit value beyond email_messages.

**Rationale:** Keeps the ledger cash-denominated (uniform accounting/reporting). Pack inventory is a parallel counter. Metadata captures the business context. Audit trail for individual emails lives in the dedicated email_messages table.

**Rollback:** N/A — affects only new entries.

### DD-6: Email overage as a separate service module (`billing-email-overage.ts`)

**Decision:** New service `billing-email-overage.ts` with a single function `tryConsumePackCredit(projectId)` that: (a) looks up the project's billing account, (b) checks if a custom sender domain is verified for the project, (c) atomically decrements `email_credits_remaining` if > 0 (using SELECT FOR UPDATE), (d) returns `{ allowed: boolean, remaining?: number, reason?: string }`. `email-send.ts` calls this function when tier daily limit is exhausted.

**Alternatives considered:**
- *Logic inside `email-send.ts`:* Tight coupling between billing and email sending. Hard to test in isolation.
- *Middleware:* Email sending is an internal service, not an HTTP handler — middleware is the wrong abstraction.

**Rationale:** Clean separation of concerns. Billing logic lives with billing. `email-send.ts` stays focused on SES sending + tier limit enforcement. The overage service is testable in isolation with clear inputs/outputs.

**Rollback:** Remove the service, tier overflow returns 429 without pack check (current behavior).

### DD-7: Identifier auto-detection via format heuristics

**Decision:** New utility `resolveAccountIdentifier(id: string)` that returns `{ type: 'wallet' | 'email', value: string }`:
- Starts with `0x` and is 42 chars → wallet
- Contains `@` and passes `validateEmail` → email
- Otherwise → throw HttpError(400, "Invalid identifier")

Used by balance, history, checkout, tier checkout, pack checkout endpoints.

**Alternatives considered:**
- *Separate endpoints for wallet vs email:* `/billing/v1/accounts/by-wallet/:w` vs `/by-email/:e`. More verbose, requires clients to pick the right one.
- *Query parameter:* `/billing/v1/accounts/:id?type=email`. Extra parameter, easy to get wrong.

**Rationale:** Auto-detection is unambiguous (wallets and emails have distinct formats). Simpler client code. Preserves backward compatibility: existing `/billing/v1/accounts/0x...` calls work unchanged because wallet addresses still match the wallet detection.

**Rollback:** Easy — just stop calling the resolver and go back to wallet-only lookup.

## Risks / Trade-offs

**Backward compatibility risk:** Existing code paths use `getBillingAccount(wallet)` and similar wallet-only APIs. New code adds parallel email-based paths without modifying existing function signatures. *Mitigation:* Explicit backward-compat test suite — every existing billing E2E test must still pass without modification, and new tests verify email-based flows separately.

**Stripe webhook idempotency:** Pack purchases use the same webhook handler as cash topups (`handleStripeWebhookEvent`). If webhook processing crashes partway, the event may be reprocessed. *Mitigation:* Existing `stripe_webhook_events` table already handles this with `stripe_event_id` as the idempotency key. The `creditFromTopup` function is extended to branch on `topup_type` but maintains the same idempotency contract.

**Concurrent email send on the last pack credit:** Two concurrent sends both pass the "credits > 0" check. *Mitigation:* `SELECT ... FOR UPDATE` on the billing_accounts row during `tryConsumePackCredit`, and a CHECK constraint `email_credits_remaining >= 0` on the column.

**Auto-recharge cascading failures:** If a card is declined, auto-recharge could retry indefinitely. *Mitigation:* 3-failure cutoff, then disable auto-recharge and send a final warning email. Failure count resets on successful charge.

**SES reputation from billing mailbox:** The platform billing mailbox shares `mail.run402.com`'s DKIM signature. Abuse there affects ALL run402 customers. *Mitigation:* DD-3 rate limits.

## Migration Plan

Additive change. No breaking migrations. No existing data needs transformation.

1. **Database migrations (server.ts startup, v1.19):**
   - `ALTER TABLE internal.billing_accounts ADD COLUMN email_credits_remaining INT NOT NULL DEFAULT 0 CHECK (email_credits_remaining >= 0)`
   - `ALTER TABLE internal.billing_accounts ADD COLUMN auto_recharge_enabled BOOLEAN NOT NULL DEFAULT false`
   - `ALTER TABLE internal.billing_accounts ADD COLUMN auto_recharge_threshold INT NOT NULL DEFAULT 2000`
   - `ALTER TABLE internal.billing_accounts ADD COLUMN auto_recharge_failure_count INT NOT NULL DEFAULT 0`
   - `ALTER TABLE internal.billing_accounts ADD COLUMN stripe_customer_id TEXT`
   - `ALTER TABLE internal.billing_topups ADD COLUMN topup_type TEXT NOT NULL DEFAULT 'cash' CHECK (topup_type IN ('cash', 'email_pack', 'tier'))`
   - `ALTER TABLE internal.billing_topups ADD COLUMN funded_email_credits INT NOT NULL DEFAULT 0`
   - `ALTER TABLE internal.billing_topups ADD COLUMN tier_name TEXT` (for tier topups)
   - `CREATE TABLE IF NOT EXISTS internal.billing_account_emails (email TEXT PRIMARY KEY, billing_account_id UUID NOT NULL, email_verified_at TIMESTAMPTZ, verification_send_count INT NOT NULL DEFAULT 0, last_verification_sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`
   - Index on `billing_account_emails.billing_account_id`

2. **SES setup (manual one-time):** Create `billing@mail.run402.com` mailbox. Register in SES as a platform-owned identity.

3. **Stripe Product setup (manual one-time):**
   - Product "Run402 Tier — Prototype" at $0.10
   - Product "Run402 Tier — Hobby" at $5.00
   - Product "Run402 Tier — Team" at $20.00
   - Product "Run402 Email Pack" at $5.00

4. **Deploy gateway with new routes + modified email-send:** All new endpoints are additive. Modified email-send maintains backward compatibility for projects without custom sender domains.

5. **Existing wallet-based billing remains untouched.** Every current E2E test must pass unchanged.
