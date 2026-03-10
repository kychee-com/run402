# Demo Mode Spec

> Every published app gets a free live demo. Visitors can interact with it. The gateway enforces limits. When limits are hit, visitors are guided to fork. App authors write zero demo-specific code.

---

## Why

Published apps on Run402 need a "try before you fork" experience. Without it, visitors see a static listing page and must pay for a tier before they know if the app is worth it. With demo mode, every published app has a live, interactive instance that resets periodically — like a test drive.

The demo must be:
- **Generic** — works for any app, no per-app demo code
- **Interactive** — visitors can click, drag, edit, browse (not just screenshots)
- **Limited** — can't be used as free production software
- **Self-healing** — resets to the published snapshot on a schedule
- **Conversion-oriented** — limits guide visitors toward forking

---

## How it works

### 1. Publishing creates a demo instance

When an app is published via `POST /admin/v1/projects/:id/publish`, the system also provisions a **demo project** — a real Run402 project restored from the published bundle, flagged as `demo_mode = true`.

The demo project:
- Has its own project ID, schema, keys
- Is restored from the published bundle (same as fork)
- Gets a subdomain: `{app-name}.run402.com` (the app's claimed subdomain)
- Has no owner wallet — it's platform-operated
- Has no lease expiry — it lives as long as the published version exists
- Is excluded from billing

### 2. Gateway enforces demo limits

When `demo_mode = true`, the gateway middleware intercepts requests and enforces limits **before** they reach PostgREST, auth, storage, or SQL exec.

Limits are stored in `demo_config` on the project and have sensible defaults.

#### Default limits

| Resource | Default limit | Rationale |
|----------|--------------|-----------|
| Row inserts (total, all tables) | 50 | Enough to try the app, not enough to use it |
| Auth user signups | 3 | Can test multi-user, can't run a real team |
| Storage file uploads | 5 | Can see upload UX, can't use as file hosting |
| DDL statements | Blocked | Can't alter schema |
| Secret writes | Blocked | Can't configure integrations |
| Function deploys | Blocked | Can't modify serverless functions |

Reads are unlimited — visitors can browse all seeded data freely.

#### Enforcement points

| Gateway path | Check |
|---|---|
| `POST /rest/v1/:table` | Increment row insert counter; reject if over limit |
| `PATCH /rest/v1/:table` | Allowed (editing existing data is fine) |
| `DELETE /rest/v1/:table` | Allowed but capped (max 20 deletes) — prevents wiping demo data |
| `POST /admin/v1/projects/:id/sql` | Reject DDL; allow DML up to row insert limit |
| `POST /auth/v1/signup` | Increment auth user counter; reject if over limit |
| `POST /storage/v1/...` | Increment file counter; reject if over limit |
| `POST /admin/v1/projects/:id/secrets` | Blocked |
| `POST /admin/v1/projects/:id/functions` | Blocked |

#### Counter tracking

Counters are tracked in-memory (or Redis if multi-instance) per demo project. They reset when the demo resets.

No need for durable counters — if the gateway restarts, counters reset early. That's fine; it's a demo.

### 3. Demo reset

A scheduled task resets each demo project to its published snapshot on a configurable interval.

**Default interval: 4 hours.**

Reset process:
1. Drop all tables in the demo schema
2. Restore from the published bundle (same `deployBundle()` path used by fork)
3. Re-apply grants
4. Reset in-memory counters to zero
5. Auth users created by visitors are wiped (seeded users are restored)
6. Storage uploads by visitors are deleted (seeded assets are restored)

This reuses the existing publish/fork restore pipeline — no new restore logic needed.

#### Reset schedule options

Stored in `demo_config`:
```json
{
  "reset_interval_hours": 4
}
```

Can be overridden per app. Some apps (e.g., a game with leaderboard) might want faster resets (1 hour). Others might want slower (12 hours).

### 4. Error responses when limits are hit

When a demo limit is reached, the gateway returns **403** with a structured body:

```json
{
  "error": "demo_limit_reached",
  "code": "DEMO_ROW_INSERT_LIMIT",
  "message": "This is a live demo. You've reached the insert limit. Fork this app to get your own copy with no limits.",
  "limit_type": "row_inserts",
  "current": 50,
  "max": 50,
  "fork": {
    "version_id": "av_abc123",
    "app_name": "Prello",
    "min_tier": "prototype",
    "pricing": {
      "prototype": "$0.10 for 7 days",
      "hobby": "$5.00 for 30 days",
      "team": "$20.00 for 30 days"
    },
    "fork_url": "https://run402.com/apps#av_abc123"
  },
  "resets_at": "2026-03-10T16:00:00Z"
}
```

The error is:
- **Human-readable** — clear message
- **Agent-readable** — structured fork info, version ID, pricing
- **Actionable** — includes everything needed to fork
- **Temporary** — includes `resets_at` so visitors know when limits clear

### 5. Frontend demo banner

Demo projects get an injected banner (similar to the fork badge) that says:

> **Live demo** — shared, resets every 4 hours. Fork for your own permanent copy.

This is injected by the site-serving layer (CloudFront function or edge inject), not by the app itself.

The existing fork badge overlay already handles the "Copy agent prompt" UX. The demo banner is a simpler, smaller element — a top bar or subtle fixed strip.

---

## Data model

### Changes to `internal.projects`

```sql
ALTER TABLE internal.projects ADD COLUMN demo_mode BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE internal.projects ADD COLUMN demo_config JSONB;
ALTER TABLE internal.projects ADD COLUMN demo_source_version_id TEXT REFERENCES internal.app_versions(id);
ALTER TABLE internal.projects ADD COLUMN demo_last_reset_at TIMESTAMPTZ;
```

### Default `demo_config` schema

```json
{
  "max_row_inserts": 50,
  "max_auth_users": 3,
  "max_storage_files": 5,
  "max_row_deletes": 20,
  "reset_interval_hours": 4,
  "allow_edits": true,
  "allow_deletes": true,
  "banner_text": "Live demo — shared, resets every 4 hours. Fork for your own permanent copy."
}
```

### Publish flow changes

When publishing with `visibility: public` and `fork_allowed: true`:

1. Existing publish flow (unchanged)
2. **New:** If no demo project exists for this app, create one:
   - `POST` internal project creation (no x402, platform-funded)
   - `demo_mode = true`
   - `demo_source_version_id = new_version_id`
   - `demo_config = default config`
   - Restore bundle into demo project
   - Claim the app's subdomain for the demo project
3. **New:** If demo project already exists, update `demo_source_version_id` and trigger an immediate reset

### Republish behavior

When the publisher publishes a new version:
- The demo project's `demo_source_version_id` is updated
- An immediate reset restores the new version's bundle
- Visitors see the latest version after next reset

---

## Subdomain routing

The app's primary subdomain (e.g., `prello.run402.com`) points to the demo project.

When someone forks, their fork gets a different subdomain (e.g., `prello-copy.run402.com` or `my-prello.run402.com`).

This means:
- `prello.run402.com` → demo instance (read-heavy, limited writes, resets)
- `my-prello.run402.com` → forked instance (full access, user-owned)

The published app's listing page (`/apps#version-id`) links to the live demo URL.

---

## What the visitor experience looks like

1. Visitor finds "Prello" on `/apps` or via a shared link
2. Clicks through to `prello.run402.com` — sees a live Trello-like app with realistic boards, cards, members
3. Can drag cards, check items, add comments, browse boards
4. Tries to create a 4th user → gets demo limit message with fork CTA
5. Tries to create too many cards → same
6. Sees the fork badge in the corner → copies the agent prompt
7. Pastes prompt into Claude Code → agent forks the app → they have their own `my-prello.run402.com` at the $0.10 prototype tier
8. Their copy has the same schema and seed data, but no limits, their own auth, their own budget

---

## What is NOT in scope

- **Per-visitor isolation** — demo is shared. All visitors see/edit the same data. This is intentional: it's simpler, and the shared-ness creates social proof ("others are using this too") while the messiness motivates forking ("I want my own clean copy").
- **Demo analytics** — tracking demo visits, limit hits, fork conversion. Useful later, not v1.
- **Demo-specific seed data** — the demo uses the same seed data as the published bundle. If authors want richer demo data, they include it in their publish.
- **Rate limiting** — demo projects use the same API rate limits as any project. If abuse becomes a problem, add IP-based rate limiting later.
- **Demo for private/unlisted apps** — only public forkable apps get auto-demo.

---

## Implementation order

1. **Add `demo_mode` column + gateway middleware** — enforce limits on demo-flagged projects
2. **Add demo error response format** — structured 403 with fork info
3. **Add demo reset scheduled task** — reuse `deployBundle()` restore path
4. **Wire into publish flow** — auto-create demo project on public publish
5. **Add demo banner injection** — top bar on demo sites
6. **Tune defaults** — adjust limits based on real usage

---

## Open questions

1. **Should edits to existing seeded data be allowed?** Proposed: yes. Editing feels interactive and doesn't accumulate new data. The reset restores everything anyway.

2. **Should the demo project be on testnet or mainnet?** Proposed: neither — it's platform-operated, excluded from billing entirely. No x402 payment needed to interact with a demo.

3. **Should we show "resets in X minutes" in the UI?** Probably yes, but low priority. The reset is transparent — visitors don't need to plan around it.

4. **Should demo projects count toward schema slot limits?** Yes, they consume a real schema slot. This naturally limits how many apps can have demos (which is fine — only public forkable apps get them, and there won't be thousands at first).
