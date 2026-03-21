# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-09T11:47:46.786076
**Completed**: 2026-03-09T12:25:53.210623
**Status**: completed

---

With the clarified assumptions, I’d change the recommendation materially:

**publisher rewards fit this model well**, and **multi-level can be fair** if you implement it as a **capped waterfall**, not an uncapped stack.

## 1) Recommended v1 model

### Core idea
- **Fork remains free** in the sense you described: no creator fee on the artifact.
- The forker still pays normal Run402 hosting/tier pricing.
- **Run402 shares part of its hosting revenue back to publishers** of the source lineage.

### My recommended default
Launch with a single standard policy:

- **Reward pool:** **20%** of rewardable hosting revenue
- **Scope:** initial paid fork deployment **and** renewals
- **Depth cap:** **3 rewarded hops max**
- **Distribution:**
  - If only the source version is in the chain: **100% of the pool** to that publisher
  - If source version + 1 ancestor: **70% / 30%** of the pool
  - If source version + 2+ ancestors: **70% / 20% / 10%** of the pool to the closest 3 publishers

That yields these **gross revenue shares**:

| Rewarded chain | Closest source publisher | Next ancestor | Third ancestor | Run402 retained* |
|---|---:|---:|---:|---:|
| Source only | 20% | — | — | 80% |
| Source + 1 ancestor | 14% | 6% | — | 80% |
| Source + 2 ancestors | 14% | 4% | 2% | 80% |

\*Retained before infra/COGS/payout ops.

This is the key point: **depth does not reduce platform take** if you cap the total pool.  
That’s why multi-level is much more viable under your actual business model than in the previous framing.

---

## 2) Direct-parent vs multi-level: nuanced tradeoff

I agree with your pushback: the earlier “permanent rent” framing was too blunt for your actual design.

### Direct-parent-only is good when:
- you want the **simplest possible model**
- you want to maximize incentive for the **final packager/marketer/curator**
- you think most downstream value will come from **distribution and polish**, not foundational architecture

### Multi-level is good when:
- you want to reward **foundational creators**, not just remixers
- you want to avoid a world where someone can rename/beautify/market an app and capture **100% of downstream rewards**
- you want the ecosystem to feel more like **forkable application lineage**, not just affiliate capture

### The real distinction
The bad version of multi-level is:

- **additive**
- **uncapped**
- **deep/infinite**

Example of a bad model:
- 15% to direct parent
- +5% to grandparent
- +2% to great-grandparent
- +... forever

That really does impose a compounding upstream tax and makes platform economics worse with depth.

The good version of multi-level is:

- **fixed total pool**
- **shallow depth cap**
- **strong local bias**

That is not “permanent rent” in the same sense. In your setup, the **forker price does not increase**. The question is only how Run402 allocates its own margin across the lineage.

### My recommendation
Use **multi-level by default**, but keep it **shallow and biased toward the closest parent**.

Why this matches your example:

- Agent1 builds the foundational app
- Agent2 beautifies/markets it
- Agent3 forks Agent2

Under the recommended model on a **$5 Hobby** fork/renewal:
- Agent2 gets **$0.70**
- Agent1 gets **$0.30**
- Run402 keeps **$4.00**

That feels much closer to the fairness intuition you’re aiming for than direct-parent-only, where Agent1 gets nothing.

### Why not give more to ancestors?
Because you still need strong incentive for Agent2-style curation/distribution.  
If the direct parent only gets, say, 40–50% of the pool, remixers will feel under-rewarded.

### Why cap at depth 3?
Because that captures the fairness case without turning every long chain into permanent economic sediment.

If you later want another knob, the next one should be:
- **time cap**, or
- **stay at depth 3 but adjust weights**

Not unbounded depth.

---

## 3) Recommended percentages with actual tier math

### Recommended standard: **20% pool**
That gives psychologically meaningful numbers:

| Tier | Price | Total publisher rewards pool | Run402 retained |
|---|---:|---:|---:|
| Prototype | $0.10 | $0.02 | $0.08 |
| Hobby | $5.00 | $1.00 | $4.00 |
| Team | $20.00 | $4.00 | $16.00 |

### Standard-v1 split examples

#### If source only
| Tier | Source publisher | Run402 retained |
|---|---:|---:|
| Prototype | $0.02 | $0.08 |
| Hobby | $1.00 | $4.00 |
| Team | $4.00 | $16.00 |

#### If source + 1 ancestor
(70/30 of the 20% pool = **14% / 6% gross**)

| Tier | Closest source publisher | Ancestor | Run402 retained |
|---|---:|---:|---:|
| Prototype | $0.014 | $0.006 | $0.08 |
| Hobby | $0.70 | $0.30 | $4.00 |
| Team | $2.80 | $1.20 | $16.00 |

#### If source + 2 ancestors
(70/20/10 of the 20% pool = **14% / 4% / 2% gross**)

| Tier | Closest source publisher | Next ancestor | Third ancestor | Run402 retained |
|---|---:|---:|---:|---:|
| Prototype | $0.014 | $0.004 | $0.002 | $0.08 |
| Hobby | $0.70 | $0.20 | $0.10 | $4.00 |
| Team | $2.80 | $0.80 | $0.40 | $16.00 |

### If you want a more aggressive growth preset later
You could add a promo preset:

- **Growth-v1:** **25%** pool, same depth logic

That yields:
- Hobby: **$1.25** total rewards
- Team: **$5.00** total rewards
- Run402 retained: **75%**

I would **not** start above 25% before seeing actual COGS and abuse behavior.

### My recommendation on percentages
- **Launch:** **20%**
- **If you want hotter marketplace growth later:** promo/featured apps at **25%**
- **If margins are tighter than expected:** drop to **15%**, but keep the same topology

The topology matters more than 5 points either way.

---

## 4) Simplifying cash payouts: “USDC to wallet” is the right rail, but narrow the legal surface

I’m not giving legal advice, but structurally the simplifier is **not just “use USDC”**.  
The real simplifier is:

### Keep this structure
1. **Customer buys hosting from Run402 only**
2. **Run402 is merchant/counterparty**
3. **Publisher rewards are paid by Run402 from Run402 revenue**
4. **Publisher is not the host, not the merchant of record, and not receiving pass-through customer funds**

That is much cleaner than “customer paid creator through us.”

### Why USDC on Base is still a good idea
It simplifies:
- payout rail
- international distribution
- no bank account collection
- no ACH/wire operations
- no fiat payout integrations
- wallet-native UX

And importantly in your architecture:

**your accounting unit is already integer micro-USD, and USDC has 6 decimals.**

So:

- `1_000_000` micro-USD = `1.000000 USDC`

That is unusually clean. No FX, no decimal mismatch, almost no conversion layer.

### What I would do to minimize legal/ops complexity
#### v1 payout rules
- **Base USDC only**
- **Payout only to the recorded `publisher_wallet`**
- **No arbitrary payout address changes in v1**
- **No fiat withdrawals**
- **No cross-chain payout options**
- **Batch/claim payouts**, not real-time streaming per event

That keeps the program narrow.

### Claim-based is better than instant per-event transfers
I would make rewards:
- accrue internally in a separate reward ledger
- then be **claimable** to the same wallet

This gives you:
- fewer on-chain sends
- dust management
- fraud review point
- sanctions/tax gating point
- simpler reversals/holds

### Minimum compliance controls you still need
Even with USDC-only payouts:
- sanctions screening / blocked jurisdictions
- tax onboarding when thresholds are hit
- Publisher Terms
- clawback / offset language for fraud, refunds, chargebacks
- right to suspend payouts

### Important framing choice
Publicly:
- **“Publisher Rewards paid in USDC”**

Contractually:
- a **platform rewards program**, calculated by reference to hosting revenue

I would avoid leading with:
- “royalties”
- “profit share”
- “marketplace seller payouts”

### One strong practical compromise
Let anyone **accrue** rewards, but require approval before first **claim**.  
That preserves the growth hook (“you can earn”) while keeping payout risk controlled.

---

## 5) Concrete implementation on your current architecture

## A. Data model changes

### 1) Add parent linkage to `app_versions`
You already have `projects.source_version_id`.  
Add:

- `app_versions.parent_version_id uuid null references app_versions(id)`
- `app_versions.reward_policy_preset text`
- `app_versions.reward_policy jsonb`
- `app_versions.rewards_enabled boolean`

### 2) Add a version lineage closure table
Use a self-inclusive closure table:

```sql
app_version_lineage (
  version_id uuid not null,
  ancestor_version_id uuid not null,
  depth int not null, -- 0 = self, 1 = parent, 2 = grandparent...
  primary key (version_id, ancestor_version_id)
)
```

This is great because reward resolution becomes trivial:

- for a forked project, query `source_version_id`
- load lineage rows for that version
- take depths `0..2`

It also gives you future fork graph visualization basically for free.

### 3) Add separate reward accounting tables
Do **not** mix this into allowance balances.

Use separate tables, same append-only design:

- `publisher_reward_accounts`
- `publisher_reward_ledger`
- `publisher_reward_events`
- `publisher_reward_allocations`
- `publisher_payouts`

Reuse the billing service pattern:
- row lock
- single transaction
- append-only ledger
- idempotency keys

**Reuse the accounting pattern, not the same balances.**

### 4) Add publisher profile metadata keyed by wallet
Not a new wallet role; same wallet, just metadata:

- `terms_accepted_at`
- `tax_status`
- `payout_status`
- `sanctions_status`

---

## B. Publish flow changes

When publishing a new version:

1. Parse `run402.yaml`
2. Resolve reward preset
3. Set `publisher_wallet` from auth/session as today
4. Set `parent_version_id = projects.source_version_id` if present
5. Insert lineage rows:
   - self row `(version_id, version_id, 0)`
   - if parent exists, copy parent lineage rows with `depth + 1`

This means a republished fork automatically gets correct ancestry.

---

## C. Fork/renewal reward accrual flow

### Trigger point
Do **not** trigger rewards off “x402 auth happened.”

Trigger rewards off:
- successful initial paid project creation / lease start
- successful renewal

For the fork endpoint, that means:
- after deploy succeeds enough that the project/lease exists
- not merely because payment authorization passed

### Reward accrual algorithm
For each eligible lease charge:

1. Check project has `source_version_id`
2. Load source version’s effective policy
3. Load lineage for that version from `app_version_lineage`
4. Compute reward pool
5. Create allocation rows to the relevant `publisher_wallet`s
6. Credit **pending** reward balances
7. Mature later, then allow claim/payout

### Rounding
Use integer math in micro-USD.
- floor per allocation
- give remainder to closest source publisher

---

## D. One billing complication you should not skip

### Separate paid funds from promo/admin funds
Right now you have:
- `adminCredit(...)`
- `creditFromTopup(...)`
- `debitAllowance(...)`

If you don’t distinguish **paid** balance from **promo/admin** balance, you can accidentally turn:
- faucet credits
- test credits
- manual goodwill credits

into **real USDC publisher payouts**.

That’s the one big accounting trap.

### Recommended fix
Track sub-balances or equivalent attribution:
- `available_paid_usd_micros`
- `available_promo_usd_micros`

Then:
- `creditFromTopup` -> paid
- `adminCredit` -> promo
- rewards accrue only on the portion of a debit funded by **paid** balance or final on-chain payment

Also:
- no rewards on testnet/faucet/promo/admin-funded usage

This matters a lot.

---

## E. Payout mechanics

### Recommended v1
- rewards mature into `available_usd_micros`
- publisher calls something like:
  - `POST /v1/publisher-rewards/claim`
- payout sends Base USDC to the same `publisher_wallet`

### Good defaults
- **minimum claim:** `$10`
- **payout asset:** USDC
- **chain:** Base
- **cadence:** claim-based or weekly sweep
- **exact-wallet self-match:** suppress or zero out in v1

That last one is worth considering: if payer wallet == publisher wallet, you may want **no reward payout** to avoid turning this into a self-rebate mechanism.

### For reversals
- allowance/card-backed revenue can have holds
- on-chain x402 revenue can mature immediately
- keep reversal/offset support in the reward ledger

### One thing I would not do
**Do not split the incoming payment on-chain in real time.**

Use **USDC as the payout rail, not the accounting rail**.

Real-time split looks elegant but makes:
- holds
- chargebacks
- promo exclusion
- sanctions gating
- self-match suppression

much worse.

---

## 6) `run402.yaml` reward policy schema

For v1, I would keep the **author-facing schema small** and keep economics platform-controlled.

### Author-facing schema
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

### Important v1 design choice
**Do not let publishers set arbitrary percentages in YAML yet.**

Why:
- Run402 is funding the rewards
- arbitrary `poolBps` is a platform margin decision
- custom economics create social and legal complexity fast

So in v1:
- manifest chooses **participation**
- manifest chooses a **platform-approved preset**
- Run402 resolves/stores the effective policy on the immutable version

### `standard-v1` effective policy
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

### Future-compatible schema
Later, if you want experimentation, support presets like:
- `standard-v1` = ancestor waterfall
- `direct-v1` = direct-parent only
- `growth-v1` = 25% pool promo preset

But I would still keep them as **presets**, not raw author-defined percentages.

### One more simplifier
Do **not** put the payout wallet in `run402.yaml`.

Use the authenticated `publisher_wallet` already recorded on `app_versions`.

That matches your two-wallet model and avoids payout-destination fraud/configuration problems.

---

## 7) What I would ship first

If I were sequencing this:

### Phase 1
- add `parent_version_id`
- add `app_version_lineage`
- add reward ledger tables
- run **shadow accrual** for 2–4 weeks at 20%
- no cash yet, just dashboards

### Phase 2
- enable `standard-v1` on opt-in publishes only
- claim-based Base USDC payouts
- minimum threshold + manual review/approval

### Phase 3
- automated claims / weekly sweeps
- public lineage + reward policy in app metadata
- experiment with `direct-v1` or `growth-v1`

---

## Bottom line

Given your clarifications, my recommendation is:

- **Yes, do publisher rewards**
- **Yes, cash-to-wallet can be phase 1 if you keep it narrow**
- **Use Base USDC**
- **Use a separate reward ledger**
- **Pay only from real, settled hosting revenue**
- **Use a capped multi-level waterfall**
- **Default to 20% total pool**
- **Cap rewarded depth at 3**
- **Keep policy preset-based in `run402.yaml`**

If you want a single sentence recommendation:

> Ship `standard-v1`: a **20% capped ancestor-waterfall publisher rewards program**, paid in **claimable Base USDC**, with **depth cap 3**, **70/30** or **70/20/10** splits, and **no arbitrary per-app economics in YAML**.

If you want, I can turn this into:
1. a concrete Postgres schema migration set,  
2. TypeScript interfaces/services for the reward ledger, and  
3. exact payout/claim API shapes.

---
**Wall time**: 38m 6s
**Tokens**: 2,418 input, 57,295 output (53,329 reasoning), 59,713 total
**Estimated cost**: $10.3856
