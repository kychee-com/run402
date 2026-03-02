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

**How it works technically:**
- We generate and manage custodial wallets for users who don't have their own
- Stripe integration converts fiat → USDC (via on-ramp partners) into the user's agent wallet
- The wallet signs x402 payment transactions on behalf of the agent
- All settlements happen on Base L2 (sub-cent transaction fees)
- Users with existing wallets can connect directly

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

Each step requires slightly more commitment but delivers more value. Users enter at any level and naturally progress upward.

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

**Level 4 — MCP Server Install (conversion step)**
- For developers who want their agents to use the platform ongoing
- One-line install command
- Agent now has permanent access to discovery, wallet, and all services
- This is the retention mechanism, not the acquisition step
- **CTA:** "Make it permanent — install the MCP server →"

**Level 5 — Fund Wallet (monetization step)**
- Connect Stripe, purchase agent allowance
- Set spending limits and controls
- Agent operates autonomously within budget on real infrastructure
- **CTA:** "Go live — fund your agent's wallet →"

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
