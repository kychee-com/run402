## 0. Gateway wire-shape verification (blocking pre-req)

- [ ] 0.1 Against a live/staging gateway — or by reading `packages/gateway/src/routes/write-auth.ts` + `services/write-auth.ts` on run402-private `origin/main` — confirm the exact request+response shapes of `POST /agent/v1/control-plane/write-auth/challenges` (returns `confirm_url`/`redirect_to`? `delivery`? `challenge_id`?) and `POST /agent/v1/control-plane/write-auth/cli/token` (`write_auth_token`, `token_type`, `header`, `expires_in`, `session`?). Confirm the `403 WRITE_AUTH_REQUIRED` envelope and that SIWX wallet auth still provisions/deploys with **no** write-auth token. Pin the real field names before coding the seams + cache.

## 1. core — write-auth token cache

- [ ] 1.1 Add `core/src/write-auth-session.ts` mirroring `control-plane-session.ts`: `WriteAuthSessionCache { write_auth_token, token_type, header, principal_id, amr, expires_at }`, `getWriteAuthSessionPath()` (`{base}/write-auth-session.json`, `RUN402_WRITE_AUTH_SESSION_PATH` override), `read/save/clear/isExpired/loadLiveWriteAuthSession`, `writeAuthSessionFromTokenResponse` (relative `expires_in` → absolute `expires_at`), `selfHealPermissions`, atomic 0600 write.
- [ ] 1.2 Add `core/src/write-auth-session.test.ts` (round-trip, expiry, corrupt-shape throw, 0600 perms), mirroring `control-plane-session.test.ts`.

## 2. SDK — ceremony seams + types

- [ ] 2.1 In `sdk/src/namespaces/operator.ts`, add a `WriteAuth` sub-class — `requestChallenge({ cliRedirectUri, codeChallenge, state, token? })` → `POST /agent/v1/control-plane/write-auth/challenges`; `exchangeClaimCode({ code, codeVerifier, state, token? })` → `POST /agent/v1/control-plane/write-auth/cli/token` — exposed as `r.operator.writeAuth`. Keep isomorphic (no `fs`/`http`); honor an explicit `token` over the default credential (like the claim seams).
- [ ] 2.2 Add request/response types (`WriteAuthChallengeInput`/`Result`, `WriteAuthClaimInput`, `WriteAuthTokenResponse`) using the field names confirmed in 0.1; export the public ones from the SDK type-surface entry.

## 3. SDK — error mapping

- [ ] 3.1 Add `WriteAuthRequiredError` to `sdk/src/errors.ts` (extends the `Run402Error` base; carries status/body/context; message points at `run402 operator write-auth`).
- [ ] 3.2 In `sdk/src/kernel.ts`, add a `res.status === 403 && envelopeCode(resBody) === "WRITE_AUTH_REQUIRED"` branch **before** the generic 401/403 → `Unauthorized`, throwing `WriteAuthRequiredError`. Export it from `index.ts`.

## 4. SDK/Node — dual-header injection

- [ ] 4.1 Extend `NodeCredentialsProvider.getAuth(path)` in `sdk/src/node/credentials.ts`: if allowance headers exist, return them unchanged; else if `loadLiveControlPlaneSession()` returns a session, return `{ Authorization: "Bearer <token>" }` and, when `loadLiveWriteAuthSession()` is present, add `{ "X-Run402-Write-Auth": "Bearer <token>" }`. Import the core loaders via `../../core-dist/`.
- [ ] 4.2 Add `getAuth` cases to `sdk/src/node/credentials.test.ts`: wallet present → unchanged; wallet-less + session + token → dual header; wallet-less + session only → bearer only; expired write-auth token → no `X-Run402-Write-Auth`.

## 5. CLI — operator write-auth verb + wallet-less writes

- [ ] 5.1 In `cli/lib/operator.mjs`, add a `write-auth` verb reusing `generatePkce` + the loopback server: require a live control-plane session (else fail with guidance to `login --loopback`), `requestChallenge`, open `confirm_url` (respect `--no-open`), capture `code`+`state`, verify `state`, `exchangeClaimCode`, `saveWriteAuthSession`; JSON to stdout.
- [ ] 5.2 Add the verb to the help text + `assertKnownFlags`; extend `logout` to `clearWriteAuthSession()` so `operator logout` clears both caches.
- [ ] 5.3 Confirm `provision` / `deploy apply` need no command change (the dual header rides via `getAuth`); ensure `WriteAuthRequiredError` flows through `reportSdkError` with the remediation hint intact.

## 6. Docs

- [ ] 6.1 Fix the stale `core/src/control-plane-session.ts` header comment — drop SIWX-equivalence-for-writes; note the write-auth-token requirement for `provision`/`deploy`.
- [ ] 6.2 Document the dual-credential wallet-less write path, the `run402 operator write-auth` ceremony, and the `WRITE_AUTH_*` codes in `cli/llms-cli.txt` and `sdk/llms-sdk.txt`.

## 7. Tests + sync

- [ ] 7.1 SDK unit tests for the `writeAuth` seams (mock fetch: correct paths/bodies/bearer) and the `403 WRITE_AUTH_REQUIRED` → `WriteAuthRequiredError` mapping.
- [ ] 7.2 CLI e2e (`cli-operator-write-auth.test.mjs`): stub the gateway seams + drive the loopback redirect locally; assert the token is cached and a follow-up request carries the dual header; assert the no-session guidance path. Register the file in the `package.json` test allow-list.
- [ ] 7.3 If `operator:write-auth` is tracked in `sync.test.ts` `SURFACE`, add the row + `SDK_BY_CAPABILITY` mapping and keep CLI/OpenClaw parity; otherwise note why it is excluded (browser ceremony, like `operator login`).
- [ ] 7.4 `npm test` green; `npm run build` + `npm run build:core` clean (the new core file compiles into `core-dist/`).
