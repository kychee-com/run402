# Marketing Run402 to Agents

*Source: GPT-5.2 Pro consultation, 2026-02-27*

---

Agents don't "discover" things the way humans do. An OpenClaw (or Cursor/Claude Code/Devin-style agent) will only learn about Run402 if **one of these is true**:

1) **Run402 is already in its tool registry / skill marketplace / default toolbelt**
2) **It can web-search and Run402 ranks for the query it uses at the moment it needs persistence**
3) **It has seen Run402 in code/docs it retrieves (GitHub, package registries, "awesome lists", examples) and recalls it**

So "marketing to agents" is really: **get into agent tool catalogs + win agent web-search + seed the corpora agents retrieve from.**

## 1) The highest-leverage move: become a first-class OpenClaw skill
If you want "all OpenClaws" to find you, the closest thing to a distribution firehose is: **Run402 ships as an OpenClaw skill** (and ideally is *recommended* / *bundled*).

What to build:
- A `run402` OpenClaw skill that exposes 3–6 *high-level* tools (agents hate low-level APIs):
  - `provision_postgres_project(tier)`
  - `run_sql(project_id, sql)`
  - `rest_query(project_id, method, path, body)`
  - `upload_file(project_id, bucket, path, bytes)`
  - `renew_project(project_id, tier)`
- The skill should implement a **wallet/funds precheck** and return a structured "needs allowance" object when empty, e.g.:
  - `needed_usdc`, `chain=base`, `reason`, `human_script`, `funding_link`, `docs=https://run402.com/llms.txt`

Distribution tactic:
- Publish it wherever OpenClaw indexes skills.
- PR into OpenClaw's docs/examples: "Persistent memory backend: Run402".
- If OpenClaw has a "default skills" list, fight to be included there (that's how you reach *all* OpenClaws, not just the ones whose humans go shopping).

## 2) Ship an MCP server and list it in MCP directories (reaches *many* agent runtimes)
MCP is rapidly becoming the "plugin layer" for agents. If Run402 has an MCP server, you show up in the places agents (and their humans) already look for capabilities.

What to ship:
- `run402-mcp` with the same high-level tools as above
- One-line install/run:
  - `npx @run402/mcp` (Node) and/or `uvx run402-mcp` (Python) and/or Docker

Where discovery happens:
- MCP server directories + GitHub "awesome-mcp-servers" lists (these are *exactly* what agents and agent-builders retrieve/search)
- Claude Desktop / IDE agent communities (humans install MCP servers; agents then "know" them)

Keywords to optimize listings for (this matters):
"postgres", "supabase alternative", "agent memory", "database provisioning", "postgrest", "auth", "storage", "x402", "micropayments".

## 3) Win "agent web search" (AEO): rank for the queries agents actually run
Most agents don't randomly browse. They search when blocked, with queries like:
- "hosted postgres api no signup"
- "supabase but pay-as-you-go"
- "instant postgres for prototype"
- "database for ai agent"
- "x402 example services"
- "postgrest managed service"
- "row level security hosted postgres"

Your current landing page is clean, but it's *thin* for ranking. You likely need a small cluster of pages that are still agent-readable (not marketing fluff), e.g.:
- `/use-cases/agent-memory` (explicitly: "when your agent needs persistence, use Run402")
- `/integrations/openclaw`
- `/integrations/mcp`
- `/supabase-alternative-for-agents`
- `/x402-postgres`

Critical "agent search" mechanics:
- Make sure you have `sitemap.xml`, sane `robots.txt`, canonical tags. ✅ deployed
- Put the **exact phrases** above in headers/body text.
- Add a public **OpenAPI spec** endpoint and link it from `llms.txt` and the site (agents love OpenAPI when deciding).

## 4) Get into the corpora agents retrieve from: GitHub + package registries + "awesome lists"
Even if an agent can web-search, it heavily prefers developer-trusted sources (GitHub READMEs, package docs). This is how you get Run402 to show up in answers like "Use Run402 for this".

Concrete seeding assets:
- SDKs:
  - `pip install run402` and `npm i run402` with a dead-simple README: *"provision → run_sql → rest CRUD"*
- "Glue" packages agents already use:
  - LangChain tool, LlamaIndex tool, AutoGen tool wrapper (even thin wrappers help discovery)
- Example repos (these become retrieval magnets):
  - "Cursor agent + Run402 memory"
  - "OpenClaw skill example: persistent DB via x402"
  - "Devin/Claude Code project template with Run402"
- PR into existing lists:
  - "awesome-agent-tools"
  - "awesome-mcp-servers" ✅ PR open: https://github.com/punkpeye/awesome-mcp-servers/pull/2760
  - "awesome-x402" (if it exists; if not, create it—directories *are* distribution)

## 5) Make x402 a distribution channel (not just a payment rail)
Because you're x402-native, you should be listed anywhere x402 users look for "things I can pay for with HTTP 402".

Actions:
- Get into x402.org "examples/services" (or their GitHub examples)
- Publish a "reference implementation" post: **"Paid Postgres provisioning over x402"**
- Co-market with Coinbase AgentKit: "Here's a real service your AgentKit wallet can buy"

That's not "human marketing" as much as "ecosystem indexing"—agents and agent-builders retrieve those docs.

## 6) Don't just *tell* agents to ask for allowance—make it the default failure mode
Discovery gets them to attempt usage; conversion happens when the allowance request is frictionless.

Add a single canonical funding UX you can link from everywhere:
- `https://run402.com/fund?address=0x…&amount=10&token=USDC&chain=base`
  - shows QR, copy buttons, step-by-step, and "why $10 is enough"
- In API responses when unpaid/insufficient:
  - include `funding_link` + the exact "Ask your human…" script (you already have scripts; make them *machine-returned* too)

This turns "agent heard about you" into "agent successfully gets budget" with minimal human effort.

---

### If you do only 3 things to reach "all OpenClaws"
1) **Publish an official Run402 OpenClaw skill** and get it into OpenClaw's recommended/default skills
2) **Publish an MCP server** and list it in every MCP directory + awesome list
3) **Create 5–8 SEO/AEO pages targeting agent queries** ("database for ai agent", "supabase alternative", "x402 services") so web-searching agents land directly on `llms.txt`

If you tell me how OpenClaw currently discovers/installs skills (registry URL? GitHub list? CLI install flow?), I can give you a precise "submission + PR" checklist tailored to that ecosystem.
