Below is the cleanest “x402-native” pricing model I’ve seen work for infra products like yours (database + auth + storage + hosting primitives), **while avoiding AWS-style line-item hell** and still keeping **healthy margin**.

## What x402 changes about pricing (vs Vercel/Supabase)

With x402, you can gate a resource behind **HTTP 402 Payment Required** and have clients (humans or agents) **pay and retry** in a single flow. ([docs.cdp.coinbase.com][1]) This lets you do something card/subscription platforms can’t do well:

* **Charge up-front, before you incur cost** (provisioning, renewals, upgrades).
* Keep the customer experience “no accounts / no invoices,” which x402 is explicitly built for. ([x402.org][2])
* Avoid the “usage surprise bill” problem by designing prepaid chunks.

Also: settlement isn’t literally free forever. Coinbase’s facilitator announced fees starting **Jan 1, 2026** (first 1,000 settled payments/month free, then **$0.001 per settled payment**). ([X (formerly Twitter)][3])
That pushes you away from “charge $0.0002 per API call on every request” unless you batch payments or use sessions.

## The pricing structure that best fits infra + x402: prepaid leases with hard caps

This is the model you’re already converging on with Run402:

* **Pay only on provisioning and renewal**
* Everything else uses the keys you return (no payment header needed)
* **Hard caps** (storage + API calls + time) → no overage billing complexity
* When caps are hit, return 402 with “renew/upgrade” ([run402.com][4])

That is *exactly* the “hide AWS complexity” move: users don’t think about Aurora capacity units, CloudFront egress tiers, NAT gateways, etc. They think: **“I bought a project lease.”**

Run402’s public pricing page literally spells this out (“Leases are prepaid with hard caps. No overage charges, no surprise bills.”). ([run402.com][5])

### Why leases are ideal (economically)

Infra has a fixed-ish baseline cost footprint (cluster + backups + ops overhead) and a long tail of abusive patterns. Leases let you:

* Collect cash before doing work (x402’s core superpower).
* Put a predictable *max loss* bound on every customer/project.
* Offer simple SKUs that an AI agent can reason about (“$5 for 30 days”).

x402 docs even recommend simple patterns like flat per-call or tiered; leases are basically “tiered + time-based” in the simplest form. ([docs.x402.org][6])

## The ideal pricing model: 3 paid tiers + 2 add-on packs (still simple)

If I were optimizing for “simple, profitable, AWS-hidden”, I’d do:

### 1) Three tiers, priced as “leases”

Keep 3 SKUs, paid up-front via x402:

* **Prototype** (low price, short duration, hard-limited)
* **Hobby** (default for real prototypes / small apps)
* **Team** (serious usage; priced for margin, not “fairness”)

Run402 already uses this shape: $0.10 / $5 / $20 with increasing time/storage/calls. ([run402.com][5])

**Key recommendation:** tune the tiers so **each tier is profitable even if a user hits the caps**. That means your cap choices must be driven by worst-case AWS cost, not typical-case.

### 2) Two prepaid add-on packs (optional but high leverage)

To avoid forcing an early renewal (which feels like “I paid twice for the same month”), add exactly two packs:

* **Extra Storage Pack**: buy +X GB (extends storage cap, doesn’t change time)
* **Extra Calls Pack**: buy +Y API calls (extends call cap, doesn’t change time)

These stay x402-native (pay once, get more quota) and avoid AWS complexity. No metered overages, no per-GB-hour billing.

If you want to be *extremely* strict on simplicity, you can skip packs and only allow upgrades/renewals. But packs usually increase conversion and reduce “my app died” friction.

### 3) Upgrade path is “pay the difference”

Let customers upgrade Prototype → Hobby → Team by paying the delta (prorate remaining days if you want, but you can also keep it dumb/simple: “upgrade resets lease to 30 days”).

## How to set prices to guarantee margin (without exposing AWS)

Internally, treat each tier like an insurance product:

**Price(tier) ≥ WorstCaseCost(tier) / (1 − TargetGrossMargin)**

Where:

* WorstCaseCost includes: DB compute share, storage, backups, egress you implicitly include, support/ops, fraud/abuse overhead.
* TargetGrossMargin for managed infra is typically high (because the value is “no AWS complexity”), often **70–85%** once you’re stable.

### Practical way to do this fast

1. Measure p95 resource burn per “API call” *in your system* (CPU ms, DB IO, bytes out).
2. Convert caps into worst-case monthly AWS burn.
3. Apply a markup multiplier:

* **Bandwidth-heavy** products: mark up egress aggressively (it’s the classic cost surprise).
* **Compute-heavy** products: tighten API call caps, because “calls” is your proxy for compute.

Vercel and Supabase both end up charging meaningfully above raw infra costs; their public unit prices are a good sanity check for what the market tolerates. For example, Vercel’s on-demand network pricing is listed at $0.15/GB in some contexts, and functions have multiple charge axes. ([Vercel][7]) Supabase’s paid tiers similarly push overages on storage/functions beyond quotas. ([Supabase][8])
You don’t need their complexity—just use them to validate that “premium over AWS” is normal.

## Important x402-specific constraint: don’t make tiny payments too frequent

Because facilitators can charge per settlement (Coinbase’s is $0.001 per settled payment after the free allotment), you want to minimize *number of paid events*, not just value. ([X (formerly Twitter)][3])

That’s another reason leases are ideal:

* Provision = 1 payment
* Renew = 1 payment
* Maybe 1–2 pack purchases/month
* Not “every request is a payment”

x402 V2 also explicitly moves toward **wallet identity + reusable sessions** to avoid paying on every call. ([x402.org][9]) That aligns with “pay occasionally for chunks.”

## What I would *not* do (even if it maps to AWS better)

* Don’t charge per REST request, per row read, per SQL query, per MB transferred, etc.
  That becomes AWS with different words.
* Don’t do “credits” with 12 conversion rates. Customers hate it and it breaks the “simple” requirement.
* Don’t do seat-based pricing like Vercel unless collaboration is truly the product. Vercel Pro is explicitly seat + usage based. ([Vercel][10]) Your product value is infra autonomy.

## Mapping this to your expanding surface area (Vercel-lite + Supabase-core)

As you add hosting/functions/cron/realtime/etc. (the “Vercel-lite surface” you outlined), the pricing should still look like **one lease** that includes the whole stack, not a menu of AWS primitives.

Concretely:

* Bundle **Sites + Functions + Cron + Realtime** into the lease quotas.
* Only break out pricing if one dimension becomes a dominant cost driver (usually egress or heavy realtime).

## A concrete “simple + profitable” pricing page template

If you want the pricing page to be one-glance simple:

* Prototype — **$X** — **N days** — **A MB storage** — **B calls**
* Hobby — **$Y** — * — **D calls**
* Team — **$Z** — **30 days** — **E GB** — **F calls**
* Add-ons: **+Storage Pack**, **+Calls Pack**

And one promise (this matters for conversion):

* “Prepaid leases. Hard caps. No overage billing. When you hit limits, you renew or upgrade.” ([run402.com][5])

---

### If you want my strongest opinion in one line

**Keep prepaid leases as the core (it’s the most x402-native and simplest), but tune tier caps from worst-case AWS burn and add only two quota packs (storage + calls) to avoid forced early renewals.**

If you share *your current AWS cost envelope per project* (even rough: $/GB-month storage, $/million calls equivalent, cluster baseline), I can propose specific tier numbers that hit a target gross margin while keeping the “$0.10 / $5 / $20” simplicity vibe.

[1]: https://docs.cdp.coinbase.com/x402/welcome?utm_source=chatgpt.com "Welcome to x402 - Coinbase Developer Documentation"
[2]: https://www.x402.org/?utm_source=chatgpt.com "x402 - Payment Required | Internet-Native Payments Standard"
[3]: https://x.com/CoinbaseDev/status/1995564027951665551?utm_source=chatgpt.com "Coinbase x402 Facilitator will introduce a minimal fee ..."
[4]: https://run402.com/llms.txt "run402.com"
[5]: https://run402.com/ "Run402 - Postgres for AI Agents"
[6]: https://docs.x402.org/faq?utm_source=chatgpt.com "FAQ"
[7]: https://vercel.com/pricing "Vercel Pricing: Hobby, Pro, and Enterprise plans"
[8]: https://supabase.com/docs/guides/functions/pricing "Pricing | Supabase Docs"
[9]: https://www.x402.org/writing/x402-v2-launch?utm_source=chatgpt.com "Introducing x402 V2: Evolving the Standard for Internet- ..."
[10]: https://vercel.com/docs/plans/pro-plan "Vercel Pro Plan"

Here’s a clean **MVP pricing table you can ship today** that matches your “x402 lease” model (prepaid, hard caps, no AWS-style line items), **doesn’t start free**, and is easy to tune later by changing caps—not prices.

## Recommended MVP prices (ship these now)

### 1) Prototype (paid trial)

* **$0.10** for **7 days**
* **250 MB** storage
* **500K calls**
  This is already the simplest “not free” onramp and matches the x402 story: a true micropayment that still blocks abuse better than free. ([run402.com][1])

### 2) Hobby (default plan)

* **$5** for **30 days**
* **1 GB** storage
* **5M calls** ([run402.com][1])

### 3) Team (serious usage)

* **$20** for **30 days**
* **10 GB** storage
* **50M calls** ([run402.com][1])

**Why these three are the right MVP starting point**

* They’re **extremely simple** (three numbers per tier: time, storage, calls).
* They’re **x402-native**: one payment to provision, one payment to renew/upgrade.
* They keep you away from “pay-per-request” settlement overhead, which matters because facilitators can charge per settled payment after a free tier (e.g., CDP Facilitator: **1,000 free/month then $0.001/transaction**). ([Coinbase Developer Docs][2])
* They align with your current “project lease” lifecycle (prepaid, hard caps, no overages). ([run402.com][1])

## What you show on the pricing page (keep it this simple)

Show only:

* **Duration**
* **Storage**
* **Calls**

And one sentence:

* “Includes database + REST + auth + storage + RLS (+ your Vercel-lite surface like sites/functions/cron as it lands), prepaid with hard caps.”

Everything else stays *implicit*.

## The important part: hidden guardrails so you don’t accidentally lose moneyblic pricing, you need a few **non-negotiable internal caps** (not marketed as “pricing complexity,” just “platform limits”) so a single Prototype user can’t torch your AWS bill.

I’d implement these immediately:

### Guardrail A: “Calls” includes everything expensive

Count as a “call”:

* REST queries
* Auth requests
* Storage signed URL minting
* Function invocations
* Realtime publishes (or at least messages > N bytes)

This lets you keep **one metering unit**.

### Guardrail B: hard bandwidth ceiling (don’t expose it yet)

Bandwidth is the classic cloud cost surprise. Keep it simple:

* Prototype: **~2–5 GB egress**
* Hobby: **~25–50 GB egress**
* Team: **~100–200 GB egress**

If you don’t want to show it publicly yet, enforce it silently and trigger a **402 “renew/upgrade”** when exceeded.

### Guardrail C: function/runtime limits (when you add Functions)

Set platform defaults (same across all tiers if you want maximum simplicity):

* max runtime **10s**
* max memory **256MB**
* max payload **1–5MB**
* basic concurrency limits per project

### Guardrail D: anti-abuse limit for Prototype

To stop someone from buying 10,000 Prototype projects for $1,000 and using you as cheap infra:

* **1 active Prototype project per wallet** (or per wallet/day)
* require upgrade to keep the project alive after trial

This keeps Prototype as “paid try,” not “cheap production.”

## How you fine-tune later (without changing prices)

For the first 10–50 users, you’ll learn almost everything you need from two numbers per tier:

1. **% of projects that hit caps** (storage or calls or bandwidth)
2. **your worst-case cost at cap** (per tier)

Tuning playbook:

* If **nobody** hits caps → you can *raise caps* (improves perceived value) without touching price.
* If many users hit caps but *don’t upgrade* → caps are too low *or* upgrade path friction is too high.
* If users hit caps and *upgrade quickly* → you can either keep caps (great) or later raise price on Team.

## If you want a “more revenue” variant (still simple)

If your gut says “$0.10 feels too cheap for a paid trial,” the simplest bump (without rewriting anything) is:

* Prototype **$1** (same caps, 7 days)
* Hobby **$9**
* Team **$29**

But I’d only do this if you’re seeing meaningful abuse or you want stronger revenue-per-user immediately.

---

If you tell me one thing—**your internal target gross margin** (e.g., 70% vs 85%)—I’ll map the hidden guardrails (bandwidth + function runtime) to the three tiers so the worst-case tier economics are safe while keeping the public pricing page identical.

[1]: https://run402.com/ "Run402 - Postgres for AI Agents"
[2]: https://docs.cdp.coinbase.com/x402/core-concepts/facilitator?utm_source=chatgpt.com "Facilitator - Coinbase Developer Documentation"

