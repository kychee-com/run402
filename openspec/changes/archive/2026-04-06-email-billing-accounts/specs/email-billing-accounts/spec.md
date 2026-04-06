### Requirement: Email-based billing account creation

The gateway SHALL support creating billing accounts using an email address.

#### Scenario: Create account by email

- **WHEN** `POST /billing/v1/accounts` is called with `{ "email": "user@example.com" }`
- **THEN** the gateway SHALL create a billing account with `available_usd_micros = 0` and `email_credits_remaining = 0`
- **AND** create a `billing_account_emails` mapping (email → account)
- **AND** return the account ID, email, and verification status
- **AND** the account SHALL have `email_verified = false` until verified

#### Scenario: Duplicate email (idempotent)

- **WHEN** an account already exists for the given email
- **THEN** the gateway SHALL return the existing account (HTTP 200, same shape)

#### Scenario: Email verification

- **WHEN** an email account is created
- **THEN** a verification email SHALL be sent to the email address
- **AND** the email SHALL contain a time-limited verification link
- **AND** spending (Stripe checkout, email sends against pack) SHALL be allowed regardless of verification status (payment proves identity; verification is only for notifications and account recovery)
- **NOTE:** Verification is a soft signal, not a gate — blocking spending until verified creates chicken-and-egg problems when Stripe is the primary identity proof.

#### Scenario: Link wallet to email account

- **WHEN** `POST /billing/v1/accounts/:account_id/link-wallet` is called with SIWX auth for a new wallet
- **THEN** the wallet SHALL be added to `billing_account_wallets` for the same account
- **AND** the account SHALL gain access to both x402 and Stripe payment rails

#### Scenario: Wallet already has an account

- **WHEN** a wallet that already has its own billing account tries to link to an email account
- **THEN** the gateway SHALL return HTTP 409 with an error (wallet can only belong to one account)

### Requirement: Identifier auto-detection

The gateway SHALL auto-detect whether an identifier parameter is a wallet address or email.

#### Scenario: Wallet address detection

- **WHEN** an identifier starts with `0x` and is 42 characters long
- **THEN** it SHALL be treated as a wallet address

#### Scenario: Email detection

- **WHEN** an identifier contains `@` and matches email format
- **THEN** it SHALL be treated as an email address

#### Scenario: Invalid identifier

- **WHEN** an identifier is neither a valid wallet address nor a valid email
- **THEN** the gateway SHALL return HTTP 400

### Requirement: Balance and history by email or wallet

#### Scenario: Balance by email

- **WHEN** `GET /billing/v1/accounts/:id` is called with an email
- **THEN** the gateway SHALL resolve the email to a billing account
- **AND** return `{ available_usd_micros, email_credits_remaining, tier, lease_expires_at }`

#### Scenario: Balance by wallet

- **WHEN** `GET /billing/v1/accounts/:id` is called with a wallet address
- **THEN** behavior SHALL be unchanged from existing behavior, plus the response SHALL now include `email_credits_remaining`

#### Scenario: History by email

- **WHEN** `GET /billing/v1/accounts/:id/history` is called with an email
- **THEN** the gateway SHALL return the ledger history for the email's billing account

### Requirement: Stripe checkout accepts email identifier

The existing `POST /billing/v1/checkouts` endpoint SHALL accept email as account identifier.

#### Scenario: Checkout by email

- **WHEN** `POST /billing/v1/checkouts` is called with `{ "email": "user@example.com", "amount_usd_micros": 5000000 }`
- **THEN** the gateway SHALL resolve the email to a billing account (creating one if needed)
- **AND** return a Stripe checkout URL
- **AND** on payment completion, credit the email account's `available_usd_micros`

#### Scenario: Checkout by wallet (unchanged)

- **WHEN** `POST /billing/v1/checkouts` is called with `{ "wallet": "0x..." }`
- **THEN** behavior SHALL be unchanged

### Requirement: Stripe tier checkout

The gateway SHALL expose a Stripe-based tier subscription endpoint.

#### Scenario: Subscribe via Stripe (new tier)

- **WHEN** `POST /billing/v1/tiers/:tier/checkout` is called with `{ "email": "user@example.com" }` or `{ "wallet": "0x..." }`
- **AND** the account has no active tier
- **THEN** the gateway SHALL create a Stripe checkout session for the tier price (prototype $0.10, hobby $5, team $20)
- **AND** return `{ checkout_url, topup_id }`
- **AND** on payment completion, set the account's tier, lease_started_at, lease_expires_at

#### Scenario: Renew via Stripe (active tier, same tier)

- **WHEN** an account with an active tier calls the endpoint for the same tier
- **THEN** a checkout session SHALL be created
- **AND** on completion, the lease SHALL be extended (same logic as wallet-based renewal)

#### Scenario: Upgrade via Stripe

- **WHEN** an account calls the endpoint for a higher tier than current
- **THEN** a checkout session SHALL be created for the new tier price
- **AND** on completion, the tier SHALL be upgraded with prorated refund of the old tier (same logic as wallet-based upgrade)

#### Scenario: Invalid tier

- **WHEN** `:tier` is not a valid tier name
- **THEN** the gateway SHALL return HTTP 400

### Requirement: Email pack purchase

The gateway SHALL expose an endpoint to purchase prepaid email credit packs.

#### Scenario: Buy email pack via Stripe

- **WHEN** `POST /billing/v1/email-packs/checkout` is called with `{ "email": "user@example.com" }` or `{ "wallet": "0x..." }`
- **THEN** the gateway SHALL create a Stripe checkout session for $5
- **AND** return `{ checkout_url, topup_id }`
- **AND** on payment completion, increment `email_credits_remaining` by 10,000
- **AND** append a ledger entry with `kind = 'email_pack_purchase'`

#### Scenario: Pack credits never expire

- **WHEN** an email pack is purchased
- **THEN** the credits SHALL remain on the account indefinitely
- **AND** the ledger entry SHALL include no expiration metadata

#### Scenario: Pack credit balance visible

- **WHEN** `GET /billing/v1/accounts/:id` is called
- **THEN** the response SHALL include `email_credits_remaining`

### Requirement: Email pack consumption (tier overflow)

The email sending service SHALL consume email pack credits only when the tier daily limit is exhausted AND the project has a verified custom sender domain.

#### Scenario: Under tier limit

- **WHEN** the mailbox is under its tier daily email limit
- **THEN** email SHALL be sent using the tier allocation
- **AND** `email_credits_remaining` SHALL NOT be decremented

#### Scenario: Over tier limit with custom domain and pack credits

- **WHEN** the mailbox has reached its tier daily email limit
- **AND** the project has a verified custom sender domain
- **AND** the billing account has `email_credits_remaining > 0`
- **THEN** the email SHALL be sent from the custom sender domain
- **AND** `email_credits_remaining` SHALL be decremented by 1 atomically
- **AND** the decrement SHALL occur in the same transaction as the send record

#### Scenario: Over tier limit without custom domain

- **WHEN** the mailbox has reached its tier daily email limit
- **AND** the project has NO verified custom sender domain
- **THEN** the email SHALL NOT be sent
- **AND** the gateway SHALL return HTTP 429 with an error explaining: "Tier email limit exhausted. To send more emails, register a custom sender domain and buy an email pack."
- **AND** `email_credits_remaining` SHALL NOT be consumed (shared reputation protection)

#### Scenario: Over tier limit with custom domain but no pack credits

- **WHEN** the mailbox has reached its tier daily email limit
- **AND** the project has a verified custom sender domain
- **AND** the billing account has `email_credits_remaining = 0`
- **AND** auto-recharge is not enabled (or auto-recharge fails)
- **THEN** the email SHALL NOT be sent
- **AND** the gateway SHALL return HTTP 402 with a Stripe checkout URL for a new pack

#### Scenario: Atomic debit

- **WHEN** multiple concurrent email sends compete for the last few pack credits
- **THEN** `email_credits_remaining` SHALL be decremented atomically using `SELECT ... FOR UPDATE`
- **AND** the final balance SHALL NOT go negative

### Requirement: Auto-recharge for email packs

The gateway SHALL support automatic repurchase of email packs when credits run low.

#### Scenario: Enable auto-recharge

- **WHEN** `POST /billing/v1/email-packs/auto-recharge` is called with `{ "enabled": true, "threshold": 2000 }` and a saved Stripe payment method
- **THEN** `auto_recharge_enabled` SHALL be set to true
- **AND** `auto_recharge_threshold` SHALL be stored (default 2000)

#### Scenario: Auto-recharge trigger

- **WHEN** `email_credits_remaining` drops below `auto_recharge_threshold` during a send
- **AND** auto-recharge is enabled
- **AND** the account has a saved Stripe payment method
- **THEN** the gateway SHALL create an off-session Stripe charge for $5
- **AND** on success, increment `email_credits_remaining` by 10,000
- **AND** log the auto-recharge in the ledger with `kind = 'email_pack_auto_recharge'`

#### Scenario: Auto-recharge failure

- **WHEN** an auto-recharge Stripe charge fails (card declined, expired, etc.)
- **THEN** the gateway SHALL send a notification email to the account's email
- **AND** track the failure count
- **AND** after 3 consecutive failures, disable auto-recharge and send a final warning

#### Scenario: Disable auto-recharge

- **WHEN** `POST /billing/v1/email-packs/auto-recharge` is called with `{ "enabled": false }`
- **THEN** `auto_recharge_enabled` SHALL be set to false
- **AND** subsequent tier overflow without pack credits SHALL return 402 (not auto-charge)

### Requirement: Shared domain reputation protection

The `mail.run402.com` shared sending domain SHALL never use email pack credits.

#### Scenario: mail.run402.com is hard-capped

- **WHEN** a project without a custom sender domain hits its tier daily email limit
- **THEN** no further emails SHALL be sent from `mail.run402.com` for that day
- **AND** email pack credits SHALL NOT be consumable from `mail.run402.com`
- **AND** the error message SHALL direct the user to register a custom sender domain

#### Scenario: Custom domain bypass is explicit

- **WHEN** a project has a verified custom sender domain
- **THEN** its sends automatically use the custom domain (from Feature #2)
- **AND** overages against the email pack work transparently
