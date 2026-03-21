# Google Ads Strategy v2

**Based on**: gpt-5.4-pro consultation (2026-03-10)
**Amended by**: Tal + Claude, 2026-03-10
**Changes**: Elevated Agent Allowance to core cross-cutting message; added OpenClaw movement as major campaign angle.

---

## What changed from v1

The original consultation treated Agent Allowance as a low-volume niche (campaign F, "small exact-match experiments") and didn't mention OpenClaw at all. Both of these are wrong.

**Agent Allowance** is not a feature — it is the product thesis. "Give your agent an allowance, not a wallet" is the single most differentiating thing Run402 says. The pain it addresses — "I'm scared to give my AI agent spending power" — is massive and growing. The consultant was right that nobody searches "ai agent allowance" yet, but wrong to conclude it should be a small experiment. The right move is to make it a **cross-cutting message** that appears in every campaign, not a standalone campaign competing for budget.

**OpenClaw** is the movement that makes agent-native infra a real category. It's already driving adoption in China with an installer/services economy. Agents discover tools through OpenClaw/ClawHub, not through Google. But the *humans* who configure those agents — the developers, the installers, the power users — do search Google. A campaign targeting "OpenClaw deploy," "OpenClaw backend," and "OpenClaw hosting" captures demand at the exact moment someone is trying to make their OpenClaw agent do something real.

---

## 1) Core message hierarchy (revised)

Lead with these, in this order:

1. **Give your agent an allowance, not a wallet** — the trust/safety hook
2. **Let your AI agent deploy a real app** — the capability hook
3. **No AWS account / no dashboard / no Git repo** — the pain hook
4. **Postgres + REST API + auth + storage + static hosting** — the "what's included" hook
5. **Hard-capped prepaid pricing from $0.10** — the pricing hook
6. **Works with Claude Code, Cursor, ChatGPT, OpenClaw** — the compatibility hook
7. **x402 / USDC** only when the query is already crypto/protocol-aware

The allowance message works at every stage of the funnel because it answers the question every person asks before letting an agent spend money: "What's the worst that can happen?"

Answer: the allowance amount. That's it.

---

## 2) Campaign structure (revised)

### A. Brand campaign
_Unchanged from v1._ Cheap, obvious, necessary.

**Keywords**
- [run402]
- [run 402]
- [run402 pricing]
- [run402 x402]
- [run402 allowance]
- [run402 openclaw]
- [agentdb] if residual demand exists

**Landing pages**
- `/`
- `/humans/`
- pricing / FAQ / docs as sitelinks

---

### B. Problem-intent campaign: "my agent can't deploy this"
_Mostly unchanged from v1._ Still the best non-brand Google angle.

**Keywords**
- [deploy app without aws account]
- "deploy app without cloud account"
- [host app without aws]
- "backend without signup"
- "deploy web app without dashboard"
- "cloud hosting without account"
- "no credit card backend" (test carefully)
- **NEW:** "ai agent cloud spending" / "control ai agent spending" / "limit ai agent costs"

**Landing page**
- `/use-cases/deploy-app-without-aws-account/`

**Allowance angle in RSAs:**
Every RSA in this campaign should include at least one allowance-themed headline:
- "Hard-Capped Agent Budget"
- "No Surprise Cloud Bills"
- "Worst Case = Your Allowance"

---

### C. Competitor alternative campaigns
_Unchanged from v1._ Good structure already exists.

#### 1) BaaS / backend alternatives
**Keywords:** [supabase alternative], "supabase alternative for ai agents", [firebase alternative], [appwrite alternative], [neon alternative], [railway alternative]

**Landing pages:** existing + new per v1 recommendations.

**Allowance angle:** The comparison table on each page should include a "Spend control" row showing: Competitor = "credit card on file, pay-as-you-go, no agent budget cap" vs Run402 = "prepaid allowance, hard cap, worst case = balance."

#### 2) Frontend / deploy alternatives
**Keywords:** [vercel alternative], "deploy without vercel", "deploy full stack app via api", "gitless deployment"

**Landing page:** `/use-cases/vercel-alternative-for-agents/`

---

### D. Tool-specific campaigns: Claude Code / Cursor / ChatGPT / OpenClaw
_Expanded from v1 to include OpenClaw._

**Create these pages**
- `/use-cases/claude-code-deploy-app/`
- `/use-cases/cursor-deploy-full-stack-app/`
- `/use-cases/chatgpt-deploy-webapp/`
- `/use-cases/openclaw-deploy-app/`
- maybe `/use-cases/backend-for-ai-coding-agents/`

**Keywords**
- [claude code deploy app]
- [claude code backend]
- [cursor deploy app]
- [cursor backend hosting]
- [chatgpt deploy web app]
- [ai coding agent hosting]
- [backend for ai agents]
- **NEW:** [openclaw deploy app]
- **NEW:** [openclaw backend]
- **NEW:** [openclaw database]
- **NEW:** [openclaw hosting]

**Why**
This is where the ICP lives. People search around the tools they use. OpenClaw is becoming one of those tools — especially in Asia, where the installer economy is already real.

---

### E. Prototype / temporary Postgres campaign
_Unchanged from v1._ Keep on a short leash. Emphasize prototype, 7-day lease, testnet, upgrade path.

---

### F. Agent Allowance / spend-control campaign (ELEVATED)

This is no longer a "small experiment." It is a **standalone campaign with real budget** because it captures a pain point that is growing fast: the fear of giving AI agents spending power.

**Keywords — cost/trust intent (high potential)**
- "ai agent spending limit"
- "control ai agent costs"
- "ai agent budget"
- "limit ai spending"
- "ai agent cost control"
- "safe ai agent spending"
- "ai agent prepaid"
- "no surprise ai bills"
- "ai agent cloud budget"
- "cap ai agent spending"

**Keywords — allowance-specific (low volume now, own the category)**
- [ai agent allowance]
- [agent allowance]
- [agent spend control]
- [prepaid budget for ai agent]
- [give ai agent budget]

**Keywords — wallet/delegation concern (people searching for solutions)**
- "should i give ai agent credit card"
- "ai agent wallet risks"
- "ai agent payment"
- "delegate spending to ai"
- "ai agent procurement"

**Landing page**
- `/agent-allowance/`

**Why this is bigger than v1 assumed:**
The consultant said "the category barely exists." That's true for the *term* "agent allowance" — but the *pain* is everywhere. As more people use Claude Code, Cursor, and ChatGPT to build real things, the question "how do I let my agent spend money safely?" becomes urgent. Run402 has the best answer: a prepaid, hard-capped, revocable allowance. Owning this category early — even at low volume — means owning the answer when volume arrives.

**Cross-campaign role:**
Beyond its own campaign, the allowance message should appear in every other campaign as secondary headlines and descriptions. It is the trust layer that makes "let your agent deploy an app" feel safe instead of scary.

---

### G. OpenClaw movement campaign (NEW)

This campaign targets the growing OpenClaw ecosystem — developers, installers, and power users who are making agents do real work through skills and tools.

**Keywords**
- [openclaw]
- [openclaw skills]
- [openclaw tools]
- [openclaw deploy]
- [openclaw backend]
- [openclaw database]
- [openclaw postgres]
- [clawhub]
- [clawhub skills]
- "openclaw mcp server"
- "openclaw full stack"
- "openclaw app hosting"
- "build with openclaw"

**Landing page**
- `/openclaw/` (NEW — needs to be built)
- should show: how Run402 works as an OpenClaw skill, `npx @run402/mcp`, one-call deploy, template marketplace, allowance model

**Why this matters:**
OpenClaw is the movement that normalizes agents buying and operating infrastructure. It's not just a tool — it's a distribution channel and a community. Being the reference infrastructure skill in OpenClaw/ClawHub means:

1. **Agents find you without Google** — but the humans configuring those agents search Google for "openclaw deploy" and "openclaw backend"
2. **Installers adopt you** — the Chinese installer economy charges 395-695 RMB per setup; they need a repeatable deploy target
3. **Template creators publish on you** — your marketplace + fork model is exactly what OpenClaw template creators want
4. **You own the category** — "the cloud that OpenClaw agents call" is a position nobody else is claiming

**RSA angle:**
- Headlines: "OpenClaw Deploys Real Apps" / "Full Backend for OpenClaw" / "One Skill, Full Stack" / "Database + Auth + Hosting"
- Descriptions: "Install the Run402 skill and let OpenClaw deploy Postgres, API, auth, storage, and hosting in one call. Hard-capped allowance pricing."

**Important:** This campaign should also run in Chinese (via Google Ads targeting Chinese-language searches) once the `/zh-cn/openclaw` page exists, per the China market strategy.

---

### H. Tiny protocol/dev campaign: x402 / machine payments
_Unchanged from v1._ Very small volume, highly qualified.

---

## 3) Budget allocation (revised)

If starting from scratch:

- **25%** problem-intent ("without AWS/account/dashboard")
- **20%** competitor alternatives
- **20%** tool-specific (Claude/Cursor/OpenClaw)
- **15%** agent allowance / spend control
- **10%** OpenClaw movement
- **5%** brand
- **5%** prototype / x402 / retargeting

If budget is tight, start with 5 campaigns:

1. Brand
2. Deploy without AWS account
3. Supabase alternative for agents
4. Agent Allowance / spend control
5. OpenClaw deploy

Then add Vercel alternative and Claude/Cursor pages next.

**Why the shift from v1:**
v1 allocated 5% to "prototype / allowance / x402 experiments" combined. That undervalued the two most differentiating angles. The allowance message and the OpenClaw movement are what make Run402 different from "another Supabase alternative." They deserve real budget.

---

## 4) What the ads should say (revised)

### RSA angle #1: problem-intent (updated with allowance)
**Headlines**
- Deploy Apps Without AWS
- Give Your Agent a Budget
- Hard-Capped, No Surprise Bills
- Postgres + Auth + Hosting
- No Dashboard Required
- Works With Claude Code
- $0.10 Prototype Deploy

**Descriptions**
- Your AI agent deploys backend + frontend in one flow. Set a prepaid allowance — worst case is the balance.
- Skip IAM, RDS, S3, and cloud setup. Fund a $10 allowance and let your agent build.

---

### RSA angle #2: tool-specific (updated with OpenClaw)
**Headlines**
- Backend for AI Agents
- Works With Claude Code
- OpenClaw Deploys Full Apps
- Cursor Can Ship Full Apps
- No Git Repo Needed
- Auth, Storage, Hosting
- Prepaid Agent Budget

**Descriptions**
- Give your coding agent a real backend: Postgres, API, auth, storage, and hosting. Hard-capped allowance.
- Install as an OpenClaw skill or MCP server. One call, one payment, live app.

---

### RSA angle #3: allowance-first (NEW — lead message)
**Headlines**
- Allowance, Not a Wallet
- Cap Your Agent's Spending
- Worst Case = Your Balance
- Prepaid Agent Infrastructure
- No Surprise Cloud Bills
- Fund by Card or USDC
- Safe Spend for AI Agents
- $10 Funds 100 Prototypes

**Descriptions**
- Give your AI agent a prepaid allowance. Set a hard cap, let it buy infrastructure. Revoke anytime.
- The agent buys Postgres, auth, storage, and hosting within your budget. Every purchase logged.

---

### RSA angle #4: OpenClaw (NEW)
**Headlines**
- OpenClaw Ships Real Apps
- Full Backend via OpenClaw
- One Skill, Full Stack
- Database + Auth + Hosting
- Budget-Capped Agent Infra
- Fork Any App in One Call

**Descriptions**
- Install Run402 as an OpenClaw skill. Your agent deploys Postgres, REST API, auth, storage, and hosting.
- One-call deploy, hard-capped allowance, forkable app marketplace. The cloud OpenClaw agents call.

---

## 5) Ad extensions (revised)

### Sitelinks
- **Agent Allowance** (promoted to first position)
- **OpenClaw Skill** (NEW)
- **Supabase Alternative**
- **Vercel Alternative**
- **Deploy Without AWS**
- **Fork Apps**
- **Pricing**

### Callouts
- Prepaid Allowance
- Hard-Capped Budgets
- No Surprise Bills
- OpenClaw Compatible
- Works With Claude Code
- No Signup
- Start on Testnet

### Structured snippets
**Features:**
Postgres 16, REST API, Auth, Storage, Functions, Static Hosting, OpenClaw Skill, MCP Server

### Price extensions
- Prototype — **$0.10 / 7 days**
- Hobby — **$5 / 30 days**
- Team — **$20 / 30 days**

---

## 6) Landing page changes (revised)

### From v1 (still valid):
- Don't make "paste llms.txt" the only CTA for cold traffic
- Add: Copy starter prompt, See the 2 API calls, Start a $0.10 prototype, Start free on testnet
- On-page must-haves: H1, pricing, supported tools, CTA, code snippet above fold

### New priorities:

#### 1) Make "Fund a $10 allowance" the primary CTA across all paid landing pages
Not "paste llms.txt" (too technical for cold traffic) and not just "$0.10 prototype" (too small to optimize Google Ads around). The allowance CTA:
- feels safe ("it's prepaid, I control it")
- has enough value to justify a Google click cost
- leads to repeat behavior (top up, renew, fund more)

#### 2) Build `/openclaw/` landing page
Must include:
- H1: "The cloud OpenClaw agents call"
- What Run402 does in one sentence
- `npx @run402/mcp` install command
- The 5 tools your skill exposes
- Template marketplace / fork model
- Allowance pricing
- "Install the skill" CTA
- Chinese language toggle or link to `/zh-cn/openclaw`

#### 3) Add "Spend control" row to every comparison table
On every competitor alternative page, add a row comparing spend control:

| | Supabase | Run402 |
|---|---|---|
| **Agent spend control** | None — credit card on file, usage-based billing, no agent budget cap | Prepaid allowance, hard cap, revocable, worst case = balance |

This row does more to differentiate Run402 than any feature comparison.

#### 4) Build tool-specific pages (from v1)
- `/use-cases/claude-code-deploy-app/`
- `/use-cases/cursor-deploy-full-stack-app/`
- `/use-cases/openclaw-deploy-app/`

---

## 7) Tracking
_Unchanged from v1._ The GCLID capture + offline conversion import is critical. Track funded allowances as the primary conversion, not just prototype provisions.

**One addition:** Track OpenClaw skill installs (`npx @run402/mcp`) as a conversion event. If someone lands on `/openclaw/`, copies the install command, and later provisions a project through the MCP server, that's the highest-intent conversion path possible.

---

## 8) Bidding / targeting settings
_Mostly unchanged from v1._

**One addition for OpenClaw campaign:** Consider targeting beyond US-only from the start. The OpenClaw movement is strong in China/Asia. If you have Chinese landing pages ready, run the OpenClaw campaign with broader geo targeting (US + HK + Singapore + UK + Germany + Australia as a start).

---

## 9) Negative keywords (revised)

### From v1 (still valid):
- Core negatives (jobs, salary, course, tutorial, etc.)
- "Agent" negatives (travel, insurance, real estate, etc.)
- "Allowance" negatives (kids, child, tax, meal, rental)
- Crypto negatives for mainstream campaigns

### New negatives for OpenClaw campaign:
- openclaw download
- openclaw install tutorial
- openclaw free
- openclaw open source
- openclaw vs [other AI frameworks]
- openclaw course
- openclaw certification

### New negatives for allowance campaign:
- pocket money
- weekly allowance kids
- chore chart
- allowance app for kids
- family budget
- per diem

---

## 10) What I would NOT do
_Unchanged from v1, plus:_

- **Don't** treat Agent Allowance as a small experiment — it's the core trust message
- **Don't** ignore OpenClaw — it's both a distribution channel and a search intent source
- **Don't** limit OpenClaw campaigns to English — the movement is multilingual
- **Don't** wait for "ai agent allowance" search volume to grow before investing — own the category now

---

## 11) Launch timeline (revised)

### Week 1
- Set up GCLID capture + offline conversion import
- Add "Fund a $10 allowance" CTA to all landing pages
- Add "Spend control" comparison row to existing alternative pages
- Build `/openclaw/` landing page
- Build `/use-cases/claude-code-deploy-app/`

### Week 2
Launch:
1. Brand
2. Deploy without AWS account
3. Agent Allowance / spend control
4. Supabase alternative for agents

### Week 3
- Review search terms, add negatives
- Launch OpenClaw movement campaign
- Launch Vercel alternative campaign
- Split out winners into tighter ad groups
- Test "Fund a $10 allowance" vs "$0.10 prototype" vs "Start on testnet"

### Week 4
- Add tool-specific campaigns (Claude Code, Cursor)
- Add retargeting (allowance-themed retargeting ads)
- Test x402/protocol campaign
- Launch OpenClaw campaign in Chinese (if `/zh-cn/openclaw` is ready)
- Add Firebase/Appwrite/Render comparison pages based on query data

---

## Summary: what changed

| Area | v1 | v2 |
|---|---|---|
| **Agent Allowance** | Campaign F, 5% budget, "small experiments" | Cross-cutting message in every campaign + standalone 15% budget |
| **OpenClaw** | Not mentioned | New campaign (10% budget) + added to tool-specific campaigns |
| **Core message** | "Deploy without AWS" | "Allowance, not a wallet" + "Deploy without AWS" |
| **Primary CTA** | "Copy starter prompt" / "Start $0.10 prototype" | "Fund a $10 allowance" |
| **Comparison tables** | Feature comparison | Feature comparison + spend control row |
| **Geo targeting** | US only | US only + broader for OpenClaw campaign |
| **Minimum viable launch** | 4 campaigns | 5 campaigns (added Allowance) |

---

## The one-sentence strategy

> **Lead with trust ("allowance, not a wallet"), capture intent around deployment pain and alternatives, and ride the OpenClaw movement as both distribution channel and search demand source.**
