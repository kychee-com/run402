# Consultation Result

**Model**: gpt-5.2-pro
**Submitted**: 2026-03-02T11:38:18.072191
**Completed**: 2026-03-02T11:51:46.829828
**Status**: completed

---

## Minimal Run402 additions to let OpenClaw ship *all 8 apps* end‑to‑end (MVP)

You already have the “Supabase core” for CRUD apps (Postgres + PostgREST + Auth + SQL + basic RLS + Storage). To autonomously build the listed apps, OpenClaw mainly needs a **Vercel-lite surface (hosting + functions + cron)** and two Supabase gaps (**group/team RLS** and **realtime**), plus **secure storage defaults** for photos.

### P0 (must-have) primitives

### 1) **Static web hosting (“Sites”)**
**What:** host a SPA/PWA build output (Next.js `output: "export"`, Vite/React, etc.) at a stable URL.  
**Why:** “Works on phone” + “ship a real app” requires a deploy target with HTTPS.  
**Unblocks:** *all* use cases (1–8).

**Minimal API/MCP surface**
- `deploy_site(project_id, build_zip | files, spa_fallback=true)` → `{ site_url }`
- Optional: `rollback_site`, `list_sites`, `delete_site`

**MVP implementation hint:** reuse your existing S3 + add a CloudFront distribution; store each site under a `{project_id}/{site_id}/` prefix and do SPA rewrite to `/index.html`.

---

### 2) **HTTP compute (“Functions”) with service-role DB access**
**What:** project-scoped serverless endpoints (Node/TS) callable over HTTPS.  
**Why:** eliminates the biggest remaining class of “needs a backend”: verification, webhooks, signed upload URL minting, moderation, custom logic.  
**Unblocks:** puzzle anti-cheat/verification (2), RSVP handling (5), booking workflows + email triggers (6), Stripe webhooks later (7), secure storage signing (4), presence/moderation helpers (8).

**Minimal requirements**
- Deploy a function from code (single file is fine for MVP).
- Functions get *implicit* access to:
  - `RUN402_PROJECT_ID`
  - a **service_role token** (or an internal admin credential) so functions can bypass RLS when needed
  - `RUN402_API_BASE` for calling your PostgREST/auth/storage APIs

**Minimal API/MCP surface**
- `deploy_function(project_id, name, code, runtime="node20")` → `{ url }`
- `delete_function(project_id, name)`
- `list_functions(project_id)`
- (Nice) `get_function_logs(project_id, name, tail=100)`

---

### 3) **Secrets / env var store (for functions + cron)**
**What:** store per-project secrets (Stripe webhook secret, puzzle salt, admin invite token pepper, etc.).  
**Why:** without this, agents either hardcode secrets into frontend (bad) or into DB rows (often leaky).  
**Unblocks:** (2) anti-cheat, (6) email notifications, (7) Stripe later, (5) mailing list integrations, (4) share tokens.

**Minimal API/MCP surface**
- `set_secret(project_id, key, value)` (service_key only)
- `delete_secret(project_id, key)`
- `list_secrets(project_id)` (names only)

---

### 4) **Scheduler / cron (“Jobs”)**
**What:** scheduled invocation of a function or execution of a SQL statement.  
**Why:** daily puzzle publishing, recurring tasks, streak reminders, usage rollups.  
**Unblocks:** (2) daily puzzle, (1) recurring tasks, (3) reminders/streak maintenance, (7) usage aggregation.

**Minimal API/MCP surface**
- `create_job(project_id, name, cron, target: {type: "function"|"sql", ...}, payload?)`
- `run_job_now(project_id, name)`
- `delete_job(project_id, name)`
- `list_jobs(project_id)`

**MVP implementation hint:** EventBridge Scheduler (or your own lightweight scheduler worker) calling your Functions or Admin SQL endpoint.

---

### 5) **Group/team RLS templates (not just user_owns_rows)**
Right now your templates are mostly “per-user row ownership” and “public read/write”. The apps listed need **membership-scoped** access (family/class/team/room).

**What:** add 1–2 templates that cover 80% of “multi-user shared data” safely.

**Template A: `member_of_group`**
- Assumes a membership table like `group_members(group_id, user_id, role)`
- Applies to any table with `group_id` column
- Policies:
  - `SELECT`: user is member of group
  - `INSERT/UPDATE/DELETE`: user is member (optionally role-gated)

**Template B: `role_based_admin` (optional but small)**
- “admins can do anything in group”
- “members can read/write limited columns”

**Also add one helper function** in each project schema:
- `auth.uid()` → returns UUID from JWT `sub`
This makes policies far less error-prone for agents.

**Unblocks:** (1) families, (2) classes, (3) teacher vs student, (6) admin vs guest, (7) teams/roles, (8) rooms.

**Minimal API/MCP surface**
- Extend existing `/admin/v1/projects/:id/rls` with templates:
  - `member_of_group`
  - (optional) `admin_of_group`
- Or add `apply_rls_policy(project_id, template, params)`

---

### 6) **Realtime (minimal “chat-grade”, not full Supabase WAL)**
You don’t need “full database changefeed for every query” to satisfy the MVP apps. You need “live messages in a room” + optional presence.

**What:** a managed WebSocket (or SSE) service with:
- auth via Run402 JWT
- “subscribe to channel” semantics
- server-side enforcement that user may subscribe to that channel (membership check in DB)

**How to keep it minimal**
- Use Postgres `LISTEN/NOTIFY` as your backbone.
- Let OpenClaw create triggers (via `run_sql`) on `messages` that `NOTIFY` on `room:{room_id}` when inserts occur.
- Realtime service listens and broadcasts to connected clients who are subscribed to that room.

**Unblocks:** (8) chat/Q&A wall; also makes (1)/(3) dashboards feel instant.

**Minimal API/MCP surface**
- Mostly docs + a client snippet, but one tool helps agents:
  - `realtime_info(project_id)` → returns `{ websocket_url, protocol }`
- (Optional) `enable_realtime_trigger(project_id, table, channel_sql)` if you want to avoid agents writing triggers.

---

### 7) **Storage “secure-by-default” + large uploads**
For the photo dropbox, the current `10mb` gateway upload path isn’t enough, and “anon_key can hit storage” is risky if not carefully designed.

**Minimal upgrades**
1) **First-class presigned uploads** (large files, direct-to-S3)
   - Multipart optional for MVP, but single PUT presign is already a big win.
2) **Private buckets by default**
   - Public only when explicitly marked public.
3) **Auth-required signed URL minting**
   - Ideally: require a user JWT (or a function using service_role) to mint a download/upload URL.

**Unblocks:** (4) family photo dropbox; also useful for attachments in (1)/(5).

**Minimal API/MCP surface**
- `create_signed_upload_url(project_id, bucket, path, content_type, max_bytes)`  
- `create_signed_download_url(project_id, bucket, path)`
- Or keep your existing `/storage/v1/object/sign/*` but **lock it down** to Bearer JWT / service_key and document the recommended pattern (client → function → presigned URL).

---

### 8) **Transactional email (service-only)**
You can technically ship some MVPs without email, but your examples explicitly want notifications/invites.

**What:** a single “send email” capability usable from Functions (or service_key), rate-limited, using a Run402-managed sender domain (`noreply@run402.com`) for MVP.

**Unblocks:** (6) booking request/approval emails, (3) reminders, (5) RSVP confirmation/newsletter double-opt-in, (7) “invoice later”.

**Minimal API/MCP surface**
- `send_email(project_id, to, subject, text|html)` (service_key only)
- Or expose as a built-in binding in Functions (`run402.sendEmail(...)`) so OpenClaw doesn’t manage provider SDKs.

---

## If you want the *absolute smallest* set of new primitives
If you’re trying to minimize engineering surface, the tight core is:

1. **Sites (static hosting)**  
2. **Functions (HTTP compute) + Secrets**  
3. **Cron (scheduler)**  
4. **Group RLS template**  
5. **Realtime (room/pubsub)**  
6. **Large-file private storage via presigns**  
7. **Email sending (can be implemented as a Functions binding)**

Everything else (image thumbnails, domains, OAuth, queues, previews) can come later and still let OpenClaw build the listed apps.

---

## MCP tool additions OpenClaw will need (minimum)
To make “build autonomously” true, add these tools to `@run402/mcp`:

- `deploy_site`
- `deploy_function`
- `set_secret` (and maybe `list_secrets`)
- `create_job` (cron)
- `send_email` (or make it a Functions binding)
- `realtime_info`
- Extend `rest_query` to support PostgREST RPC paths cleanly (optional, but helpful)

That’s the MVP feature set that covers *all eight* app types with the least new platform surface area.

---
**Tokens**: 9,335 input, 21,248 output, 30,583 total
