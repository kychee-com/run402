# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-10T22:17:31.191276
**Completed**: 2026-03-10T22:34:24.849962
**Status**: completed

---

Short answer: **no, not yet**.

Based on the source you shared, the MCP is **functionally strong** but **under-optimized as a marketing surface**. The website sells **“full-stack infrastructure for AI agents”**; the MCP still mostly reads like **“a Postgres tool with extras.”**

The biggest leak is this mismatch:

- **Site story:** prompt → live app on the internet
- **MCP story:** provision database → run SQL

If MCP is the primary integration point, then the MCP tool list is effectively your **homepage for agents**.

## Highest-priority fixes

### P0 — Fix message drift immediately
Right now your surfaces disagree:

- `README.md` lists **5 tools**
- `SKILL.md` says **10 tools**
- `index.ts` exposes **32 tools**

That is both a **trust problem** and a **discovery problem**.

#### Action
Create a **single source of truth** for tool metadata and generate from it:

- MCP tool descriptions
- README tool table
- SKILL docs
- llms.txt sections if possible

Also add a CI check that fails if docs/tool counts drift.

#### Messaging change
Standardize on one top-line position everywhere:

> **Run402 is full-stack infrastructure for AI agents — Postgres, REST API, auth, storage, functions, and static hosting, paid with x402.**

Right now these surfaces are too DB-centric:

- README title/subtitle
- SKILL title: “Postgres for AI Agents”
- `package.json` description omits functions/hosting

---

### P0 — Make the default story “first live URL,” not “first database”
Your thesis is “fastest path from agent-wrote-code to live app.”  
But the MCP currently leads with low-level DB workflows.

The hero tools should be:

1. `bundle_deploy`
2. `fork_app`
3. `provision_postgres_project`
4. `get_quote`

#### Action
- Put a **“Start here”** section at the top of README and SKILL.
- Mark `bundle_deploy` as **recommended for new apps**.
- Reorder tool registration so clients that preserve order show the hero path first.
- In docs, explicitly say:
  - **New app from scratch?** `bundle_deploy`
  - **Start from template?** `fork_app`
  - **Backend only?** `provision_postgres_project`
  - **Budget first?** `get_quote`

#### Important site-side alignment
Your `/humans` prompt currently says:

> “Please build me a demo app using run402.com/llms.txt (curl it)”

If the MCP is the primary interface, this prompt should instead say something like:

> **If the Run402 MCP is installed, use it. Otherwise curl run402.com/llms.txt. Prefer `bundle_deploy` for new apps.**

Right now your site may be teaching people to bypass your best distribution surface.

---

### P1 — Bring your best site marketing into the MCP itself
Your strongest agent marketing already exists in `llms.txt`:

- demo app ideas
- “Make It Great”
- wallet / allowance guidance
- pricing framing
- use-case framing

But the MCP exposes almost none of that in-protocol.

#### Action
Add MCP **resources/prompts** for:

- `quickstart`
- `demo_prompts`
- `make_it_great`
- `pricing`
- `allowance_payment_help`
- `auth_quickstart`
- `run402_use_cases`

If client support for prompts/resources is inconsistent, add a simple fallback tool like:

- `get_run402_guide(topic)`

That is worth it. Agents often won’t independently fetch your website.

---

### P1 — Rewrite key tool descriptions for marketing *and* better tool routing
For models, “marketing” means:

- clearer intent matching
- better feature discoverability
- stronger confidence in when to use a tool

Your current descriptions are clear, but they often undersell Run402.

#### Biggest misses
- `provision_postgres_project` sells only **database**, not **backend**
- auth is marketed on the site but mostly hidden in the MCP
- `deploy_function` spends too much description budget on package list
- `bundle_deploy` is strong, but not positioned as the obvious default

#### Suggested rewrites

**`provision_postgres_project`**
Current:
> Provision a new Postgres database...

Suggested:
> **Create a Run402 backend in seconds:** hosted Postgres plus built-in REST API, auth, storage, and RLS. Use this for backend-only projects; for full apps, prefer `bundle_deploy`.

**`bundle_deploy`**
> **Recommended start for new apps.** Deploy a full Run402 stack—database, migrations, RLS, secrets, functions, static site, and optional `*.run402.com` subdomain—in one call and one x402 payment.

**`deploy_site`**
> Deploy a static frontend or landing page to a live URL without extra hosting setup. Costs **$0.05 USDC via x402**; pair with `claim_subdomain` for a branded URL.

**`deploy_function`**
> Deploy an API route, webhook, or AI backend endpoint without managing cloud infrastructure. Functions run on Node 22, can use project secrets, and pair with `deploy_site` for full-stack apps.

**`fork_app`**
> Start from a working full-stack template instead of a blank project. Fork a published app—including database, functions, and site—into a new Run402 project.

**`get_quote`**
> See transparent pricing, limits, and lease durations before spending. Good first call when the user asks about budget, tiers, or whether Run402 fits a prototype vs MVP.

Also tighten descriptions for utility tools in a brand-helpful way:

- `list_projects`: “See all active Run402 projects for a wallet—useful when working without a dashboard.”
- `check_balance`: “Check an agent allowance / billing balance before deploying or renewing.”

---

### P1 — Redesign success, payment, and error messages as conversion moments
This is the biggest underused marketing surface.

Right now your success outputs are functional, but they don’t fully sell the value created.

#### Good rule
- **Descriptions** are for the model
- **Milestone responses** are for the human watching the transcript

### What to change

#### 1) Lead with the public outcome
For major wins, put the live URL first.

Example for `bundle_deploy`:

Instead of:
> Bundle Deployed: my-app

Prefer:
> ## Your app is live  
> **Live URL:** https://my-app.run402.com

Then the table.

Humans care more about “it’s live” than `project_id` or `schema`.

#### 2) Show “what you got”
For provisioning and bundle deploy, explicitly list:

- Postgres
- REST API
- auth
- storage
- functions/site/subdomain if applicable

That reinforces breadth.

#### 3) Add next-best-action CTAs
Examples:

After `provision_postgres_project`:
- `setup_rls`
- `deploy_function`
- `deploy_site`

After `deploy_site`:
- `claim_subdomain`
- `deploy_function`

After `fork_app`:
- `deploy_site` / `deploy_function` to customize
- `publish_app` when ready to share

#### 4) Upgrade payment-required responses
Your payment responses are too mechanical.

Instead of just raw JSON + “retry”, include:

- what the user is paying for
- cost breakdown if available
- what they get in return
- next actions:
  - `check_balance`
  - `get_quote`
  - billing link
  - allowance explainer link

Example structure:

```md
## Payment required

This action uses Run402’s x402 micropayment flow.

### What you’re paying for
- Prototype backend: $0.10
- Static site deploy: $0.05
- Subdomain: free

### What you’ll get
- live Postgres backend
- REST API + auth + storage
- public site URL

### Next steps
- Check balance: `check_balance`
- View pricing: `get_quote`
- Fund allowance: https://run402.com/billing?utm_source=run402-mcp
- Learn allowance model: https://run402.com/agent-allowance?utm_source=run402-mcp
```

#### 5) Turn common errors into onboarding
Example: if a project is missing locally, don’t just error.

Say:
- Building a new app? `bundle_deploy`
- Need backend only? `provision_postgres_project`
- Need to find existing projects? `list_projects`

That’s not fluff. That’s conversion-preserving recovery UX.

---

### P2 — Use `fork_app` / `publish_app` as growth loops
This is a marketing engine hiding in plain sight.

#### Action
After `publish_app`, return:

- gallery URL
- version
- copy-paste prompt:
  - “Fork this Run402 app and customize it…”

After `browse_apps`, make `fork_app` the obvious CTA.

After `fork_app`, suggest publishing again once customized.

You already have an app marketplace. The MCP should actively feed it.

---

### P2 — Instrument this like a funnel
If MCP is the primary GTM surface, you need marketing metrics for it.

#### Track
- install → first tool call
- first tool call → first paid tool
- payment-required → successful retry
- first project → first live URL
- first live URL → second feature adoption
- publish → forks

Best north-star metric:

> **Time to first live URL**

Also put UTM params on links from MCP responses so your site analytics can attribute MCP-driven conversions.

---

## Small but high-leverage copy changes

### README
Your README should open more like:

> **run402-mcp — full-stack infrastructure for AI agents**  
> From agent-written code to a live app on the internet.  
> Provision Postgres, REST API, auth, storage, serverless functions, static sites, and subdomains via MCP. Pay with x402 USDC. No signups or dashboards.

Then add:

```md
## Start here

Most users should start with one of these:

- `bundle_deploy` — full app in one call
- `fork_app` — start from a template
- `provision_postgres_project` — backend only
- `get_quote` — pricing and limits
```

### SKILL.md
Change the frame from **“Postgres for AI Agents”** to **“Full-stack infra for AI agents.”**

And fix the stale “10 tools” line immediately.

---

## One guardrail: don’t over-market low-level tools
I would **not** add salesy footers to:

- `run_sql`
- `rest_query`
- `get_schema`
- file CRUD
- logs

That will pollute context and annoy both models and users.

Instead, concentrate the marketing on:

- install / README / SKILL
- hero tool descriptions
- payment-required responses
- deploy / provision / fork / publish success
- recovery errors

That’s where the conversion value is.

---

## If I were prioritizing the next sprint

### Do these 3 first
1. **Fix docs drift** and unify messaging across README, SKILL, package description, and tool catalog.
2. **Make `bundle_deploy`/`fork_app` the obvious start path** in MCP and on run402.com prompts.
3. **Rewrite milestone/payment/error responses** to emphasize live URLs, what the user got, and next steps.

If you want, I can also draft:
- a rewritten `README.md`
- a rewritten `SKILL.md` intro + tool matrix
- replacement description strings for all 32 tools
- response copy templates for success / payment / error states

---
**Wall time**: 16m 53s
**Tokens**: 5,017 input, 39,556 output (37,046 reasoning), 44,573 total
**Estimated cost**: $7.2706
