# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-06T22:10:18.843673
**Completed**: 2026-03-06T22:35:31.397751
**Status**: completed

---

Short version: **yes, add `git push`**, but **don’t replace your API deploy model with git as the only primitive**. The winning move is:

- **Git as the primary DX**
- **API as the control plane underneath**
- **x402 on create/renew/upgrade**, not per push
- **one repo = one deployable app/project** at first
- **the moat = forkable, prepaid full-stack apps**, not generic git hosting

If you do only “upload code via git instead of POST,” the upside is modest. If you do **git + forkability + wallet identity + budget-capped infra**, it gets very interesting.

---

## My recommendation

### Product thesis
The compelling version is **not** “we host git repos.”

It’s:

> **An agent can clone a public app, pay $0.10 or $5, push once, and get its own live copy with backend, functions, site, auth, storage, and hard cost caps — no account, no OAuth, no dashboard.**

That’s meaningfully different from GitHub/Vercel/Netlify.

---

# 1) Git-push-to-deploy vs current API deploy

## Best framing
Treat this as:

- **Current API deploy = low-level primitive**
- **Git push = high-level interface on top**

Not a hard pivot away from API.

## Pros of git-push-to-deploy

| Dimension | Git push wins because… |
|---|---|
| Agent familiarity | Agents already understand repo workflows, commits, clone/fork/push. |
| Multi-file apps | Much more natural for sites and multi-function codebases than POSTing blobs. |
| Forkability | `git clone` + modify + push to a new remote is a huge composability unlock. |
| Provenance | Commit SHA becomes the source of truth for “what is live.” |
| Rollback | Rollback to prior commit is conceptually obvious. |
| Incremental updates | Git transport is efficient for repeated edits vs re-uploading full payloads. |
| Public templates/network effects | Public repos can become reusable starting points for other agents. |
| Machine continuity | Agents can resume work from git state much better than from opaque deployment records. |

## Cons of git-push-to-deploy

| Dimension | Git push loses because… |
|---|---|
| Infra complexity | A git server is materially more complex than HTTP file upload endpoints. |
| Wallet auth | Stock git does not natively know how to authenticate with an EVM wallet. |
| x402 fit | x402 is naturally HTTP control-plane; raw git transport is a clumsy place for payments. |
| Ops burden | Repo storage, GC, quotas, packfiles, backups, export, abuse handling all appear. |
| Scope creep | Public repos tempt you into README rendering, search, browse UI, issues, PRs, etc. |
| Legal/moderation | Public code hosting creates DMCA/abuse expectations. |
| Mixed source-of-truth risk | If API deploy and git deploy both mutate the same target, drift gets ugly fast. |

## Key strategic point
**Git alone is not enough reason to do this.**  
The reason to do it is:

1. **forkable code**, and
2. **code tightly coupled to prepaid infra**

If you only want nicer upload DX, a thinner “git remote helper over your existing API” may be enough.

---

# 2) What I would actually build

## Recommended resource model

### Keep these concepts separate
- **Project** = billing/runtime boundary
- **Repo** = source code boundary
- **Deployment** = immutable output of a commit

### Initial simplification
Make it **1 repo ↔ 1 project** initially.

That avoids:
- source ambiguity
- cross-project deploy complexity
- weird billing questions
- multi-repo ACL complexity

Later, you can add monorepos or multiple repos per project if needed.

## Add a manifest
Use a tiny repo manifest, e.g. `run402.yaml`:

```yaml
version: 1
kind: app # site | functions | app
tier: hobby
visibility: private

deploy:
  branch: main

site:
  root: site

functions:
  dir: functions

database:
  migrations: db/migrations
  applyOnPush: false

secrets:
  required:
    - OPENAI_API_KEY
```

### Why this matters
Agents need **one obvious convention**.  
Do not support ten styles.

A good initial repo shape:

```text
/site/*
/functions/*.ts
/db/migrations/*.sql
/run402.yaml
/CLAUDE.md
```

### Important: don’t auto-run destructive DB changes by default
I would **not** apply migrations automatically on push in v1.  
Let push deploy code; keep DB mutation explicit.

---

# 3) How this maps to x402 payments

## Strong recommendation
### **Do not charge per push**
Charge on:

1. **repo/project creation**
2. **renewal**
3. **upgrade**
4. optional **top-ups**
5. optional future **fork/template fees**

### Why not per push?
Per-push billing is a bad fit because:

- git pushes are frequent and low-value
- git clients retry
- auth/payment during git pack transfer is brittle
- it punishes iteration
- users won’t know whether a tiny push costs money

## Best payment model

### A. First push can trigger payment
User-facing UX can still feel like “push to deploy”:

```bash
git remote add run402 run402://new/hobby/private/myapp
git push run402 main
```

Under the hood:

1. helper sees repo doesn’t exist
2. helper calls `POST /v1/git/repos`
3. x402 challenge settles
4. repo/project is created
5. helper gets a short-lived session token
6. actual git push happens
7. deployment runs

So: **first push pays**, but technically payment is for **creation**, not “the push itself.”

### B. Renewals
If the lease is expired:

- push should fail cleanly
- helper can optionally auto-renew via x402/Stripe if policy allows
- then retry the push

### C. Runtime usage
Keep your existing model:

- REST/API/auth/function invocations consume quota
- static site traffic should probably also consume quota
- storage consumes storage quota

## One change I’d strongly consider
Your public copy should move from **“API calls”** to **“requests.”**

Because once sites are first-class, a static file hit is not an “API call.”

Internally you can keep `apiCalls`; externally I’d sell:
- **requests**
- **storage**
- **functions**
- **duration**

## Optional future x402-native upside
This model gives you a very natural future feature:

### **paid forks / premium templates**
A public repo could declare a `forkFee`.

Then x402 isn’t only paying run402 for infra — it can also pay creators for reusable apps/templates.

That’s actually a very strong “GitHub for agents” differentiator.

---

# 4) Tier mapping

## Don’t copy GitHub’s plan model too literally
GitHub plans are **user/org plans**.  
Your current tiers are **project leases**.

That’s a feature, not a bug.

## Recommended mapping

### Prototype
Closest thing to “free,” but with anti-abuse pricing.

- 7-day lease
- good for prototypes, previews, forks, experiments
- tiny price prevents spam
- ideal for “fork this public app and try it”

### Hobby
Personal persistent app/project.

- private or public repo
- durable deploy target
- enough limits for real small apps

### Team
Really a **capacity/production** tier, not a collaboration tier.

If you truly keep “no collaboration,” I’d consider eventually renaming this externally to something like **Scale** or **Production**.  
“Team” implies seats/orgs/collaborators.

## Practical tier mapping to current config
Use current limits largely as-is:

- **storageMb** = total app storage, and can include repo/artifact bytes
- **apiCalls** → market as **requests**
- **maxFunctions** = max files under `/functions`
- timeout/memory stay as current Lambda tier limits

## Repo-specific limits I’d add
Even if you reuse current pricing, add explicit git-side guardrails:

- max repo size
- max blob size
- no Git LFS in v1
- no submodules in v1
- maybe only deploy `main` in v1

This keeps abuse under control.

## Stripe subscriptions
Be careful here.

If Stripe “Hobby” or “Team” means “skip settlement forever,” then with git repos you risk accidental **unlimited repo creation** semantics.

I’d define subscriptions as:

- a wallet-level **pass** or **auto-renew convenience**
- possibly with a bounded number of active projects/repositories

Not “one $5 subscription gives unlimited Hobby repos.”

---

# 5) Wallet auth for git

## Reality check
“No auth” is good product language.  
But technically you still need **transport auth**.

The right meaning is:

> **No accounts, no SSH keys, no API keys, no OAuth. Wallet proof mints short-lived git access.**

## I would not try to make raw stock git do wallet auth by itself
Use a small helper.

### Best option: a custom remote helper
Something like:

```bash
npx @run402/git install
git remote add run402 run402://new/hobby/private/myapp
git push run402 main
```

Why remote helper > credential helper:

- can do create-on-first-push
- can handle x402 flows cleanly
- can mint scoped session tokens
- can hide payment/auth complexity from git

## Auth flow
1. local helper gets nonce/challenge
2. wallet signs EIP-712 / SIWE-style message
3. server verifies signature
4. server mints short-lived scoped token:
   - repo
   - operation (`pull` / `push`)
   - expiry
5. helper uses token for smart HTTP git operation

### Important
Support:
- EOAs
- **ERC-1271 smart wallets**

If wallet = identity, smart-wallet support matters quickly.

## Public/private
- **public repo**: anonymous clone/fetch
- **private repo**: helper-required clone/push
- **write access**: owner wallet only in v1

No collaboration means ACLs stay very simple.

---

# 6) AWS architecture: what changes

## What stays the same
A lot of your current infra can stay:

- **Aurora** for project metadata/runtime state
- **Lambda** for functions
- **S3 + CloudFront** for static sites
- **existing deploy code paths** for functions/sites
- **gateway/x402 middleware** for create/renew APIs
- **subdomain system** for stable aliases

That’s good news.

## What’s new

### 1. A dedicated git ingress service
Do **not** put git pack upload traffic onto the existing gateway monolith if you can avoid it.

Use:
- `git.run402.com`
- separate ECS service / target group
- independent autoscaling

Git push/clone can be CPU and network spiky.

### 2. Repo storage
For MVP, the pragmatic choice is:

- **EFS** mounted into git service tasks

Why:
- simplest way to back standard bare repos
- works with git smart HTTP
- easy hooks
- works with Fargate

Longer-term, EFS may not be the final answer if repo count and clone volume explode, but it’s the fastest sane MVP.

### 3. Repo metadata tables
In Aurora, add tables like:

- `repos`
- `repo_sessions`
- `repo_deployments`
- `repo_forks` (optional)
- `repo_aliases` / `repo_visibility`

Also store:
- owner wallet
- linked project id
- deployment mode
- current live commit
- size/quota info

### 4. Deploy event pipeline
On successful push:

- git service emits push event to **SQS/EventBridge**
- a deploy worker processes the commit
- deploy worker calls existing deployment services

For v1, because your deploy model is simple, this worker could even be:
- a small ECS service, or
- a Lambda with EFS access

### 5. Backup/export
Hosted git creates stronger trust expectations.

You should add:
- periodic `git bundle` backup to S3
- self-serve export
- read-only grace period on expiry

Your existing TODO for export becomes much more important.

---

## A subtle but important architecture point
Your current pod/cell design is for backend/runtime multitenancy.  
**Git hosting should probably become a global control-plane service**, not something replicated independently inside each pod.

Suggested shape:

- **global git control plane**
- repos live in global repo store
- repo metadata maps to `project_id` + `pod_id`
- deploy jobs route to the owning pod

That will matter once you have multiple pods.

---

## One very important constraint from your current infra
Your current VPC has **no NAT gateway**.

That means:  
**Do not introduce arbitrary server-side frontend builds in ECS/Fargate v1** unless you also introduce new egress design.

So I would strongly recommend:

### v1 deploy scope
- static files only for sites
- Node functions bundled from repo source
- maybe allow relative imports
- no `npm install`
- no arbitrary `npm run build` on server

That keeps the architecture aligned with your current NATless setup and with your current “code-only deploy” function path.

---

# 7) The right v1 scope

## I would launch with these constraints
- HTTPS git only
- no SSH
- one repo ↔ one project
- `main` branch deploys prod
- static site from `/site`
- functions from `/functions`
- no arbitrary build step
- no Git LFS
- no submodules
- owner-only pushes
- public clone or private clone
- API/MCP still used for secrets, SQL, domains, renewals

## Keep API deploy alive
Two reasons:

1. some agents will still prefer HTTP/MCP tools
2. it remains your lowest-level primitive

### But:
Add a `deployment_mode = api | git`
and **don’t let both silently mutate the same code target**.

Otherwise reproducibility dies.

---

# 8) Public/private repos and licensing

## Visibility is not licensing
Also, **repo visibility is not runtime visibility**.

A private repo can still deploy a public website.  
A public repo can still deploy a backend requiring keys.

Keep those concepts separate.

## Don’t invent a new license on day one
My advice: **don’t block launch on an agent-specific license.**

Use:
- normal SPDX licenses for legal baseline
- plus a machine-readable policy file, e.g. `run402.policy.json`

Example ideas:
- fork allowed?
- commercial use?
- attribution?
- training allowed?
- paid fork fee?

For agents, machine-readable policy is more useful than novel legal text.

Also: for agent-native repos, **`CLAUDE.md` / `AGENTS.md` matters a lot**.  
Frankly, for your audience, that may matter more than a README.

---

# 9) What makes this irresistible to agents?

## The killer feature is not “git hosting”
The killer feature is:

> **Forkable full-stack capsules with prepaid budgets.**

Meaning:
- clone a repo
- it has `run402.yaml`
- it has site + functions + maybe DB migrations
- first push creates your own backend
- hard cap enforced
- live URL comes back immediately

That is something GitHub + Vercel + Supabase does **not** give an agent without human signup.

## Features that will matter most

### 1. First push creates everything
No separate cloud console. No OAuth. No browser.

### 2. Machine-readable push output
After push, print stable parseable lines:

```text
remote: RUN402_PROJECT_ID=prj_123
remote: RUN402_DEPLOYMENT_ID=dpl_456
remote: RUN402_SITE_URL=https://myapp.sites.run402.com
remote: RUN402_API_URL=https://api.run402.com/...
```

Agents will actually use this.

### 3. Great templates
You need public starter repos:
- todo app
- Stripe webhook app
- auth starter
- CRUD SaaS starter
- RAG starter
- workflow app

This matters more than repo browsing UI.

### 4. `CLAUDE.md` / `AGENTS.md` first-class
Public repos should be optimized for machine continuation.

### 5. Hard budget caps
This is still your biggest wedge.
“Deploy safely without surprise bills” is a real agent-native differentiator.

### 6. Fast deploys
If push-to-live is fast, agents will prefer you over “push to GitHub and wait for another system to notice.”

---

# 10) A phased rollout I’d recommend

## Phase 0: validate DX without full hosted git
Fastest path:
- build a `git-remote-run402`
- helper packages current repo state
- calls existing deploy APIs underneath

Pros:
- very fast to ship
- validates whether agents want git push
- almost no new infra

Cons:
- no hosted clone/fork
- no public repo network effects

## Phase 1: minimal hosted git
Add:
- `git.run402.com`
- bare repos on EFS
- public/private clone
- owner-only pushes
- post-push deploys into existing Lambda/S3 paths

This is the real “GitHub without the Hub” MVP.

## Phase 2: forkable app network
Add:
- fork metadata
- public repo discovery
- template quality signals
- optional paid forks via x402
- preview deployments
- delegated/team wallets later

---

# 11) What I would explicitly avoid

- **Don’t charge per push**
- **Don’t build arbitrary server-side buildpacks in v1**
- **Don’t let API deploy and git deploy both be source-of-truth**
- **Don’t launch with orgs/collaboration/PRs/issues**
- **Don’t build a full GitHub UI**
- **Don’t invent a custom license before you need it**
- **Don’t burn a Postgres schema for every code-only site forever** if site-only repos become common

That last point matters: if static-only repos become a big thing, you’ll probably eventually want a `project_kind` or a lighter-weight lease class so every repo doesn’t consume Aurora/project resources unnecessarily.

---

# Bottom line

## I would greenlight this if your goal is:
- become the default **agent deploy target**
- unlock **forkable agent-built apps**
- make x402 feel like native infrastructure procurement

## I would **not** frame it as:
- “we’re becoming a generic git host”

The strongest version is:

- **wallet-owned**
- **first push provisions + deploys**
- **repo is an app capsule**
- **public repos are forkable by agents**
- **budgets are prepaid and capped**

If you want, I can next turn this into a concrete **v1 product spec** with:
1. repo URL format  
2. auth handshake  
3. `run402.yaml` schema  
4. deploy semantics for site/functions  
5. Aurora table additions  
6. AWS service diagram  
7. a phased implementation plan for your team.

---
**Tokens**: 3,980 input, 48,622 output, 52,602 total
