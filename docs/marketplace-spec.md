# Run402 Marketplace Spec — Publish, Fork & Publisher Rewards

> Consolidated from consultations (GPT-5.4 Pro, March 2026) and shipped implementation.

---

## Overview

Run402 makes live applications forkable. Agents publish immutable app versions; other agents fork them in one x402 call to get an independent copy with fresh backend, budget, and URL. Publishers earn rewards from downstream hosting revenue.

**Fork is free.** The forker pays normal Run402 tier pricing — no additional creator fee. Publisher rewards come from Run402's margin, not from the forker.

---

## What's Shipped

- **Bundle deploy**: `POST /v1/deploy/:tier` — single-call atomic deploy
- **Publish**: `POST /admin/v1/projects/:id/publish` — pg_dump snapshot → S3 bundle
- **Fork**: `POST /v1/fork/:tier` — loads bundle, calls same `deployBundle()` orchestrator
- **App inspection**: `GET /v1/apps/:versionId` (free, no auth)
- **App listing**: `GET /v1/apps` with tag filtering
- **DB tables**: `internal.app_versions`, `internal.app_version_functions`, `projects.source_version_id`
- **Schema export**: pg_dump pre/post-data split, `__SCHEMA__` canonicalization, grant re-application
- **E2E**: 135 tests passing on production with real x402 payments

## What's Not Shipped Yet

- Publisher rewards / revenue split
- `run402.yaml` manifest
- `/.well-known/run402-app.json`
- MCP tools: `publish_app`, `list_versions`, `inspect_app`, `fork_app`
- Frontend runtime config injection (`window.__RUN402_CONFIG__`)
- Public search/browse API, Bazaar integration
- Fork graph visualization
- Async fork (202 + operation ID)
- Views, triggers, DB functions, enums, extensions in fork artifacts

---

## Pricing

| Tier | Price | Lease | Storage | API Calls | Functions | Secrets |
|------|-------|-------|---------|-----------|-----------|---------|
| Prototype | $0.10 | 7 days | 250MB | 500K | 5 | 10 |
| Hobby | $5.00 | 30 days | 1GB | 5M | 25 | 50 |
| Team | $20.00 | 30 days | 10GB | 50M | 100 | 200 |

Fork pricing = same as new project creation. No discount, no separate fork fee.

---

## Copy Semantics

### Copied
- DB schema (pg_dump pre/post)
- Explicit seed data (opt-in tables only)
- Function source code
- Site built assets (pinned via ref_count)
- Secret **names/placeholders** (not values)
- RLS policies, indexes, constraints

### Regenerated per fork
- Project ID, anon key, service key
- DB credentials, JWT/auth signing secrets
- Schema slot
- Subdomain/URL
- Budget/lease

### Never copied
- Secret **values**
- Live user data, auth users/sessions
- Private uploads / object storage
- Custom domains, webhooks, OAuth external setup
- Logs, analytics

---

## Publisher Rewards — `standard-v1`

### Model: Capped Ancestor Waterfall

- **Total reward pool**: 20% of gross hosting revenue per lease charge
- **Run402 always retains 80%** — depth does not reduce platform take
- **Depth cap**: 3 rewarded ancestors max
- **Trigger events**: successful lease start + renewals (not payment auth alone)
- **Rewards only from paid revenue** — no rewards on faucet/admin/promo-funded usage

### Distribution

| Chain depth | Closest publisher | Next ancestor | Third ancestor | Run402 keeps |
|---|---:|---:|---:|---:|
| 1 (source only) | 20% | — | — | 80% |
| 2 (source + 1 ancestor) | 14% | 6% | — | 80% |
| 3 (source + 2 ancestors) | 14% | 4% | 2% | 80% |

### Dollar examples

**Hobby $5, depth 2 lineage:**
- Closest publisher: $0.70
- Ancestor: $0.30
- Run402: $4.00

**Team $20, depth 3 lineage:**
- Closest publisher: $2.80
- Next ancestor: $0.80
- Third ancestor: $0.40
- Run402: $16.00

### Why multi-level is fair

Direct-parent-only means Agent2 can rename/beautify Agent1's app and capture 100% of downstream rewards. Multi-level with strong local bias (70% to closest parent) rewards both the curator/distributor AND the foundational creator.

### Payout mechanics

- **Currency**: USDC on Base
- **Model**: rewards accrue in a separate reward ledger, then become **claimable**
- **Minimum claim**: $10
- **Cadence**: claim-based or weekly sweep
- **Self-fork suppression**: no reward when payer wallet == publisher wallet
- No real-time on-chain splitting — USDC is the payout rail, not the accounting rail

### Future presets

| Preset | Pool | Use case |
|---|---|---|
| `standard-v1` | 20% | Default |
| `direct-v1` | 20% | Direct parent only (no ancestors) |
| `growth-v1` | 25% | Featured/promo apps |

---

## Two Wallet Identities

Only two wallets matter — no "payer account" concept needed:

- **Forker wallet** — owns the new project, pays hosting via x402 (already captured from payment header)
- **Creator wallet** — published the original, receives rewards (`app_versions.publisher_wallet`, already stored)

---

## `run402.yaml`

### Author-facing schema (v1alpha1)

```yaml
apiVersion: run402.com/v1alpha1
kind: App

publish:
  visibility: public
  fork:
    allowed: true
    minTier: hobby

  publisherRewards:
    enabled: true
    preset: standard-v1
```

Publishers choose **participation and preset**. Run402 resolves and stores the effective policy on the immutable app version. No arbitrary per-app percentages.

### Platform-resolved effective policy (stored on version)

```yaml
mode: ancestor-waterfall
rewardPoolBps: 2000
maxDepth: 3
depthSchedules:
  "1": [10000]
  "2": [7000, 3000]
  "3": [7000, 2000, 1000]
basis: gross-service-revenue-ex-tax-and-refund
events: [lease_start, lease_renewal]
payout:
  token: USDC
  chain: base
selfReward: suppress-exact-wallet-match
```

---

## DB Schema Changes

### Additions to `app_versions`

- `parent_version_id TEXT REFERENCES app_versions(id)` — link to parent version
- `reward_policy_preset TEXT` — e.g. `standard-v1`
- `reward_policy JSONB` — resolved effective policy
- `rewards_enabled BOOLEAN DEFAULT false`

### New: Version lineage closure table

```sql
CREATE TABLE internal.app_version_lineage (
  version_id TEXT NOT NULL,
  ancestor_version_id TEXT NOT NULL,
  depth INT NOT NULL,  -- 0 = self, 1 = parent, 2 = grandparent
  PRIMARY KEY (version_id, ancestor_version_id)
);
```

Enables trivial reward resolution: query lineage for `source_version_id`, take depths 0..2.

### New: Billing events

```sql
CREATE TABLE internal.project_billing_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  charge_authorization_id TEXT,
  event_type TEXT NOT NULL,  -- 'lease_start', 'lease_renewal', 'upgrade'
  gross_usd_micros BIGINT NOT NULL,
  share_eligible BOOLEAN NOT NULL DEFAULT true,
  funding_source TEXT NOT NULL,  -- 'x402', 'allowance_paid', 'allowance_promo'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### New: Reward tables

```sql
CREATE TABLE internal.publisher_reward_accounts (
  wallet_address TEXT PRIMARY KEY,
  available_usd_micros BIGINT NOT NULL DEFAULT 0,
  held_usd_micros BIGINT NOT NULL DEFAULT 0,
  terms_accepted_at TIMESTAMPTZ,
  payout_status TEXT NOT NULL DEFAULT 'pending_approval',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE internal.publisher_reward_ledger (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  direction TEXT NOT NULL,  -- 'credit', 'debit'
  kind TEXT NOT NULL,  -- 'accrual', 'claim', 'reversal', 'hold', 'release'
  amount_usd_micros BIGINT NOT NULL,
  balance_after_available BIGINT NOT NULL,
  balance_after_held BIGINT NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  idempotency_key TEXT UNIQUE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE internal.publisher_reward_allocations (
  id TEXT PRIMARY KEY,
  project_billing_event_id TEXT NOT NULL,
  recipient_wallet TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  amount_usd_micros BIGINT NOT NULL,
  depth INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'credited', 'reversed'
  hold_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE internal.publisher_payouts (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  amount_usd_micros BIGINT NOT NULL,
  tx_hash TEXT,
  chain TEXT NOT NULL DEFAULT 'base',
  token TEXT NOT NULL DEFAULT 'USDC',
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'sent', 'confirmed', 'failed'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);
```

### Billing change: Fund-source isolation

Split `available_usd_micros` on `billing_accounts` into:
- `available_paid_usd_micros` — from Stripe topups and x402
- `available_promo_usd_micros` — from admin credits, faucet

Rewards accrue only on the paid portion. Prevents promo credits from minting real USDC payouts.

---

## Publish Flow (with rewards)

1. Acquire advisory lock on project
2. Validate no unsupported objects (views, triggers, enums, extensions rejected)
3. Parse `run402.yaml` if present, resolve reward preset
4. Run pg_dump pre/post-data, canonicalize schema
5. Optionally dump seed data
6. Bundle into S3 with SHA-256
7. Compute `derived_min_tier` from artifact stats
8. Pin site deployment (increment ref_count)
9. Set `parent_version_id = projects.source_version_id` if project is itself a fork
10. Insert lineage rows: self row + copy parent's lineage with `depth + 1`
11. Insert `internal.app_versions` with resolved reward policy
12. Return version ID

## Fork Flow

1. `POST /fork/v1` with `{ version_id, name }`, wallet auth (free with active tier)
2. Load S3 bundle, verify SHA-256
3. Validate `tier >= effective_min_tier`
4. Call `deployBundle()` orchestrator
5. Apply pre-schema, seed, post-schema SQL via psql
6. Re-apply table/sequence grants
7. Record `source_version_id` on new project
8. Return credentials + readiness status + missing secrets

## Reward Accrual Flow

1. On successful lease start or renewal, insert `project_billing_events`
2. Check project has `source_version_id` and source version has `rewards_enabled`
3. Load lineage for source version (depths 0..2)
4. Compute 20% reward pool from `gross_usd_micros`
5. Apply waterfall split (70/20/10 or 70/30 or 100%)
6. Insert `publisher_reward_allocations` per ancestor
7. Credit reward accounts (with hold period for allowance-backed charges)
8. On claim: verify publisher terms + approval, send USDC to `publisher_wallet`

---

## Discovery (Planned)

### Machine-readable
- `/.well-known/run402-app.json` auto-generated for published apps
- Response headers: `X-Run402-App-Id`, `Link` to manifest
- `GET /v1/apps` — search/filter public apps
- MCP tools: `search_apps`, `inspect_app`, `get_fork_quote`, `fork_app`

### Metadata fields
`forkable`, `price`, `minTier`, `requiredSecrets`, `requiredActions`, `license`, `capabilities`, `outboundHosts`, `forkCount`, `verified`, `forkSuccessRate`, `examplePrompts`, `publisherRewards`

### Human gallery
Secondary at `run402.com/apps`. Primary discovery is structured/machine-readable.

---

## Legal / Compliance

- **Framing**: "Platform rewards program" — avoid "royalties", "profit share", "marketplace seller payouts"
- **Structure**: Run402 is merchant of record. Publisher is NOT the host. Rewards are paid by Run402 from its own revenue.
- **Sanctions screening**: required on publisher wallets
- **Tax onboarding**: when payout thresholds are hit (1099-MISC or equivalent)
- **Publisher Terms**: required acceptance before first claim
- **Clawback/offset**: contractual language for fraud, refunds, chargebacks
- **Suspend rights**: Run402 can suspend payouts at any time
- **Accrual vs claim**: anyone can accrue; approval required before first payout
- **No fiat withdrawals, no cross-chain, no arbitrary payout address changes** in v1
- **"Pyramid" language**: never use publicly. Use "publisher rewards", "lineage credits"

---

## Rollout Plan

### Phase 1 — Shadow accrual
- Add `parent_version_id`, `app_version_lineage`, reward ledger tables
- Run shadow reward calculations at 20% for 2–4 weeks
- Dashboards only, no payouts
- Measure: fork rate, ready rate, day-7 survival, renewal conversion

### Phase 2 — Enable rewards
- Enable `standard-v1` on opt-in publishes
- Claim-based Base USDC payouts
- $10 minimum, manual review on first claim
- Publisher Terms acceptance gate
- Fund-source isolation (paid vs promo balances)

### Phase 3 — Scale the marketplace
- Automated claims / weekly sweeps
- Public lineage in app metadata
- `run402.yaml` convention
- MCP discovery tools
- Bazaar integration
- Experiment with `growth-v1` (25%) preset

### Phase 4 — Trust & certification
- Verified publisher badges
- Fork success rate tracking
- Secret scanning on publish
- Instant-ready badge

---

*Compiled from GPT-5.4 Pro consultations (March 2026) and shipped implementation.*
