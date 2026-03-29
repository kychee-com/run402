## Context

Three user-reported issues block standard usage patterns:

1. **Content-Range invisible to browsers** — The gateway proxies PostgREST's `Content-Range` header correctly, but the CORS `Access-Control-Expose-Headers` list doesn't include it. Browser JS can't read it. This breaks the standard `Prefer: count=exact` + HEAD pattern for row counting.
2. **getUser() has no email** — JWTs contain `{sub, role, project_id}`. Edge functions get `{id, role}` from `getUser()`. Getting the user's email requires either a DB query or trusting client input.
3. **SQL filter false-positive on `role` column** — The regex `/\bSET\s+(search_path|role)\b/i` blocks the Postgres `SET role` command but also matches `UPDATE members SET role = 'admin'`. Affects both admin SQL route and bundle migrations.

## Goals / Non-Goals

**Goals:**
- Browser clients can read `Content-Range` from REST API responses
- Edge functions can get the authenticated user's email from `getUser(req)` without a DB round-trip
- `UPDATE ... SET role = ...` works in `db.sql()` and bundle migrations

**Non-Goals:**
- Adding other user metadata (display_name, avatar_url) to JWT/getUser — email is special because it's immutable identity; profile data belongs in DB queries
- Changing PostgREST HEAD behavior — the gateway already proxies the header; only CORS blocks it
- Reworking the SQL safety filter architecture — we're making a targeted fix, not redesigning validation

## Decisions

### 1. CORS: Add Content-Range to expose list

Add `Content-Range` to the `Access-Control-Expose-Headers` value in `server.ts:132`.

**Alternative considered:** Per-route CORS for `/rest/v1/*` only. Rejected — `Content-Range` is a standard HTTP header, no reason to restrict it.

### 2. JWT: Add email claim

Add `email: user.email` to all three `jwt.sign()` calls in `auth.ts` (password login, OAuth, token refresh). The claim is read directly from the `internal.users` row already fetched in each flow — no extra query.

**Alternative considered:** Have `getUser()` fetch email from DB via service key. Rejected — adds latency, requires network call from Lambda, and the email is already known at token-signing time. Email changes are rare and the token expires in 1h.

### 3. getUser(): Return email from JWT

Change both `getUser()` implementations (Lambda layer + local dev inline) to return `{ id: payload.sub, role: payload.role, email: payload.email }`.

**Backwards compatibility:** Existing functions that destructure `{ id, role }` will continue to work — `email` is additive. Functions already deployed with old layer code won't have `email` until the layer is redeployed, but the JWT will already contain it — the field will just be `undefined` until the layer catches up.

### 4. SQL filter: Drop `role` from SET blocklist

Change the regex from `/\bSET\s+(search_path|role)\b/i` to `/\bSET\s+search_path\b/i` in both `admin.ts` and `bundle.ts`.

**Alternative considered:** Smarter regex with `^\s*SET` or negative lookbehind for UPDATE. Rejected — the `SET role` block is defense-in-depth and the real boundary (search_path pre-set + transaction wrapping) is solid. `role` is too common a column name to block. `SET search_path` remains blocked as it's both dangerous and almost never a legitimate column name.

## Risks / Trade-offs

- **[JWT size +~30 bytes]** → Negligible. JWTs are already ~200 bytes; email adds ~30. Well within header limits.
- **[Stale email in token]** → Mitigated by 1h token expiry. If email changes mid-session, the old token keeps working but shows old email. Acceptable — same trade-off Supabase makes.
- **[Removing `SET role` block]** → Low risk. The `SET role` PostgreSQL command is already neutralized by the transaction wrapper and pre-set search_path. Even if user SQL runs `SET role = 'postgres'`, it's scoped to the transaction and the `pre_request` hook revalidates on next PostgREST call.
- **[Lambda layer rebuild required]** → Must publish new layer and redeploy CDK for the `getUser()` change to take effect in Lambda. Gateway-side changes deploy via normal CI.
