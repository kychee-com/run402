## Why

Run402's auth system supports password signup and Google OAuth, but has no passwordless email flow. The `magic_link` email template exists in `email-send.ts` but there's no endpoint to request or consume magic links. Products built on run402 that need email-only authentication (no password, no social login) have to build their own auth layer.

Additionally, the `internal.users` schema declares `password_hash NOT NULL` in `init.sql`, but the OAuth flow already inserts `NULL` (relying on a runtime ALTER TABLE migration). This inconsistency needs a clean fix: users should be able to exist with any combination of auth methods (password, OAuth, magic link).

## What Changes

- **Gateway**: New `POST /auth/v1/magic-link` endpoint that accepts an email and `redirect_url`, generates a one-time token, and sends the magic link email pointing to the project's frontend. New `grant_type=magic_link` flow on the existing `POST /auth/v1/token` endpoint that verifies the token, auto-creates users if needed, and issues access + refresh tokens.
- **Password management**: New `PUT /auth/v1/user/password` endpoint for password change (existing password users) and password reset (magic link → set new password). Password-set for passwordless users is gated by a project-level `allow_password_set` setting (default: false). Projects that don't enable it (e.g., one-time signing flows) keep their users passwordless.
- **Identity model**: `password_hash` becomes officially nullable in the schema. Users can exist with any combination of auth methods. The `/auth/v1/providers` endpoint reports magic link availability.
- **Rate limiting**: Per-email (5/hr) and per-project (scaled by tier: 50/200/1000 per hour) rate limits prevent email bombing via the magic link endpoint.
- **Security**: Tokens are SHA-256 hashed at rest (same pattern as OAuth state/codes). Response is identical for existing vs new emails (no account enumeration). Single active token per email per project.
- **Cleanup**: Expired magic link tokens purged by the existing OAuth cleanup job.
- **Docs**: Update `llms.txt` with magic link auth documentation.
- **MCP**: File a GitHub feature request on `kychee-com/run402-mcp` for `auth_magic_link_request` and `auth_magic_link_verify` tools.
- **BREAKING**: `password_hash` column becomes nullable. The password login flow already handles `NULL` password_hash (returns "use social login" error), now updated to also mention magic link.

## Non-goals

- Frontend magic link UI (individual projects build their own)
- SMS or WhatsApp verification (separate feature if needed later)
- Passwordless WebAuthn/passkeys (different authentication model)
- Custom email template customization per project (uses the existing `magic_link` template)

## Capabilities

### New Capabilities

- `magic-link-auth`: Passwordless email authentication. Request a magic link via API, receive it by email, verify the token to get an access + refresh token. Auto-creates users on first use. Rate-limited per email and per project. Tokens are single-use, time-limited (15 min default), and hashed at rest. The magic link URL points to the project's own frontend (via `redirect_url`), which then calls the verification endpoint.
- `password-management`: Password change, reset, and initial set for project users. Change requires current password. Reset works via magic link (login → set new password). Initial password-set for passwordless users gated by project-level `allow_password_set` setting (default off).

### Modified Capabilities

- `multi-method-identity`: Users can now exist with any combination of password, OAuth, and magic link authentication. `password_hash` is officially nullable. The providers endpoint reports all available auth methods. Fixes the init.sql / runtime schema inconsistency for OAuth-created users.

## Impact

- **Gateway** (`packages/gateway/src/`): New route handler for `/auth/v1/magic-link` (with `redirect_url` validation via existing `validateRedirectUrl`), extended `grant_type` handling in `/auth/v1/token`, new `PUT /auth/v1/user/password` endpoint, updated `/auth/v1/providers` response. New service module for magic link token management and rate limiting.
- **Database**: New `internal.magic_link_tokens` table (token_hash, email, project_id, expires_at, used). `password_hash` made nullable in init.sql. New rate limit tracking (in-memory or DB-backed).
- **Email**: Uses existing `magic_link` template in `email-send.ts` — no template changes needed.
- **Tests**: Unit tests for token generation, verification, rate limiting, account enumeration prevention. E2E test for full magic link round-trip (request → email → verify → authenticated).
- **Docs**: `site/llms.txt` gains magic link auth section. `site/openapi.json` gains `/auth/v1/magic-link` endpoint.
- **MCP repo**: GitHub issue on `kychee-com/run402-mcp` requesting `auth_magic_link_request` and `auth_magic_link_verify` tools.
