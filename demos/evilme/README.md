# EvilMe — villain origin story generator

A full-stack demo that runs **100% on run402**: forge your supervillain alter-ego
from your name + one mundane fact, get an AI manga portrait, then vote villains
head-to-head in an Elo arena. Built as an **Astro SSR** app on the run402 platform.

Live (after onboarding): `https://evilme.run402.com`

## What it shows off (max run402 surface, one app)

| Feature | run402 surface |
|---|---|
| Server-rendered pages + API routes | `@run402/astro` `run402()` SSR adapter (Lambda + SnapStart + ISR cache + ALS context) |
| Sign in to forge (passkey / Google / magic-link / password) | hosted-auth components `<SignIn methods={…}>`, `<SignedIn>`, `<SignedOut>`, `<UserButton>` + cookie sessions |
| "Only you can edit your villains" | Postgres **RLS** keyed to `run402.current_user_id()`, written through `db(req)` |
| Public gallery / leaderboard / arena | RLS public-read policy; reads via `db(req)` / `adminDb().sql()` |
| AI manga portrait | `ai.generateImage({ prompt, aspect })` — on-platform, project-billed |
| Storing + rendering the portrait | `assets.put()` → `AssetRef` JSONB → `<Run402Picture asset={…}>` |
| Elo vote tally (platform-mediated) | `adminDb().sql()` BYPASSRLS for a write the caller doesn't own |
| One atomic deploy of DB + site + function | `run402 deploy apply --dir dist --manifest run402.config.json` |

## Design notes

- **No external AI.** run402's `ai.*` surface is translate / moderate / generateImage —
  there's no text LLM — so the villain *story* is generated **procedurally** (see
  `src/lib/story.ts`, deterministic per name+fact) and the *portrait* is the
  on-platform `ai.generateImage`. That keeps the app 100% on run402 (no OpenAI key).
  The old evilme used OpenAI GPT for the story + a raw S3 PUT into an internal
  bucket + an `X-Admin-Key` bypass — all gone.
- **RLS model.** `villains` is public-read (gallery/arena/leaderboard), but only
  the owner can insert/update/delete — `user_id` is filled by a column DEFAULT of
  `run402.current_user_id()`, so inserts never carry a user id and never add a
  redundant `.eq("user_id", …)` filter. Voting is the one platform-mediated write,
  so it tallies Elo through `adminDb()`.

## Local dev

```bash
npm install
npm run dev        # astro dev
npm run check      # astro check (typecheck)
npm run build      # → dist/run402/{client,server,adapter.json}
```

`db()` / `ai` / `assets` resolve at runtime inside the run402 SSR function; for
local dev against a real project, set `RUN402_PROJECT_ID` + `RUN402_SERVICE_KEY`.

## Deploy (onboarding, one-time operator)

EvilMe is **source-only** until provisioned. To onboard:

1. `run402 projects provision --name evilme --wallet <deploy-wallet>` → `project_id`.
2. Mark it a system project (admin) + claim the `evilme` subdomain.
3. `run402 ci link github --project <id> --repo kychee-com/run402 --environment demos --repository-id <id> --wallet <deploy-wallet>` → `binding_id`.
4. Record `project_id` / `binding_id` / `owner_wallet` / `oidc_subject` into `app.json`.

Then every push deploys keyless via `deploy.ts`, which builds the Astro app and runs:

```bash
run402 deploy apply --dir dist --manifest run402.config.json --project <id>
```

`run402.config.json` carries the DB migration (`schema.sql`); `--dir dist` carries
the Astro static client + the `class: "ssr"` function. Routes are implicit (the
gateway sends unmatched paths to the SSR function), so the slice is CI-OIDC-safe.

> **Note:** the shared `demos/_deploy` matrix workflow needs an Astro-aware leg
> (install + `astro build` before the apply). Wiring that in is part of onboarding —
> tracked alongside provisioning.
