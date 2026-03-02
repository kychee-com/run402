# Run402: The Agent Services Marketplace
## Frictionless Cloud Infrastructure for the Machine Economy

---

**Kychee Technologies** | March 2026

Run402 is a B2B2M (Business-to-Business-to-Machine) marketplace that makes cloud services instantly accessible to AI agents. We combine a smart discovery layer, frictionless payments, and ready-to-use infrastructure services — enabling any AI agent to find, pay for, and provision cloud resources autonomously, in seconds, with zero human setup.

Our thesis: AI agents are becoming autonomous economic actors. They need infrastructure — databases, storage, compute, hosting — the same way human developers do. But they can't sign up for AWS accounts, enter credit cards, or navigate dashboards. Run402 bridges this gap by creating the first complete marketplace where agents discover services, pay with pre-funded wallets, and get production-ready infrastructure instantly.

**Three legs. One platform:**

1. **Discovery Layer** — A smart, machine-readable catalog where agents find the right service for their task. The "Google for agent infrastructure."
2. **Agent Wallet** — A payment system where humans fund wallets that agents spend autonomously, with full controls and reporting. Built on x402, accessible via Stripe.
3. **Infrastructure Services** — Real, production-grade cloud services (starting with Postgres, S3, Lambda) that agents can provision and use immediately.

All three legs are required for the MVP. Each reinforces the others. Discovery without services is an empty directory. Services without payments are friction. Payments without discovery are invisible.

---

## Part 1: Vision

### The Opportunity

Gartner predicts machine customers will drive over $30 trillion in purchases by 2030 and be responsible for 22% of generated revenue. Today, the infrastructure for this economy barely exists. Coinbase and Cloudflare have established the x402 payment protocol — the "Visa network" for agent payments. But there is no Shopify. No one has built the complete marketplace that connects agent demand with cloud service supply.

The x402 ecosystem currently has ~251 registered services, most of them thin wrappers or demos. The official discovery layer (Coinbase's Bazaar) is self-described as "Yahoo search" — a flat directory with no quality signals, no recommendations, no trust scoring. Agent developers today must manually find, evaluate, and hardcode each service integration.

Run402 aims to be the platform that makes this entire process autonomous.

### The B2B2M Model

Run402 operates on a novel go-to-market model we call **B2B2M — Business-to-Business-to-Machine**.

Traditional marketplace models serve human buyers (B2C) or business buyers (B2B). Run402's marketplace has two distinct customer types:

- **Businesses** (agent developers, service providers) — the humans who build agents and the humans who build services. They make purchasing decisions, set budgets, configure integrations, and evaluate ROI.
- **Machines** (AI agents) — the autonomous software that actually discovers, selects, pays for, and consumes services at runtime. They are the active "shoppers" in the marketplace.

This creates a unique dynamic: we market to humans but sell to machines. Our product interfaces must serve both — dashboards and controls for the humans, APIs and machine-readable catalogs for the agents.

The B2M (Business-to-Machine) concept has been emerging in Gartner research and industry analysis since 2023, but B2B2M as a specific marketplace model — where the platform serves businesses on both the supply and demand side, with machines as the active transacting party — appears to be a new framing.

---

### Leg 1: The Discovery Layer

**What it is:** A smart, machine-readable service catalog that agents query to find the best infrastructure service for their current task.

**Why it's the key:** Discovery is the primary value driver of any marketplace. In the agent economy, discovery has unique characteristics:

- **Agents don't browse.** They query programmatically. The discovery layer must be API-first, with rich metadata, structured schemas, and machine-readable pricing.
- **Agents need recommendations, not lists.** "Give me the 251 services" is useless. "Give me the cheapest Postgres with >99% uptime under $1" is useful. Smart routing based on price, latency, reliability, and capability is the differentiator.
- **Quality data is the moat.** Every transaction through the discovery layer generates signal — uptime, response time, success rate, cost accuracy. Over time, this data makes recommendations better, which attracts more agents, which generates more data. The data flywheel is the network effect.

**How agents find us:** The discovery layer is delivered as:
- An **MCP server** — the standard way AI agents (Claude, Cursor, CrewAI, LangChain agents) discover tools today
- An **llms.txt endpoint** — enabling any LLM to read our catalog and understand our services in natural language
- A **Bazaar-compatible registry** — interoperable with the x402 ecosystem
- A **REST API** — for custom integrations

**How we market to agent developers:** Agent developers are our demand-side customers. They adopt our discovery layer by installing our MCP server or SDK into their agent framework. We reach them through:
- Integration with agent frameworks (LangChain, CrewAI, AutoGen, LangGraph)
- Presence in MCP marketplace directories (Cline, LobeHub, mcpmarket.com)
- Developer content and documentation
- Direct outreach to x402 ecosystem builders
- Community participation in x402 Discord and developer forums

**Network effect mechanics:** The discovery layer creates a two-sided network effect:
- More services listed → more useful for agents → more agent developers adopt → more transactions
- More transactions → better quality data → better recommendations → more services want to list
- First-party services bootstrap the supply side, ensuring agents always find something useful

### Leg 2: The Agent Wallet

**What it is:** A complete payment solution that lets humans fund wallets that AI agents spend autonomously — with full controls, limits, and reporting.

**The core problem:** For an agent to pay for services via x402, it needs a crypto wallet with USDC. Most agent developers and their end users don't have crypto wallets. This is the single biggest friction point in the entire x402 ecosystem.

**Our solution — progressive onboarding:**

1. **Try for Free:** New users get testnet coins from our faucet to experiment with the platform at zero cost. No wallet, no credit card, no signup friction.
2. **Fund with Credit Card:** When ready to go live, users connect a Stripe payment method and purchase "agent allowance" — USDC credits that their agents can spend on the marketplace. We handle all crypto complexity behind the scenes.
3. **Bring Your Own Wallet:** Advanced users who already have crypto wallets can connect them directly for native x402 payments.

**Controls and reporting:**
- Per-agent spending limits (daily, weekly, total)
- Per-service spending caps
- Per-transaction maximum
- Real-time spending dashboard showing every transaction: what service, what amount, what the agent was doing
- Alerts when budgets approach limits
- Full audit trail exportable for accounting

**How users fund their agents — the critical onboarding problem:**

Getting USDC into a user's wallet is the single hardest UX and regulatory challenge in the x402 ecosystem. The x402 FAQ explicitly states that the protocol does not natively support fiat on-ramps or credit card deposits, and every path to acquiring USDC currently requires KYC somewhere. Every player in the ecosystem has either ignored this problem or assumed crypto-native users. We must solve it.

The section "Payment Funding Models & Regulatory Analysis" (below, in MVP Specification) provides a detailed breakdown of five possible funding models, their regulatory implications across all relevant jurisdictions (US/FinCEN, EU/MiCA, Israel), and our recommended approach.

**Summary of recommended approach (details in full analysis below):**

1. **Testnet is completely free** — no wallet, no payment, no KYC. This powers the "ask your agent" funnel. Zero friction.
2. **When converting to mainnet: Stripe Crypto Onramp embedded widget.** User clicks "Fund Wallet," enters credit card via Stripe's widget, Stripe handles all KYC/AML/compliance, USDC lands in user's wallet on Base. We never touch fiat or perform currency exchange. Stripe carries the full regulatory burden.
3. **Bring Your Own Wallet** for crypto-native users who already hold USDC — direct connection, no intermediary needed.

The user never needs to know what USDC is, what Base is, or what a blockchain wallet is. They see "Add $10 to your agent's budget" and use their credit card.

**Controls and reporting:**
- Per-agent spending limits (daily, weekly, total)
- Per-service spending caps
- Per-transaction maximum
- Real-time spending dashboard showing every transaction: what service, what amount, what the agent was doing
- Alerts when budgets approach limits
- Full audit trail exportable for accounting

**The "piggy bank" concept:** Think of the Agent Wallet as a prepaid debit card for your AI agent. You load it with a budget. The agent spends it autonomously within the rules you set. You see every transaction. You top up when needed. No surprises.

**Facilitator compatibility:** While we build our own payment flow, the system is designed so that any x402 facilitator can be used. Our wallet works with Coinbase's facilitator, PayAI, x402.rs, or any future facilitator. We are not locked to a single payment rail.

### Leg 3: Infrastructure Services

**What it is:** Production-grade cloud services that agents can provision and use instantly. Our "anchor tenant" services that bootstrap the marketplace supply side.

**Why we build services ourselves:**
- Solves the cold-start problem — agents always find real, working services in our marketplace
- Generates revenue from day one (not dependent on marketplace fees alone)
- Provides quality benchmarks that third-party services are measured against
- Creates deep understanding of what agents actually need (informing our discovery layer design)

**MVP Services — The Full-Stack Agent Toolkit:**

These five services, built on AWS, allow an agent to deploy a complete web application:

| Service | What It Provides | Built On | Why Agents Need It |
|---|---|---|---|
| **Database (Postgres)** | Managed PostgreSQL with REST API, auth, row-level security | AWS Aurora Serverless v2 | Every app needs persistent data storage |
| **Object Storage (S3)** | File storage with pre-signed URLs, bucket management | AWS S3 | Store uploads, generated files, assets, exports |
| **Serverless Compute (Lambda)** | Run arbitrary code on demand — any runtime | AWS Lambda | Execute business logic, data processing, API backends |
| **Static Hosting (Amplify)** | Deploy frontend applications with CDN | AWS Amplify | Serve web UIs, SPAs, static sites |
| **DNS & Domains (Route 53)** | Domain management and DNS configuration | AWS Route 53 | Give deployed apps real URLs |

Together, these five services enable an agent to autonomously build and deploy a fully functional web application: database for data, storage for files, compute for backend logic, hosting for the frontend, and DNS to make it accessible.

**Provisioning model:**
- Lease-based with hard caps (no surprise bills)
- Tiers matching different use cases (prototype / hobby / production)
- Pay-per-provision via x402, debited from the Agent Wallet
- Each project gets isolated resources
- Automatic cleanup after lease expiry (with grace period)

**All infrastructure runs on AWS.** Payments and crypto run on Stripe and Base L2. This separation keeps infrastructure reliable and enterprise-grade while payments remain frictionless and agent-native.

---

## Part 2: MVP Specification

### MVP Scope

The MVP delivers all three legs at minimum viable functionality:

**Discovery Layer MVP:**
- MCP server that agents can install to discover our services
- llms.txt endpoint describing all available services in natural language
- REST API for programmatic service discovery
- Service metadata: capabilities, pricing, availability, schemas
- Initially lists only our own first-party services (5 services)
- Registration endpoint for third-party services to list themselves

**Agent Wallet MVP:**
- Testnet faucet — get free test coins to try the platform
- Wallet generation — automatic custodial wallet creation for new users
- Stripe integration — buy agent allowance with credit card
- Existing wallet connection — connect your own crypto wallet
- Spending limits — set per-agent and per-transaction caps
- Transaction log — see every payment your agent made
- Basic dashboard — web UI showing balance, recent transactions, spending by service

**Infrastructure Services MVP:**
- **Postgres** — provision a database with REST API, get connection credentials (already built at run402.com)
- **S3-compatible storage** — provision a bucket, get pre-signed URLs for upload/download
- **Lambda-compatible compute** — deploy and execute functions on demand
- **Amplify hosting** — deploy a static site or SPA from a build artifact
- **Route 53 DNS** — register a subdomain or configure DNS for a custom domain

Each service follows the same pattern:
1. Agent discovers service via MCP / discovery API
2. Agent provisions via a single API call (x402 payment included)
3. Agent receives credentials / endpoints to use the service
4. Service runs on isolated AWS infrastructure
5. Lease expires → read-only → archive → delete

### MVP Architecture

```
┌─────────────────────────────────────────────────┐
│          Agent (Claude, CrewAI, etc.)            │
│                                                   │
│  MCP Client / HTTP Client                        │
└──────────┬──────────────────────────┬────────────┘
           │                          │
     Discovery                    Provision
           │                          │
┌──────────▼──────────┐   ┌──────────▼──────────────┐
│   Discovery Layer    │   │    Service Endpoints     │
│                      │   │                          │
│  MCP Server          │   │  POST /v1/postgres       │
│  llms.txt            │   │  POST /v1/storage        │
│  REST API            │   │  POST /v1/compute        │
│  Bazaar registry     │   │  POST /v1/hosting        │
│                      │   │  POST /v1/dns            │
└──────────────────────┘   └────────────┬─────────────┘
                                        │
                              x402 Payment
                                        │
                           ┌────────────▼─────────────┐
                           │      Agent Wallet         │
                           │                           │
                           │  Custodial wallets        │
                           │  Stripe on-ramp           │
                           │  BYO wallet support       │
                           │  Spending controls        │
                           │  Transaction reporting    │
                           └────────────┬──────────────┘
                                        │
                              Settlement (Base L2)
                                        │
                           ┌────────────▼──────────────┐
                           │     AWS Infrastructure     │
                           │                            │
                           │  Aurora (Postgres)         │
                           │  S3 (Storage)              │
                           │  Lambda (Compute)          │
                           │  Amplify (Hosting)         │
                           │  Route 53 (DNS)            │
                           └────────────────────────────┘
```

### Legal & Terms of Service (MVP)

The MVP must ship with proper legal foundations. These protect us and establish clear expectations for a novel type of customer (AI agents acting on behalf of humans).

**Documents to prepare:**

1. **Terms of Service / Terms of Use** — Governs use of the platform, services, and APIs. Must cover:
   - Acceptable use policy (no illegal content, no abuse of provisioned infrastructure)
   - Lease-based service model — services are rented, not owned
   - Data lifecycle and deletion policy (see below)
   - Liability limitations for provisioned infrastructure
   - Right to suspend or terminate services for non-payment or abuse
   - Agent authorization — the human account holder is responsible for all actions taken by agents operating under their wallet
   - Spending limit disclaimers — we provide controls but the account holder bears ultimate responsibility
   - No SLA guarantees in MVP (best-effort availability)

2. **Privacy Policy** — What data we collect, how we use it, how we store it. Must cover:
   - Wallet data and transaction history
   - Service usage metadata (what was provisioned, when, by which agent)
   - Data stored BY the user in provisioned services (databases, storage buckets, etc.)
   - We do NOT access user-stored data except for operational maintenance
   - GDPR considerations (Tal is in Netherlands, potential EU users)
   - Data retention and deletion timelines
   - Third-party data sharing (Stripe for payments, AWS for infrastructure, facilitators for settlement)

3. **Data Lifecycle & Deletion Policy** — This is critical and unique to our model:
   - Active lease: data is live, fully accessible, backed up
   - Lease expires (payment not renewed): **14-day warning period** — services go read-only, data preserved
   - Day 14 after expiry: data is **archived** (compressed, moved to cold storage, not accessible)
   - Day 30 after expiry: data is **permanently deleted** — no recovery possible
   - Clear communication at each stage (see agent communication below)
   - User can re-activate at any point during the 14-day warning by making payment
   - User can request data export during the 14-day warning period
   - Immediate deletion available on request (user can ask to delete their data at any time)

4. **Refund & Dispute Policy** — For x402 payments:
   - Lease-based model means no partial refunds mid-lease
   - Unused portion of pre-paid leases: policy TBD (no refund vs. credit)
   - Disputed transactions: process for human escalation
   - Testnet transactions are non-refundable (they're free)

**Where these documents live:**
- Human-readable versions at [platform].com/terms, /privacy, /data-policy
- Machine-readable summaries in llms.txt so agents can understand policies before provisioning
- API responses include relevant policy links in headers/metadata

### Payment Funding Models & Regulatory Analysis

This section addresses the hardest practical problem in the x402 ecosystem: how do users get USDC into a wallet so their agents can pay for services? Every funding path carries regulatory implications. Kychee Technologies is a Delaware corporation with founders in Israel and the Netherlands, potentially serving users globally — so we must consider US federal (FinCEN), US state, EU (MiCA), and Israeli regulations.

**The ecosystem's dirty secret:** As of March 2026, the x402 protocol does not natively support fiat deposits or credit card payments. The official x402 FAQ states this explicitly: facilitators or third-party gateways can wrap x402 flows with on-ramps, but the protocol itself provides no fiat path. Every x402 user today either (a) already holds USDC from a crypto exchange account (high friction, requires KYC at the exchange), or (b) uses a third-party on-ramp. The entire ecosystem has punted on this problem by assuming crypto-native users.

#### The Five Funding Models

**Model 1: "We Fund the Testnet, You Pay Nothing" (Zero Friction)**

How it works: User receives free testnet coins from our faucet. All experimentation happens on testnet. No wallet, no credit card, no KYC. This is the entry point of our friction ladder (Levels 0–3).

Regulatory status: **No regulatory concern.** Testnet tokens have no monetary value. No money transmission, no exchange, no financial service is occurring. This is functionally identical to offering a free trial of SaaS software.

Limitation: Only works for testing. The friction problem hits when the user wants to go live on mainnet.

**Model 2: Stripe Crypto Onramp Embedded Widget (RECOMMENDED)**

How it works: We embed Stripe's fiat-to-crypto onramp widget in our dashboard. User clicks "Fund Wallet," the Stripe widget appears, user enters credit card (or Apple Pay, Google Pay, bank transfer), Stripe converts USD/EUR to USDC and deposits it directly into the user's wallet on Base. We never touch fiat currency. We never perform currency exchange. We never custody fiat.

Regulatory status: **Lowest regulatory burden for us.** Stripe acts as the merchant of record for onramp transactions. Stripe handles all KYC verification, sanctions screening, fraud detection, and regulatory compliance. Stripe carries the regulatory responsibility — the integrating developer (us) does not need a money transmitter license or VASP registration to offer the onramp. This applies in the US (Stripe is a licensed money transmitter in all required states) and in the EU (Stripe operates under its own licenses — the developer doesn't need PSAN in France or MiCA authorization for the onramp itself).

Cost to user: Stripe charges approximately 1–2% plus a fixed fee per transaction. For a $10 funding, the user might pay ~$0.50 in fees. Stripe supports purchases of USDC on Base, which is our settlement network.

Integration effort: Stripe provides embeddable widgets and hosted onramp pages. Integration is straightforward — similar complexity to adding Stripe Checkout to a website. Requires a Stripe account and approved onramp application (typically reviewed within 48 hours).

User experience: User sees "Add funds" → Stripe widget → enters card → receives USDC in wallet. If user has previously used Stripe (via Link), payment info is pre-populated. First-time users complete lightweight KYC through Stripe (name, email, possibly ID verification depending on amount). Returning users fund instantly.

Confidence level: **HIGH.** This is a well-established pattern. Stripe's onramp documentation is public and the product is generally available. The regulatory burden on Stripe (not on us) is clearly documented. Many Web3 companies use this exact model.

**Model 3: Accept Fiat via Stripe, We Convert to USDC (High Risk)**

How it works: User pays us via standard Stripe Checkout (credit card). We receive USD in our Stripe balance. We then separately purchase USDC on an exchange or via Circle and deposit it into the user's platform wallet.

Regulatory status: **VERY HIGH RISK. Almost certainly requires money transmitter registration.** Under FinCEN's 2013 guidance (FIN-2013-G001), an "exchanger" is a person engaged as a business in the exchange of virtual currency for real currency, funds, or other virtual currency. An exchanger is a money transmitter under BSA regulations. By accepting fiat and converting to USDC for users, we would be acting as a currency exchanger — accepting real currency from one person and providing convertible virtual currency. This triggers:
  - FinCEN MSB registration (federal)
  - State money transmitter licenses in every state where we have users (49 states plus DC — Montana is the only exemption). New York's BitLicense alone can cost $50,000+ in application fees. California's DFAL takes full effect July 1, 2026.
  - AML/KYC compliance program (written program, compliance officer, ongoing training, independent review)
  - Suspicious Activity Reports (SARs) and Currency Transaction Reports (CTRs)
  - In the EU: CASP authorization under MiCA (since Tal is in the Netherlands, which already requires full MiCA compliance as of July 2025)
  - In Israel: VASP licensing under the Supervision Law and AML compliance with the Israel Money Laundering and Terror Financing Prohibition Authority

The "integral exemption" (31 CFR 1010.100(ff)(5)(ii)(B)) is unlikely to apply. This exemption covers money transmission that is only integral to the sale of goods or services different from money transmission itself. Three conditions must be met: (1) the money transmission must be part of providing a good or service distinct from money transmission, (2) only the person providing that distinct service can claim the exemption, and (3) the money transmission must be integral (necessary) for providing the service. While we provide cloud infrastructure (distinct from money transmission), the fiat-to-USDC conversion step is NOT integral to our infrastructure service — users could fund their wallets through other means. FinCEN has consistently held that when a company's payment mechanism is the primary service being offered alongside another product, the integral exemption does not apply. The 2014 FinCEN ruling on virtual currency payment systems (FIN-2014-R012) rejected the integral exemption for exactly this pattern.

Confidence level: **HIGH that this model requires licensing.** FinCEN rulings are explicit and consistent on this point.

**RECOMMENDATION: DO NOT PURSUE THIS MODEL.** The licensing burden would cost hundreds of thousands of dollars, take 12–24 months, and require ongoing compliance infrastructure that is disproportionate to an MVP.

**Model 4: Prepaid Platform Credits — We Hold a Hot Wallet (Medium-High Risk)**

How it works: User pays $10 via standard Stripe Checkout. User receives "10 credits" in our internal system. Our platform maintains a USDC hot wallet. When the user's agent consumes a service, our hot wallet makes the actual x402 payment. The user never sees or touches USDC — they interact only with our credit system.

Regulatory status: **COMPLEX — likely triggers MSB obligations, but arguments exist both ways.** This is the hardest model to analyze because it touches multiple regulatory categories:

  (a) **Money transmitter analysis:** We accept value (fiat) from Person A (the user) and transmit value (USDC) to Person B (the service provider) on Person A's behalf. This is textbook money transmission under FinCEN's definition (31 CFR 1010.100(ff)(5)). The fact that we denominate the intermediate step as "credits" does not change the substance — FinCEN looks at the economic reality, not labels.

  (b) **Integral exemption argument (weak but not frivolous):** One could argue that the payment transmission is integral to our cloud infrastructure service. The analogy would be: when AWS charges your credit card for Lambda compute, nobody calls that money transmission — it's selling a service. Our "credits" could be characterized as prepayment for our own services, not transmission of value to third parties. However, this argument weakens significantly once we open the marketplace to third-party services — at that point, we ARE transmitting value to third parties on behalf of users, which is the core definition of money transmission.

  (c) **Prepaid access analysis:** FinCEN defines "prepaid access" as access to funds paid in advance that can be retrieved or transferred through an electronic device (31 CFR 1010.100(ff)(4)). If our credits can only be spent within our closed ecosystem (only on our first-party services), this resembles a closed-loop prepaid system, which has certain exemptions. However, once credits can be spent on third-party services through our marketplace, the system becomes open-loop and the exemptions narrow substantially.

  (d) **Provider of prepaid access:** If classified as prepaid access, FinCEN requires the designated "provider of prepaid access" to register as an MSB, implement an AML program, file SARs, and comply with recordkeeping requirements (31 CFR Part 1022). This is similar in burden to money transmitter obligations.

The Wilson Sonsini analysis of gaming companies facing this exact pattern (in-game currencies purchased with fiat, spent within an ecosystem) concluded that gaming companies could potentially rely on the integral exemption for closed-loop systems but face significant risk when value becomes transferable or redeemable.

Confidence level: **MEDIUM.** The regulatory treatment depends heavily on exact implementation details — whether credits are refundable, whether they can be spent on third-party services, whether they represent a claim on specific assets. A fintech attorney would need to review the specific implementation.

**If we pursue first-party services only (Option C from MVP strategy), the integral exemption argument is strongest.** If we open to third-party services, this model almost certainly requires MSB registration.

**Model 5: Partner with Embedded Wallet Provider (MoonPay, Privy, Crossmint)**

How it works: We integrate a third-party embedded wallet provider. The provider handles wallet creation, KYC, and fiat on-ramping. The user's experience is seamless — they see "sign up, add payment method" — but the wallet infrastructure and compliance burden is carried by the partner.

Regulatory status: **Low regulatory burden for us, similar to Model 2.** The wallet provider (MoonPay, Privy, Crossmint) carries the MSB registration and compliance obligations. We provide the platform; they provide the financial infrastructure. This is analogous to a marketplace using Stripe for payments — the marketplace doesn't need a payment license because Stripe has one.

Recent development: MoonPay launched "MoonPay Agents" in February 2026, specifically designed for this use case — non-custodial wallets that AI agents can transact with autonomously, with the human completing one-time KYC through MoonPay. Crossmint offers smart wallets with x402 compatibility, multi-chain support, and built-in KYC/AML via VASP licensing and SOC2 Type II compliance.

Trade-off: Dependency on a third party for a critical flow. If MoonPay goes down, our users can't fund their agents. We also inherit their fee structure (typically 1–5% depending on provider and payment method).

Confidence level: **HIGH that this reduces our regulatory burden.** The authorized delegate / agent model is well-established in FinCEN guidance.

#### Jurisdiction-Specific Considerations

**United States (Delaware corporation):**
- FinCEN: Federal MSB registration is required if we perform money transmission, currency exchange, or provide prepaid access. Registration is done via BSA E-Filing, renewed biannually. Must maintain a written AML program.
- State licensing: Required in up to 49 states plus DC. Cost and timeline vary widely — New York BitLicense is the most expensive ($50K+ in fees, 12–18 month review). Many startups avoid this by using a licensed partner as an "authorized delegate" (operating under the partner's license).
- GENIUS Act (passed June 2025): Establishes a federal framework for payment stablecoins. Implementation regulations expected through 2026–2027. Does not directly change MSB requirements but signals regulatory clarity for stablecoin use.

**European Union / Netherlands (Tal's location, potential EU users):**
- MiCA: The Markets in Crypto-Assets Regulation requires CASP (Crypto-Asset Service Provider) authorization to provide crypto-asset services in the EU. The Netherlands required full compliance by July 1, 2025 — one of the earliest deadlines in the EU.
- If we custody crypto assets (hold USDC in wallets on behalf of EU users), we may need CASP authorization. USDC is MiCA-compliant — Circle achieved MiCA compliance and USDC is classified as an EMT (Electronic Money Token) in the EU.
- Transfer of Funds Regulation (TFR): Requires CASPs to collect and transmit sender/recipient information on ALL crypto transfers (no minimum threshold in the EU, unlike the US $3,000 threshold). Effective since December 2024.
- If we use Stripe Onramp (Model 2), Stripe handles EU compliance. If we custody wallets ourselves, we need CASP authorization.
- Transaction caps for non-EU stablecoins: MiCA limits non-EU currency stablecoins (like USDC, which is USD-denominated) to 1 million transactions daily or €200 million in payment value. This is unlikely to affect our MVP but matters at scale.

**Israel (Barry's location):**
- Israel regulates crypto under the Supervision of Financial Services (Regulated Financial Services) Law. VASPs must be licensed by the Capital Markets Authority (CMA) and comply with AML/KYC requirements under the Anti-Money Laundering Order (2021), aligned with FATF standards.
- The Bank of Israel has published stablecoin principles (2023) but these have not yet become law. The BOI's 2026 digital shekel roadmap is underway but does not yet affect private stablecoin use.
- Israeli banks have historically been reluctant to handle crypto transactions, though Directive 411 requires a risk-based approach (not blanket refusal) and the Supreme Court has ruled banks are not prohibited from crypto transactions.
- If Run402 is structured as a Delaware corporation with Israeli operations, the CMA may require Israeli licensing for financial services activity. A fintech attorney familiar with Israeli regulation should review the specific structure.

#### Recommended Payment Architecture for MVP

Based on the regulatory analysis above, the recommended payment architecture is:

**Tier 1 — Free Testnet (all users start here):**
No payment, no wallet, no KYC. Users get testnet coins from faucet. Powers the entire "ask your agent" funnel and friction ladder Levels 0–3. Zero regulatory concern.

**Tier 2 — Stripe Crypto Onramp (mainnet funding):**
Embedded Stripe widget converts fiat → USDC → user's wallet on Base. Stripe handles all KYC/AML/compliance. We never touch fiat. We never perform exchange. Our regulatory burden is limited to operating the platform and managing wallet infrastructure (see Tier 2b below).

**Tier 2b — Wallet custody decision (CRITICAL — requires legal counsel):**
Two sub-options for how we manage the wallet after funding:

  - **(a) We host custodial wallets:** We generate and manage wallets, hold private keys, sign x402 transactions on behalf of agents. This is the best UX (user never thinks about wallets) but likely makes us a hosted wallet provider under FinCEN guidance, which is classified as money transmission. Would require MSB registration and potentially state MTLs. Could be mitigated by operating as an authorized delegate of a licensed partner.

  - **(b) Users hold non-custodial wallets via embedded provider:** We integrate Privy, Crossmint, or MoonPay for wallet infrastructure. They handle wallet creation and custody. We provide the platform layer (discovery, provisioning, controls). This adds a dependency but keeps us out of the money transmission definition.

  **Recommendation for MVP: Option (b) — use an embedded wallet provider.** The regulatory cost and timeline of Option (a) is disproportionate for an MVP. We can always bring wallet custody in-house later after obtaining proper licensing.

**Tier 3 — Bring Your Own Wallet (crypto-native users):**
Users with existing USDC on Base connect their own wallet. We never touch their funds — they sign x402 transactions directly. Zero regulatory concern for us on this path.

**What we explicitly DO NOT do (at MVP):**
- We do not accept fiat and convert to USDC ourselves (Model 3) — would require MSB + state MTLs
- We do not operate a proprietary credits system that involves fiat-to-crypto conversion (Model 4 without licensing)
- We do not sell, redeem, or exchange USDC
- We do not custody fiat currency at any point

#### Updated Friction Ladder (with payment model integrated)

Level 0 — "Ask Your Agent" (zero friction): Paste llms.txt URL into any AI chat. Agent reads and explains value. No account needed.

Level 1 — One Curl Command (10 seconds): `curl https://api.[platform].com/try` provisions free testnet Postgres. No account.

Level 2 — Web Playground (1 minute): Interactive page showing live provisioning with testnet coins. No account.

Level 3 — "Build Me an App" Prompt (5 minutes): Ready-made prompt, agent provisions testnet resources and demonstrates the full flow.

Level 4 — Create Account (30 seconds): Email/OAuth signup. Needed for persistent testnet projects and to prepare for mainnet.

Level 5 — Fund Wallet via Stripe Onramp (2–3 minutes): Click "Go Live" → Stripe widget → credit card → USDC in wallet. First-time KYC through Stripe (lightweight — name, email, card). Returning users fund in seconds.

Level 6 — MCP Server Install (retention): One-line install for ongoing agent access to our services. Agent can now discover and provision autonomously.

**Key insight:** The first four levels require zero payment, zero KYC, zero commitment. The user has fully experienced the product before we ever ask for money. Payment friction (Level 5) only hits after the user has seen the value.

#### Immediate Action Items (Payment/Regulatory)

1. **Engage a fintech attorney** with US + EU crypto experience to review the specific structure of Kychee Technologies → Run402 and confirm: (a) whether Stripe Onramp integration alone triggers any licensing requirement, (b) whether non-custodial wallet integration (via Privy/Crossmint/MoonPay) keeps us outside MSB classification, (c) Israeli regulatory implications for Barry's involvement.

2. **Apply for Stripe Crypto Onramp access** — requires a Stripe account and approved application. Typically 48 hours. Start in sandbox/test mode.

3. **Evaluate embedded wallet providers** — compare Privy, Crossmint, and MoonPay Agents on: fee structure, x402 compatibility, Base L2 support, KYC friction level, API quality.

4. **Do NOT build custodial wallet infrastructure** until legal counsel confirms the regulatory path and licensing timeline.

5. **Do NOT accept fiat payments** into Kychee's bank account for the purpose of funding user wallets — this is the highest-risk activity and should be avoided entirely at MVP.

### Communicating with AI Agent Customers

This is a genuinely novel B2B2M problem: when something goes wrong, or a lease is expiring, or we need to warn about pending data deletion — who do we tell, and how?

The "customer" is a human developer whose AI agent is the one actually using our services. The agent may be running autonomously. The human may not be actively monitoring. Traditional email or push notifications may be ignored or never seen by the entity that needs to act (the agent).

**Communication channels (MVP must support all of these):**

1. **API response headers** — Every API call to our services includes status headers:
   - `X-Lease-Status: active | warning | read-only | archived`
   - `X-Lease-Expires: 2026-04-15T00:00:00Z`
   - `X-Lease-Warning: Payment required within 14 days to prevent data deletion`
   - This is the primary channel for agents — they see it on every request and can act programmatically

2. **Webhook notifications** — User registers a webhook URL during setup:
   - Lease expiry warnings (7 days, 3 days, 1 day, same day)
   - Payment failures
   - Service incidents or maintenance
   - Data deletion countdown (daily during 14-day warning)
   - Webhook payloads are structured JSON that agents can parse and act on

3. **Dashboard alerts** — For the human developer:
   - Web dashboard shows service status, warnings, overdue payments
   - This is the "human fallback" when agents don't handle the issue

4. **Email notifications** — Traditional backup channel:
   - Lease expiry warnings to the account holder's email
   - Payment failure notifications
   - Data deletion final warnings (critical — this must reach the human)
   - Account security alerts

5. **MCP server status** — If the agent is connected via our MCP server:
   - Discovery responses include service health status
   - Agent can query lease status at any time via MCP tool
   - Proactive warnings injected into discovery results when leases are expiring

**Escalation flow for critical issues (e.g., pending data deletion):**

```
Day 0: Lease expires
  → API headers change to warning status
  → Webhook fires (lease expired)
  → Dashboard shows warning
  → Email sent to account holder

Days 1-7: Gentle reminders
  → Daily webhook: "Payment required, X days until read-only"
  → Dashboard warning persists
  → API responses include warning headers

Day 7: Services go read-only
  → Webhook fires (services now read-only)
  → Email: "Your services are now read-only — pay to restore"
  → Agent write requests return 402 with payment instructions

Day 10: Urgent warning
  → Webhook: "4 days until data archive"
  → Email: "URGENT: Data will be archived in 4 days"

Day 14: Data archived
  → Webhook: "Data archived — will be deleted in 16 days"
  → Email: "Your data has been archived — contact support to recover"
  → Services return 410 Gone

Day 30: Data permanently deleted
  → Webhook: "Data permanently deleted"
  → Final email confirmation
  → Resources fully deprovisioned
```

**The key insight:** We need BOTH machine-readable channels (API headers, webhooks, MCP status) AND human-readable channels (email, dashboard). The agent should be empowered to handle renewals autonomously if it has wallet access. The human is the safety net when the agent doesn't act.

**Future consideration:** A dedicated "agent inbox" — a message queue that agents poll or subscribe to, receiving structured notifications about all account events. This is the B2B2M-native communication channel that doesn't exist yet.

### Marketing & Distribution Plan

**Target audience:** Developers building AI agents — specifically those using agent frameworks (LangChain, CrewAI, AutoGen, LangGraph), AI coding tools (Claude Code, Cursor, Devin), and autonomous agent platforms.

**Core marketing insight:** We can't ask users to install an MCP server as a first step. That's a commitment — it requires configuration, understanding of MCP, and trust in an unknown brand. Instead, we need a friction ladder that starts with near-zero effort and progressively deepens engagement.

#### The "Ask Your Agent" Channel

This is our signature acquisition move and should be the primary call-to-action across all marketing:

> **"Paste this link into your AI chat and ask: can this help me?"**
> `https://[platform].com/llms.txt`

**Why this works:**
- Zero friction — the user is already in an AI chat (Claude, ChatGPT, Cursor). They just paste a URL and ask a question.
- The agent reads our llms.txt and becomes our salesperson. It understands our services, evaluates whether they're relevant to what the user is building, and explains the value — in context, personalized to the user's actual project.
- It's self-qualifying. If the agent says "yes, this could help you deploy that app you're building," the user is already convinced by their own trusted AI.
- It's demonstrably B2B2M — we're literally marketing to the machine, which then markets to the human.
- It's viral. "Ask your AI about us" is a novel, shareable concept. It's the kind of thing developers tweet about.

**What llms.txt must contain:**
- Clear description of all services and capabilities
- Testnet faucet URL so the agent can try services for free immediately
- API schemas so the agent can actually provision services within the same conversation
- Example prompts showing what agents can build with our platform
- Pricing and limitations in structured format

**The ideal flow:**
1. User pastes our URL into Claude / ChatGPT / Cursor
2. Agent reads llms.txt, understands the platform
3. User asks "can this help me build [their project]?"
4. Agent says yes and explains how
5. Agent provisions testnet resources and demonstrates — right there in the conversation
6. User is convinced → funds wallet → agent continues building with real resources

This means the llms.txt isn't just documentation — it's an **agent-optimized sales funnel**. It should be written and structured to enable the agent to take action, not just understand.

#### The Friction Ladder

Each step requires slightly more commitment but delivers more value. Users enter at any level and naturally progress upward. See "Updated Friction Ladder (with payment model integrated)" in the Payment Funding section above for the definitive version with payment/regulatory details.

**Level 0 — "Ask Your Agent" (zero friction)**
- User pastes our URL into any AI chat
- Agent reads llms.txt, explains value, optionally tries testnet
- No signup, no install, no configuration
- **CTA:** "Paste this link into your AI chat →"

**Level 1 — One Curl Command (10 seconds)**
- `curl https://api.[platform].com/try` provisions a free testnet Postgres and returns credentials instantly
- User sees a working database in their terminal in seconds
- No signup, no wallet, no account
- **CTA:** "Try it now — one command, free database →"

**Level 2 — Web Playground (1 minute)**
- Interactive page on the website where you click "Provision a Database" and watch it happen live with test coins
- Visual demonstration of the full flow: faucet → wallet → provision → use
- Shows the dashboard, transaction log, and service credentials
- **CTA:** "See it live in your browser →"

**Level 3 — "Build Me an App" Prompt (5 minutes)**
- We provide ready-made prompts users paste into Claude / Cursor:
  - "Using [platform].com, build and deploy a simple todo app with a Postgres backend"
  - "Using [platform].com, create a landing page with a contact form and deploy it"
- The agent handles everything: reads docs, provisions services, writes code, deploys
- User watches their agent autonomously build and ship a working app
- **CTA:** "Give your agent this prompt and watch it build →"

**Level 4 — Create Account (30 seconds)**
- Email/OAuth signup for persistent testnet projects
- Needed before going live
- **CTA:** "Create your account →"

**Level 5 — Fund Wallet via Stripe Onramp (2–3 minutes, monetization step)**
- Click "Go Live" → Stripe Crypto Onramp widget → credit card → USDC in wallet on Base
- Stripe handles all KYC/AML/compliance — we never touch fiat
- Set spending limits and controls
- Agent operates autonomously within budget on real infrastructure
- **CTA:** "Go live — fund your agent's wallet →"

**Level 6 — MCP Server Install (retention step)**
- One-line install for ongoing agent access
- Agent now has permanent discovery, wallet, and service access
- This is the retention mechanism, not the acquisition step
- **CTA:** "Make it permanent — install the MCP server →"

**Key design principle:** The first four levels require zero payment, zero KYC, zero commitment. Users fully experience the product value before we ever ask for money.

#### Distribution Channels

1. **"Ask Your Agent" Placement**
   - Every piece of content, every tweet, every README ends with: "Paste this link into your AI chat and ask if it can help you"
   - The URL itself is the marketing. The agent is the salesperson.
   - Optimize llms.txt relentlessly — it's our most important marketing asset

2. **MCP Marketplace Presence**
   - List our Discovery MCP server on Cline marketplace, LobeHub, mcpmarket.com, PulseMCP
   - One-click install for developers ready for Level 4
   - Important distribution channel but not the first-touch channel

3. **x402 Ecosystem Engagement**
   - List services on the official x402 Bazaar
   - Participate in x402 Discord and community forums
   - Reach out to x402 ecosystem builders for partnerships and cross-listing
   - Engage with Coinbase developer programs or grants if available

4. **Agent Framework Integrations**
   - Build plugins/integrations for LangChain, CrewAI, AutoGen, LangGraph
   - Contribute examples showing agents using our platform
   - Target framework documentation and community channels

5. **Developer Content**
   - "Build and deploy a web app with zero human intervention" demo video
   - "I asked Claude to build an app and it deployed itself" blog post / tweet thread
   - Technical posts on agent-native infrastructure patterns
   - Open-source example agents that use our platform

6. **Direct Outreach**
   - Contact builders listed on the x402.org ecosystem page
   - Reach teams building agent frameworks and coding assistants
   - Connect with AI agent companies building autonomous workflows

**Key message:** "Your agent needs infrastructure. Paste this link and ask it."

---

## Part 3: Next Steps (Post-MVP)

### Opening the Marketplace

Once the MVP is live with our five first-party services, we open the supply side to third-party providers.

**Why:** The long-term value of Run402 is the marketplace, not the services. Third-party services create variety, competition, and scale that we can't achieve alone. Our first-party services established credibility and quality standards; now the marketplace amplifies them.

**What this includes:**
- Self-service registration for service providers
- Automated health monitoring and uptime tracking
- Transaction-based quality scoring (latency, success rate, reliability)
- "Verified" badge for services meeting SLA commitments
- Discovery fee model (small per-referral fee, paid via x402)
- Provider dashboard with analytics (traffic, conversion, revenue)

### Reputation and Trust System

Quality data from transactions powers a trust layer that makes the marketplace defensible.

**Why:** Agent developers need confidence that discovered services actually work. Trust signals — built from real transaction data — are what separates Run402 from a flat directory. This data flywheel is the primary business moat.

**What this includes:**
- Reliability scores based on observed uptime and response times
- Success rate tracking per service
- Cost accuracy verification (does the service charge what it advertises?)
- Latent quality signals (do agents that use this service succeed at their tasks?)
- ERC-8004 compatible reputation that's portable across the ecosystem

### Expanding the Service Catalog

More services make the marketplace more useful and attract more agents.

**Why:** The five MVP services cover basic web application deployment. Real-world agents need many more capabilities — email, queues, caching, search, monitoring, CI/CD, and more. Each new service type attracts a new segment of agent developers.

**What this includes:**
- Prioritized based on demand data from the discovery layer (what are agents searching for that we don't have?)
- Mix of first-party services (where we see strategic value) and third-party services (where providers are eager to list)
- Vertical-specific service bundles (e.g., "full SaaS stack", "data pipeline", "e-commerce backend")

### Cross-Protocol Compatibility

Support for payment protocols beyond x402 ensures Run402 isn't dependent on a single standard.

**Why:** Google's AP2 protocol is emerging alongside x402. Future protocols may appear. The discovery layer's value is protocol-agnostic — agents need to find services regardless of how they pay.

**What this includes:**
- AP2 compatibility layer
- Traditional API key + billing support as a fallback
- Multi-facilitator support within x402
- Fiat payment rails for services that don't require crypto

---

## Appendix A: Competitive Landscape

### Ecosystem Scale (as of March 2026)

The x402 ecosystem is significantly larger and more mature than initially assessed:
- **17** client-side integrations (wallets, SDKs, agent frameworks)
- **45+** services/endpoints (APIs accepting x402 payments)
- **50+** infrastructure & tooling projects (facilitators-as-a-service, gateways, analytics, discovery)
- **28** facilitators (up from our earlier estimate of ~5 significant players)
- **3** learning & community resources

### Direct Competitors: Discovery Layer

Our discovery layer concept — quality-ranked, agent-optimized service discovery — has direct competition.

| Player | What They Have | How They Compare to Us |
|---|---|---|
| **Rencom** | Ranks x402 endpoints by historical agent outcomes. Sort by price, popularity, reliability. Minimizes execution failure and cost variance. | Closest match to our discovery vision. Already doing outcome-based ranking. We need to differentiate on breadth (combining discovery with wallet and services) rather than discovery features alone |
| **EntRoute** | Machine-first API discovery. Ranked, verified endpoints with semantic intent resolution, continuous verification probes, MCP server, and TypeScript SDK. | Near-spec-match to our discovery MVP. Has MCP server, has verification, has ranking. A serious competitor |
| **x402list.fun** | Directory with pricing comparison, transaction volume, reliability metrics across blockchain networks. | Analytics-focused discovery. More of a comparison tool than an agent-native discovery API |
| **x402station** | Analytics platform with advanced UI for monitoring x402 services, real-time performance metrics. | Dashboard for humans, not agent-native discovery. Potential data source or partner |
| **x402scan** | Ecosystem explorer for x402 resources and analytics. | Similar to x402station — explorer/analytics, not agent-facing |
| **BlockRun.AI** | Pay-as-you-go AI gateway + catalog of all x402 services. | Combines LLM access with discovery. Interesting bundle but different primary value |
| **AIsa** | Resource marketplace aggregating LLMs, data APIs based on HTTP 402. | Marketplace approach, but seems early and narrow (LLMs + data) |
| **Coinbase Bazaar** | Protocol owner's official directory. Basic listing, no quality signals. | Still a flat directory, but the default starting point for the ecosystem |

### Direct Competitors: Agent Wallet

Agent wallet with budget controls and human dashboard is no longer a novel concept.

| Player | What They Have | How They Compare to Us |
|---|---|---|
| **ampersend** | "A wallet for agents and a dashboard for humans." Abstracts crypto complexity, provides automation, control, and observability for agent operations. | Very close to our wallet concept. Purpose-built for agent payments. Likely the most direct wallet competitor |
| **Oops!402** | Brings x402 to ChatGPT and Claude via remote MCP. Discovery + budget controls + scoped execution + receipts. | Does 2 of our 3 legs (discovery + wallet) in one MCP package. Targets the exact same users (AI chat users) |
| **Locus** | MCP-enabled wallet with spending controls. Auto-generates tools for every x402 endpoint used. | MCP-native wallet with auto-tool-generation — clever approach that reduces friction |
| **Latinum** | Open-source MCP wallet and facilitator. Agents can pay 402 requests directly. | Open-source, so more of a building block than a competitor. But validates the concept |
| **1Pay.ing** | x402 payment wallet for instant micropayments, trusted checkout flows, integrations. | Consumer-facing wallet, less agent-specific than our concept |
| **Primer** | Browser wallet (Primer Pay) + TypeScript & Python SDKs for payers/payees. Full ERC-20 support. | Browser-based approach. Different UX model but serves same payment need |

### Direct Competitors: Infrastructure Services

First-party cloud infrastructure (Postgres, S3, Lambda, Amplify, DNS) payable via x402 remains our most differentiated leg.

| Player | What They Have | How They Compare to Us |
|---|---|---|
| **AurraCloud** | AI agents hosting and tooling platform with MCP, smartWallets, and X402 support. | Closest to our infra play. Hosting + tooling for agents. Unclear if they offer raw cloud primitives (databases, storage, compute) |
| **CodeNut** | "Web3 vibe-coding platform for building and deploying x402-enabled applications and agents." | Build-and-deploy platform. Different angle — they're an IDE, not infrastructure-as-a-service |
| **Pinata** | IPFS storage via x402. No account needed. | Storage only. Decentralized (IPFS), not traditional cloud storage |
| **SerenAI** | Payment gateway enabling agents to pay for database queries and API access via x402. | Database *access* gateway, not database *provisioning*. We provision new isolated databases |
| **zkStash** | Shared memory layer for agents with optimized retrieval and x402 support. | Agent memory, not general-purpose infrastructure |
| **Farnsworth** | 7-layer recursive memory (SYNTEK), encrypted on-chain storage (DropClaw), agent service marketplace (PlanetExpress). | Agent-specific infrastructure. Different layer than our cloud primitives |

### Multi-Leg Competitors (doing 2+ of our 3 legs)

| Player | Legs | Assessment |
|---|---|---|
| **Oops!402** | Discovery + Wallet | Strong. Already in Claude/ChatGPT via MCP. Missing infrastructure services |
| **Agently** | Discovery + Payments | "Routing and settlement layer for agentic commerce." Agents discover, orchestrate, and pay other agents/tools. No first-party services |
| **Dexter** | Discovery + Payments + Facilitator | Facilitator + marketplace + MCP discovery + cross-chain bridge. Broad but facilitator-first, not services-first |
| **Foldset** | Infrastructure + Wallet | "Gate any API behind x402. Wallet provisioning, reverse proxy, analytics, fiat off-ramps." Tooling for *providers*, not for agent *consumers* |
| **ampersend** | Wallet + Dashboard | Wallet + operations management. No discovery, no services |

### Adjacent Players & Potential Partners

| Player | Relationship |
|---|---|
| **28 Facilitators** (CDP, PayAI, thirdweb, Kobaru, Bitrefill, etc.) | Our facilitator-agnostic design is even more important now. Support the top 5-10 to maximize compatibility |
| **Firecrawl, Zyte API** (web scraping) | High-value services to list in our discovery layer |
| **x402engine** (28 APIs), **ouchanip** (10 APIs), **Spraay** (200+ AI models) | Multi-service providers. Both potential competitors (they bundle services) and potential listings |
| **MCP Marketplaces** (Cline, LobeHub, mcpmarket.com) | Distribution partners for our MCP server. Not direct competitors |
| **DJD Agent Score, Orac, MerchantGuard** (trust/reputation) | Could provide or consume trust signals for our discovery layer |
| **x402-watch, zauth** (monitoring/verification) | Potential data sources for our reliability scoring |

### Revised Competitive Position

**What's still unique:** No existing player combines all three legs AND provides first-party cloud infrastructure (Postgres, S3, Lambda, Amplify, DNS) that enables agents to autonomously deploy complete applications from scratch. The "zero to deployed web app" story remains differentiated.

**What's no longer unique:** Quality-ranked discovery (Rencom, EntRoute), agent wallets with budget controls (ampersend, Oops!402, Locus), and MCP-based service access are all being built by multiple teams. These were novel concepts months ago — they're emerging categories now.

**Strategic implication:** Our competitive moat is narrower than initially assessed. The first-party infrastructure services are the hardest to replicate and the strongest differentiator. The discovery layer and wallet are necessary for the full experience but are not defensible on their own. Speed to market matters more than we originally estimated — this ecosystem is moving fast.

**This raises a strategic question for MVP scope — see options below.**

### MVP Strategy Options

The competitive landscape reveals three viable paths. Each trades off speed-to-market against long-term positioning.

#### Option A: "Services Only" — List on Existing Ecosystem

**What we build:** Only the 5 infrastructure services (Postgres, S3, Lambda, Amplify, DNS) with x402 payment.
**What we use from others:** List services on Rencom, EntRoute, and Coinbase Bazaar for discovery. Let users pay with existing wallets (ampersend, Locus, Oops!402, or their own wallet). No proprietary discovery layer. No proprietary wallet.

**Pros:**
- Fastest to market — all engineering goes to the hardest-to-copy differentiator
- Immediately validates whether agents actually want to provision infrastructure
- Zero competition on the specific service offering (nobody else does Postgres + S3 + Lambda + DNS via x402)
- Gets us listed in existing ecosystems, gaining visibility without building distribution
- Lowest cost and engineering effort

**Cons:**
- We become a commodity provider dependent on others for distribution
- No data flywheel — Rencom/EntRoute own the quality signals, not us
- No direct relationship with the agent developer — the discovery layer owns the customer
- No "ask your agent" channel — our llms.txt would just describe services, not a platform
- If infrastructure services turn out to be a feature not a product, we have no second act
- Hard to differentiate from future competitors who wrap AWS similarly

**Best if:** We want to validate demand for agent-native infrastructure with minimum investment before committing to a platform play.

#### Option B: "Full Platform" — Build All Three Legs

**What we build:** Discovery layer + Agent wallet + Infrastructure services. The full vision as currently documented.

**Pros:**
- End-to-end "zero to deployed app" story that nobody else can offer
- Own the customer relationship at every touchpoint
- "Ask your agent" channel works at full power — llms.txt enables discovery, payment, and provisioning in one flow
- Data flywheel from our own transactions
- Maximum long-term defensibility

**Cons:**
- Slowest to market — building three products simultaneously
- Competing directly with Rencom/EntRoute (discovery) and ampersend/Locus/Oops!402 (wallet) who already have head starts
- Highest cost and engineering effort
- Risk of building mediocre versions of all three instead of excellent version of one
- The ecosystem is moving fast — by the time we ship, competitors may be further ahead

**Best if:** We believe speed-to-market matters less than completeness, and that the combination of all three legs is the actual product, not any individual leg.

#### Option C: "Services + llms.txt" — The Middle Path (Recommended for consideration)

**What we build:** The 5 infrastructure services + a well-crafted llms.txt + a minimal "ask your agent" landing page. A lightweight MCP server that exposes our services (but not a full discovery marketplace for others). No proprietary wallet — support any x402-capable wallet.
**What we use from others:** List on Rencom, Bazaar, and other discovery layers for additional visibility. Let users pay with any wallet that supports x402.

**Pros:**
- Focus engineering on the unique differentiator (infrastructure services)
- Still own the "ask your agent" acquisition channel — our llms.txt is our sales funnel
- Our MCP server lets agents discover and provision our services directly, without needing a general-purpose discovery layer
- Compatible with every wallet in the ecosystem — we don't fight ampersend, we work with them
- Faster to market than Option B, more defensible than Option A
- The llms.txt IS lightweight discovery — agents that read it get everything they need to provision our services
- Can always expand to full platform (Option B) later if demand validates the thesis
- Gets us on existing discovery platforms AND our own direct channel simultaneously

**Cons:**
- No proprietary wallet means no spending controls, no Stripe integration, no fiat on-ramp under our brand
- We don't capture wallet-level data (transaction patterns, agent behavior)
- The "zero to deployed app" story requires the user to already have a wallet and USDC — more friction than Option B's progressive onboarding
- If llms.txt doesn't drive enough direct traffic, we're dependent on Rencom/Bazaar for distribution

**Best if:** We want to test the core thesis (do agents want to provision infrastructure?) with the "ask your agent" channel, while keeping the option to build wallet/discovery later.

#### The "Everything Is Tiny" Factor

All of these competitors — Rencom, EntRoute, ampersend, Oops!402, Locus — are likely very early stage, probably smaller teams than us, probably pre-revenue or minimal revenue. The x402 ecosystem has 140+ projects but most are likely hackathon-level or single-developer projects. The total number of real agent-to-service transactions happening daily across the entire ecosystem is probably very small.

This cuts both ways:

- **Argument for Option A/C:** If everything is tiny, the discovery layers and wallets might not even work well yet. Don't depend on infrastructure that might be flaky.
- **Argument for Option B:** If everything is tiny, nobody has won yet. Building the full platform now while the market is nascent means we can establish position before anyone consolidates. The head starts that Rencom and ampersend have might be only weeks or months, not years.
- **Reality check for all options:** The market for autonomous agent transactions may itself be tiny. Before building a three-leg platform, it's worth validating that agents actually want to provision databases and deploy apps autonomously, at any meaningful volume.

#### Recommended Decision Framework

1. **Start with Option C** — ship infrastructure services + llms.txt + lightweight MCP server. Get listed on Bazaar and Rencom. This can be done fastest and tests the core hypothesis.
2. **Measure:** Are agents actually provisioning services? Through which channel — our llms.txt, Rencom, Bazaar, direct MCP? What's blocking the ones that try but fail?
3. **If agents come but wallet friction is high** → build the wallet (evolve toward Option B). The data will tell you whether fiat on-ramp and spending controls matter.
4. **If agents come through Rencom/Bazaar but not our llms.txt** → double down on discovery (evolve toward Option B). The data will tell you whether proprietary discovery matters.
5. **If agents don't come at all** → the market isn't ready. Option A was the right call — you validated cheaply.
6. **If agents come through our llms.txt directly** → the "ask your agent" channel works. This is the strongest signal to invest more. The llms.txt + services combination might be the whole product.

---

## Appendix B: Business Moats and Risks

### Moats

1. **First-party infrastructure services.** This is the strongest differentiator. Nobody else offers Postgres + S3 + Lambda + Amplify + DNS as x402-payable services that enable complete app deployment. This is hard to replicate — it requires real AWS infrastructure management, not just API wrapping.
2. **End-to-end "zero to deployed app" story.** The combination of discovery + wallet + infrastructure creates a unique capability: an agent can go from having nothing to having a live web application, autonomously. No competitor enables this full arc.
3. **"Ask your agent" acquisition channel.** The llms.txt-as-sales-funnel concept is novel. Competitors with similar capabilities (Rencom, EntRoute, Oops!402) aren't marketing this way. First-mover on this distribution approach could create brand recognition.
4. **Data flywheel (if we achieve scale).** Every transaction generates quality signals. More data → better recommendations → more agents → more data. However, Rencom and EntRoute are building similar flywheels — this moat depends on speed.
5. **Wallet lock-in (weaker than initially assessed).** Multiple wallet competitors exist (ampersend, Locus, Oops!402). Switching costs are lower when alternatives are available. The lock-in comes from the wallet + services combination, not the wallet alone.

### Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Discovery/wallet competitors ship faster** | Rencom, EntRoute, Oops!402, ampersend already have traction. Our discovery and wallet become redundant | Lead with infrastructure services (the hardest-to-copy leg). Consider partnering with existing wallet/discovery instead of building all three from scratch |
| Agent autonomy doesn't materialize at scale | The entire market thesis collapses | First-party services are useful to human developers too. Frictionless provisioning has value even when humans trigger it |
| Coinbase builds everything we're building | Protocol owner eats the ecosystem | Move fast on quality/curation. Build agent developer relationships. Coinbase wants ecosystem partners — consider applying to their programs |
| x402 doesn't win as the standard | Payment rails become irrelevant | Design protocol-agnostic from day one. Support AP2 and future standards. Discovery value is independent of payment protocol |
| Security breach in custodial wallets | Loss of user funds, trust destruction | Small balance limits in MVP. Partner with established custodial wallet providers (ampersend, Locus). Insurance for held funds |
| AWS costs exceed x402 payments | Negative unit economics | Lease-based model with hard caps ensures predictable costs. Pricing includes margin from day one. Monitor cost-to-revenue ratio per service |
| Third-party services underperform | Marketplace trust erodes | Quality scoring based on real data. "Verified" tier with SLA requirements. Ability to delist poor performers |
| **Ecosystem consolidation** | Larger players (thirdweb, Coinbase, AltLayer) acquire or out-resource smaller competitors | Focus on niche (agent infrastructure) where large players are weakest. Build developer community and brand recognition early |

---

## Appendix C: Key References and Context

- **x402 Protocol:** Open payment standard by Coinbase enabling HTTP-native stablecoin payments. Backed by x402 Foundation (Coinbase + Cloudflare). [x402.org](https://x402.org)
- **x402 Bazaar:** Official discovery layer for x402 ecosystem. [docs.cdp.coinbase.com/x402/bazaar](https://docs.cdp.coinbase.com/x402/bazaar)
- **x402 Ecosystem:** 140+ projects across 5 categories (client integrations, services, infrastructure, facilitators, learning resources). Growing rapidly. [x402.org/ecosystem](https://x402.org/ecosystem)
- **MCP (Model Context Protocol):** Anthropic's standard for AI agents to discover and use tools. The de facto integration point for agent capabilities.
- **Google AP2:** Google's Agent Payments Protocol, an extension to their A2A (Agent-to-Agent) framework. Supports both traditional payment rails and x402 stablecoins.
- **Gartner Machine Customers:** Research predicting machines responsible for 22% of revenue by 2030, $30T+ in purchases. CEOs surveyed consider 2030 the tipping point.
- **B2M concept:** Business-to-Machine model described by Marek Jeleśniański (2025) and referenced in Gartner research on machine customers.
- **Base L2:** Coinbase's Ethereum Layer 2 network. Sub-cent transaction fees. Primary settlement layer for x402.
- **USDC:** Circle's USD-pegged stablecoin. Primary payment token in x402 ecosystem.
- **ERC-8004:** Ethereum standard for portable, verifiable reputation — used by SlinkyLayer and proposed for x402 trust scoring.

---

## Appendix D: Naming Strategy

### What Needs a Name

| Element | Type | Notes |
|---|---|---|
| **The Company / Platform** | Primary brand | The marketplace itself. This is the name people say, agents query, and developers remember. Needs its own domain. |
| **The Discovery Layer** | Product name or feature name | Could be a named product (like "Bazaar" is for Coinbase) or simply a feature of the platform. If named separately, it should be a path under the main domain (e.g., platform.com/discover) |
| **The Agent Wallet** | Product name or feature name | The payment/wallet system. Could have its own name (like "Stripe Treasury" is to Stripe) or be a feature. Path under main domain (e.g., platform.com/wallet) |
| **Individual Services** | Service names | Postgres, Storage, Compute, Hosting, DNS. These don't need creative names — functional names are better for machine discovery. Listed under the platform (e.g., platform.com/services/postgres) |
| **The MCP Server** | Package name | What developers install. Needs to be findable in MCP directories. Should reference the platform name (e.g., "@platformname/mcp") |
| **The npm/pip packages** | Package names | Follow the platform name for consistency |

### Domain Strategy

**One primary domain for everything.** Subdomains for functional separation, paths for product areas.

```
brand.com                    — Marketing site, landing page
app.brand.com                — Dashboard, wallet UI, reporting
api.brand.com                — All service endpoints + discovery API
docs.brand.com               — Documentation
brand.com/discover            — Discovery layer docs/explorer
brand.com/wallet              — Wallet product page
brand.com/services            — Service catalog
brand.com/services/postgres   — Individual service pages
```

**Do NOT create separate domains for:**
- Individual services (no separate postgres.brand.com domain)
- The discovery layer (no separate discover.io domain)
- The wallet (no separate agentpay.com domain)

Splitting into multiple domains fragments brand equity, SEO, and developer trust. One domain, one brand, one platform.

**Exception:** If the B2B2M concept gains traction as a category term, consider owning b2b2m.com as a thought leadership / educational property that links back to the platform. This is a branding asset, not a product domain.

### Naming Criteria

The platform name should:

1. **Be machine-friendly** — Short, no special characters, easy to type in code and CLI commands. Agents will reference this name in API calls, MCP configurations, and documentation.
2. **Be domain-available** — .com is strongly preferred. .ai, .dev, or .io are acceptable alternatives.
3. **Signal what it does** — Names that hint at infrastructure, marketplace, or agent services are stronger than abstract names. Developers should have some intuition about what this is before clicking.
4. **Not be tied to x402** — "Run402" references a specific protocol. If x402 evolves, gets renamed, or a competing protocol wins, the name becomes confusing. The platform should outlive any single payment protocol.
5. **Work as a verb or noun** — "Deploy on [brand]" or "Use [brand] for hosting" should sound natural.
6. **Be short** — Ideally 2 syllables, max 3. Agents and developers will type this frequently.
7. **Not conflict with existing brands** — Especially in the cloud/infra/agent space.

### Elements to Name

| Priority | Element | Naming Approach |
|---|---|---|
| **Critical** | The platform | Needs a unique, ownable name with .com (or .ai/.dev) domain |
| **Important** | The MCP server package | @platformname/mcp or platformname-mcp |
| **Important** | The npm package | @platformname/sdk |
| **Optional** | The discovery layer | Can be a named feature (e.g., "Platform Discover") or just "Discovery API" |
| **Optional** | The wallet | Can be a named feature (e.g., "Platform Wallet") or just "Agent Wallet" |
| **Not needed** | Individual services | Use functional names: Postgres, Storage, Compute, Hosting, DNS |
| **Nice to have** | The B2B2M concept | Consider owning b2b2m.com for thought leadership |

### Current State

"Run402" is a working name. It served well for the initial Postgres service proof-of-concept but has limitations as the platform name:
- Ties the brand to the x402 protocol specifically
- Sounds like a single service ("run a 402"), not a marketplace
- Doesn't convey discovery or marketplace positioning
- The "402" reference is meaningful to x402-aware developers but opaque to everyone else

A new name should be selected before significant marketing investment begins. The run402.com domain can redirect to the new platform domain and continue serving as the technical endpoint for existing integrations during transition.

### Naming Workshop Needed

Selecting the platform name is a separate exercise. Key inputs:
- Domain availability check for candidate names
- Trademark search in relevant classes
- Test with target audience (agent developers) for recall and association
- Verify npm / PyPI package name availability
- Check MCP marketplace naming conventions

---

## Appendix E: Glossary

| Term | Definition |
|---|---|
| **B2B2M** | Business-to-Business-to-Machine. A marketplace model where the platform serves businesses on both supply and demand sides, with AI agents as the active transacting party |
| **Agent Wallet** | A pre-funded crypto wallet managed on behalf of a user, from which AI agents can autonomously make x402 payments within set spending limits |
| **Discovery Layer** | A machine-readable catalog of services that AI agents can query to find, evaluate, and select infrastructure services programmatically |
| **Facilitator** | An x402 network participant that verifies payment conditions and manages settlement between agents and service providers |
| **Faucet** | A mechanism that distributes free testnet tokens to users for testing and experimentation |
| **llms.txt** | A standard format for providing machine-readable information about a service to LLMs, enabling AI agents to understand capabilities and usage |
| **Machine Customer** | An AI agent or autonomous software that acts as an economic actor — discovering, evaluating, purchasing, and consuming services without human intervention |
| **MCP Server** | A server implementing Anthropic's Model Context Protocol, allowing AI agents to discover and use tools/services through a standardized interface |
| **x402** | An open payment protocol that uses HTTP status code 402 to embed stablecoin payments directly into web requests |
