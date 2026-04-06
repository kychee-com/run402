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

- [ ] 10.1 Extend `billing-email-overage.ts` with auto-recharge trigger: after successful decrement, if `email_credits_remaining < auto_recharge_threshold` AND `auto_recharge_enabled`, fire-and-forget an off-session Stripe charge. [code]
  - TDD: Write failing test for threshold trigger
  - TDD: Write failing test for no trigger when disabled
  - Implement (fire-and-forget Promise, no blocking)
- [ ] 10.2 Create `triggerAutoRecharge(accountId)` in `stripe-billing.ts` — uses saved Stripe payment method to charge $5 off-session, on success adds pack credits, on failure increments `auto_recharge_failure_count` and sends notification email. After 3 failures, disables auto-recharge. [code]
  - TDD: Write failing test for successful auto-recharge
  - TDD: Write failing test for card decline → failure count increment
  - TDD: Write failing test for 3rd failure → disable + notification
  - TDD: Write failing test for successful charge resets failure count
  - Implement

## 11. Route — billing endpoints (email account support)

- [ ] 11.1 Modify `GET /billing/v1/accounts/:id` in `routes/billing.ts`: use `resolveAccountIdentifier`, look up by email if email, by wallet if wallet. Response includes `email_credits_remaining`. [code]
  - TDD: Write failing test for wallet lookup (unchanged)
  - TDD: Write failing test for email lookup
  - TDD: Write failing test for invalid identifier
  - TDD: Write failing test for response includes email_credits_remaining
  - Implement
- [ ] 11.2 Modify `GET /billing/v1/accounts/:id/history` similarly. [code]
  - TDD: Write failing tests for both identifier types
  - Implement
- [ ] 11.3 Add `POST /billing/v1/accounts` — create email billing account. Calls `getOrCreateBillingAccountByEmail`, sends verification email (rate-limited), returns account ID + email. [code]
  - TDD: Write failing test for successful creation
  - TDD: Write failing test for duplicate email idempotent
  - TDD: Write failing test for rate-limited verification
  - Implement
- [ ] 11.4 Add `POST /billing/v1/accounts/:id/link-wallet` — link a wallet (SIWX auth) to an existing email account. [code]
  - TDD: Write failing test for successful link
  - TDD: Write failing test for wallet already linked conflict
  - TDD: Write failing test for invalid SIWX
  - Implement

## 12. Route — Stripe checkout endpoints

- [ ] 12.1 Modify `POST /billing/v1/checkouts` in `routes/billing-stripe.ts` to accept `email` field in addition to `wallet`. Use identifier resolver. [code]
  - TDD: Write failing test for wallet (unchanged)
  - TDD: Write failing test for email
  - TDD: Write failing test for neither provided (400)
  - Implement
- [ ] 12.2 Add `POST /billing/v1/tiers/:tier/checkout` — Stripe tier checkout. Body accepts `email` or `wallet`. Returns `{ checkout_url, topup_id }`. [code]
  - TDD: Write failing test for valid tier subscribe
  - TDD: Write failing test for invalid tier (400)
  - TDD: Write failing test for missing identifier (400)
  - TDD: Write failing test for upgrade/renew paths
  - Implement
- [ ] 12.3 Add `POST /billing/v1/email-packs/checkout` — Stripe pack checkout. Body accepts `email` or `wallet`. Returns `{ checkout_url, topup_id }`. [code]
  - TDD: Write failing test for successful checkout
  - TDD: Write failing test for missing identifier (400)
  - Implement
- [ ] 12.4 Add `POST /billing/v1/email-packs/auto-recharge` — enable/disable auto-recharge. Requires saved payment method (verify via Stripe API). [code]
  - TDD: Write failing test for enable
  - TDD: Write failing test for disable
  - TDD: Write failing test for enable without saved payment method (400)
  - Implement

## 13. Tier config + price mapping

- [ ] 13.1 Add Stripe price ID mapping to `packages/shared/src/tiers.ts` or config module: `prototype → price_xxx`, `hobby → price_yyy`, `team → price_zzz`, `email_pack → price_aaa`. Load from env vars or secrets. [code]
- [ ] 13.2 Add validation: startup logs warn if Stripe price IDs are not configured (for local dev). [code]

## 14. Backward-compatibility test suite

- [ ] 14.1 Run existing `test/billing-e2e.ts` — must pass unchanged. [code]
- [ ] 14.2 Run existing unit tests `billing.test.ts` — must pass unchanged. [code]
- [ ] 14.3 Run existing E2E `test/e2e.ts` (lifecycle) — must pass unchanged (tests wallet-based tier subscription). [code]
- [ ] 14.4 Run existing `test/email-e2e.ts` — must pass unchanged (tests email sending under tier limit). [code]
- [ ] 14.5 Gateway unit tests full suite (`npm run test:unit`) — must pass. [code]
- [ ] 14.6 TypeScript type-check passes (`npx tsc --noEmit -p packages/gateway`). [code]
- [ ] 14.7 Lint passes (`npm run lint`). [code]

## 15. E2E test — new features

- [ ] 15.1 Create `test/email-billing-e2e.ts` covering the full email billing flow: [code]
  - Create email account → verify rate limiting works (rapid second request fails with 429)
  - Stripe checkout for tier subscribe → simulate payment (use Stripe test webhook or direct DB seed)
  - Balance endpoint returns tier, email_credits_remaining = 0
  - Stripe checkout for email pack → simulate payment → credits = 10,000
  - Send email under tier limit → no credit consumed
  - Send emails to exceed tier limit with NO custom domain → 429
  - Register custom sender domain (from Feature #2)
  - Send emails to exceed tier limit WITH custom domain → consumes pack credits
  - Verify pack balance decrements correctly
  - Link wallet to email account → verify both identifiers resolve to same account
- [ ] 15.2 Add `npm run test:email-billing` script to root `package.json`. [code]

## 16. Docs

- [ ] 16.1 Update `site/llms.txt` — add email billing account section, Stripe tier checkout, email pack flow. [manual]
- [ ] 16.2 Update `site/llms-cli.txt` — add CLI commands for billing operations. [manual]
- [ ] 16.3 Update `site/openapi.json` — add new endpoints. [manual]
- [ ] 16.4 Update `site/updates.txt` and `site/humans/changelog.html` with Feature #3 entry. [manual]
- [ ] 16.5 Update `AGENTS.md` tool table with new MCP tools. [manual]

## 17. MCP / CLI / OpenClaw (run402-mcp repo)

- [ ] 17.1 Create MCP tools in `run402-mcp`: `create_email_account`, `tier_checkout`, `buy_email_pack`, `email_pack_status`, `set_auto_recharge`, `link_wallet`. [code]
- [ ] 17.2 Create CLI command `run402 billing` with subcommands: `create-email-account`, `tier-checkout`, `buy-pack`, `pack-status`, `auto-recharge`, `link-wallet`, `balance`, `history`. [code]
- [ ] 17.3 Create OpenClaw shim at `openclaw/scripts/billing.mjs`. [code]
- [ ] 17.4 Update `sync.test.ts` SURFACE array — 13/13 tests must pass. [code]
- [ ] 17.5 Update `SKILL.md` and `README.md` with new tool documentation. [manual]
