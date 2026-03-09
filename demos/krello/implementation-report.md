# Krello Implementation Report

## Summary

Krello is a Trello-style collaboration app built natively on run402 with:

- Multi-user, multi-board collaboration
- Email/password auth on run402
- Invite-link board sharing with roles
- Rich cards with labels, assignees, checklists, comments, due dates, priorities, estimates, and link attachments
- Board duplication and export
- A polished responsive UI deployed as a static run402 site
- A run402-native function for board creation, starter content, invite acceptance, role changes, member removal, duplication, and export
- A public, forkable publish target intended for `krello.run402.com`

## What Went Well

- Run402 auth + PostgREST are enough to support a serious collaborative app without adding another backend.
- The publish/fork flow is a good fit for a clonable product demo.
- Static site deployment is simple and maps well to a no-build SPA.
- Functions are useful for the cases where REST alone is awkward or unsafe, especially invite acceptance and board duplication.

## Run402 Constraints And Tradeoffs

- Storage is project-scoped behind `apikey`, not row-level. Because of that, Krello uses protected link attachments in the database instead of private file uploads. File attachments would need a stricter storage model or a proxy pattern.
- Publish rejects custom functions, triggers, views, and custom types in the project schema. The app avoids those and keeps logic in plain tables, RLS policies, and a run402 function.
- Shared-board RLS is easier if access can be derived without recursive policy dependencies. Krello uses denormalized board access arrays (`member_ids`, `editor_ids`, `admin_ids`) to keep policies publishable and avoid recursive checks.

## Deliverables

- `schema.sql`: collaborative board schema and custom RLS policies
- `function.js`: run402 function for board lifecycle operations
- `site/index.html`: static entrypoint
- `site/styles.css`: full visual system
- `site/app.js`: SPA logic, auth, dashboard, board UI, card UI, filters, drag-and-drop
- `deploy.ts`: provision, deploy, subdomain claim, publish, pin

## Validation

- Local syntax checks: `node --check demos/krello/function.js` and `node --check demos/krello/site/app.js` both passed.
- Local TypeScript check: `npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --lib es2022,dom --skipLibCheck demos/krello/deploy.ts` passed.
- Remote run402 deployment: completed on 2026-03-09.
- Published version: `ver_1773072452721_1daf3d`
- Project: `prj_1773058949104_0054`
- Live URL: `https://krello.run402.com`
- Smoke test: signup, login, `POST /functions/v1/krello/bootstrap`, starter-board creation, and authenticated filtered board reads all succeeded against the live deployment.
- Frontend fix deployed: card and list drag-and-drop now uses real drag payloads, broader drop targets, and post-drag click suppression to avoid accidental card opens while reordering.
- Site polish deployed: Krello now serves an app-specific SVG favicon from `/favicon.svg`.

## Deployment Notes

- The app is live at `https://krello.run402.com`.
- The published app metadata is visible through `GET /v1/apps/ver_1773072452721_1daf3d`.
- The project was pinned after deploy so the demo will not expire.

## Debug Note

- The earlier suspected `GET /rest/v1/boards` inconsistency was a false alarm caused by the smoke test itself.
- CloudWatch logs in `/agentdb/gateway` showed the empty board read happened at `2026-03-09 12:23:45Z`, while `POST /functions/v1/krello/bootstrap` was still running and did not finish until roughly 3.6 seconds later.
- The board insert happened inside that bootstrap flow, so the empty read was expected: the read landed before the board existed.
- No run402 platform fix was needed for this specific behavior.
- The drag-and-drop failure was also app-side rather than run402-side. The original UI only accepted drops on narrow spacer elements and did not initialize `dataTransfer` payloads, which breaks HTML5 drag-and-drop in stricter browsers. The fix was shipped in the current live version.

## Improvements Worth Considering

- Real file attachments once storage access can be made per-user or per-board.
- Presence indicators and realtime subscriptions when run402 offers native live sync.
- Activity rollups and smarter board analytics once aggregate query helpers or materialized summaries are available.
- Board templates as published child apps for easier remixing.
