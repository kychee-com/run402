# Consultation Result

**Model**: gpt-5.2-pro
**Submitted**: 2026-03-05T08:56:11.381583
**Completed**: 2026-03-05T09:10:36.945717
**Status**: completed

---

You’re already *most of Supabase’s wedge* (Postgres + REST + RLS + Auth + Storage) **and** you’ve got the beginnings of *Vercel’s wedge* (Sites + subdomains). The next “OpenClaw blockers” are the primitives that let an agent ship *complete* apps without telling a human to go wire up external services.

Below is the prioritized “feature Y” list, explicitly mapped to Vercel/Supabase parity, with suggested pricing.

---

## Where you’re ahead vs Vercel/Supabase
- **Procurement & onboarding:** x402, no signup, hard caps, auto-expiry (nobody else has this as a first-class UX).
- **Backend core:** Postgres + RLS + PostgREST + Storage + JWT Auth is already “app-complete” for CRUD apps.

## The gaps that actually stop agents
### Compared to **Vercel**
Missing: **Functions**, **env/secrets**, **cron**, **stable production alias / domains**, **logs**.

### Compared to **Supabase**
Missing: **Edge Functions**, **Realtime**, **OAuth/social**, **“Studio-lite”/dashboard**, **backups/export**, (often) **pgvector**.

### Compared to **Firebase / Cloudflare**
Missing: **event-driven compute** (webhooks + scheduled + DB-triggered), **realtime**, **push-style messaging**.

---

# The most impactful “Y’s” (in order)

## 1) HTTP Compute: “Functions” (server-side code that runs next to the DB) [IMPLEMENTED]
**What OpenClaw can’t do today:** “I need an API route / webhook endpoint / call Stripe/OpenAI/Slack safely without putting secrets in the browser.”

This is the #1 unblocker for real apps:
- Stripe checkout + webhooks
- Slack/Discord bots
- “ingest a CSV, transform, store”
- call external APIs, do auth checks, custom business logic
- server-side rendering helpers / PDF generation / image transforms

**Vercel parity:** Vercel Functions  
**Supabase parity:** Edge Functions

**Minimum lovable scope**
- `deploy_function(name, code, runtime=node|deno, entrypoint)`  
- `invoke_function` (HTTP) at a Supabase-shaped URL like `/functions/v1/:name`
- **Logs** endpoint (`get_function_logs`) so agents can self-debug
- Built-in injection of project context:
  - service-role access (for admin tasks)
  - ability to forward end-user JWT (so functions can act “as user” when needed)

**Pricing suggestion**
- **Bundle into the existing leases** with hard caps (this keeps the “no surprise bill” story intact).
- Add **compute quotas** per tier (invocations + max duration + egress ceiling). If you need an add-on later:
  - “Compute Pack” as a fixed-price top-up (avoid per-invocation billing).
- Don’t charge per deployment; charge by plan/quota (Vercel mental model).

---

## 2) Secrets / Env Var Store (for Functions + future Jobs) [IMPLEMENTED]
**What OpenClaw can’t do today:** “I need to store STRIPE_SECRET_KEY / OPENAI_API_KEY / webhooks signing secrets securely.”

**Vercel parity:** Environment Variables  
**Supabase parity:** Secrets for functions

**Minimum lovable scope**
- `set_secret(key, value)` / `delete_secret(key)` / `list_secrets()` (value never readable back)
- Namespaces per “environment” later (preview/prod), but you can start single-env.
- KMS-backed encryption + audit trail (even minimal) for trust.

**Pricing suggestion**
- Included in all paid tiers (and prototype).
- Quotas: number of secrets + total bytes (Team gets more). This should not be a revenue line item.

---

## 3) Scheduler / Cron (“Jobs” that call Functions or HTTP) [FUTURE]
**What OpenClaw can’t do today:** “Send daily digests, reminders, cleanup tasks, retry failed work.”

This turns a CRUD app into a product.

**Vercel parity:** Vercel Cron  
**Supabase parity:** Scheduled functions (common pattern)

**Minimum lovable scope**
- `create_job(name, cron, target=function|url, enabled=true)`
- `run_job_now`, `list_jobs`, `get_job_runs` (debuggability matters)
- Tight guardrails: max frequency, max runtime, concurrency = 1 by default

**Pricing suggestion**
- Bundle into leases; cap:
  - number of jobs
  - max runs/day
  - runtime budget (counts against compute quota from Functions)

---

## 4) Transactional Email (one-call “send_email” + Auth emails that just work) [FUTURE]
**What OpenClaw can’t do today:** “Users need email verification, password resets, invites, receipts.”

Agents routinely hit this wall because wiring SES/Resend/Mailgun is *human-console work*.

**Supabase parity:** Supabase Auth emails (but still a common pain)  
**Vercel parity:** not built-in (usually Resend), so this is a chance to be *better* for agents.

**Minimum lovable scope**
- `send_email(to, subject, text|html)` via service_key
- Default “from” domain (`noreply@run402.com`) so it works instantly
- Later: custom sender domain (DKIM/SPF) as a Team feature

**Pricing suggestion**
- Include a small monthly allowance in Hobby/Team (enough for prototypes).
- Add a simple **Email Pack** add-on if/when needed (emails are a real cost driver + abuse vector).
  - Example model: “Included: 1k (Hobby), 10k (Team). Packs: +10k / month for $X.”
- Keep it quota-based, not per-email micropayments.

---

## 5) Realtime (chat-grade subscriptions + Postgres changefeed) [FUTURE]
**What OpenClaw can’t do today:** “Chat, live dashboards, multiplayer, collaborative editing.”

Polling works, but it’s not “wow” and it breaks Supabase client compatibility for many templates.

**Supabase parity:** Supabase Realtime  
**Firebase parity:** Realtime Database / Firestore listeners

**Minimum lovable scope**
- Authenticated WebSocket (or SSE) channels
- Two primitives:
  1) **Broadcast/pubsub**: `channel("room").send(...)`
  2) **DB changefeed (optional v1)**: subscribe to table changes for a project schema
- Rate limits + connection caps + message size caps (abuse control)

**Pricing suggestion**
- Bundle into leases with quotas:
  - concurrent connections
  - messages/minute or GB egress
- If it becomes a cost center, introduce a **Realtime Pack** later (fixed-price).

---

## 6) Sites “Production Alias” + Custom Domains (finish your Vercel-lite) [FUTURE]
You already shipped deployments + subdomains; the next friction is “every deploy has a new URL” and “I need my own domain”.

**Vercel parity:** Production alias, Domains  
**Why it matters:** this is the human-facing “ship it” moment.

**Minimum lovable scope**
- `prj-xxx.sites.run402.com` always points to latest `target=production`
- `GET /v1/deployments?project=...` + promote-to-production
- Custom domains: CNAME + automatic TLS

**Pricing suggestion**
- Production alias: free/included.
- Custom domains:
  - Include 1 domain in Hobby, N domains in Team
  - Charge per additional domain/month only if you need an anti-abuse lever (otherwise keep it free to reduce friction)

---

## 7) Auth upgrades that reduce onboarding friction: Magic links + Passkeys (then OAuth) [FUTURE]
OAuth (Google/GitHub) is valuable, but it *still requires someone to create OAuth credentials*—which is exactly the “go touch a console” trap.

If you want “agent can ship without human setup,” prioritize:
- **magic link login**
- **passkeys/WebAuthn**

Then add OAuth providers as “bring your own keys” for production polish.

**Supabase parity:** Supabase Auth (OAuth + magic links; passkeys are emerging)

**Pricing suggestion**
- Included (auth is core). No reason to monetize.

---

## 8) AI-native Postgres: pgvector (and a curated extensions set) [FUTURE]
Agents building “X” frequently need “memory/search”. If pgvector isn’t available, they’ll immediately detour to Pinecone/Upstash.

**Supabase parity:** Vector support  
**Neon parity:** common extension story

**Minimum lovable scope**
- Enable `pgvector` + a short list of “safe, common” extensions (pgcrypto, citext, pg_trgm, unaccent, etc.)
- Document it in a machine-readable way (OpenAPI + “supported_extensions” endpoint)

**Pricing suggestion**
- Included; it mostly manifests as DB CPU/storage that you already cap via tier quotas.
- If vector search becomes heavy, introduce a “Vector index size” quota later (but don’t start there).

---

# What I would *not* prioritize next (even though competitors have it)
- **GraphQL:** [REJECTED] doesn’t unblock agents if REST + RPC exists; adds surface + security complexity.
- **Full Supabase Studio clone:** [FUTURE] great eventually, but not the fastest path to “OpenClaw can ship anything.” Do a “Studio-lite” later once compute/email/realtime exist.
- **Database branching/preview DBs:** [FUTURE] very nice, but only after Functions + Sites + Domains are solid.

---

# Recommended build order (high leverage, agent-first)

### Sprint 1–2: unblock shipping + onboarding
1) **Functions + logs (v1)** [IMPLEMENTED]
2) **Secrets** [IMPLEMENTED]
3) **Sites production alias + deployment listing** [FUTURE] (easy win, immediate polish)
4) Publish **/openapi.json** (big onboarding multiplier for non-MCP agents)

### Sprint 3–4: make apps “real products”
5) **Cron/Jobs** [FUTURE]
6) **Transactional email** [FUTURE]

### Sprint 5+: “wow” apps (chat/collab)
7) **Realtime** [FUTURE]

Parallel “trust” track (doesn’t block agents, but boosts adoption):
- Wallet-based **project ownership + key recovery**
- Self-serve **export/backup**
- Public **status page**

---

# Pricing packaging (keep it simple)
- **Bundle** Functions + Secrets + Cron + Realtime into your existing lease tiers with **quotas and hard caps**.
- Only add add-ons for true cost drivers:
  - **Email Pack** (and maybe later Realtime Pack / Compute Pack)
- Avoid per-deploy / per-invocation charges if you want the “Vercel feel”; if you need anti-abuse friction, enforce it via tier quotas + prototype limitations.

If you tell me the top 10 “build me X” requests you’re seeing (or want to demo), I can map each to the exact missing primitive and propose concrete quota numbers per tier that keep AWS burn bounded while maximizing wow.

---
**Tokens**: 4,114 input, 21,987 output, 26,101 total
