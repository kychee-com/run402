# DreamDrop

DreamDrop is a deliberately visual full-stack demo of [Wasp](https://wasp.sh) on top of [Run402](https://run402.com). A human drops a strange product idea; Wasp sends a type-safe Action, and a Run402 function moderates the prompt, generates launch art, puts the bytes on the content-addressed CDN, and persists the artifact in Postgres. Agents can call the same function through a $0.05 x402-priced route.

Live demo: [dreamdrop-wasp.run402.com](https://dreamdrop-wasp.run402.com)

## What each stack does

| Wasp | Run402 |
| --- | --- |
| React UI and routing | Postgres and dark-by-default REST |
| Type-safe Actions and Queries | Node 22 serverless generation function |
| React Query cache and mutations | AI moderation + image generation |
| Node server boundary for secrets | Content-addressed assets, x402, and email |

## Run locally

DreamDrop starts in an interactive in-memory demo mode, so no Run402 credentials are needed for the first run. Wasp still starts its normal development PostgreSQL container; DreamDrop's Prisma schema is intentionally empty because all product data lives in Run402.

The commands below use the Wasp 0.25 CLI declared by this app. A global Wasp install is optional.

```bash
npx --yes --package @wasp.sh/wasp-cli@0.25.0 wasp start db
```

In a second terminal:

```bash
npx --yes --package @wasp.sh/wasp-cli@0.25.0 wasp start
```

Open `http://localhost:3000`. Create, remix, and email-preview flows all work in demo mode.

## Build and deploy the hosted version

The hosted build prerenders the Wasp page and points its browser data layer at the same-origin Run402 routes. This keeps local development centered on Wasp's typed Actions and Queries while allowing Run402 to host the complete public demo without a separate long-running Node server.

```bash
REACT_APP_RUN402_HOSTED=true \
REACT_APP_API_URL=https://dreamdrop-wasp.run402.com \
npm run build:hosted

run402 up --manifest run402.deploy.ts --check
run402 up --manifest run402.deploy.ts --plan
# Run next_actions[0].command exactly as printed, adding --yes --verify.
```

The warning is expected: `/agent/remix` is intentionally public and priced. The gateway settles x402 before the function runs. The owning Run402 organization must have a payout wallet and enough organization balance for the $0.03 image-generation call. On-chain testnet USDC and organization balance are separate balances.

Create a mailbox and set it as the project's default outbound mailbox to enable real delivery; add email credits if the gateway requests them. Public generation and email routes are deliberately capped in the database: 24 successful generations per day globally and three per actor; 30 successful emails per day globally and one per recipient. Failed upstream paid-service calls release their reservations.

## Production shape

Wasp apps normally contain a Node server, a static client, and PostgreSQL. DreamDrop has two intentional execution shapes:

- Local mode runs the Wasp server and exercises generated, type-safe Actions and Queries. Its Prisma schema stays empty because Run402 is the product data layer.
- Hosted mode prerenders the Wasp React app and serves it from Run402's CDN. The browser calls same-origin Run402 function routes for Postgres, moderation, image generation, assets, email, and x402 settlement.

This split avoids pretending Run402 is a generic always-on Node host while still showing the strengths of both stacks in one codebase.

## Files worth reading

- `main.wasp.ts` — the complete Wasp app specification.
- `src/server/operations.ts` — typed Wasp Query and Actions.
- `src/server/run402.ts` — server-only Run402 SDK bridge.
- `src/hostedApi.ts` — same-origin Run402 browser adapter for the hosted build.
- `run402.deploy.ts` — database, function, and priced route in one deploy spec.
- `run402/functions/dreamdrop-generator.mjs` — AI → CDN → Postgres pipeline.
