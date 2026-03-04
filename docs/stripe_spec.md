# Stripe Plans Spec — run402

## Design Summary

### The 3-Step Human Integration Story
1. **Agent discovers run402** — reads llms.txt, tries it for free on Base Sepolia testnet
2. **Agent tells human** — "this is cool, I built X, here's what I can do with more resources"
3. **Human upgrades** — two paths:
   - **(a) Fund the wallet (preferred):** Human funds agent's wallet with USDC on Base L2 via Coinbase app. Agent pays for tiers (Prototype/Hobby/Team) with real money. KYC handled by Coinbase.
   - **(b) Stripe subscription (crypto-averse fallback):** Human subscribes to Hobby ($5/mo, $50/yr) or Team ($20/mo, $200/yr) via Stripe. No Prototype tier — testnet is the free trial.

### Architecture Decisions
- **Identity:** Wallet address IS the identity. No login, no user accounts.
- **Linking:** Agent gives human `run402.com/subscribe?wallet=0x...`. Stripe customer metadata stores wallet address.
- **Invisible subscription:** Agent behavior is identical whether paying x402 or subscribed. Gateway intercepts x402 payment, checks Stripe for that wallet, skips settlement if subscribed. Zero new protocol for agents.
- **Shared resource pool:** One subscription = unlimited projects. Storage and API calls aggregated across all projects for the wallet.
- **Upgrade in place:** Existing testnet projects get absorbed into the subscription. Data preserved, same credentials.
- **One payment method at a time:** If wallet has active Stripe subscription, all projects go through subscription. No mixing.
- **Daily cron for lifecycle:** Unified cron handles both x402 lease expiry and Stripe subscription status. Queries Stripe API. No webhooks.

### Stripe Products
| Plan | Monthly | Annual (2mo free) | Storage | API Calls |
|------|---------|-------------------|---------|-----------|
| Hobby | $5/mo | $50/yr | 1 GB shared | 5M shared |
| Team | $20/mo | $200/yr | 10 GB shared | 50M shared |

### New Gateway API Endpoints
- `GET /v1/wallets/:address/projects` — public, returns projects + usage for a wallet
- `POST /v1/stripe/checkout` — creates Stripe Checkout Session with wallet in metadata
- `POST /v1/stripe/portal` — creates Stripe Customer Portal session for plan management
- `GET /v1/stripe/subscription/:wallet` — returns subscription status for a wallet

### Subscribe Page (`/site/subscribe/index.html`)
- Static HTML, dark theme matching /humans
- Reads `?wallet=0x...` from URL
- Shows: wallet address, existing projects with usage stats
- Two pricing cards (Hobby/Team) with monthly/annual toggle
- Stripe Checkout redirect on purchase
- Post-checkout: confirmation + Stripe Customer Portal link

### Data Model Changes
- Add `wallet_address` column to `internal.projects` (populated from x402 sender address on creation)
- Stripe is source of truth for subscription state — queried by wallet address

### llms.txt Changes
- Restructure as: Step 1 (free testnet trial) → Step 2 (upgrade: fund wallet OR human subscribes via Stripe)
- Stripe positioned as fallback for crypto-averse humans

### Testing
- Stripe test mode + full E2E test: checkout → subscription verification → project creation without payment → aggregate limit enforcement

---

## Interview Notes (detailed Q&A)

### Q22: Privacy of wallet project data
**Answer: Public is fine**
Wallet addresses are pseudo-anonymous. Project names and usage stats are low-risk information. New public API endpoint: `GET /v1/wallets/:address/projects` returns project IDs, names, tier, and basic usage stats. Used by the subscribe page to show the human what they're paying for.

### Q21: Subscribe page design
**Answer: Match /humans style, wallet-centric**
Same dark theme as /humans page. Shows: wallet address at top (from URL param), existing projects list with usage stats (fetched from gateway API), two pricing cards (Hobby/Team) with monthly/annual toggle, Stripe checkout button. Minimal, agent-first branding. After successful checkout, show confirmation + Stripe Customer Portal link for future management.

### Q20: llms.txt structure for Stripe path
**Answer: Two paths — free trial, then upgrade**
Restructure llms.txt as: Step 1 — try free on testnet. Step 2 — upgrade via two options: (a) fund wallet with USDC [preferred, agent-native], or (b) human subscribes via Stripe [fallback for crypto-averse humans]. Stripe is positioned as the alternative for humans who resist crypto, not as the primary path.

### Q19: What happens to existing x402 projects on subscription?
**Answer: Absorb all existing projects**
All projects for that wallet get absorbed into the subscription. Leases become irrelevant — projects stay alive as long as subscription is active. Tier limits upgrade to subscription tier (e.g. Prototype → Hobby limits). Clean transition. The daily cron (Q9) handles this: if wallet has active subscription, project never expires regardless of original lease.

### Q18: Can x402 and Stripe coexist for the same wallet?
**Answer: One or the other, not both**
If a wallet has an active Stripe subscription, ALL projects go through subscription. No mixing payment methods. Simpler to reason about. To get higher-tier features, upgrade the subscription. If subscription lapses, agent can go back to x402 per-project payments.

### Q17: Plan upgrade/downgrade
**Answer: Stripe Customer Portal handles it**
Redirect to Stripe's hosted Customer Portal for all plan management (upgrade, downgrade, cancel). Stripe handles proration automatically. Zero custom code for plan changes. Our subscribe page is for initial checkout only; all subsequent management goes through Stripe Portal.

### Q16: Testing strategy
**Answer: Stripe test mode + E2E test**
Use Stripe test mode for development and CI. Write an E2E test that exercises the full flow: create Stripe checkout via API, simulate successful payment (test card), verify subscription is active, create a project without x402 payment, verify aggregate limits work. Real Stripe test mode, not mocks.

### Q15: Email collection
**Answer: Stripe Checkout collects email, we read it back**
Stripe's hosted checkout asks for email as part of payment (no extra fields on our side). After successful checkout, we read the email from the Stripe customer object (via success_url redirect params or API query). Email is available in Stripe for receipts, and we can query it for our own notifications. Clean — Stripe handles collection, we just read.

### Q14: Wallet authentication protocol
**Answer: Invisible subscription — zero new protocol**
Agent behavior is identical whether paying x402 or subscribed. Agent still sends x402 payment headers like normal. Gateway intercepts BEFORE settlement, extracts the wallet address from the payment proof, checks Stripe for active subscription on that wallet. If subscribed → skips payment settlement. If not → proceeds with normal x402 payment. The agent doesn't even know it has a subscription — it just stops getting charged. Zero new auth code for agents.

For metered endpoints (REST API, storage) that use apikey/service_key: the project already has a `wallet_address` column (Q8), so the gateway can look up the wallet from the project and check subscription status.

### Q13: Project creation flow for subscribed agents
**Answer: Same endpoint, subscription bypass**
POST /v1/projects — same as today. Agent includes a wallet signature header. Gateway checks Stripe subscription for that wallet — if active, skips x402 payment and creates project under the subscription's tier. One endpoint, two payment paths. The agent doesn't even need to know which payment method is in use (x402 lib handles 402 responses, wallet sig handles subscription auth).

### Q12: Subscribe URL pattern
**Answer: `run402.com/subscribe?wallet=0x...`**
Simple query param. Agent constructs URL with its own wallet address. llms.txt documents this as "when you need more resources or your testnet funds run out, send your human to this URL". The subscribe page reads the wallet param and shows existing projects + pricing.

### Q11: Resource limit enforcement for Stripe subscriptions
**Answer: Aggregate enforcement**
Track total storage and API calls across ALL projects for a wallet. When aggregate exceeds tier limit, block new operations. Requires summing usage across projects on each check (can cache). This is the honest enforcement model — the human is paying for a pool, not per-project.

### Q10: Subscribe page tech stack
**Answer: Static HTML + gateway API**
Keep the /site pattern. Static HTML page that calls gateway API endpoints for Stripe checkout and portal. Use Stripe.js for the payment form. No framework, no build step. Consistent with the existing site. Gateway gets new API routes for Stripe operations.

### Q9: Subscription lifecycle management
**Answer: Daily cron job that queries Stripe**
No webhooks. A daily cleanup cron handles ALL project lifecycle — both x402-lease projects (check expiry) and Stripe-backed projects (query Stripe API for subscription status). If Stripe subscription is cancelled or payment failed, cron marks projects as expired with the same grace period. Single unified lifecycle management.

### Q8: Data model changes
**Answer: Add wallet_address to projects table**
Add a `wallet_address` column to `internal.projects`. Populated on project creation from the x402 payment's sender address. Enables lookup by wallet for the subscribe page and subscription linking. Stripe subscription state lives in Stripe (source of truth) — we just query it by wallet when needed.

### Q7: Wallet verification on subscribe page
**Answer: No verification needed, but show existing projects**
If someone wants to pay for a random wallet, that's their money. But the subscribe page should show existing projects associated with that wallet so the human can see what they're paying for. This also serves as a soft validation — if there are no projects, the human knows something might be wrong.

### Q6: Stripe pricing
**Answer: Annual discount — 2 months free**
- Hobby: $5/mo or $50/yr (save $10)
- Team: $20/mo or $200/yr (save $40)
- No Prototype tier on Stripe (testnet is free, Stripe is for production)

### Q5: Dashboard scope for humans?
**Answer: Light — pricing page + project list**
Pricing page with checkout, plus a simple page showing projects under the subscription with basic usage stats (storage used, API calls). Billing management via Stripe Customer Portal. Human can see what their agent is doing with their money.

### Q4: What happens to existing testnet projects on subscription?
**Answer: Upgrade in place**
The existing testnet project gets "promoted" to a paid project under the subscription. Data preserved, same credentials. The agent's testnet prototype becomes a real production project with the subscribed tier's limits.

### Q3: How does the agent authenticate with its subscription?
**Answer: Wallet signature**
Agent signs a challenge with its private key. Gateway verifies signature, looks up wallet in Stripe customer metadata, confirms active subscription. Zero new credentials — the wallet IS the identity. This is the most elegant approach: no new auth mechanism, no extra credentials. The agent already has a wallet from the x402 flow.

### Q2: How does an agent's project get linked to a human's Stripe subscription?
**Answer: Wallet-based, agent-first flow (no login)**
The agent has a wallet. When it needs its human to subscribe, it gives the human a personalized link like `https://run402.com/subscribe?wallet=0x...`. The human pays via Stripe. The subscription is linked to the agent's wallet address (stored in Stripe customer metadata). No login required — the wallet IS the identity.

This works with Stripe: create a Checkout Session with the wallet in `metadata` and/or `client_reference_id`. The Stripe customer record is keyed by wallet address.

### Q1: One subscription = how many projects?
**Answer: Unlimited projects (shared pool)**
The tier's resource limits (storage, API calls) are shared across all projects. Agent can create as many as it wants within the pool.

