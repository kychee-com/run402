# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-09T10:27:23.156292
**Completed**: 2026-03-09T10:52:02.310297
**Status**: completed

---

I reviewed the docs/code you pasted. My take:

**The strategy is good. The exact mechanics you proposed are not.**

This could become one of Run402’s strongest growth loops, but I would **not** ship it as:

- universal free live forks across all tiers
- copied secret values
- copied root/admin accounts
- **33% gross multi-level “pyramid” rev-share** from day 1

I **would** ship a narrower version:

- **free-to-try forks** via a **sponsored prototype install**
- **direct-parent lineage credits** first
- paid as **Run402 allowance credits**, not cash
- **fresh secrets + fresh owner bootstrap**, never copied secrets/root identities

## Quick verdict

| Idea | Verdict | Recommendation |
|---|---|---|
| Free fork for everyone | **Partial yes** | Make it **free to the forker**, not free to the system: sponsor **Prototype** installs/trials first |
| 33% creator share | **Too aggressive to start** | Start around **10–15%**, maybe **20% max** if margins prove out |
| Multi-level/pyramid share | **No at launch** | Start **direct parent only**; maybe add shallow capped lineage later |
| Copy base secrets | **Hard no** | Use **generated**, **BYO**, or later **shared connector** models |
| Copy root account | **Hard no** | Create a **fresh owner/admin** on fork via bootstrap inputs/placeholders |

---

## Why this is strategically right

Your own docs already point here:

- `elevator.md` / vision: Run402 wants to be the **registry + execution layer for forkable apps**
- previous consultation: publish/fork can make Run402 a **platform, not just a utility host**
- current architecture already stores:
  - `app_versions.publisher_wallet`
  - `source_version_id`
  - `required_secrets`
  - `required_actions`
  - `derived_min_tier`
- billing is centralized in `billing.ts`, which is exactly what you want for any revenue attribution logic

So the **direction** is excellent: lower install friction + reward creators = more supply, more reuse, more retained hosting revenue.

---

## Why the proposal as stated is risky

### 1) “Always free” conflicts with your current operating model
Your current story is:

- bounded spend
- approved procurement
- hard caps
- auto-expiry

Universal free live forks create real AWS cost with no upfront commitment. Even if prototype is cheap, **abandonment and abuse** become your CAC.

This is especially risky because:

- no-signup/no-console is core to the product
- popular public apps could be forked at scale
- some apps won’t become usable because they still need secrets/manual setup

**Important product truth:** the current friction is probably **not mostly the $0.10**.  
It is more likely:

- payment/auth ceremony
- missing secrets
- ownership bootstrap
- whether the app is truly one-click runnable

So removing price alone won’t solve most failed installs unless the app is also self-contained.

---

### 2) 33% gross is likely too rich, especially if multi-level
I’m uncertain of your exact gross margin by tier, but **33% of gross hosting revenue** is aggressive.

Examples:

- Hobby $5 → creator gets **$1.65**
- Team $20 → creator gets **$6.60**

That might be fine at depth 1 **if** margins are strong.

But if by “pyramid” you mean recursive sharing, economics get ugly fast.  
If each level effectively passes 33% upstream, total ancestor take can converge near **49.25% of gross**.

That’s before:

- infra cost
- support
- chargebacks
- fraud reserve
- taxes/compliance overhead

I would not lock in 33% universal rev-share without real margin data.

---

### 3) Copying secret values/root accounts is a security footgun
This is the biggest hard stop.

Your current publish/fork design is right to avoid this. Previous docs already said:

- make required secrets explicit
- do **not** copy secret values

That should remain true.

#### Never copy into public fork artifacts:
- API keys
- OAuth client secrets
- Stripe secrets
- OpenAI keys
- DB passwords
- service role keys
- JWT signing secrets
- encryption keys
- existing admin/root passwords
- auth user rows from a live app

Also: your publish flow stores immutable bundles in S3.  
If you put secret values into an immutable artifact, you’ve created a permanent secret leak path.

### 4) Copying a root account breaks independence
A fork should be an **independent app with fresh control**.

Current TODO text already said the fork should get its own:

- backend
- budget
- URL

That should also imply:

- fresh service/admin credentials
- fresh app owner principal
- fresh auth root/admin user

If you copy the original root account, the fork is not really independent.

---

### 5) The current API conflates payer and owner
This matters a lot.

In `routes/publish.ts`, the fork route gets wallet identity from the payment header:

```ts
const paymentHeader = req.headers["x-402-payment"] as string | undefined;
const walletAddress = paymentHeader ? extractWalletFromPaymentHeader(paymentHeader) : undefined;
...
await forkApp(body, tier, apiBase, txHash, walletAddress || undefined);
```

Today that’s okay because **payer ≈ owner**.

The moment you do “free” or sponsored forks, those become separate concepts:

- **owner wallet** = who owns the new project
- **payer account** = who funded the install/trial
- **beneficiary wallet** = who receives creator rewards

You should make those explicit before launching creator economics.

---

### 6) Cash rev-share brings real settlement/compliance overhead
Your own earlier consultation was right to defer this.

If creators get real money:

- chargeback clawbacks
- tax forms
- KYC/OFAC
- reserves
- disputes
- payout thresholds
- country restrictions

Because you already have a **closed-loop allowance system**, the clean v1 is:

> **creator rewards = Run402 credits first**

That fits the existing billing architecture much better.

---

### 7) “Pyramid” is bad language even if the mechanism is legitimate
Even if the economics are based on real hosting spend, I would never use “pyramid” publicly.

Use terms like:

- **lineage credits**
- **fork-tree rewards**
- **upstream creator credits**
- **publisher rewards**

---

## My recommendation

## Ship this model instead

### 1) Free install = sponsored **Prototype** fork
Not free forever.  
Not free Hobby/Team by default.

**Best first version:**

- public app
- self-contained / low-friction
- fork to **Prototype**
- platform sponsors the install/trial
- user pays only when renewing/upgrading

This preserves the feel of “free fork” without opening unlimited cost exposure.

### 2) Only free-install apps that are actually one-click runnable
Use your existing metadata:

- `required_secrets.length === 0`
- `required_actions.length === 0`
- `derived_min_tier <= prototype`
- no unsupported storage-copy requirement
- no sensitive live-data snapshot

If an app needs secrets or manual setup, either:

- don’t offer free live install yet, or
- create a **draft fork** and only provision once required inputs are provided

---

### 3) Start with **direct-parent** rewards only
You do **not** need a pyramid to allow continuous forking.

A direct-parent model already creates recursive incentives:

- A publishes
- B forks A → A earns when B pays
- B improves and republishes
- C forks B → B earns when C pays

That is already a compounding creator tree.

In fact, this is better than a deep pyramid because it rewards the creator who made the version that was actually installed, instead of imposing permanent rent on all descendants.

### 4) Pay rewards in **Run402 credits** first
This is the cleanest move given your billing system:

- credit the creator’s allowance account
- keep everything on-ledger
- no payout/KYC complexity yet
- creators can immediately spend credits on their own projects

This is very aligned with your existing allowance architecture.

---

## Specific product shape I’d ship

## v1 recommendation
### Free install policy
- only for **public** apps
- only for **Prototype**
- only for **verified/curated** apps initially
- only if app is **instant-ready**
- one free active fork per version per wallet
- hard daily/platform budget caps

### Creator reward policy
- **direct parent only**
- reward on **paid renewals/upgrades only**
- not on the sponsored/free install itself
- pay in **Run402 credits**
- start at **10–15%**
- optionally time-box to **12 months** per child project

If you want to be more aggressive later:
- maybe **20% direct parent**
- maybe shallow lineage later like **12% / 5% / 3%** capped at depth 3

I would **not** start with 33% gross or any uncapped recursive structure.

---

## Hard product rules I would enforce

### Safe to copy
- schema
- functions source
- site assets
- public config defaults
- curated/demo seed data
- RLS/indexes/grants
- app metadata

### Must be regenerated per fork
- DB creds
- JWT/auth signing secrets
- service keys
- encryption keys
- root/admin credentials
- owner/admin user identity

### Must never be copied from the source app
- publisher’s third-party secrets
- live customer data
- auth users/sessions from production
- billing/payment credentials
- anything stored as a “secret” today

---

## Concrete implementation suggestions

## 1) Add explicit policy fields to `app_versions`
Right now `app_versions` already has the right shape for this sort of control.

Add something like:

- `install_policy`  
  - `paid`
  - `platform_sponsored_prototype`
  - `creator_sponsored_prototype`
- `reward_policy`
  - `none`
  - `direct_parent_credit`
  - later `lineage_credit`
- `reward_bps`
- `reward_depth_cap`
- `beneficiary_wallet`
- `instant_ready` / `free_install_eligible`

Store these on the **published version**, so the economics are immutable and auditable.

---

## 2) Separate owner, payer, and beneficiary in the request model
This is the first technical change I’d make.

Right now `walletAddress` from x402 is doing too much.

You want three identities:

- **owner_wallet** → owns/manages the forked project
- **payer_account** → funds install/renewal
- **beneficiary_wallet** → gets creator credits

That separation will matter not just for free forks, but also later for teams/orgs, sponsored installs, and delegated spending.

---

## 3) Keep the same `/v1/fork/:tier` path; change funding resolution
Do **not** build a second deploy engine. Your current TODO principle is correct.

Instead, treat “free fork” as a **billing mode**, not a new provisioning mode.

Funding resolution could be:

1. if version is eligible for sponsored install and caller passes abuse checks  
   → sponsor pays
2. else  
   → existing x402/allowance path

That preserves:

- one API call
- one deploy orchestrator
- one accounting path
- one provenance model

---

## 4) Add a project billing event layer
You need a clean join between project hosting charges and creator rewards.

Either extend `charge_authorizations` or add a new table, e.g.:

- `project_billing_events`
  - `project_id`
  - `charge_authorization_id`
  - `event_type` (`create`, `renew`, `upgrade`)
  - `gross_usd_micros`
  - `share_eligible`
  - `funding_source`

Then reward allocation runs off those events.

---

## 5) Add reward allocations as a separate settlement layer
Do not credit creators inline in the request path.

Add something like:

- `creator_reward_allocations`
  - `project_billing_event_id`
  - `recipient_wallet`
  - `amount_usd_micros`
  - `depth`
  - `status` (`pending`, `credited`, `reversed`)
  - `hold_until`

Then settle asynchronously.

That gives you:

- retries
- chargeback holds
- reversals
- auditability

---

## 6) Add source-of-funds buckets before broad rev-share
This is an important billing gotcha from your current architecture.

Today you have one allowance balance. If you start crediting creators and sponsoring installs, you’ll eventually want to distinguish:

- **cash-backed funds**
- **promo funds**
- **creator reward funds**

Otherwise:

- promo/reward-funded spend can recursively mint more creator rewards
- you can’t cleanly exclude non-cash-funded usage from rev-share

So before broad rollout, I’d add either:

- separate balance buckets on `billing_accounts`, or
- tagged fund tranches in the ledger

If you want a simpler pilot, you can ignore this at first and keep rewards conservative, but long-term it matters.

---

## 7) Add `source_project_id` now; full lineage graph later
Your current comments mention recording `source_version_id` on the project.

For direct-parent rewards, I’d also store:

- `source_project_id`
- `source_version_id`

That’s enough for v1.

Only add a full closure table / transitive lineage table if you later decide to do multi-level rewards.

---

## 8) Pull `run402.yaml` forward if you want a marketplace economy
It’s listed as not-in-v1, but if you want free installs + creator rewards, it becomes much more valuable.

Use it to declare:

- what data is publishable
- which tables are seed/demo vs excluded
- secret descriptors
- owner bootstrap inputs
- install policy
- reward policy
- support/license metadata

The current auto-snapshot model is fine for MVP, but a real app marketplace benefits from an explicit install contract.

---

## 9) Add owner bootstrap instead of copying root accounts
Example:

- publish metadata says app needs an `owner_email`
- optional `owner_password` or generated magic link
- seed SQL / post-fork hook can reference placeholders like:
  - `{{RUN402_OWNER_USER_ID}}`
  - `{{RUN402_OWNER_EMAIL}}`

This gives the same “instant admin” UX without copying identities.

---

## 10) Add publish-time hygiene checks before broad free install
Especially because public apps are forkable artifacts.

I would add:

- secret scanning on function source/site assets
- public-publish table allowlists
- deny export of auth/billing/internal tables
- warnings for object storage dependencies
- a visible **Instant Ready** badge

If you skip this and make installs free, you’ll create lots of broken or unsafe forks.

---

## Best rollout plan

## Phase 1: test the funnel, not the full economy
Cheapest test:

- keep the current fork flow
- sponsor only **Prototype** installs for a curated set of public apps
- reward **nothing** yet
- measure:
  - fork rate
  - ready rate
  - day-7 survival
  - renewal/upgrade conversion

You can even prototype this with existing billing primitives by granting a limited promo credit instead of rewriting the whole path.

### Very low-risk experiment
Use your existing allowance tools:

- auto-credit eligible wallets with the prototype amount (`100_000` micros) for one fork
- or debit a platform sponsor account internally

That lets you test whether “free” materially improves conversion before building full creator economics.

---

## Phase 2: add direct-parent creator credits
Once you see free installs convert:

- add `source_project_id`
- add `project_billing_events`
- add `creator_reward_allocations`
- pay **10–15%** direct-parent **Run402 credits**
- reward only on **paid renewals/upgrades**
- hold credits for chargeback safety

---

## Phase 3: only then consider deeper lineage
If the economics look good, then consider:

- depth 2 or 3 lineage
- total upstream cap around **20–25%**
- maybe creator-sponsored install pools
- eventual cash-out

But I would not jump there first.

---

## My strongest recommendations

### Do this
- **Free sponsored Prototype installs**
- **Direct-parent Run402 credits**
- **Fresh secrets + fresh owner bootstrap**
- **Curated/instant-ready apps first**
- **Measure renewals, not just forks**

### Don’t do this
- don’t copy secret values
- don’t copy root/admin accounts
- don’t make Team/Hobby universally free by default
- don’t launch cash payouts first
- don’t launch multi-level 33% “pyramid” rewards first

---

## Bottom line

**Yes, the underlying idea is good.** It strongly fits the Run402 vision and could be a real moat.

But the version I’d endorse is:

> **Make installs free, not hosting.  
> Pay creators in credits, not cash.  
> Start with direct-parent rewards, not a pyramid.  
> Generate fresh secrets and ownership, don’t clone them.**

If you want, I can turn this into a concrete implementation spec next:
- DB migration plan
- API changes
- billing flow
- reward formulas
- anti-abuse rules
- rollout checklist

---

# Clarification (post-consultation)

The original question was mis-represented. Here's what was actually meant:

## "Free to fork" = no creator fee on the fork itself

Forking an app is free — there is **no additional charge** beyond the normal tier pricing. The forker still pays for their own Run402 project at whatever tier they choose ($0.10 prototype, $5 hobby, $20 team). "Free fork" means the **code/schema/config artifact** is free to take, not that hosting is free.

This means: try any public app on a $0.10 prototype fork. If you want production, pay for a higher tier. The creator earns rev-share from the forker's ongoing hosting payments.

## "Secrets infrastructure" is forked, never secret values

The consultation correctly identified that secret values must never be copied — but the original question never proposed copying them. What's forked is the **secret infrastructure**: the secret names, descriptions, required flags, and placeholders. The forker provides their own values. This is already how the current publish/fork system works (`required_secrets` metadata, not values).

## Implications for the consultation's recommendations

Given these clarifications, several of the consultation's objections dissolve:

- **"Always free conflicts with operating model"** — No, the forker pays normal tier pricing. Run402 revenue is unchanged per project. No sponsored/subsidized installs needed.
- **"Copy secrets is a hard no"** — Agreed, and was never proposed. Already works correctly.
- **"Copy root account is a hard no"** — Agreed, and was never proposed. Fresh credentials are already generated per fork.

The recommendations that **remain highly relevant**:
- Rev-share percentage (start 10-15%, not 33%)
- Direct-parent first, shallow lineage later
- Pay creators in Run402 credits before cash
- Add reward policy fields to `app_versions`
- Add `creator_reward_allocations` table with async settlement
- Fund-source buckets to prevent promo credits from minting rewards
- Phased rollout: measure conversion first, then add rewards

The **owner/payer/beneficiary three-wallet separation is unnecessary**. The consultation invented a "payer account" to handle sponsored/free installs — which don't exist in this model. The actual identities are just two, both already in the system:
- **forker wallet** = owns the new project, pays for hosting (the x402 payer, already captured)
- **creator wallet** = published the original, receives rev-share (`app_versions.publisher_wallet`, already stored)

---
**Wall time**: 24m 39s
**Tokens**: 3,445 input, 48,453 output (44,718 reasoning), 51,898 total
**Estimated cost**: $8.8249
