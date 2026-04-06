## 1. Schema migrations

- [x] 1.1 Add columns to `internal.billing_accounts` (email_credits_remaining + CHECK, auto_recharge_*, stripe_customer_id) [code]
- [x] 1.2 Add columns to `internal.billing_topups` (topup_type + CHECK, funded_email_credits, tier_name) [code]
- [x] 1.3 Create `internal.billing_account_emails` table + index [code]
- [x] 1.4 Added startup migration block v1.19 to server.ts [code]
- [x] 1.5 N/A — billing tables live in server.ts migrations only, not init.sql (existing pattern preserved) [code]

## 2. Platform billing mailbox (manual SES setup)

- [x] 2.1 SES: `run402.com` already verified, `billing@mail.run402.com` is a subdomain address (no extra SES identity needed). Bootstrap creates `internal.mailboxes` row at server startup. [infra]
- [x] 2.2 Added `BILLING_MAILBOX_ID` + Stripe price ID env vars to config.ts. Runtime resolver looks up mailbox by slug='billing' if env var empty. [code]
- [~] 2.3 Verification check: send test email — will verify after deploy [infra]

## 3. Stripe product setup (manual one-time)

- [x] 3.1 Stripe products + prices created via API: Prototype (prod_UHikXZuApEw7t8 / price_1TJ9JKH8QWpuz0qXNls1VDch $0.10), Hobby (price_1TJ9JVH8QWpuz0qXPXXPpK7V $5, on existing prod_U5O0h08KtVfPGw), Team (price_1TJ9JWH8QWpuz0qXBYifLLlu $20, on existing prod_U5O02ezqPtmJcb), Email Pack (prod_UHil4JuXTDUz5d / price_1TJ9JyH8QWpuz0qXGuX9WsdA $5). All one-time, USD. [infra]
- [x] 3.2 Price IDs stored in AWS Secrets Manager: `agentdb/stripe-price-ids` [infra]
- [x] 3.3 Verified via Stripe REST API (list products/prices) [infra]

## 4. Service — identifier resolution

- [x] 4.1 Create `billing-identifier.ts` with `resolveAccountIdentifier` — wallet/email detection, normalization, 400 on invalid (9 tests) [code]

## 5. Service — email billing accounts

- [x] 5.1 `getOrCreateBillingAccountByEmail` — atomic create, idempotent, rollback on failure (3 tests) [code]
- [x] 5.2 `getBillingAccountByEmail` — found/not-found/normalization (3 tests) [code]
- [x] 5.3 `linkWalletToEmailAccount` — success/409 conflict/404 missing (3 tests) [code]
- [x] 5.4 Backward-compat: all 28 existing billing.test.ts tests still pass unchanged [code]

## 6. Service — verification email (rate-limited)

- [x] 6.1 Created `billing-notifications.ts` with `sendVerificationEmail` using platform billing mailbox (3 tests) [code]
- [x] 6.2 Rate limiting: 60s per-email cooldown, 10/IP/hour, 500/hour + 2000/day global (4 tests) [code]
- [x] 6.3 Verification send count + timestamp persisted on `billing_account_emails` (covered in sendVerificationEmail test) [code]

## 7. Service — Stripe tier checkout

- [x] 7.1 Create `stripe-tier-checkout.ts` with `createTierCheckout(identifier, tierName)` — supports wallet+email, creates Stripe customer, topup row with topup_type='tier' + tier_name, returns checkout URL (6 tests). Tier action (subscribe/renew/upgrade/downgrade) applied by webhook handler via setTierForAccount — deferred to task 7.2 [code]
- [x] 7.2 `handleStripeWebhookEvent` branches on topup_type metadata. `applyTierFromTopup` in stripe-tier-checkout.ts handles subscribe/renew/upgrade/downgrade with prorated refund and idempotency via status check (6 new tests) [code]

## 8. Service — email packs

- [x] 8.1 `stripe-email-pack.ts` with `createEmailPackCheckout` — $5 pack = 10,000 credits, Stripe checkout with topup_type='email_pack' metadata (5 tests) [code]
- [x] 8.2 `creditEmailPackFromTopup` with atomic credit + ledger entry (amount_usd_micros=5_000_000, kind='email_pack_purchase', metadata includes credits added). Webhook handler extended to route email_pack topups. Idempotent via topup status check (4 tests) [code]

## 9. Service — email overage (pack consumption)

- [x] 9.1 Created `billing-email-overage.ts` with `tryConsumePackCredit(projectId)` — rejects no_custom_domain/no_billing_account/no_credits, atomic SELECT FOR UPDATE decrement, race-safe (5 tests) [code]
- [x] 9.2 Modified `email-send.ts` — when tier daily limit exhausted, calls `tryConsumePackCredit`. On success, rolls back counter + proceeds. On failure: 429 for no_custom_domain, 402 for no_credits, existing 402 upgrade hint for no_billing_account. 21/21 existing email-send tests still pass. [code]

## 10. Service — auto-recharge

- [x] 10.1 `billing-email-overage.ts` triggers auto-recharge fire-and-forget after successful decrement (reads auto_recharge_enabled + threshold from account) [code]
  - TDD: Write failing test for threshold trigger
  - TDD: Write failing test for no trigger when disabled
  - Implement (fire-and-forget Promise, no blocking)
- [x] 10.2 `stripe-auto-recharge.ts` — `triggerAutoRecharge(accountId)` + `setAutoRecharge(accountId, enabled, threshold)`. Off-session PaymentIntent, adds credits in transaction with ledger entry (kind='email_pack_auto_recharge'), 3-failure cutoff auto-disables (6 tests) [code]
  - TDD: Write failing test for successful auto-recharge
  - TDD: Write failing test for card decline → failure count increment
  - TDD: Write failing test for 3rd failure → disable + notification
  - TDD: Write failing test for successful charge resets failure count
  - Implement

## 11. Route — billing endpoints (email account support)

- [x] 11.1 `GET /billing/v1/accounts/:id` — uses resolveAccountIdentifier, returns available/credits/tier/lease/auto_recharge fields [code]
- [x] 11.2 `GET /billing/v1/accounts/:id/history` — wallet via getLedgerHistory, email via direct allowance_ledger query by billing_account_id [code]
- [x] 11.3 `POST /billing/v1/accounts` — creates email account via getOrCreateBillingAccountByEmail, sends verification email (rate-limited, errors swallowed to not block creation) [code]
- [x] 11.4 `POST /billing/v1/accounts/:id/link-wallet` — calls linkWalletToEmailAccount. Note: SIWX wallet ownership proof deferred — route trusts wallet in body. Should be enhanced with SIWX middleware in future pass. [code]

## 12. Route — Stripe checkout endpoints

- [x] 12.1 Modified `POST /billing/v1/checkouts` — accepts wallet (existing behavior) and email (400 for now — directs to tier/pack endpoints). Email allowance top-up deferred (not a MVP requirement). [code]
- [x] 12.2 Added `POST /billing/v1/tiers/:tier/checkout` — body with wallet or email, calls createTierCheckout [code]
- [x] 12.3 Added `POST /billing/v1/email-packs/checkout` — body with wallet or email, calls createEmailPackCheckout [code]
- [x] 12.4 Added `POST /billing/v1/email-packs/auto-recharge` — calls setAutoRecharge(accountId, enabled, threshold). Saved-payment-method verification deferred (Stripe will reject at charge time if no PM). [code]

## 13. Tier config + price mapping

- [x] 13.1 Price IDs in `config.ts` as env vars: STRIPE_PRICE_PROTOTYPE/HOBBY/TEAM/EMAIL_PACK. Mapped in stripe-tier-checkout.ts TIER_PRICE_IDS const. [code]
- [x] 13.2 Stripe services throw HttpError(503) if price ID is empty — explicit error instead of silent fallback [code]

## 14. Backward-compatibility test suite

- [~] 14.1 test/billing-e2e.ts — will run against production after deploy (requires live server) [code]
- [x] 14.2 billing.test.ts: 28/28 passing (unchanged) [code]
- [~] 14.3 test/e2e.ts (lifecycle) — deferred to production E2E sweep [code]
- [~] 14.4 test/email-e2e.ts — deferred to production E2E sweep [code]
- [x] 14.5 Full gateway unit suite: 867/867 passing — ZERO regressions across all 44 test files [code]
- [x] 14.6 TypeScript type-check clean [code]
- [x] 14.7 Lint clean [code]

## 15. E2E test — new features

- [x] 15.1 Created `test/email-billing-e2e.ts` — covers: create account, idempotent duplicate, balance by email+wallet+invalid, tier checkout by both identifiers, invalid tier, email pack checkout by both, missing identifier, history by email, auto-recharge enable/disable. 14 test scenarios. [code]
- [x] 15.2 Added `npm run test:email-billing` script [code]
- **Note**: E2E test does NOT complete Stripe payments (would require test card + webhook mocking). Instead it verifies endpoint correctness + that Stripe URLs are returned. Tier exhaustion + pack consumption flows are tested at the unit level (billing-email-overage.test.ts).

## 16. Docs

- [x] 16.1 Updated `site/llms.txt` — new section with email accounts, Stripe tier checkout, email packs, auto-recharge [manual]
- [~] 16.2 `site/llms-cli.txt` — deferred (CLI commands covered in phase 17) [manual]
- [x] 16.3 Updated `site/openapi.json` — added 5 new endpoints: POST /billing/v1/accounts, POST /billing/v1/accounts/{id}/link-wallet, POST /billing/v1/tiers/{tier}/checkout, POST /billing/v1/email-packs/checkout, POST /billing/v1/email-packs/auto-recharge [manual]
- [x] 16.4 Updated `site/updates.txt` and `site/humans/changelog.html` with April 6 entry [manual]
- [x] 16.5 Updated `AGENTS.md` tool table with new billing tools [manual]

## 17. MCP / CLI / OpenClaw (run402-mcp repo)

- [x] 17.1 Created 5 MCP tools: create_email_billing_account, link_wallet_to_account, tier_checkout, buy_email_pack, set_auto_recharge [code]
- [x] 17.2 Created `run402 billing` CLI with 7 subcommands: create-email, link-wallet, tier-checkout, buy-pack, auto-recharge, balance, history [code]
- [x] 17.3 Created OpenClaw shim `openclaw/scripts/billing.mjs` [code]
- [x] 17.4 Updated sync.test.ts SURFACE — 13/13 tests passing [code]
- [x] 17.5 Updated SKILL.md (21/21 SKILL tests passing) and README.md tool table [manual]
