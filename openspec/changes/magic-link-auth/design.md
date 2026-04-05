## Context

Run402 project users currently authenticate via password or Google OAuth. Magic link adds a third method — passwordless email auth. This also fixes the `password_hash NOT NULL` schema inconsistency (init.sql says NOT NULL, but OAuth already inserts NULL via runtime migration) and adds a missing password change/reset capability.

The magic link flow follows the same architectural pattern as OAuth: the gateway generates tokens, the project's frontend handles the redirect, and the existing `/auth/v1/token` endpoint exchanges the token for a session.

## Goals

- Add `POST /auth/v1/magic-link` and `grant_type=magic_link` on `/auth/v1/token`
- Add `PUT /auth/v1/user/password` for password change/reset/set
- Make `password_hash` officially nullable (multi-method identity)
- Rate-limit magic link requests per email and per project
- Add `allow_password_set` project-level setting

## Non-Goals

- Frontend UI for magic link (projects build their own)
- WebAuthn/passkeys (future feature)
- Custom email templates per project
- SMS/WhatsApp verification

## Decisions

### 1. Magic link URL points to project frontend, not gateway

**Choice:** The `POST /auth/v1/magic-link` request requires a `redirect_url`. The email link points to `<redirect_url>?token=<token>`. The project's frontend extracts the token and calls `POST /auth/v1/token?grant_type=magic_link` to exchange it.

**Alternatives considered:**
- *Gateway-hosted verify page:* Gateway serves a page at `/auth/v1/magic-link/verify?token=...` that auto-exchanges the token and redirects. Simpler for projects but couples Run402 to frontend concerns and limits customization.

**Rationale:** Consistent with the OAuth flow (which also redirects to the project's frontend with a code). Projects control the UX. The `redirect_url` is validated via the existing `validateRedirectUrl()` function (allows localhost, claimed subdomains, custom domains).

### 2. Reuse existing `/auth/v1/token` endpoint with new grant_type

**Choice:** Magic link verification goes through `POST /auth/v1/token?grant_type=magic_link` rather than a new dedicated endpoint.

**Alternatives considered:**
- *New `POST /auth/v1/magic-link/verify` endpoint:* Dedicated endpoint, clearer API surface. But duplicates token issuance logic (JWT signing, refresh token creation).

**Rationale:** The token endpoint already handles `password` (default), `refresh_token`, and `authorization_code` grant types. Adding `magic_link` is a natural extension. Response shape is identical. Clients use the same token refresh flow regardless of how they initially authenticated.

### 3. In-memory rate limiting (same pattern as existing)

**Choice:** Rate limits tracked in-memory using Maps with TTL cleanup, same as the existing rate limiting patterns in the gateway.

**Alternatives considered:**
- *DB-backed rate limits:* Survives gateway restarts, accurate across multiple instances. But adds latency to every magic link request and the codebase uses in-memory rate limiting elsewhere.
- *Redis:* Accurate across instances but adds an infra dependency Run402 doesn't currently have.

**Rationale:** Run402 runs a single gateway instance. In-memory is consistent with existing patterns. Acceptable trade-off: on restart, rate limit counters reset (minor — the window is only 1 hour).

### 4. Password reset = magic link login + password set (no separate flow)

**Choice:** There is no dedicated "forgot password" or "password reset token" flow. Instead: user requests a magic link → logs in → calls `PUT /auth/v1/user/password` with just `new_password` (no `current_password` required because the user already had a password — they're resetting, not setting for the first time).

**Alternatives considered:**
- *Dedicated reset token:* Separate `POST /auth/v1/password-reset` that emails a reset-specific token. More API surface but clearer intent separation.

**Rationale:** Magic link already proves email ownership and creates an authenticated session. A password reset is just "log in without your password, then change it." This avoids a second token type and a second email template. The `PUT /auth/v1/user/password` endpoint distinguishes three cases by state:
1. Has password + provides `current_password` → password **change**
2. Has password + no `current_password` → password **reset** (must be authenticated, e.g., via magic link)
3. No password + no `current_password` → password **set** (gated by `allow_password_set`)

### 5. `allow_password_set` as project-level setting (default off)

**Choice:** Whether passwordless users can add a password is a project-level setting stored in `internal.projects`. Default: false.

**Alternatives considered:**
- *Always allow:* Simpler but wrong for products like e-signing where one-time users shouldn't be prompted to create passwords.
- *Per-user flag:* Too granular — the project owner decides the auth model, not individual users.

**Rationale:** The project owner knows their auth model. A signing app keeps it off. A community app turns it on. Stored as a column on `internal.projects` and read from the existing project cache.

## Risks / Trade-offs

**Magic link as password reset has no "intent" signal** → A user who clicked a magic link to sign in (not to reset their password) can still call the password endpoint. *Mitigation:* This is fine — they're authenticated either way. The password endpoint requires a Bearer token, so the user explicitly takes a second action.

**In-memory rate limits reset on deploy** → Brief window after deploy where rate limits are zero. *Mitigation:* Deploys are infrequent and the window is small. Abuse during this window is bounded by SES sending limits.

**`allow_password_set` adds a column to projects** → One more setting to manage. *Mitigation:* Boolean with sensible default (false). No migration complexity — it's an `ADD COLUMN IF NOT EXISTS` with default.

## Migration Plan

Additive change. No breaking migrations.

1. `ALTER TABLE internal.users ALTER COLUMN password_hash DROP NOT NULL` — already runs in server.ts startup migration, now also reflected in init.sql for new installs
2. `ALTER TABLE internal.projects ADD COLUMN IF NOT EXISTS allow_password_set BOOLEAN NOT NULL DEFAULT false` — new startup migration
3. `CREATE TABLE IF NOT EXISTS internal.magic_link_tokens (...)` — new startup migration
4. Deploy gateway with new routes
5. Existing users/projects unaffected — magic link is opt-in per project (projects choose to add it to their frontend)
