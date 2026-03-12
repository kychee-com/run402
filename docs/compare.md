# Run402 vs InsForge — Competitive Analysis

_Last updated: 2026-03-11_

## TL;DR

InsForge is a pre-seed BaaS (Backend-as-a-Service) that bolted on MCP agent support ($1.5M from MindWorks, ~5 people). Run402 is agent-native infrastructure where the agent _is_ the customer — no dashboards, no signups, no subscriptions. Different DNA, overlapping features.

---

## 1. Positioning & Messaging

| | Run402 | InsForge |
|---|---|---|
| **Tagline** | "Full-stack infrastructure for AI agents" | "The Backend Built for Agentic Development" |
| **Core claim** | Agents provision and deploy via HTTP payments — no human in the loop | Agents use MCP to configure a managed backend — human creates account first |
| **Who pays** | Agent pays per-action via x402 micropayments (USDC on-chain) | Human pays monthly subscription ($0–$25/mo) |
| **Primary audience** | AI agents (literally — the homepage serves `llms.txt`) | Developers using AI coding agents (Cursor, Claude Code, etc.) |
| **Secondary audience** | Humans who fund agent budgets | Teams needing production BaaS |

**Key difference:** InsForge markets to _developers who use agents_. Run402 markets to _agents directly_. InsForge's agent is a tool the developer wields; Run402's agent is the autonomous customer.

---

## 2. Product Capabilities

### Feature Matrix

| Feature | Run402 | InsForge |
|---|---|---|
| **Postgres Database** | Yes (schema-isolated, 2000 slots) | Yes |
| **REST API** | Yes (PostgREST, auto-generated) | Yes (auto-generated from schema) |
| **Authentication** | Yes (JWT + refresh tokens, RLS) | Yes (OAuth, sessions, user mgmt) |
| **Row-Level Security** | Yes (one-call templates) | Yes (Postgres RLS) |
| **File Storage** | Yes (S3-backed) | Yes (S3-compatible, 1GB–100GB) |
| **Serverless Functions** | Yes (Node.js on Lambda) | Yes (Edge Functions, globally distributed) |
| **Static Site Hosting** | Yes (CDN, custom subdomains) | Yes (Site Deployment) |
| **Realtime / WebSockets** | No | Yes (pub/sub, live sync) |
| **Vector DB / Embeddings** | No | Yes (PGVector) |
| **AI Model Gateway** | No (image gen only) | Yes (OpenAI, Claude, Kimi K2.5) |
| **Bundle Deploy (one call)** | Yes (DB + migrations + RLS + functions + site + subdomain) | No (multi-step MCP) |
| **Forkable Apps** | Yes (publish → fork → earn rewards) | No |
| **Publisher Rewards** | Yes (20% revenue share to ancestors) | No |
| **Custom Subdomains** | Yes (`myapp.run402.com`) | Unknown |
| **MCP Server** | No (pure HTTP REST) | Yes (primary agent interface) |
| **CLI** | No (`npx @x402/fetch` SDK only) | Yes (`npx @insforge/cli create`) |
| **VS Code Extension** | No | Yes |
| **Mobile SDKs** | No | Yes (Swift, Kotlin) |
| **Multi-region** | No (us-east-1 only) | Yes |
| **SOC2 / HIPAA** | No | Enterprise plan |

### What Run402 Has That InsForge Doesn't

1. **x402 micropayments** — agents pay per-action, no subscription, no signup
2. **Bundle deploy** — entire full-stack app in one HTTP call
3. **Forkable apps + marketplace** — agents publish, other agents fork, publishers earn
4. **Hard-capped budgets** — humans set spend limits, agents can't exceed them
5. **Lease-based pricing** — projects auto-expire, no zombie resources
6. **No account required** — pay and use, that's it

### What InsForge Has That Run402 Doesn't

1. **Realtime / WebSockets** — live data sync, pub/sub
2. **Vector database** — PGVector for embeddings and semantic search
3. **AI Model Gateway** — route to OpenAI/Claude/Kimi from one endpoint
4. **MCP Server** — native integration with Cursor, Claude Code, Copilot
5. **Edge Functions** — globally distributed (Run402 is Lambda in us-east-1)
6. **Mobile SDKs** — Swift and Kotlin clients
7. **VS Code Extension** — IDE integration
8. **Enterprise compliance** — SOC2, HIPAA
9. **Multi-region deployment**

---

## 3. Pricing & Business Model

### Run402 — Pay-per-action, no subscription

| Tier | Price | Lease | Storage | API Calls | Functions |
|---|---|---|---|---|---|
| Prototype | $0.10 | 7 days | 250MB | 500K | 5 |
| Hobby | $5.00 | 30 days | 1GB | 5M | 25 |
| Team | $20.00 | 30 days | 10GB | 50M | 100 |

Additional micropayments: deploy site ($0.05), generate image ($0.03), send message ($0.01).

**No overages.** Hit the limit → blocked until renewal. No surprise bills.

### InsForge — Monthly subscription with overages

| Plan | Price | Database | Bandwidth | Storage | MAU |
|---|---|---|---|---|---|
| Free | $0/mo | 500MB | 5GB | 1GB | 50K |
| Pro | $25/mo | 8GB | 250GB | 100GB | 100K |
| Enterprise | Custom | Custom | Custom | Custom | Custom |

Pro plan includes $10 compute credits. Overages: $0.125/GB database, $0.09/GB bandwidth, $0.021/GB storage, $0.00325/MAU.

**Key differences:**
- Run402: one-time payment, lease expires, renew manually. Max cost is known upfront.
- InsForge: recurring subscription, overages can accumulate. Free tier pauses after 1 week of inactivity.
- Run402 Prototype ($0.10 for 7 days) vs InsForge Free (free but pauses). For agents that spin up and tear down quickly, Run402 is cheaper. For long-running production apps, InsForge Pro offers more resources.

---

## 4. Developer / Agent Experience

### Run402 — HTTP-first, agent-native

```
Agent → HTTP POST with x402 payment → Project provisioned → Use REST API
```

- No signup flow. No email. No password.
- Agent pays with USDC (on-chain) or from human-funded allowance (Stripe).
- Full API documented in `/llms.txt` (56KB markdown, designed for LLMs).
- OpenAPI spec available.
- SDK: `@x402/fetch` wraps standard fetch with payment signing.
- Error messages include next steps for agents.

### InsForge — MCP-first, IDE-native

```
Human creates account → Connects MCP server to IDE → Agent configures backend via MCP
```

- Human creates account via CLI (`npx @insforge/cli create`).
- Agent connects via MCP server protocol.
- Works inside Cursor, Claude Code, Copilot, Windsurf, etc.
- VS Code extension for IDE-native experience.
- Docs at `docs.insforge.dev` (traditional docs site + `llms.txt`).

**Key difference:** Run402 requires no human setup — the agent does everything. InsForge requires a human to create an account and connect MCP, then the agent takes over. Run402 is more autonomous; InsForge is more integrated with existing developer workflows.

---

## 5. Technology & Architecture

| | Run402 | InsForge |
|---|---|---|
| **API style** | REST (PostgREST) | REST (auto-generated) |
| **Agent protocol** | HTTP + x402 headers | MCP (Model Context Protocol) |
| **Payment** | x402 / USDC on Base chain | Stripe subscription |
| **Database** | Aurora PostgreSQL (AWS) | PostgreSQL (managed) |
| **Functions runtime** | AWS Lambda (Node 22) | Edge Functions (V8 isolates?) |
| **Hosting** | AWS ECS + CloudFront | Unknown (likely multi-cloud) |
| **Storage** | S3 | S3-compatible |
| **Auth tokens** | JWT (self-issued) | Sessions + OAuth |
| **Open source** | No | GitHub repo exists (github.com/InsForge/InsForge) |

---

## 6. Marketing & Go-to-Market

### InsForge — Aggressive, polished, early-stage

- **Funding**: $1.5M pre-seed from MindWorks Ventures (2025). ~5 employees, Seattle.
- **Website**: Dark theme, emerald green accents, animated, highly polished
- **Social proof**: 15+ testimonials, logos of 11 agent platforms
- **Benchmarks**: Claims 1.6x faster, 30% fewer tokens, 1.7x higher accuracy vs Supabase/raw Postgres
- **Content**: Active blog (weekly cadence), multiple authors, technical depth
- **Community**: Discord server, GitHub presence
- **Sales**: "Talk to Founder" (cal.com booking link)
- **Channels**: Twitter (@InsForge_dev), Discord, GitHub, blog
- **Positioning**: Direct Supabase/Firebase competitor, angled for AI agents

### Run402 — Minimal, agent-first, bootstrapped

- **Website**: Dark theme, neon green accents, minimal — homepage is literally an LLM doc reader
- **Social proof**: None on site (two live demos: evilme, cosmicforge)
- **Benchmarks**: None published
- **Content**: No blog, no case studies
- **Community**: None visible (no Discord, no GitHub community)
- **Sales**: No sales motion visible
- **Channels**: Twitter (@run402com) only
- **Positioning**: Novel category — "infrastructure that agents buy"
- **Team signals**: Solo founder or very small team

---

## 7. Strengths & Weaknesses

### Run402

**Strengths:**
- Genuinely novel: agents as autonomous customers is a new paradigm
- x402 micropayments eliminate subscription friction for agents
- Bundle deploy (one-call full-stack) is a killer feature for agent UX
- Forkable apps create a potential marketplace / network effect
- Hard-capped budgets solve the "agent runs up a bill" fear
- Lease-based pricing = no zombie resources, clean economics
- No vendor lock-in (Postgres, PostgREST, standard JWT, plain Node.js functions)

**Weaknesses:**
- No MCP support — agents in Cursor/Claude Code can't discover Run402 natively
- No realtime, no vector DB, no AI gateway — feature gaps for modern apps
- Single region (us-east-1)
- No compliance certifications
- No community, no content marketing, no social proof
- Agent-first positioning is ahead of market — most buyers are still humans
- No open-source presence

### InsForge

**Strengths:**
- Feature-rich: realtime, vectors, AI gateway, edge functions, mobile SDKs
- MCP integration = frictionless for developers already using agent IDEs
- Free tier lowers barrier to entry
- Active content marketing and community building
- Enterprise features (SOC2, HIPAA) open large contracts
- Multi-region deployment
- VS Code extension and CLI reduce setup friction
- Social proof from real users

**Weaknesses:**
- Subscription model creates friction for agent autonomy (human must sign up)
- No micropayment or per-action pricing — agents can't self-provision
- No bundle deploy — setting up a full app requires multiple MCP calls
- No forkable apps or marketplace dynamics
- Overages can surprise users (no hard caps)
- Positioning as "Supabase for agents" invites direct comparison with a much larger competitor
- Dependence on MCP protocol (if MCP adoption slows, so does InsForge)

---

## 8. Strategic Implications for Run402

### Where InsForge validates our thesis
- The market agrees: AI agents need backend infrastructure
- MCP is becoming the standard agent-to-tool protocol
- Developers want one-call simplicity, not dashboard configuration

### Where InsForge challenges us
- They have features we don't (realtime, vectors, AI gateway, MCP)
- They have marketing we don't (blog, testimonials, benchmarks, community)
- They have enterprise readiness we don't (SOC2, HIPAA, multi-region)
- MCP support is table-stakes for agent discovery — we should add it

### Where we have structural advantages
- **x402 micropayments**: agents can self-provision without human gatekeeping. InsForge can't replicate this without rebuilding their billing model.
- **Bundle deploy**: one HTTP call → full app live. This is 10x simpler than MCP multi-step configuration.
- **Forkable apps + rewards**: creates a marketplace flywheel. InsForge has no equivalent.
- **Hard-capped budgets**: solves the #1 fear (runaway agent costs). InsForge has overages.
- **Lease-based pricing**: clean resource lifecycle. No zombie projects.

### Recommended actions
1. **Add MCP server** — expose Run402 APIs via MCP so agents in Cursor/Claude Code can discover us
2. **Publish benchmarks** — prove bundle deploy speed, token efficiency, cost per deploy
3. **Build social proof** — collect testimonials, showcase demo apps prominently
4. **Start content marketing** — blog about agent infrastructure, x402 protocol, forkable apps
5. **Add vector/embedding support** — PGVector is a Postgres extension, low lift
6. **Consider realtime** — even basic webhooks/polling would close the gap
7. **Ship a free testnet tier** — match InsForge's free tier for discovery (faucet already exists)

---

## 9. Bottom Line

InsForge is a **better Supabase for the MCP era** — feature-rich, well-marketed, developer-friendly. They win on breadth and polish.

Run402 is a **new primitive** — infrastructure that agents buy, deploy, and fork autonomously. We win on depth of agent autonomy and economic model.

The question is whether the market wants a slightly better BaaS (InsForge) or a fundamentally different model where agents are first-class economic actors (Run402). If autonomous agents become the dominant builders, Run402's architecture is structurally superior. If human developers remain the primary buyers using agents as tools, InsForge's model is more natural.

**Our bet: agents become autonomous.** Ship faster, market louder, and prove it.

---

## 10. Three-Day Blitz — Beat InsForge by Sunday

_Goal: Close every gap that matters and open new ones they can't match._

### Day 1 (Wednesday) — Ship MCP Server

**Why:** MCP is the #1 way agents discover tools in Cursor, Claude Code, Copilot, and Windsurf. Without it, we're invisible to the exact audience InsForge is capturing. We already documented the full MCP spec in `llms.txt` (including config snippets for Claude Desktop, Cursor, Cline) — we just never built the package.

**Ship:**
- [ ] Build `packages/mcp-server` — thin MCP wrapper over our existing REST API
  - Tools: `create_project`, `deploy_bundle`, `execute_sql`, `deploy_site`, `deploy_function`, `fork_app`, `list_apps`
  - Resources: `project://`, `schema://`, `functions://`, `apps://`
  - Auth: service_key or x402 payment headers passed through
- [ ] Publish as `run402-mcp` on npm (the name we already documented)
- [ ] Test with Claude Code and Cursor — verify agent can discover and use Run402 end-to-end
- [ ] Update `llms.txt` MCP config section with real (not aspirational) setup instructions

**Result:** Any agent in any MCP-compatible IDE can discover and use Run402. Matches InsForge's core distribution channel.

---

### Day 2 (Thursday) — Marketing Blitz

**Why:** InsForge has 15 testimonials, weekly blog posts, and benchmark claims. We have zero public content. A single day of focused content closes the credibility gap.

**Morning — Benchmark & proof:**
- [ ] Record a bundle deploy: time from `POST /v1/deploy/prototype` to live app with working DB + auth + functions + site + subdomain. Target: under 60 seconds.
- [ ] Compare to InsForge: count the MCP tool calls needed to achieve the same result. Document token count and steps.
- [ ] Record a fork: time from `POST /v1/fork/prototype` to live forked app. Target: under 30 seconds.
- [ ] Publish results on `site/benchmarks/index.html` — simple, factual, with reproducible steps.

**Afternoon — Content & social proof:**
- [ ] Write 2 blog posts (ship as `site/blog/`):
  1. "One HTTP call to a full-stack app" — bundle deploy walkthrough, contrast with multi-step setup on InsForge/Supabase
  2. "Agents that pay for themselves" — x402 micropayments explained, why subscriptions don't work for autonomous agents
- [ ] Add a "Built with Run402" section to `site/humans/index.html` showcasing evilme + cosmicforge with screenshots
- [ ] Tweet the benchmark results and blog posts from @run402com
- [ ] Add `site/compare/insforge.html` — public-facing comparison page (SEO for "insforge alternative")

**Result:** Someone Googling "InsForge alternative" or "agent backend" finds us with real benchmarks and content.

---

### Day 3 (Friday) — Feature Knockout + Polish

**Morning — PGVector (quiet enable, no flagship demo):**
- [ ] Enable `pgvector` extension on Aurora (one SQL command: `CREATE EXTENSION vector`)
- [ ] Add embedding example to `llms.txt` (create table, insert vectors, similarity search via RPC)
- [ ] Update feature matrix on humans page: "Vector DB: Yes (PGVector)"

> **Why no demo app?** We evaluated 10+ casual PGVector app ideas (see `docs/consultations/pgvector-casual-app-ideas.md`). Every one fails the "single LLM call" test:
> - **Small personal data** (captions, names, pep talks) → fits in an LLM context window, no DB needed
> - **Large personal data** (photos, memes, playlists) → locked in walled gardens (Google Photos, Spotify), can't practically import
> - **Generic knowledge** (restaurant recs, activity ideas) → LLM generates better answers than searching a pre-seeded DB
>
> PGVector only wins when data is **born in the app, from many users, growing beyond context window size** — that requires a product with traction, not a demo. So: enable the extension, document it for agents who need it, check the competitive box, but don't burn demo energy here. Focus the flagship demo on what actually differentiates us (bundle deploy, forkable apps, x402).

**Afternoon — Free testnet tier + onboarding polish:**
- [ ] Ship a `/v1/projects/create/free` endpoint — 0 USDC, 24-hour lease, 50MB storage, 10K API calls, 1 function
  - Rate-limited: 1 free project per wallet per 24h (same pattern as faucet)
  - Purpose: let agents try Run402 with zero commitment — matches InsForge's free tier
- [ ] Improve error messages on all 402 responses — include "try free tier first" hint
- [ ] Add a "Getting Started in 30 seconds" section at the top of `llms.txt`
- [ ] Final pass on `site/humans/index.html` — add MCP setup, benchmarks link, blog link, comparison link

**Result:** Free tier removes the last barrier to trial. PGVector quietly checks the competitive box. Site tells a complete story.

---

### Scoreboard After 3 Days

| Capability | Before | After | InsForge |
|---|---|---|---|
| MCP support | No | **Yes** | Yes |
| Free tier | No | **Yes (24h)** | Yes (pauses after 1wk) |
| Vector DB | No | **Yes (PGVector)** | Yes (PGVector) |
| Bundle deploy | **Yes** | **Yes** | No |
| Forkable apps | **Yes** | **Yes** | No |
| x402 micropayments | **Yes** | **Yes** | No |
| Hard-capped budgets | **Yes** | **Yes** | No |
| Published benchmarks | No | **Yes** | Yes (self-reported) |
| Blog / content | No | **Yes (2 posts)** | Yes (weekly) |
| Social proof on site | No | **Yes (demos)** | Yes (15 testimonials) |
| Comparison page (SEO) | No | **Yes** | No |

**Net result:** We match them on MCP, free tier, vectors, and marketing presence — while keeping our structural advantages (x402, bundle deploy, forkable apps, hard caps) that they can't replicate in 3 days or 3 months.
