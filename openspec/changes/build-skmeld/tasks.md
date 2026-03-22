## 1. Project scaffold

- [x] 1.1 Create `apps/skmeld/` directory structure (sql/, functions/, src/, docs/)
- [x] 1.2 Initialize package.json with React 19, Vite, TypeScript, Tailwind, shadcn/ui, TanStack Query, React Router, dnd-kit, react-hook-form, zod
- [x] 1.3 Configure vite.config.ts, tsconfig.json, tailwind.config.ts, postcss.config.js
- [x] 1.4 Set up shadcn/ui with emerald theme preset

## 2. SQL schema + seed

- [x] 2.1 Write sql/schema.sql — all 20+ tables (app_settings, role_definitions, profiles, invites, space_occupancies, properties, space_types, spaces, request_statuses, priority_levels, request_categories, entry_preferences, request_sources, status_transitions, vendors, maintenance_requests, request_comments, attachments, request_events, notification_log)
- [x] 2.2 Write sql/rls.sql — RLS policies for all tables (owner_admin/staff full access, resident scoped to own data, internal visibility hidden)
- [x] 2.3 Write sql/views.sql — security-invoker views (v_request_board, v_request_activity, v_request_export, v_request_metrics)
- [x] 2.4 Write sql/seed-base.sql — config data (3 roles, 9 statuses, 4 priorities, 10 categories, 3 entry preferences, 5 sources, allowed status transitions, default app_settings with ui_labels)
- [x] 2.5 Write sql/seed-demo.sql — demo data (2 properties, 10+ spaces, 3 demo users, 15+ requests across all statuses, comments, attachments metadata)

## 3. Serverless functions

- [x] 3.1 Write functions/submit-request.ts — create request, validate caller + space occupancy, snapshot SLA dates, log event
- [x] 3.2 Write functions/update-request.ts — update metadata (category, priority, assignee, vendor, schedule), log events for changes
- [x] 3.3 Write functions/transition-request.ts — enforce status_transitions, require notes/summary/reason per status, set timestamps, log events
- [x] 3.4 Write functions/add-comment.ts — create comment (public/internal), validate visibility by role, attach photos
- [x] 3.5 Write functions/create-invites.ts — owner_admin only, create invite tokens, build occupancy intent, return invite URLs
- [x] 3.6 Write functions/redeem-invite.ts — verify token, create profile + occupancies, mark invite accepted
- [x] 3.7 Write functions/bootstrap.ts — create admin user, set app_settings, optionally seed demo data, return login URL

## 4. Frontend shell

- [x] 4.1 Create src/main.tsx, src/App.tsx with React Router setup
- [x] 4.2 Create src/api/client.ts — PostgREST query helper and function invoke helper with auth headers
- [x] 4.3 Create auth pages: /login, /claim (invite redeem)
- [x] 4.4 Create auth context/provider: signup, login, token refresh, role lookup from profiles
- [x] 4.5 Create app layout with role-based sidebar navigation (staff sees board/requests/properties/vendors/reports, admin also sees people/settings, resident sees my-requests/report)
- [x] 4.6 Create theme system with 5 presets (emerald, blue, indigo, rose, amber) + dark mode toggle

## 5. Staff board

- [x] 5.1 Build board page (/app/board) — fetch v_request_board, render kanban columns from request_statuses where show_in_board=true
- [x] 5.2 Build board card component — request number, title, property+space, requester, category icon, priority badge, age, overdue indicator, assignee avatar, photo count
- [x] 5.3 Implement drag/drop with dnd-kit — drag card between columns triggers transition_request with optimistic update
- [x] 5.4 Build board filters — search, property, assignee, category, priority, "mine", "unassigned", "overdue"
- [x] 5.5 Implement 15s polling with TanStack Query + refetch on window focus

## 6. Request detail

- [x] 6.1 Build request detail page/drawer (/app/requests/:id) — header, summary panel, photo gallery, activity timeline, comment composer
- [x] 6.2 Build activity timeline — union of events + comments + attachments, chronological, with author avatar/name, visibility badges for internal items (staff only)
- [x] 6.3 Build comment composer — textarea + public/internal toggle (staff) or public-only (resident), photo attachments
- [x] 6.4 Build photo gallery — grid of thumbnails, click to lightbox, lazy loading
- [x] 6.5 Build status action buttons — transitions available from current status per user role
- [x] 6.6 Desktop: render as side drawer over board with route sync. Mobile: full page.

## 7. Resident flow

- [x] 7.1 Build report form (/app/report) — property selector, space selector, category cards with icons, title, description, location, priority (if enabled), entry preference, pets (if enabled), visit window (if enabled), access instructions, up to 6 photos with preview + client-side compression
- [x] 7.2 Build my-requests page (/app/my-requests) — grouped list (open, resolved-awaiting, closed), poll every 30s
- [x] 7.3 Build resident request detail — same detail component but scoped to public visibility, close/reopen actions only

## 8. Admin pages

- [x] 8.1 Build properties page (/app/properties) — list, add/edit/archive properties, expandable spaces/units, CSV import
- [x] 8.2 Build people page (/app/people) — active users tab, pending invites tab, invite form (role + email + name + spaces for residents), CSV import
- [x] 8.3 Build vendors page (/app/vendors) — contact directory with trade/category, CRUD
- [x] 8.4 Build settings page (/app/settings) — app_name, company_name, logo, theme, support contact, emergency instructions, timezone, intake toggles
- [x] 8.5 Build reports page (/app/reports) — KPI cards (open, overdue, unassigned, avg first response time), charts by status/category/property, reopened count, CSV export

## 9. Polish

- [x] 9.1 Loading skeletons for board, detail, lists
- [x] 9.2 Empty states for all pages (no requests, no properties, etc.)
- [x] 9.3 Mobile responsive layout — hamburger nav, stacked board on mobile, camera-friendly upload
- [x] 9.4 Dark mode — all pages render correctly in dark theme
- [x] 9.5 Error handling — toast notifications for function errors, retry prompts
- [x] 9.6 Keyboard accessibility — forms, modals, navigation

## 10. Deploy + publish

- [x] 10.1 Write deploy.ts — tier subscribe, provision project, vite build, bundle deploy (schema + rls + views + seed-base + functions + site + subdomain), invoke bootstrap
- [x] 10.2 Write run402.yaml — bootstrap_variables declaration (admin_email, app_name, seed_demo_data)
- [x] 10.3 Add --publish flag to deploy.ts for marketplace publishing

## 11. Documentation

- [x] 11.1 Write README.md — overview, quick start, screenshots placeholder
- [x] 11.2 Write docs/setup.md — prerequisites, local dev, deploy to Run402
- [x] 11.3 Write docs/customization.md — branding, categories, priorities, statuses, ui_labels, theme
- [x] 11.4 Write docs/data-dictionary.md — all tables with column descriptions
- [x] 11.5 Write docs/fork-prompts.md — HOA, office manager, church/nonprofit fork examples
- [x] 11.6 Add LICENSE (MIT)

## 12. Tests

- [x] 12.1 SQL/RLS tests — resident isolation, internal comment hiding, staff full access, admin-only settings
- [x] 12.2 Function tests — submit, transition (valid + invalid), comment visibility, invite lifecycle
- [x] 12.3 E2E test — bootstrap → add property → invite resident → submit request → staff triage → resolve → reopen → close → CSV export
