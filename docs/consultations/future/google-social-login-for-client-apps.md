# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-16T09:54:31.247772
**Completed**: 2026-03-16T10:17:43.948448
**Status**: completed

---

Yes — I’d build this as a **Run402-managed OAuth broker** for project apps.

## The core idea

Use **one central Google OAuth flow owned by Run402**, with a fixed callback on `api.run402.com`, then hand the result back to the client app (`my-app.run402.com`) using a **short-lived one-time auth code**, not tokens in the URL.

That gives you the Lovable-style UX:

- user clicks **Continue with Google** inside `my-app.run402.com`
- Google says they’re signing in with **Run402**
- Run402 verifies Google identity
- Run402 creates/links a **project-scoped user**
- app gets the normal Run402 `access_token` + `refresh_token`

This is the cleanest fit for your current architecture.

---

# Recommendation in one sentence

**Treat Run402 as the identity broker for app users, not Google directly.**

That means:

- Google authenticates the person **to Run402**
- Run402 turns that into a **project user session**
- apps keep using your existing auth/token model

---

# Why this is the right design for Run402

## It fits your multi-tenant model
Users are scoped to a project today. Keep that.

A Google account signing into:

- `app-a.run402.com`
- `app-b.run402.com`

should create or map to **separate project users**, not a global shared app-user account.

So identity uniqueness should be:

- `project_id`
- `provider`
- `provider_user_id` (`google sub`)

## It avoids per-project Google setup
If every app had to register its own Google redirect URI / JS origin, this becomes painful fast, especially for agent-created apps.

With a central broker:

- Google only knows one callback:
  - `https://api.run402.com/auth/v1/oauth/google/callback`
- project apps only need to be in a **Run402 allowlist of redirect origins**
- works for `*.run402.com` now and custom domains later

## It matches your current token model
You already issue:

- access JWT
- refresh token

Don’t invent a second session system. Social login should end by issuing the **same session shape** as password login.

---

# Decision: auto-enable for all projects, no config API

After reviewing the consultation, we decided to **skip per-project config entirely** for v1.

## What this eliminates
- `project_auth_providers` table — not needed
- `project_auth_redirect_origins` table — not needed
- `PATCH /auth/admin/v1/config` endpoint — not needed
- MCP tool for enabling/disabling — not needed

## v1 rules (hardcoded)
- Google OAuth: **on for all projects**
- Allowed redirect origins: **auto-derived from claimed subdomains** (`https://{name}.run402.com`) + `http://localhost:*` always allowed
- Signup via Google: **always allowed**
- Auto-link by email: **off** (safe default, no config needed)
- Email domain restrictions: **none** (v2 if needed)

## Why this is fine
- If a project doesn't put a Google button in their frontend, the flow is never triggered — no harm
- The subdomain claim already serves as the implicit allowlist registration
- Email domain restrictions are a niche v2 feature
- Per-project toggles can be added later behind a config table if demand emerges
- This means agents get Google login the moment they claim a subdomain — **truly zero-config**

## Impact on CLI/MCP
- **MCP tools unaffected** — `provision_postgres_project`, `run_sql`, etc. work exactly as before
- Social login is a browser flow (popup/redirect) for **end-users of apps**, not for agents managing Run402
- No new MCP tool needed since there's no config to toggle
- Testing from CLI requires a browser (Playwright/E2E), can't test popup flow from terminal
- Existing password auth (`/auth/v1/signup`, `/auth/v1/token`) stays exactly as-is

## New Google API credentials required
- Register a **separate** OAuth client in Google Cloud Console for end-user auth (distinct from admin dashboard client)
- Callback URL: `https://api.run402.com/auth/v1/oauth/google/callback`
- New env vars: `GOOGLE_APP_CLIENT_ID`, `GOOGLE_APP_CLIENT_SECRET`

---

# Important: do **not** reuse the admin Google OAuth implementation as-is

The admin flow is fine for internal staff login, but it is **not** the right implementation for app-user auth.

For client app auth, you need stronger guarantees:

- fixed callback URL, not host-derived
- DB-backed state, not just cookie state
- project scoping
- one-time code handoff to app
- OIDC ID token validation, not just `userinfo`
- account linking rules
- redirect allowlists

So: **reuse the pattern, not the code**.

Also: I strongly recommend a **separate Google OAuth client** for end-user app auth, distinct from the admin dashboard client.

---

# High-level flow

```text
my-app.run402.com
  -> POST https://api.run402.com/auth/v1/oauth/google/start   (apikey + redirect_to + PKCE challenge)
  <- { authorization_url }

browser/popup
  -> Google OAuth
  -> GET https://api.run402.com/auth/v1/oauth/google/callback?code=...&state=...

Run402 callback
  -> exchange Google code
  -> verify ID token
  -> find/create/link project user
  -> mint short-lived Run402 auth code
  -> return to app via popup postMessage or URL fragment

my-app.run402.com
  -> POST https://api.run402.com/auth/v1/token?grant_type=authorization_code
     (apikey + auth code + PKCE verifier)
  <- access_token + refresh_token + user
```

---

# Product shape I’d ship

## App-facing endpoints

### 1. Discover providers
`GET /auth/v1/providers`

Headers:
- `apikey: <anon_key>`

Response:
```json
{
  "password": { "enabled": true },
  "oauth": [
    {
      "provider": "google",
      "enabled": true,
      "display_name": "Google"
    }
  ]
}
```

This is important for agent-generated frontends.

---

### 2. Start Google login
`POST /auth/v1/oauth/google/start`

Headers:
- `apikey: <anon_key>`
- `Content-Type: application/json`
- optional `Authorization: Bearer <user access token>` when intent is linking

Body:
```json
{
  "intent": "signin",
  "flow": "popup",
  "redirect_to": "https://my-app.run402.com/",
  "code_challenge": "base64url(sha256(verifier))",
  "code_challenge_method": "S256",
  "client_state": "opaque-app-state",
  "prompt": "select_account",
  "login_hint": "alice@example.com"
}
```

Response:
```json
{
  "provider": "google",
  "authorization_url": "https://accounts.google.com/o/oauth2/v2/auth?...",
  "expires_in": 600
}
```

Notes:

- `flow`: `"popup"` or `"redirect"`
- `redirect_to` must match an allowed origin for the project
- `client_state` is just for the app, not security-critical
- `code_challenge` is for the **Run402 auth code exchange**, not Google

---

### 3. Exchange Run402 auth code for session
Extend your existing token endpoint:

`POST /auth/v1/token?grant_type=authorization_code`

Headers:
- `apikey: <anon_key>`
- `Content-Type: application/json`

Body:
```json
{
  "code": "<run402_one_time_code>",
  "code_verifier": "<original_pkce_verifier>"
}
```

Response:
```json
{
  "access_token": "jwt",
  "token_type": "bearer",
  "expires_in": 3600,
  "refresh_token": "uuid-or-random-token",
  "user": {
    "id": "uuid",
    "email": "alice@example.com",
    "email_verified": true,
    "display_name": "Alice",
    "avatar_url": "https://..."
  },
  "provider": "google"
}
```

This should look like password login so apps don’t need two auth systems.

---

### 4. Link Google to existing account
Use the same start endpoint with:

```json
{
  "intent": "link",
  ...
}
```

and require:

- `apikey`
- authenticated user bearer token for the current project

This is how existing password users safely add Google.

---

## Admin / project config endpoints

**DECISION: Skipped for v1.** See "Decision: auto-enable for all projects" section above.

Google OAuth is on for all projects. Redirect origins are auto-derived from claimed subdomains + localhost. No config API needed.

---

# Data model changes

## 1. `internal.users`
Change this table so social-only users can exist.

Add:

- `password_hash` nullable
- `email_verified_at timestamptz null`
- `display_name text null`
- `avatar_url text null`
- `last_sign_in_at timestamptz null`

Also fix email normalization.

I would strongly recommend making email uniqueness **case-insensitive**:
- either `citext`
- or `email_normalized = lower(email)`

Because social login will make this more noticeable.

---

## 2. `internal.auth_identities`
New table:

- `id`
- `project_id`
- `user_id`
- `provider` (`google`)
- `provider_user_id` ← Google `sub`
- `email`
- `email_verified`
- `created_at`
- `updated_at`
- `last_sign_in_at`

Unique:
- `(project_id, provider, provider_user_id)`

This is the real identity table.

**Use Google `sub`, not email, as the stable identity key.**

---

## ~~3. `internal.project_auth_providers`~~ — SKIPPED for v1
Per-project config not needed. Google is on for all projects.

## ~~4. `internal.project_auth_redirect_origins`~~ — SKIPPED for v1
Redirect origins are auto-derived from claimed subdomains (`https://{name}.run402.com`) + `http://localhost:*` always allowed. No separate table needed — resolve at runtime from the existing `internal.subdomains` table.

---

## 5. `internal.oauth_transactions`
Short-lived start/callback transaction table:

- `id`
- `project_id`
- `provider`
- `intent` (`signin`, `link`)
- `user_id` nullable for linking
- `redirect_to`
- `redirect_origin`
- `flow` (`popup`, `redirect`)
- `client_state`
- `client_code_challenge`
- `client_code_challenge_method`
- `provider_code_verifier`
- `provider_nonce`
- `expires_at`
- `used_at`
- `created_at`

This must be DB-backed, not in memory, because you’re on ECS.

---

## 6. `internal.oauth_codes`
One-time auth codes returned to the app.

Store:

- `code_hash`
- `project_id`
- `user_id`
- `provider`
- `redirect_origin`
- `client_state`
- `code_challenge`
- `code_challenge_method`
- `expires_at`
- `used_at`
- `created_at`

Store the **hash**, not the raw code.

TTL: ~60 seconds.

---

# Account resolution rules

This is where a lot of platforms get into trouble.

## Safe rule set

When Google callback succeeds:

### Case 1: identity already linked
If `(project_id, google, sub)` exists:
- sign in that user

### Case 2: link flow
If intent is `link` and caller is already signed in:
- if identity belongs to same user: no-op success
- if identity belongs to another user: error `identity_already_linked`
- else link it

### Case 3: existing password user with same email
If same normalized email exists in the project:

- **v1: always return `account_exists_requires_link`** (auto-link is off globally)
- user must explicitly link via the link flow

### Case 4: no existing account
- create new user (signup always allowed in v1)
- insert identity
- mark `email_verified_at` if Google says verified

## My recommendation
For v1, **do not auto-link password accounts by email unless the existing email is verified**.

Since your current password flow has no email verification, silent email-based merges are risky.

---

# Callback behavior

## Default: popup mode
Best UX.

The callback returns a tiny HTML page on `api.run402.com` that does:

- `window.opener.postMessage(...)` to exact allowed origin
- then closes the popup

Message payload:
```json
{
  "source": "run402-auth",
  "type": "oauth_result",
  "code": "...",
  "state": "opaque-app-state",
  "provider": "google"
}
```

On error:
```json
{
  "source": "run402-auth",
  "type": "oauth_error",
  "error": "access_denied"
}
```

## Fallback: redirect mode
Redirect to:

```text
https://my-app.run402.com/#code=...&state=...
```

Use **fragment**, not query string.

Why:
- avoids server logs
- avoids referer leakage
- easier for SPAs

---

# Security requirements

These are the big ones.

## 1. Use OIDC properly
Don’t just call Google `userinfo`.

Verify the `id_token`:

- signature via Google JWKS
- `iss`
- `aud`
- `exp`
- `nonce`

Use scopes:
- `openid email profile`

Do **not** request offline access.

---

## 2. Use a fixed callback URL
Do not derive callback host from request headers.

Use config:
- `PUBLIC_API_URL=https://api.run402.com`

Then callback is always:
- `https://api.run402.com/auth/v1/oauth/google/callback`

---

## 3. DB-backed state, not cookies/in-memory
Your admin route uses cookie state. For app-user OAuth, use:

- signed `state`
- plus DB transaction row
- 10 minute TTL
- one-time consumption

This works across ECS instances.

---

## 4. Use PKCE for the Run402 -> app code exchange
This is important.

The Google leg is server-side, but the **Run402-issued auth code** is being delivered to a browser app. Treat that as a public client flow and protect it with PKCE.

The SDK can hide all of this.

---

## 5. Never put access tokens in the callback URL
No:
- `?access_token=...`
- `#access_token=...`

Only return a short-lived one-time code.

---

## 6. Strict redirect allowlists
Validate `redirect_to`:

- exact allowed origin
- `https` only in prod
- allow `http://localhost:...` only if configured
- no wildcards from user input

Bonus hardening:
- if `Origin` header exists on `start`, require it to match `redirect_to.origin`

---

## 7. Store identity by Google `sub`
Emails can change. `sub` is stable.

---

## 8. Do not store Google tokens
For sign-in-only use, discard:
- Google access token
- Google refresh token

Only keep identity metadata you need.

---

## 9. Rate limit
At minimum:

- `/oauth/google/start`
- `/token?grant_type=authorization_code`
- password login
- refresh

Rate-limit per:
- IP
- project
- maybe email/provider subject

---

## 10. `Cache-Control: no-store`
On:

- `/auth/v1/token`
- callback pages
- any auth-code response

---

## 11. Enforce project_id everywhere
This is big.

Before shipping social login, fix your existing auth checks so all user-token flows verify:

- token `project_id === req.project.id`
- DB lookups include `project_id`

Your current `/auth/v1/user` route should be tightened:
- query by `id AND project_id`
- reject mismatched token project

That’s a real multi-tenant hardening step.

---

## 12. Apply signup quotas/demo limits
Social login can create users, so it must go through the same quota logic as password signup.

Don’t let OAuth bypass demo caps.

---

# UX / DX for agents

This should be nearly zero-config.

## Best developer experience
1. Agent provisions project
2. Agent claims subdomain
3. Frontend uses one helper (Google auth is already enabled, origin auto-derived from subdomain):

```ts
await run402.auth.signInWithOAuth({ provider: "google" });
```

SDK responsibilities:

- generate PKCE verifier/challenge
- call `/oauth/google/start`
- open popup
- listen for `postMessage`
- exchange code
- return session

That’s the right abstraction for agent-generated apps.

## Also expose raw HTTP
Because Run402 is API-first, keep the whole flow usable without SDK.

---

# Strong product recommendation

If you want this to feel polished like Lovable:

## Add a tiny hosted auth callback UI
On callback success/failure, show:

- app name / subdomain
- “Signing you in to `my-app.run402.com` via Run402”
- spinner or close-popup message

This matters because Google consent will say **Run402**, not the app name.

You can derive display name from:
- claimed subdomain
- project metadata
- optional `app_name`

---

# Suggested rollout plan

## Phase 0: hardening
Before social login:
- register separate Google OAuth client for end-user auth (`GOOGLE_APP_CLIENT_ID` / `GOOGLE_APP_CLIENT_SECRET`)
- add fixed `PUBLIC_API_URL` config
- fix project-scoped bearer validation (`/auth/v1/user` should query by `id AND project_id`)
- normalize emails case-insensitively

## Phase 1: Google sign-in (v1)
Ship:
- `GET /auth/v1/providers` — static response (password + google always on)
- `POST /auth/v1/oauth/google/start` — initiate flow
- `GET /auth/v1/oauth/google/callback` — Google callback
- `POST /auth/v1/token?grant_type=authorization_code` — exchange code
- `auth_identities` table
- `oauth_transactions` + `oauth_codes` tables
- popup + redirect flows
- auto-link off, signup always on, origins from subdomains + localhost
- no per-project config API

## Phase 2: account linking
Ship:
- signed-in user can link/unlink Google via `intent: "link"`
- providers included in `/auth/v1/user` response

## Phase 3: per-project config (if needed)
- `project_auth_providers` table + config endpoint
- email domain restrictions
- disable Google per project

## Phase 4: more providers
Then GitHub / Apple / Microsoft become straightforward.

---

# v1 defaults (decided)

- Google provider: **on for all projects** (no config needed)
- Signup via Google: **always allowed**
- Account linking: **explicit only** (no auto-link by email)
- Redirect origins: **auto-derived from subdomains** + `http://localhost:*`
- Flow default: **popup**
- Callback response mode: **postMessage**, fallback fragment
- Auth transaction TTL: **10 min**
- Auth code TTL: **60 sec**
- Google scopes: **openid email profile**
- Token response shape: **same as password login**
- Per-project config API: **none** (v2/phase 3 if demand)

---

# The one-line architecture summary

**Use Google only to prove identity to Run402; let Run402 remain the issuer of project-scoped user sessions.**

That gives you:

- secure multi-tenant isolation
- easy agent ergonomics
- no per-project Google setup
- compatibility with your existing auth/JWT/refresh-token model
- room to add more providers later

If you want, I can turn this into a **concrete OpenAPI spec + SQL migrations + Express route plan** tailored to your current codebase.

---
**Wall time**: 23m 12s
**Tokens**: 9,104 input, 36,738 output (32,835 reasoning), 45,842 total
**Estimated cost**: $6.8860
