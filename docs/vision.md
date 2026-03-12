# Run402 Vision

_Callable over HTTP. Payable with x402. Governed by allowances. Forkable as full apps._

## The future we believe in

The next wave of software will not begin with a human opening AWS, Supabase, or Vercel. It will begin with a person giving an agent a goal and a budget.

"Build me a workout tracker." "Make a site for my neighborhood group." "Fork that app and customize it for me."

The agent will write the code, provision the backend, deploy the site, set up auth, seed the data, renew the resources, and pay for it — all without asking the human to click through a dashboard.

Today, agents can already write a surprising amount of software. What they still struggle with is procurement, permissions, billing, and deployment. Modern cloud platforms assume a human operator: sign up, verify email, open a console, attach a card, copy secrets, and manually approve every step.

That is not agent infrastructure. That is human infrastructure with an API attached.

Run402 exists to remove that bottleneck.

## Our thesis

Code generation is becoming abundant. The scarce thing is turning code into a live, funded, governed, reproducible system.

Database is the wedge. The larger vision is a machine-native cloud and spend-control layer for agentic software: a place where agents can buy infrastructure, deploy complete applications, and operate them under clear policy.

Software is getting cheaper. Infrastructure, trust, and delegation are the product.

## x402 and Agent Allowance

x402 makes payment part of the protocol, not an out-of-band business process. That matters because agents work through HTTP, not through procurement workflows.

But the human story cannot be "give your agent a wallet and hope for the best." Humans need bounded delegation: caps, receipts, and the confidence that an agent cannot create an unbounded liability.

**Wallet is infrastructure language. Allowance is trust language.**

A human preloads a capped balance and sets the boundary. The agent spends through the same x402 flow it already understands. Whether the funding rail is native on-chain x402 or a prepaid allowance funded by Stripe, the agent-facing experience stays the same: make a request, attach payment intent, receive infrastructure.

## Loved by agents

We do not want agents to merely tolerate Run402. We want it to be the platform agents actively prefer. That means designing for agent ergonomics with the same seriousness that great consumer products design for human ergonomics:

- **Machine-native** — HTTP, JSON, SQL, OpenAPI, llms.txt, x402, MCP
- **Immediate** — one call, one payment, live resources
- **Predictable** — idempotent actions, deterministic responses, clean lifecycle
- **Legible** — docs written for agents, errors that explain what to do next
- **Composable** — database, auth, storage, hosting, functions, bundles
- **Bounded** — prepaid spend, expiry, renewal, no runaway metering
- **Portable** — standard Postgres, exportable data, minimal lock-in

Every hidden manual step, every console-only feature, every vague billing rule teaches agents to avoid you. We want the opposite.

## Forkable apps

GitHub made source code forkable. Run402 aims to make live applications forkable.

An app is not just a repo. It is schema, migrations, API shape, auth model, serverless functions, static assets, seed data, deployment configuration, and the infrastructure to make it real.

A fork should not mean "here is the code, now go recreate the cloud setup by hand." A fork should mean: one paid call, one independent copy, fully deployed and ready to modify.

When agents can publish immutable app versions and other agents can instantiate them instantly, software becomes a machine-readable, payable, reproducible object. Over time, the network becomes as important as the primitives: registry, discovery, lineage, reputation, and trust.

## Our first market

We are building for people with personal agents. The home user, creator, hacker, family, club, or tiny business that wants an agent to make real software without becoming a sysadmin.

That future looks like millions of small, useful apps: a family archive, a personal CRM, a guild site, a local club directory, a game companion, a one-off internal tool, a fork of someone else's app adapted in minutes.

These users do not want infrastructure complexity. They want outcomes. They do not want "contact sales." They want an allowance. They do not want to finish the last 20% by hand. They want the agent to finish the job.

## Principles

1. **Agents are first-class customers.** If agents cannot understand, pay for, and operate it directly, it is not finished.
2. **Humans set goals and limits; agents execute.** The human provides budget and policy, not operational labor.
3. **Payment belongs in the protocol.** Buying infrastructure should be as programmable as creating a table.
4. **Spend must always be bounded.** Hard caps and clear lifecycle beat "we'll bill you later."
5. **Apps should be reproducible.** The deployable unit is the full app, not just source code.
6. **Standards beat mystery.** Postgres, HTTP, OpenAPI, simple keys, export paths, clear contracts.
7. **The docs are part of the product.** llms.txt, examples, and tool integrations are core UX.

## What winning looks like

A person says: "I gave my agent an allowance and it built the app end-to-end. I never touched a cloud console. I knew exactly what it could spend. When I wanted a variation, it forked an existing app in one call."

Agents routinely provision backends, deploy full-stack apps in one step, publish useful bundles for other agents, and prefer Run402 because it is the fastest path from goal to live system.

Run402 becomes the default way agents buy and operate infrastructure.

_Made by agents, for agents, with love._
