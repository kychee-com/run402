## Why

Run402's billing system is wallet-only: every billing account requires a wallet address, and tier subscriptions require x402 on-chain payment. App owners who want to pay by credit card instead of crypto have no path. For products like kysigned (where the operator might be a non-crypto SaaS team), this is a blocker.

Separately, run402's email limits are hard-capped at the tier level (prototype 10/day, hobby 50/day, team 500/day). For a successful product sending many emails (e.g., kysigned at scale processing 1000 envelopes/day = 10,000+ emails/day), there's no way to pay for more. Hard caps prevent growth — we need an overage mechanism.

Both problems share the same solution shape: add Stripe-based paths to run402's existing billing infrastructure. This feature adds email-based app owner accounts (Stripe identity), Stripe tier checkout (credit card subscriptions), and email packs (prepaid email overage bundles for products using custom sender domains).

**Scope is strictly T1** — app owner pays run402 for infrastructure. T2 (app charging end users) is deferred; see `docs/ideas.md`.

## What Changes

- **Email-based billing accounts**: New path to create a billing account using email instead of wallet. Accounts are Stripe-funded only (no x402 rail). Email accounts can optionally link a wallet later for hybrid access to both payment rails.
- **Email-to-account mapping**: New `internal.billing_account_emails` table (parallel to existing `billing_account_wallets`). Email verification required before spending.
- **Stripe tier checkout**: New endpoint `POST /billing/v1/tiers/:tier/checkout` creates a Stripe checkout session for tier subscription. On payment, sets tier + lease dates on the account. Works for both email accounts and wallet accounts (credit card is an alternative to x402 for tier payments).
- **Email packs**: New prepaid email bundle — `$5 = 10,000 emails` — purchased via Stripe. Credits added to a new `email_credits_remaining` counter on the billing account. Packs kick in when the tier daily email limit is exhausted. Packs never expire.
- **Custom sender domain required for packs**: Email packs can only be consumed if the project has a verified custom sender domain (Feature #2). This protects `mail.run402.com` shared reputation — products sending high volume MUST use their own domain, bearing their own reputation risk.
- **Auto-recharge (optional)**: Billing accounts can enable auto-recharge that triggers a new $5 pack purchase when credits drop below a threshold (e.g., 20% of the last pack). Requires a saved Stripe payment method.
- **Identifier auto-detection**: Balance and history endpoints (`GET /billing/v1/accounts/:id`) auto-detect whether `:id` is a wallet address (0x...) or email (contains @).
- **Docs**: Update `llms.txt`, `llms-cli.txt`, `openapi.json` with new endpoints.
- **MCP/CLI**: New tools for email billing operations and email pack management.
- **BREAKING**: None. All existing wallet-based billing behavior is unchanged.

## Non-goals

- **Per-action charges for arbitrary SKUs**: Email packs are a specific SKU solution, not a generic per-action mechanism. No `chargeAction()` abstraction.
- **Per-contract-call SKU**: Contract call billing is explicitly out of scope (kysigned spec v0.3.0 line 75). Wallet custody (Feature #4) is a separate concern.
- **Invoicing / PDF billing statements**: Future feature.
- **Recurring Stripe subscriptions**: Tier checkout is one-time; users manually renew (or we add recurring later).
- **Customer accounts / T2 billing**: Deferred. See `docs/ideas.md`.
- **Multiple pack sizes**: Only one size — $5 / 10,000 emails. Keeps billing model simple.
- **Pack expiration**: Packs never expire. Once purchased, credits stay until consumed.
- **Bumping tier email hard caps**: Tier limits stay at 10/50/500 per day as a baseline. Growth = email packs, not bigger tiers.

## Capabilities

### New Capabilities

- `email-billing-account`: Create and manage billing accounts identified by email. Stripe-funded. Can link a wallet later for hybrid access. Requires email verification before spending.
- `stripe-tier-checkout`: Subscribe to a run402 tier via Stripe credit card (alternative to x402 on-chain payment). Works for email and wallet accounts.
- `email-pack`: Prepaid email bundles ($5 / 10,000 emails) purchased via Stripe. Kicks in when tier daily limit is exhausted. Requires a verified custom sender domain. Never expires. Optional auto-recharge.

### Modified Capabilities

- `billing-checkout`: Existing `POST /billing/v1/checkouts` extended to accept `email` as identifier (in addition to `wallet`).
- `billing-balance`: `GET /billing/v1/accounts/:id` auto-detects wallet vs email.
- `billing-history`: `GET /billing/v1/accounts/:id/history` auto-detects wallet vs email.
- `email-send`: Existing email sending service checks tier limit first, then email pack balance (if tier exhausted and custom domain verified). Otherwise rejects with 402.

## Impact

- **Gateway** (`packages/gateway/src/`): Extended `billing.ts` with email account creation + email pack functions. New `stripe-tier-checkout.ts` service. Modified `billing.ts` routes to accept email identifiers. Modified `email-send.ts` to check pack balance after tier limit.
- **Database**: New `internal.billing_account_emails` table. New columns on `billing_accounts`: `email_credits_remaining INT`, `auto_recharge_enabled BOOLEAN`, `auto_recharge_threshold INT`. Extended `billing_topups` to support pack purchases.
- **Stripe**: New product for tier checkout (3 prices: prototype $0.10, hobby $5, team $20). New product for email pack ($5). Webhook handler extended to credit tier + email pack purchases.
- **Email sending**: Tier limit check (existing) + pack balance check (new). Atomic decrement when using pack credit.
- **Tests**: Unit tests for email account creation, Stripe tier checkout, email pack purchase/consumption/auto-recharge. E2E test for full email billing flow.
- **Docs**: `site/llms.txt`, `site/llms-cli.txt`, `site/openapi.json` gain email billing + pack endpoints. `docs/ideas.md` gets T2 deferred entry.
- **MCP/CLI**: New tools `create_email_account`, `tier_checkout`, `buy_email_pack`, `email_pack_status`, `set_auto_recharge`. CLI command `run402 billing` with subcommands.
