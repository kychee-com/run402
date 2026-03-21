# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-08T14:34:14.042693
**Completed**: 2026-03-08T14:49:53.874737
**Status**: completed

---

Short answer:

- **Yes** to **tiers** as the thing the agent buys.
- **No** to **Stripe subscription tiers + credits** as two parallel customer-facing billing models.

The clean model is:

- **Prototype / Hobby / Team** = your fixed-price **resource SKUs**
- **Run402 Allowance** = the human-funded **spend balance / policy**
- **x402 or Stripe** = the **funding rail**

So: **keep tiers, build allowance, stop deepening “unlimited Stripe tier subscriptions.”**

---

## The key distinction

If by “tiers” you mean:

1. **resource tiers** (`prototype`, `hobby`, `team`)  
   → **keep these forever**

2. **monthly Stripe plans that unlock those tiers across unlimited projects**  
   → **I would not make this your long-term product**

That second model is the part I’d phase out.

---

## Why I’d avoid both as parallel offers

### 1. It creates two contradictory mental models

Right now you’d be asking customers to choose between:

- **Usage-ish / spend-down**: “fund $10, agent spends it down”
- **Flat-rate / unlimited-ish**: “pay $5/mo and get Hobby everywhere”

Those teach opposite behaviors.

If you want to own **Agent Allowance**, the winning mental model is:

> “Humans set budgets. Agents spend against them at fixed unit prices.”

Not:

> “Sometimes the agent spends down, sometimes it’s magically covered by a plan.”

---

### 2. Your subscription path undercuts your x402 future

Native x402 says:

- Prototype lease = **$0.10**
- Hobby lease = **$5**
- Team lease = **$20**

But current Stripe subscriptions say, effectively:

- pay monthly and bypass settlement
- get that tier on all projects

That means the bridge is teaching the market a different unit than the destination.

A good bridge should preserve the end-state semantics.  
**Allowance does that. Subscriptions don’t.**

Best long-term sentence for the product:

> “Same prices, same tiers, same agent behavior — just different funding rails.”

---

### 3. Your current subscription architecture is already fighting the product

From the code, Stripe subscriptions currently require special handling in at least 4 places:

- x402 middleware bypass
- project creation tier override
- aggregate metering across projects
- daily lease sync / extension

That’s a smell.

It means the subscription model doesn’t fit your natural product shape, which is:

- an agent buys a lease
- the lease has a tier
- the lease expires
- renewal/purchase happens again

A spend-down allowance fits that naturally:

- on create/renew → **debit balance**
- if enough balance → allow
- if not → 402 / low-balance

That’s much cleaner than “active subscription implies weird synthetic entitlement state.”

---

### 4. The current Stripe path isn’t truly “crypto optional”

Based on the middleware you shared, the subscription bypass only happens if there’s a payment header with a wallet in it.

So today’s Stripe path is closer to:

> “pay with card, but still bring a wallet”

That’s not the same as:

> “give your agent an allowance, wallet optional”

If your real problem is “most agents don’t have wallets yet,” a true allowance model solves that better than wallet-bound subscriptions.

---

### 5. If you publicly ship both, users will pick the one farthest from your future

If both exist:

- self-serve users will gravitate to the simplest apparent “all-you-can-eat” option
- docs become muddled
- support gets harder
- migration gets painful later

You’ll be training the market away from x402, not toward it.

---

## The model I recommend [ACCEPTED]

## One price book. One spend model. Multiple funding rails.

### 1. **Catalog / price book** [IMPLEMENTED] - Tiers exist at $0.10/$5/$20
Keep exactly this:

- Prototype = $0.10 per lease
- Hobby = $5 per lease
- Team = $20 per lease

These are the permanent units.

---

### 2. **Funding sources** [FUTURE] - x402 works, Stripe allowance not built yet
Support:

- **x402 wallet**
- **Run402 Allowance** funded by Stripe
- later: invoice / enterprise commit
- later: embedded wallet / onramp

This means the thing that changes is **how money gets there**, not what the agent is buying.

---

### 3. **Budget policy** [FUTURE] - Allowance product not built yet
This is the actual allowance product:

- one-time top-up
- auto-top-up
- weekly/monthly hard cap
- allowed tiers
- revoke / pause
- low-balance alerts

That is much more category-defining than a generic “subscription.”

---

## So should you have “credits”?

### Internally: yes
### Externally: I would call it **allowance balance**, not “credits” [FUTURE] - Not built yet

“Credits” is fine as plumbing.  
But externally, your story is stronger as:

- **Run402 Allowance**
- **Allowance balance**
- **Budget**
- **Auto-top-up**

Not “buy credits.”

A good framing is:

> Credits are the ledger.  
> Allowance is the product.

If you do use “credits,” make them clearly:

- closed-loop
- non-transferable
- non-redeemable
- only for Run402 services

And **do not** present them as USDC or a wallet substitute.

---

## Important legal/compliance nuance

The risky thing in your Barry doc was not “any internal balance ever.”  
The risky thing was:

- accepting fiat
- converting it to crypto yourselves
- holding that crypto on behalf of users

That is very different from:

- collecting card payment for Run402
- storing a **closed-loop service balance**
- decrementing that balance for Run402 services

I’d still have counsel review stored-value / service-credit language.  
But strategically, a closed-loop allowance ledger is much safer than building a pseudo-custodial crypto system.

---

## What to do with your existing Stripe subscriptions [IMPLEMENTED] - No subscribers existed, clean break

I would **not delete them tomorrow**, but I would **stop making them the main path**.

### Recommended handling
- **Grandfather existing subscribers**
- Hide or de-emphasize new “unlimited” Stripe tier signups
- Build allowance as the new default card path
- Optionally migrate subscriptions into **recurring allowance grants**

### Best migration path
Use Stripe subscriptions **under the hood** only for **recurring top-ups**.

So instead of:

- “Hobby Monthly subscription unlocks Hobby tier”

make it:

- “$10/week auto-top-up”
- “$25/month auto-top-up”
- “$100/month team budget”

Stripe stays. Portal stays. Checkout stays.  
But the entitlement becomes **balance funding**, not **subscription bypass**.

That’s the cleanest answer to your “fixed price” concern.

---

## How to preserve the “fixed price” promise

Subscriptions promise fixed total spend.  
Allowance can promise something better for agents:

- **fixed unit prices**
- **fixed max budget**

That’s actually more appropriate for autonomous systems.

Example:

- “Prototype is always $0.10”
- “Hobby is always $5”
- “Team is always $20”
- “Your agent can spend up to $10/week”

That is a far better AI-native promise than “unlimited Hobby for $5/month.”

Because for agents, the thing humans fear is not “which plan do I need?”  
It’s **runaway spend**.

Allowance solves that directly.

---

## Architecturally, I’d separate 3 concepts

### 1. What the agent buys
`prototype | hobby | team`

### 2. Who is paying
billing account / org / human payer

### 3. Which funding source is used
- x402 wallet
- Stripe-funded allowance
- invoice

Right now billing is too tied to `wallet_address`.  
That’s okay for a stopgap, but it’s not the right long-term object model for allowance.

If you really want to own the category, build a first-class **billing account / allowance account** object.

---

## What I’d change in the codebase directionally

Not full implementation, just the shape:

### Keep
- `TIERS` as the canonical price book
- x402 native path
- Stripe Checkout / Portal plumbing

### Add
- `billing_accounts`
- `allowance_ledger`
- `funding_sources`
- `budget_policies`

### Replace
- `getWalletSubscription(...)`
with something like
- `getFundingState(...)`
- `authorizeCharge(...)`

### Phase out over time
- subscription bypass in x402 middleware
- daily lease extension based on Stripe subscription
- aggregate subscription metering across projects
- tier upgrades based on active subscription

The clean authorization point should be:

> “Can this purchase/renewal be paid for right now?”

not

> “Does this wallet happen to have an active monthly plan?”

---

## Very practical product recommendation

## Publicly offer only two ways to pay

### A. Pay with wallet
Native x402

### B. Fund allowance with card
- add $10 / $25 / $100
- optionally auto-top-up
- optional weekly/monthly cap

Then the agent spends that balance on:

- Prototype
- Hobby
- Team

That’s it.

No separate “subscription tier product” needed.

---

## If you still want recurring revenue / MRR optics

Do **committed spend**, not unlimited usage.

Examples:

- **$10/week allowance**
- **$25/month allowance**
- **$100/month team budget**
- annual prepay with bonus allowance

You can even add a small incentive:

- prepay $100, receive $105 of allowance
- annual commit gets bonus spend

That preserves predictability without breaking your pricing logic.

---

## My strongest view

The allowance model is **not** just an interim hack until wallets exist.

That’s the biggest mindset shift.

Even in the wallet-native future, humans/orgs will still want:

- caps
- revocation
- delegated spend
- budget policies

So the durable architecture is:

- **wallet = settlement primitive**
- **allowance = control primitive**

The temporary thing is the **funding rail**, not the **allowance concept**.

That means building allowance now is not wasted work.  
It is the actual future.

---

## What I would do next

### In the next 30 days:
1. **Freeze** new investment in unlimited Stripe tier subscriptions
2. Build a minimal **closed-loop allowance ledger**
3. Ship **one-time top-up**
4. Ship **balance display + low-balance alerts**
5. Reuse Stripe subscriptions only for **auto-top-up**
6. Reposition `/subscribe` to **Fund / Manage Allowance**
7. Grandfather legacy subscribers

### Messaging:
- “Give your agent an allowance, not a wallet”
- “Fund with card, crypto optional”
- “Fixed prices, capped budgets”
- “Agents spend. Humans stay in control.”

---

## Final answer

**Do not have both Run402 credits and Stripe-buyable tier subscriptions as parallel billing models.**

Instead:

- **Keep tiers** as your fixed-price product catalog
- **Build allowance** as the card-funded spend-down mechanism
- **Use Stripe subscriptions only for recurring allowance top-ups**, not as unlimited entitlements
- **Grandfather or hide** the current subscription bypass model

The clean principle is:

> **Tiers are what the agent buys.  
> Allowance is how the human controls spend.  
> x402/Stripe are just rails.**

That is the bridge that actually advances your x402 future, instead of training users away from it.

If you want, I can turn this into a concrete migration plan with:
- DB schema
- API shape
- Stripe webhook design
- phased rollout from current subscription code.

---
**Tokens**: 4,755 input, 25,170 output, 29,925 total

---

# Follow-up Discussion (2026-03-08)

## Decision: No subscribers exist yet — clean break

There are zero existing Stripe subscribers. No grandfathering needed. The subscription bypass model can be replaced entirely by allowance.

---

## Key architectural questions and answers

### Does the DB allowance bypass x402? Isn't that a step back?

Yes — a pure DB-side allowance (deduct from balance, grant access) bypasses x402 settlement entirely. The agent never learns x402.

Two options were considered:

**Option A: Full bypass (pragmatic, simpler)**
Agent sends x402 payment header → server sees wallet has allowance balance → deducts from DB → grants access. No on-chain settlement. The agent still speaks x402 protocol, just settlement is internal. When the agent later has real USDC, nothing changes from its perspective.

**Option B: Server funds real x402 (advances the future)**
Agent sends request → gets 402 → agent signs with its wallet → but the server's hot wallet actually pays the USDC (funded by Stripe revenue). Real on-chain x402 settlement happens, funded by the allowance pool. The agent does real x402. More complex but every allowance-funded transaction is a real x402 transaction.

Option A ships first. Option B is the aspirational version.

---

### The testnet faucet insight — don't kill it

**Critical realization: the testnet faucet is not just free credits. It's the x402 onboarding ramp.**

Today's faucet flow:
1. Agent calls faucet → gets a real wallet with a real private key
2. Agent signs a real x402 payment header
3. Agent learns the x402 protocol by doing it
4. When agent moves to mainnet, nothing changes except the network

A DB-side allowance that fully bypasses x402 would mean agents never learn the protocol. That defeats the goal of advancing the x402 future.

**Decision: the testnet faucet is for agents. The allowance is for humans.**

---

## Final product model: Three paths, each serving a different audience

| Path | Who | Purpose | How it works |
|---|---|---|---|
| **Testnet faucet** | Agents (autonomous) | Discover Run402, prove it works, learn x402 | Agent gets free testnet wallet + USDC. Real x402 protocol on Base Sepolia. Zero human involvement. |
| **Run402 Allowance** | Humans funding agents | Card-funded spend for production use | Human pays via Stripe → USD balance in DB → agent spends against it. Non-refundable, non-transferable, closed-loop. |
| **Native x402 wallet** | Crypto-native users | The destination / advanced path | Agent has real USDC on Base mainnet. Real on-chain x402 settlement. Full autonomy. |

### The user journey:
1. Agent discovers Run402 via llms.txt
2. Agent uses **testnet faucet** to try everything for free (learns x402)
3. Agent tells human: "This works. I need real money."
4. Human has two choices:
   - **Stripe** → fund a Run402 Allowance (no crypto knowledge needed)
   - **Crypto wallet** → fund with USDC on Base directly
5. Agent builds with real resources

---

## Non-refundable service balance — legal basis

A closed-loop, non-transferable, non-redeemable **service balance** (like AWS credits, Vercel credits, App Store balance) is standard practice:
- Not a crypto on-ramp: user never receives crypto
- Not money transmission: user is buying access to Run402 infrastructure
- Legal term: "closed-loop stored value" or "prepaid service credits"
- Most jurisdictions have regulations with de minimis thresholds
- The barry-ideas doc warnings were about accepting fiat and converting to crypto on behalf of users — this model avoids that entirely

**Action item: have counsel confirm stored-value classification in US/EU/IL jurisdictions.**

---

## The allowance balance is USD in the database

- Denominated in **USD**, not USDC
- Stored in an `internal.allowance_balances` table (or similar)
- Human pays $10 via Stripe → record $10.00 balance in DB
- Agent provisions a prototype → deduct $0.10 from balance
- No wallet, no chain, no keys involved in the balance itself
- Settlement to Run402's own seller wallet happens behind the scenes (or not at all for allowance-funded purchases)

---

## Dashboard page: show both balances

A single page (evolving from `/subscribe`) should show both funding sources side-by-side:

```
Wallet: 0xabc...def

  RUN402 ALLOWANCE          WALLET (BASE)
  $7.40                     $12.50
  Funded via Stripe         USDC on Base mainnet

  Total available: $19.90

  [Add funds via card]      [View on BaseScan]
```

**Why this is powerful:**
- USDC on Base is a public ERC-20 balance — readable via RPC, no wallet connection or signing needed
- Human sees both funding sources in one place
- **Normalizes** the wallet balance — human starts seeing "oh, that's also just money"
- Creates natural graduation: start with Stripe balance → see wallet balance grow → eventually fund wallet directly → eventually skip Run402 balance entirely
- The page itself is a subtle x402 onboarding tool for humans

### Spend priority:
Agent spends from **Run402 balance first** (no gas, instant), then falls through to **wallet USDC via x402** when balance is empty. Or let the human configure priority.

---

## Testing benefit

The allowance model also solves a major testing pain point:

- **Current pain:** testnet faucet has rate limits, needs Base Sepolia, E2E tests need pre-funded wallets, faucet drip is only $0.25
- **With allowance:** set any wallet to $100 balance in the DB, run full E2E suite against production endpoints, every provision just deducts from balance
- **For CI/CD:** GitHub Actions E2E tests use allowance-funded wallets instead of dealing with testnet RPC flakiness
- **For demos:** pre-fund demo wallets instead of requiring faucet

However, this is a **secondary benefit**, not the primary motivation. The faucet remains the agent onboarding path.

---

## Summary of decisions

1. **Kill the Stripe subscription model** (no subscribers exist — clean break) [IMPLEMENTED]
2. **Keep tiers** (prototype/hobby/team) as fixed-price resource SKUs forever [IMPLEMENTED]
3. **Build Run402 Allowance** as a closed-loop USD balance in DB, funded via Stripe [FUTURE]
4. **Keep the testnet faucet** as the agent-only autonomous discovery/learning path [IMPLEMENTED]
5. **Offer two production funding paths:** Stripe allowance (for humans) and native x402 wallet (for crypto-native) [FUTURE] (only x402 works today)
6. **Build a dashboard page** showing both Run402 balance and on-chain wallet balance [FUTURE]
7. **Allowance is non-refundable, non-transferable, closed-loop** — standard service credit model [FUTURE] (design decided, not built)
8. **Get legal review** on stored-value classification [FUTURE]
