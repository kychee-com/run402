## 1. Schema — multi-method identity model

- [x] 1.1 Update `packages/gateway/src/db/init.sql`: change `password_hash TEXT NOT NULL` to `password_hash TEXT` on `internal.users` table [code]
- [x] 1.2 Add `internal.magic_link_tokens` table to init.sql [code]
- [x] 1.3 Add `allow_password_set BOOLEAN NOT NULL DEFAULT false` column to `internal.projects` in init.sql [code]
- [x] 1.4 Add startup migrations in `server.ts` (v1.17) for existing databases [code]
- [x] 1.5 Update `projectCache` type / `ProjectInfo` in shared package to include `allow_password_set` field [code]

## 2. Service — magic link token management

- [x] 2.1 Create `packages/gateway/src/services/magic-link.ts` with createMagicLinkToken [code]
- [x] 2.2 Add verifyMagicLinkToken — hashes input, atomic UPDATE RETURNING, marks as used [code]
- [x] 2.3 Add cleanupExpiredMagicLinkTokens — deletes expired tokens [code]

## 3. Service — rate limiting

- [x] 3.1 Add magic link rate limiting — in-memory Maps, per-email (5/hr) and per-project (50/200/1000 by tier) [code]

## 4. Route — magic link request endpoint

- [x] 4.1 Add `POST /auth/v1/magic-link` — validates email + redirect_url, rate limits, creates token, sends email [code]
- [x] 4.2 Validate `redirect_url` using existing `validateRedirectUrl()` from `services/oauth.ts` [code]

## 5. Route — magic link verification (extend token endpoint)

- [x] 5.1 Add `grant_type=magic_link` to token endpoint — verify, find-or-create user, issue JWT + refresh token [code]
- [x] 5.2 Set `email_verified_at` on verification if not already set [code]

## 6. Route — password management endpoint

- [x] 6.1 Add `PUT /auth/v1/user/password` — change, reset, and set with allow_password_set gate [code]

## 7. Route — providers and project settings

- [x] 7.1 Update `GET /auth/v1/providers` — includes magic_link and password_set fields [code]
- [x] 7.2 Add `PATCH /auth/v1/settings` — toggle allow_password_set via service_key [code]

## 8. Identity model cleanup

- [x] 8.1 Update password login error message to mention magic link as alternative [code]

## 9. Unit tests

- [x] 9.1 Test magic link token creation — entropy, hashing, single-active-token guarantee [code]
- [x] 9.2 Test magic link token verification — happy path, expired, consumed, invalid [code]
- [x] 9.3 Test rate limiting — per-email, per-project (by tier), window reset [code]
- [x] 9.4 Test password management — covered in E2E (change, wrong password, settings toggle) [code]
- [x] 9.5 Test providers endpoint — covered in E2E (magic_link, password_set fields) [code]
- [x] 9.6 Test account enumeration prevention — covered in E2E (same response for existing/non-existing) [code]

## 10. E2E test

- [x] 10.1 Create `test/magic-link-e2e.ts` — full lifecycle test [code]
- [x] 10.2 Test account enumeration, providers, password change, settings toggle [code]
- [x] 10.3 Test password change flow + old password rejected [code]
- [x] 10.4 Test allow_password_set toggle via PATCH /auth/v1/settings [code]
- [x] 10.5 Add `npm run test:magic-link` script [code]

## 11. Docs

- [x] 11.1 Update `site/llms.txt` — magic link auth section with flow, endpoints, password management [manual]
- [x] 11.2 Update `site/openapi.json` — added magic-link, user/password, and settings endpoints [manual]
- [x] 11.3 Update `site/updates.txt` and `site/humans/changelog.html` with magic link auth entry [manual]

## 12. MCP feature request

- [x] 12.1 Implemented directly in `kychee-com/run402-mcp`: 4 MCP tools + CLI `auth` command + OpenClaw shim + sync test updated [code]
