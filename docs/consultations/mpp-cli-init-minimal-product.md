# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-19T10:33:09.746171
**Completed**: 2026-03-19T10:47:27.485370
**Status**: completed

---

Short answer: **`run402 init mpp` can be the UX, but it cannot just “replace the wallet” and leave the payment flow unchanged.**

The minimal honest answer is:

- **If “support MPP” means funding an agent budget via Stripe/MPP**, then yes: you can add something like `run402 init mpp`, keep the rest of Run402 mostly the same, and use MPP as a **funding rail into your existing allowance ledger**.
- **If “support MPP” means native protocol-level MPP payment on 402 responses**, then no: you need changes in **both** the CLI payment wrapper and the gateway payment middleware.

## The key architectural point

Today your “allowance wallet” does two jobs:

1. **identity/auth** via SIWX
2. **payment** via x402 / Base USDC

MPP breaks that coupling. An MPP credential/SPT is **not** a drop-in replacement for:

- `allowance.privateKey`
- `viem` signer
- `@x402/fetch`
- SIWX auth

So the right model is:

- **keep the existing wallet** as canonical agent identity
- **add MPP as another payment rail**, not a new identity

So I would **not** do “switch wallet to mpp.”  
I would do “link MPP to this wallet.”

---

## What “Run402 supports MPP” can mean

### Option A — smallest product
**MPP as a funding rail**

Human/company links an MPP-backed spend permission to the wallet, and Run402 uses that to **top up the internal allowance ledger**.

Then all existing paid flows keep working through:

- allowance ledger debit, or
- x402 on-chain

This is the smallest thing you can ship quickly because you already have:

- billing accounts
- immutable ledger
- `creditFromTopup()`
- allowance debit rail

This lets you honestly say something like:

> “Run402 supports MPP-backed agent budgets.”

But not:

> “All Run402 paid endpoints natively accept MPP 402 payments.”

### Option B — smallest true protocol support
**Run402 gateway accepts MPP directly on paid endpoints**

That means:

- gateway issues an MPP-capable payment challenge
- CLI can satisfy it
- gateway verifies it

This is the minimum to credibly say, without qualifiers:

> “Run402 supports MPP.”

But this requires deeper changes.

---

## Why `init mpp` alone is not enough

Because the current paid path is tightly x402-specific:

### CLI side
`cli/lib/paid-fetch.mjs`:

- loads `allowance.privateKey`
- constructs a `viem` signer
- registers `ExactEvmScheme`
- wraps fetch with `@x402/fetch`

That entire thing assumes:

- EVM keypair
- x402 challenge
- on-chain/Base settlement

MPP uses Stripe-style primitives instead. So even if `init mpp` stored an SPT, **`setupPaidFetch()` would still not know how to use it**.

### Gateway side
Your gateway middleware currently verifies:

- x402 on-chain payment, or
- internal allowance debit

It does **not** verify an MPP proof / PaymentIntent / SPT-based authorization. So the server would reject or ignore MPP credentials unless you add a new verification rail.

### Auth side
Your wallet is also used for SIWX auth:

- tier status
- project ownership
- account lookup
- billing account linkage

MPP does not replace that. If you removed the wallet, you’d break more than payment.

---

# Recommended minimal plan

## Recommendation 1: ship **MPP-funded allowance** first
This is the smallest credible product and matches your prior consultations.

### UX
```bash
run402 init mpp
```

What it should do:

1. **ensure allowance wallet exists**  
   Keep the current wallet because auth/tier/project ownership still rely on it.

2. **link an MPP payer/budget to that wallet**  
   Create or attach an MPP spend permission / Stripe-backed budget.

3. **store MPP config separately**
   Example:
   - `allowance.json` → existing wallet
   - `mpp.json` → linked MPP credential/budget reference

4. optionally enable:
   - auto-topup threshold
   - target balance

Example status:
```text
Allowance wallet   0x12ab...89ef
x402 balance       0.00 USDC
MPP budget         linked (test), auto-topup on, target $10
Tier               prototype
Projects           2 active
```

### Gateway changes
Very small if you keep MPP as funding rail:

- add an endpoint like:
  - `POST /billing/v1/topup/mpp`
  - or a setup/link endpoint + webhook flow
- on success, call existing `creditFromTopup()`
- keep protected endpoints using **allowance debit** exactly as they do today

### CLI payment behavior
You can keep most of `paid-fetch` intact if you do one of these:

#### simplest
Don’t touch paid-fetch much.  
MPP is just used out-of-band to add allowance balance.

#### better UX
If a 402 comes back and allowance is empty, the CLI can:

1. detect MPP is linked
2. call `/billing/v1/topup/mpp`
3. retry the original request

That makes MPP feel integrated without changing every protected endpoint to native MPP.

### Honest claim
Use wording like:

- “Run402 supports MPP-funded agent allowances”
- “Fund your agent budget with MPP”
- “MPP-backed auto-topup for Run402 allowances”

That is true and minimal.

---

## Recommendation 2: if you want to say “Run402 accepts MPP,” add dual-rail payment support

This is the smallest real protocol-level support.

## What changes are required?

### 1) Keep the wallet, add an MPP payer profile
Do **not** replace `allowance.json`.

Add something like `payments.json` or `mpp.json`:
```json
{
  "linkedWallet": "0xabc...",
  "provider": "stripe-mpp",
  "mode": "test",
  "sptRef": "spt_...",
  "created": "2026-03-19T12:00:00.000Z",
  "defaultRail": "auto"
}
```

### 2) Change `run402 init mpp`
This command should:

- create wallet if missing
- authenticate with wallet
- start MPP linking/setup
- store MPP credential reference
- set default payment rail to `auto` or `mpp`

So yes, **one command can be the user-facing entry point**.

But under the hood it is **adding a rail**, not replacing the wallet.

### 3) Replace x402-only paid fetch with multi-rail paid fetch
Today `setupPaidFetch()` is x402-only.

You need a generic wrapper that:

1. sends request
2. if 402, inspects challenge / accepted rails
3. chooses:
   - MPP if configured
   - else x402
   - else fail
4. retries with proper payment headers

So conceptually:

```js
setupPaidFetch() -> paidFetch
paidFetch:
  res = fetch(...)
  if res.status !== 402: return res
  challenge = parseChallenge(res)
  if challenge supports mpp and mpp configured:
    return retryWithMppPayment(...)
  if challenge supports x402 and allowance wallet configured:
    return retryWithX402Payment(...)
  return res
```

That is a real code change. `@x402/fetch` alone won’t do it.

### 4) Extend gateway middleware to advertise + verify MPP
Your current `x402.ts` should become a more generic payment middleware.

Minimal pattern:

- existing rails:
  - `x402`
  - `allowance`
- new rail:
  - `mpp`

When returning 402, the gateway should advertise accepted rails, e.g. in JSON/body/headers:
- x402 challenge details
- MPP challenge details

When receiving a retry:
- if x402 header → existing verifier
- if MPP header → MPP verifier
- if allowance auth/balance → existing ledger debit

### 5) Record MPP receipts in billing
For direct MPP support, you’ll want at least:

- provider payment id / intent id
- unique idempotency tracking
- amount/currency
- linked wallet
- settlement rail = `mpp`

You can keep the same billing account model.

---

# Minimal scope that is actually realistic

If you want the smallest true native MPP launch, I’d do it only for:

- `POST /generate-image/v1`

Maybe later:
- `POST /tiers/v1/:tier`

Why this is enough:

- most of Run402 is not per-request paid; it is tier-gated
- your payment surface is already narrow
- you can claim MPP support once one real paid endpoint accepts it end-to-end

---

# Can dual-rail coexist cleanly?

Yes. In fact that is the right design.

## Recommended rail model
- **wallet** = identity
- **x402** = permissionless crypto rail
- **MPP** = Stripe-native sponsored/fiat rail
- **allowance ledger** = internal settlement abstraction

This preserves your original strengths:

- x402 stays best for autonomous agent-native payments
- MPP adds corporate / fiat-funded budgets
- wallet address remains canonical account identity

Do **not** make Stripe customer ID the primary identity.

---

# Tempo L1 vs Base

For the minimal product, **Tempo does not require you to move Run402 off Base**.

You can keep:

- Base wallet auth
- Base/x402 payment rail
- current account model

MPP/Tempo should be treated as a **separate settlement rail**.

So:

- don’t switch SIWX chain to Tempo just to say “MPP”
- don’t try to turn the current wallet into a Tempo wallet
- don’t assume “new chain” means “same flow with a different RPC”

MPP is about Stripe’s payment objects and authorization model, not just chain selection.

---

# What I would do in this repo

## Minimal funding-only MVP
### CLI
- keep `allowance.json`
- add `mpp.json`
- implement `run402 init mpp`
- add `run402 status` display for MPP linkage/budget
- optionally auto-topup behavior in `paid-fetch`

### Gateway
- add MPP link/setup endpoint
- add MPP topup endpoint / webhook handling
- reuse `creditFromTopup()`
- no need to rewrite protected endpoint middleware yet

This is the **lowest-effort, highest-truth** MVP.

## Minimal native MPP MVP
### CLI
- add MPP config storage
- change `paid-fetch.mjs` to multi-rail
- keep wallet auth exactly as-is

### Gateway
- refactor payment middleware from x402-specific to rail-aware
- add MPP challenge + verify path
- record `mpp` settlement rail
- pilot on `/generate-image/v1`

---

# Bottom line

## Can `run402 init mpp` be the whole story?
**As UX: yes.**  
**As architecture: no.**

## Can it be “just switch wallet to MPP”?
**No.** That’s the wrong abstraction.

## Smallest product to credibly claim support
### Fastest/lowest risk
**MPP-backed allowance funding / auto-topup**
- keep wallet auth
- keep allowance ledger
- add MPP link + topup
- market it as **MPP-funded budgets**

### Smallest unqualified “Run402 supports MPP”
**Dual-rail 402 support on at least one endpoint**
- keep wallet for identity
- add MPP credential alongside wallet
- update paid-fetch
- update gateway verification

If you want, I can turn this into a concrete implementation plan against your repo, with:
1. proposed new config schema,
2. CLI command behavior,
3. gateway endpoint/middleware changes,
4. staged rollout order.

---
**Wall time**: 14m 17s
**Tokens**: 17,619 input, 7,633 output (7,633 reasoning), 25,252 total
**Estimated cost**: $1.9025
