## Why

Run402 needs its first marketplace seed app to prove the forkable-apps thesis. SkMeld — a property maintenance request tracker — is the ideal candidate: it maps cleanly to existing Run402 primitives (Postgres, PostgREST, auth, storage, functions, sites), doesn't need realtime or vector DB, and targets a market (individual landlords, HOAs, office managers) where per-seat SaaS pricing is the #1 complaint. It will be open source (MIT), one-click deployable to Run402, and designed for agent customization.

Full spec: `docs/consultations/property-maintenance-tracker-spec.md`

## What Changes

This is a greenfield app build. New repo structure under `apps/skmeld/`:

- **SQL schema**: 15+ tables (maintenance_requests, profiles, properties, spaces, vendors, request_comments, attachments, request_events, app_settings, role/status/priority/category config tables)
- **RLS policies**: role-based access (owner_admin sees all, staff sees all, resident sees own requests only, internal comments hidden from residents)
- **Security-invoker views**: v_request_board, v_request_activity, v_request_export, v_request_metrics
- **6 serverless functions**: submit_request, update_request, transition_request, add_comment, create_invites, redeem_invite + bootstrap function
- **React frontend**: React + TypeScript + Vite + Tailwind + shadcn/ui + TanStack Query + dnd-kit
  - Staff board (kanban with drag/drop)
  - Request detail drawer/page
  - Resident report form + my-requests list
  - Properties/spaces/vendors/people/settings/reports pages
  - Mobile-responsive, dark mode, theme presets
- **Seed data**: base seed (config/statuses/categories) + optional demo seed (sample properties, requests, users)
- **Bootstrap function**: first-admin claim, app configuration, optional demo data
- **Deploy script**: one-click deploy to Run402 (provision + deploy bundle + claim subdomain)
- **Documentation**: README, setup, customization, data dictionary, fork prompts
- **Tests**: SQL/RLS tests, function tests, frontend tests, E2E lifecycle test

## Capabilities

### New Capabilities
- `skmeld-schema`: SQL schema, seed data, RLS policies, and security-invoker views for the maintenance request data model
- `skmeld-functions`: Serverless functions for domain workflows (submit, update, transition, comment, invite, redeem, bootstrap)
- `skmeld-frontend`: React SPA with staff board, resident views, admin pages, auth flows
- `skmeld-deploy`: Deploy script, run402.yaml manifest, and marketplace publishing configuration

### Modified Capabilities

(none — greenfield app, no existing specs)

## Impact

- **New directory**: `apps/skmeld/` with full app source
- **No changes to Run402 gateway** — uses existing platform APIs only
- **Marketplace**: first publishable app version with bootstrap variables
- **Demo site**: deployed to `skmeld.run402.com`
