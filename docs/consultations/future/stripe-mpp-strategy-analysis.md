# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-18T22:40:12.977413
**Completed**: 2026-03-18T22:51:35.841034
**Status**: completed

---

Short version:

**Stripe launched MPP because x402 is not enough for Stripe’s endgame.**  
x402 is great for **open, wallet-native, crypto machine payments**.  
MPP is Stripe’s way to make **machine payments a Stripe-native product category**, including **fiat/card/wallet rails**, delegated spend tokens, and the whole Stripe control plane.

So yes: **it is partly complementary and partly competitive**.

And for Run402: **yes, you should probably support MPP eventually — but not as a replacement for x402.**  
Think **x402-first, MPP-ready**.

---

## First: separate 3 different things

A lot of the confusion comes from these being different layers:

1. **HTTP 402**  
   Just the status code / interaction pattern: “payment required.”

2. **x402**  
   A specific protocol/ecosystem around payable HTTP, strongly aligned with wallet/native crypto flows.

3. **Stripe MPP**  
   Stripe’s own machine-payments protocol that also uses HTTP 402, but introduces **Stripe-native payment primitives** like SPTs and PaymentIntents.

So:

- Stripe can **support x402**
- and also ship **MPP**
- because those are **not the same thing**

Using HTTP 402 does **not** mean “this is x402.”

---

## Why Stripe did MPP

My read: Stripe is pursuing a classic platform strategy.

### 1. x402 gives them access to the category
x402 puts Stripe into the early “agents can pay over HTTP” movement.

That matters because Stripe does **not** want machine commerce to form without them.

If x402 becomes important, Stripe wants to be there as a facilitator.

### 2. MPP gives them ownership of the control plane
In x402, Stripe is **one participant** in a broader ecosystem.

In MPP, Stripe can define the protocol around:

- PaymentIntents
- tokenized delegated spending
- compliance/risk controls
- merchant dashboard + reporting
- fiat methods
- refunds/disputes/reconciliation
- broader merchant onboarding

That is much more aligned with Stripe’s core business.

### 3. x402 is crypto-native; MPP is Stripe-native
This is the biggest strategic difference.

x402 is strongest when the buyer is:

- agent-controlled
- wallet-capable
- happy paying with USDC
- operating in a permissionless flow

But Stripe’s real opportunity is much larger:

- humans who don’t want crypto
- enterprises with cards / wallets / existing finance ops
- merchants who want familiar Stripe settlement/reporting
- buyers who want delegated budgets instead of wallets

MPP is how Stripe makes **all of that** machine-payments-compatible.

### 4. SPTs solve a problem x402 doesn’t really solve
This is important.

A major unsolved problem in machine payments is:

> How does a human or company safely let an agent spend from a traditional payment method under limits?

That is not really what x402 was built around.

**SPTs look like Stripe’s answer to delegated fiat spend.**

That’s strategically huge, because enterprise adoption often depends less on “can the agent hold USDC?” and more on:

- “Can I give this agent a capped budget?”
- “Can finance approve this?”
- “Can I revoke it?”
- “Can I reconcile it in Stripe?”

That’s Stripe territory.

### 5. It’s also a hedge
Stripe does not want to bet the entire machine-payments future on:

- Coinbase-led infra
- crypto-only flows
- one open standard it doesn’t control

So MPP is also a hedge:

- if x402 wins → Stripe participates
- if x402 stays niche/crypto → Stripe still has MPP
- if machine payments go mainstream through fiat → Stripe owns that path

---

## Is MPP a competing strategy?

**Yes — at the standards/control layer.**  
**No — not necessarily at the merchant-enablement layer.**

The cleanest way to say it:

- **x402 = ecosystem/category creation**
- **MPP = Stripe capture/control of the mainstream path**

So this is **co-opetition**.

Stripe can honestly support x402 while also wanting MPP to become the default for the part of the market that wants:

- fiat
- enterprise procurement
- Stripe-native tooling
- less crypto complexity

---

## What this means for Run402

Your own docs already hint at the right model:

> “Payment belongs in the protocol.”  
> “Wallet is infrastructure language. Allowance is trust language.”

That actually suggests **protocol pluralism**, not loyalty to one spec forever.

### My recommendation in one line:
**Run402 should be 402-native, not x402-only.**

Or even more specifically:

- **x402** = your default, permissionless, agent-native rail
- **MPP** = your optional Stripe-native rail, especially for fiat-funded allowances
- **subscriptions** = temporary fallback, not the long-term ideal

---

## Should Run402 support MPP?

### Yes, probably — but in stages

I would **not** replace x402.

I **would** prepare to support MPP in 2 ways:

---

## Best strategic framing: funding rail vs request protocol

This distinction matters a lot.

### A. Funding rail
How money gets into a budget/allowance.

### B. Request-time payment protocol
How the agent satisfies a `402 Payment Required` challenge.

For Run402, the best path may be:

### Stage 1: use MPP as a funding rail first
This is the highest-leverage move.

Example:

- human/company funds an agent budget using Stripe/MPP/SPT
- Run402 credits an internal allowance tied to a wallet
- the agent still interacts with Run402 using the same agent-facing experience

This fits your vision extremely well.

It also avoids prematurely fragmenting your agent protocol surface.

### Stage 2: add native MPP request-time support later
Only do this when:

- Stripe approval is live
- docs are stable
- pricing is clear
- there are real MPP-capable clients/SDKs
- you see demand from non-crypto/enterprise buyers

---

## Where MPP is a strong fit for Run402

### Good fit
1. **Fiat-funded allowances**
   - best match for your budget-capped model
   - better than subscriptions long-term

2. **Enterprise / crypto-averse buyers**
   - corporate card budget
   - delegated spending to agents

3. **Larger-ticket purchases**
   - bundle deploy
   - project top-up
   - lease purchase / reserve

4. **Human-in-the-loop funding**
   - a person approves a budget
   - an agent spends within that cap

### Worse fit
1. **Tiny micropayments**
   - x402 is probably still cleaner here
   - especially if SPT/card economics are not good for very small charges

2. **No-signup / permissionless flows**
   - x402 remains stronger
   - MPP, especially SPT, is more mediated by Stripe

3. **Purely crypto-native agent loops**
   - x402 already fits
   - don’t complicate your happy path unnecessarily

---

## The most important practical insight

**MPP is probably a better fit than subscriptions for fiat-funded allowances, but a worse fit than x402 for permissionless micropayments.**

That’s the core strategic takeaway.

---

## Recommended product strategy for Run402

### Keep this as your canonical story
- **Primary path:** x402 with wallet-native agent payments
- **Secondary path:** Stripe-funded allowance for humans/teams
- **Future path:** MPP-backed machine allowances and possibly native MPP challenge support

### Do not change these principles
- wallet address stays the canonical identity
- hard caps stay enforced by **your** ledger, not only Stripe
- no-signup path stays available via x402
- payment rails stay swappable

### Important warning
Do **not** let MPP pull you into making Stripe customer identity your primary identity model.

That would weaken one of your strongest theses:
**wallet address is identity; budget is policy.**

Instead, let MPP fund or authorize spend **for** a wallet-linked budget.

---

## What I would do if I were Run402

### Now
1. **Keep x402 as the default**
2. **Keep subscriptions as the current fiat fallback**
3. Build an internal abstraction like:
   - payment challenge
   - payment verification
   - receipt normalization
   - budget ledger
   - settlement rail

### Next
4. Ask Stripe whether MPP can be used first for:
   - budget top-ups
   - capped delegated spend
   - coarse-grained purchases
   rather than per-request microbilling

5. Pilot MPP on one use case:
   - `fund_allowance`
   - `deploy_bundle`
   - `start_lease`

### Later
6. Add native MPP request/response support only if ecosystem support appears

---

## Questions I’d ask Stripe on the approval/design-partner call

1. **Is MPP wire-compatible with x402 anywhere, or should we treat them as separate protocols?**
2. **What are the economics/minimums for SPT-backed machine payments?**
3. **Is SPT intended for per-request microbilling or for budgeted/top-up flows?**
4. **Can SPTs be capped by merchant, amount, expiry, and revocation?**
5. **What’s the dispute/reversal model for SPT-funded infra purchases?**
6. **What latency/finality should we expect on the crypto path?**
7. **Do you expect major agent SDKs/frameworks to support MPP soon?**
8. **Can we keep wallet identity while using MPP as the funding rail?**

If Stripe gives good answers here, MPP becomes much more attractive.

---

## My bottom line

### Why did Stripe do MPP?
Because supporting x402 lets Stripe **participate** in machine payments.  
MPP lets Stripe **own** a machine-payments stack that includes fiat, delegated spend, and the rest of Stripe’s platform.

### Is it competing with x402?
**Yes, partly.**  
Especially at the protocol/control layer.

### Should Run402 support it?
**Yes, probably — but as an additional rail, not a replacement.**

My recommendation:

> **Be x402-first, MPP-ready.**  
> Use x402 for permissionless agent-native payments.  
> Use MPP to unlock fiat-funded, budget-capped machine spending.  
> Keep your internal budget/allowance model protocol-agnostic.

One nice way to phrase this publicly:

> **Run402 accepts open x402 today and is designed for 402-native payment rails, including future Stripe machine-payment flows.**

If you want, I can also sketch a concrete **Run402 payment architecture** for supporting:
- x402
- Stripe subscriptions
- MPP/SPT
- wallet-linked allowances

behind one unified gateway.

---
**Wall time**: 11m 22s
**Tokens**: 1,971 input, 15,114 output (12,812 reasoning), 17,085 total
**Estimated cost**: $2.7797
