# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-10T22:17:31.191276
**Completed**: 2026-03-10T22:34:24.849962
**Status**: completed
**Reviewed**: 2026-03-12 — status annotations added below

---

Short answer: **no, not yet** — but significant progress since the consultation.

Based on the source you shared, the MCP is **functionally strong** but **under-optimized as a marketing surface**. The website sells **”full-stack infrastructure for AI agents”**; the MCP still mostly reads like **”a Postgres tool with extras.”**

The biggest leak is this mismatch:

- **Site story:** prompt → live app on the internet
- **MCP story:** provision database → run SQL

If MCP is the primary integration point, then the MCP tool list is effectively your **homepage for agents**.

### Progress summary

| Area | Status |
|------|--------|
| README tool table drift | DONE — 39 tools listed, comprehensive |
| CI sync check | DONE — `sync.test.ts` with SURFACE array |
| Tool count (was 32) | Grew to 37 MCP tools (image gen, wallet, etc.) |
| SKILL.md title & tool count | NOT DONE — still “Postgres for AI Agents”, still “10 tools” |
| package.json description | NOT DONE — still DB-centric |
| Hero tool ordering | NOT DONE |
| MCP resources/prompts | NOT DONE |
| Tool description rewrites | NOT DONE (bundle_deploy partially improved) |
| Success/payment/error CTAs | NOT DONE |
| fork/publish growth loops | NOT DONE |
| Funnel instrumentation | NOT DONE |

## Highest-priority fixes

### P0 — Fix message drift immediately — PARTIALLY DONE

~~Right now your surfaces disagree:~~

- ~~`README.md` lists **5 tools**~~ → DONE: README now lists **39 tools** in a comprehensive table
- `SKILL.md` says **10 tools** → **STILL 10** — actual count is 37 MCP tools
- ~~`index.ts` exposes **32 tools**~~ → now **37 tools** (added image gen, wallet, CRUD helpers)

~~That is both a **trust problem** and a **discovery problem**.~~
README↔MCP drift is fixed. SKILL.md↔MCP drift remains.

#### Action — PARTIALLY DONE

~~Create a **single source of truth** for tool metadata and generate from it:~~

- ~~MCP tool descriptions~~ → descriptions live in `src/index.ts`
- ~~README tool table~~ → DONE: 39-row table
- SKILL docs → **NOT DONE**: still documents only 10 tools
- llms.txt sections if possible → **NOT CHECKED**

~~Also add a CI check that fails if docs/tool counts drift.~~ → DONE: `sync.test.ts` has a `SURFACE` array (30 capabilities) checked against MCP, CLI, and OpenClaw. Runs in CI.

#### Messaging change — NOT DONE
Standardize on one top-line position everywhere:

> **Run402 is full-stack infrastructure for AI agents — Postgres, REST API, auth, storage, functions, and static hosting, paid with x402.**

~~Right now~~ These surfaces are still too DB-centric:

- ~~README title/subtitle~~ → title changed to “run402 — MCP Server, CLI & OpenClaw Skill” (better but not “full-stack infrastructure”)
- SKILL title: still “Postgres for AI Agents” — **NOT CHANGED**
- `package.json` description: still “AI-native Postgres databases with REST API, auth, storage, and row-level security” — **NOT CHANGED**, omits functions/hosting/images

---

### P0 — Make the default story “first live URL,” not “first database” — NOT DONE
Your thesis is “fastest path from agent-wrote-code to live app.”
But the MCP currently leads with low-level DB workflows.

The hero tools should be:

1. `bundle_deploy`
2. `fork_app`
3. `provision_postgres_project`
4. `get_quote`

#### Action — NOT DONE
- Put a **”Start here”** section at the top of README and SKILL. → **NOT DONE** — README has “Quick Start” which is just `npx run402-mcp`
- Mark `bundle_deploy` as **recommended for new apps**. → **NOT DONE** — description says “One-call full-stack app deployment” (good) but not positioned as the default
- Reorder tool registration so clients that preserve order show the hero path first. → **NOT DONE** — still category-ordered (database first, bundle_deploy in the middle at line 230)
- In docs, explicitly say: → **NOT DONE**
  - **New app from scratch?** `bundle_deploy`
  - **Start from template?** `fork_app`
  - **Backend only?** `provision_postgres_project`
  - **Budget first?** `get_quote`

#### Important site-side alignment — NOT CHECKED
Your `/humans` prompt currently says:

> “Please build me a demo app using run402.com/llms.txt (curl it)”

If the MCP is the primary interface, this prompt should instead say something like:

> **If the Run402 MCP is installed, use it. Otherwise curl run402.com/llms.txt. Prefer `bundle_deploy` for new apps.**

Right now your site may be teaching people to bypass your best distribution surface.

---

### P1 — Bring your best site marketing into the MCP itself — NOT DONE
Your strongest agent marketing already exists in `llms.txt`:

- demo app ideas
- “Make It Great”
- wallet / allowance guidance
- pricing framing
- use-case framing

But the MCP exposes almost none of that in-protocol.

#### Action — NOT DONE
No MCP resources or prompts are registered in `src/index.ts`. Add MCP **resources/prompts** for:

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

### P1 — Rewrite key tool descriptions for marketing *and* better tool routing — NOT DONE
For models, “marketing” means:

- clearer intent matching
- better feature discoverability
- stronger confidence in when to use a tool

Your current descriptions are clear, but they often undersell Run402.

#### Biggest misses — current state (2026-03-12)
- `provision_postgres_project`: still "Provision a new Postgres database. Returns project credentials on success, or payment details if x402 payment is needed." — **still sells only database, not backend**
- auth is marketed on the site but mostly hidden in the MCP — **UNCHANGED**
- `deploy_function`: still lists all 10 pre-bundled packages in the description — **still package-list heavy**
- `bundle_deploy`: now "One-call full-stack app deployment..." — **improved** but not positioned as the obvious default

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

### P1 — Redesign success, payment, and error messages as conversion moments — NOT DONE
This is the biggest underused marketing surface.

Right now your success outputs are functional, but they don’t fully sell the value created.

#### Good rule
- **Descriptions** are for the model
- **Milestone responses** are for the human watching the transcript

### What to change

#### 1) Lead with the public outcome — PARTIALLY DONE
`deploy_site` does say "The site is live at **${url}**". Other tools still lead with project_id/table data.

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

#### 3) Add next-best-action CTAs — NOT DONE
Only `deploy_function` suggests a next action ("Invoke with: `invoke_function(...)`"). All other tools just say "Keys saved to local key store."

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

#### 4) Upgrade payment-required responses — PARTIALLY DONE
Payment responses now use `## Payment Required` headings with structured guidance. Still mostly mechanical JSON + retry instructions, but better than raw dumps.

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

#### 5) Turn common errors into onboarding — NOT DONE
Example: if a project is missing locally, don’t just error.

Say:
- Building a new app? `bundle_deploy`
- Need backend only? `provision_postgres_project`
- Need to find existing projects? `list_projects`

That’s not fluff. That’s conversion-preserving recovery UX.

---

### P2 — Use `fork_app` / `publish_app` as growth loops — NOT DONE
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

### P2 — Instrument this like a funnel — NOT DONE
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

## Small but high-leverage copy changes — MOSTLY NOT DONE

### README — PARTIALLY DONE
~~Your README should open more like:~~

README title is now “run402 — MCP Server, CLI & OpenClaw Skill” and subtitle is “Developer tools for Run402 — provision Postgres databases, deploy static sites, serverless functions, generate images, and manage x402 wallets.” This is better than before but doesn't match the suggested framing:

> **run402-mcp — full-stack infrastructure for AI agents**
> From agent-written code to a live app on the internet.
> Provision Postgres, REST API, auth, storage, serverless functions, static sites, and subdomains via MCP. Pay with x402 USDC. No signups or dashboards.

“Start here” section still missing. Currently has “Quick Start” with just `npx run402-mcp`.

```md
## Start here

Most users should start with one of these:

- `bundle_deploy` — full app in one call
- `fork_app` — start from a template
- `provision_postgres_project` — backend only
- `get_quote` — pricing and limits
```

### SKILL.md — NOT DONE
Still says **”Postgres for AI Agents”** — needs to change to **”Full-stack infra for AI agents.”**

Still says **”10 tools available”** — actual MCP count is **37 tools**.

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

## If I were prioritizing the next sprint — UPDATED 2026-03-12

### Done
1. ~~**Fix docs drift**~~ — README tool table is comprehensive (39 tools). `sync.test.ts` CI check prevents MCP/CLI/OpenClaw drift.

### Remaining — next priorities
1. **Fix SKILL.md** — still says "Postgres for AI Agents" and "10 tools." Fastest remaining win.
2. **Unify messaging** — package.json, SKILL title, README subtitle should all say "full-stack infrastructure" not "Postgres databases."
3. **Add "Start here" section** to README and SKILL with the bundle_deploy/fork_app/provision/get_quote decision tree.
4. **Rewrite hero tool descriptions** in `src/index.ts` — provision, bundle_deploy, deploy_site, deploy_function, fork_app, get_quote.
5. **Add next-best-action CTAs** to success responses (provision → setup_rls/deploy_function; deploy_site → claim_subdomain; fork_app → publish_app).
6. **Consider MCP resources/prompts** for quickstart, pricing, demo ideas — or a `get_run402_guide(topic)` fallback tool.

### Deferred
- Tool registration reordering (hero tools first)
- fork/publish growth loop copy
- Funnel instrumentation / UTM params
- Error → onboarding recovery UX

---
**Wall time**: 16m 53s
**Tokens**: 5,017 input, 39,556 output (37,046 reasoning), 44,573 total
**Estimated cost**: $7.2706
