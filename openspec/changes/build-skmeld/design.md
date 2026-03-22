## Context

SkMeld is the first Run402 marketplace seed app. The full product spec lives at `docs/consultations/property-maintenance-tracker-spec.md` (GPT-5.4 Pro consultation, 1700+ lines). This design doc covers architectural decisions for implementation — the "how" behind the spec's "what."

The app is a standalone project under `apps/skmeld/` that uses Run402 as its backend (PostgREST for reads, serverless functions for writes, S3 storage for photos, JWT auth for users). It does not modify the Run402 gateway.

## Goals / Non-Goals

**Goals:**
- Build a complete, deployable app that demonstrates Run402's full stack
- Beautiful from day 1 — modern SaaS aesthetic, not a demo/prototype feel
- Easy for agents to fork and customize (data-driven config, generic schema nouns, ui_labels)
- One-click deployable via `npx tsx apps/skmeld/deploy.ts`
- Publishable to Run402 marketplace with bootstrap variables

**Non-Goals:**
- No mobile native apps
- No realtime/WebSockets (polling is sufficient)
- No email integration in v1 (optional via RESEND_API_KEY secret)
- No workflow editor UI (statuses/categories are data-driven but agent/SQL-edited)
- No multi-org support (one deployment = one business)

## Decisions

### 1. Project structure: monorepo app under `apps/skmeld/`

```
apps/skmeld/
├── deploy.ts              # one-click deploy script
├── run402.yaml            # marketplace manifest
├── sql/
│   ├── schema.sql         # tables, indexes, constraints
│   ├── rls.sql            # RLS policies
│   ├── views.sql          # security-invoker views
│   ├── seed-base.sql      # config data (statuses, categories, priorities)
│   └── seed-demo.sql      # optional demo data (properties, requests, users)
├── functions/
│   ├── bootstrap.ts       # first-admin setup + optional demo seeding
│   ├── submit-request.ts
│   ├── update-request.ts
│   ├── transition-request.ts
│   ├── add-comment.ts
│   ├── create-invites.ts
│   └── redeem-invite.ts
├── site/                  # React SPA (Vite build output goes here)
│   └── ... built assets
├── src/                   # React source
│   ├── main.tsx
│   ├── App.tsx
│   ├── api/               # PostgREST + function call helpers
│   ├── components/        # shared UI components
│   ├── pages/             # route-level pages
│   ├── hooks/             # TanStack Query hooks
│   └── lib/               # utilities, types, theme
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── docs/
    ├── setup.md
    ├── customization.md
    ├── data-dictionary.md
    └── fork-prompts.md
```

**Why under `apps/`:** Keeps the app separate from the Run402 gateway. Each marketplace app is independent — its own package.json, its own build, its own deploy script.

### 2. Data access pattern: PostgREST reads, functions for writes

- **Reads**: Frontend queries PostgREST directly via `apikey` header (for public data) or `Authorization: Bearer <access_token>` (for user-scoped data with RLS)
- **Writes**: All domain mutations go through serverless functions that use `getUser(req)` for auth and `db` (service_role) for multi-table writes
- **Simple admin CRUD**: Properties, spaces, vendors, settings use PostgREST directly with RLS

**Why:** Functions centralize business logic (transition rules, event logging, notification triggers). PostgREST handles reads efficiently with no custom code. This is the pattern recommended by the consultation and aligns with Run402's architecture.

### 3. Frontend: React + Vite + Tailwind + shadcn/ui

- **React 19 + TypeScript** — standard, well-known by agents
- **Vite** — fast dev, small build output
- **Tailwind CSS** — utility-first, easy to customize themes
- **shadcn/ui** — copy-paste components, not a dependency — agents can modify freely
- **TanStack Query** — data fetching with polling, cache, optimistic updates
- **React Router** — client-side routing
- **dnd-kit** — accessible drag/drop for the kanban board
- **react-hook-form + zod** — form validation

All dependencies MIT/Apache/BSD compatible.

### 4. Auth flow: Run402 JWT auth with role from profiles table

1. User signs up or logs in via `/auth/v1/signup` or `/auth/v1/token`
2. Frontend stores `access_token` + `refresh_token`
3. On each request, sends `apikey` (anon_key) + `Authorization: Bearer <access_token>`
4. RLS policies use `auth.uid()` to scope data
5. Functions use `getUser(req)` to verify identity and check role via profiles table

Role is stored in the app's `profiles` table, not in the JWT. The JWT only has `sub` (user_id) and `role: "authenticated"`. Functions look up the app-level role from profiles.

### 5. Image handling: client-side compression + private storage

- Max 6 photos per request, 4 per comment
- Client-side compression (max 1600px long edge, ~700KB target)
- Upload to Run402 storage (`request-photos` bucket) via presigned URLs
- Attachments table stores metadata (bucket, path, mime_type, dimensions)
- No public URLs — images served through authenticated storage endpoint

### 6. Polling strategy (no realtime)

- Board: poll every 15s when tab is active
- Request detail: poll every 10-15s
- Resident pages: poll every 30s
- Refetch on window focus
- Optimistic UI for local actions (drag/drop, status changes, comments)

### 7. Deploy script pattern

Follows existing demo deploy scripts (`demos/evilme/deploy.ts`, `demos/cosmicforge/deploy.ts`):

1. Read `.env` for `BUYER_PRIVATE_KEY`, `ADMIN_KEY`
2. Subscribe to tier (if needed)
3. Provision project
4. Build React SPA via Vite
5. Bundle deploy: schema.sql + rls.sql + views.sql + seed-base.sql + functions + built site + subdomain
6. Invoke bootstrap with default admin setup
7. Print credentials + URLs

### 8. Build order strategy

The app is large. Build in this order to get something visible early:

1. **Schema + seed** — foundation, can test with PostgREST immediately
2. **Functions** — domain logic, testable via curl/invoke
3. **Bootstrap** — first-admin flow
4. **Frontend shell** — router, auth, layout, theme
5. **Staff board** — the hero feature, most visually impressive
6. **Request detail** — timeline, comments, status changes
7. **Resident flow** — report form, my-requests
8. **Admin pages** — properties, people, vendors, settings, reports
9. **Polish** — dark mode, loading states, empty states, mobile
10. **Tests + docs + publish**

## Risks / Trade-offs

**[Large scope]** → This is the biggest single app built on Run402. Mitigation: strict phased build order, each phase is independently testable, can ship a "staff board only" MVP early.

**[Photo storage costs]** → Images can consume Hobby tier storage (1GB) quickly without compression. Mitigation: client-side compression is mandatory, not optional. Max 6 photos per request.

**[No email in v1]** → Invite links must be shared manually if RESEND_API_KEY not configured. Mitigation: functions always return invite URLs in their response — email is a nice-to-have delivery channel, not the only path.

**[Polling latency]** → 15s poll interval means the board can feel slightly stale. Mitigation: optimistic UI for local actions makes it feel instant. Polling is good enough for this use case — maintenance requests don't need sub-second updates.
