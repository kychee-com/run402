## 0. Gateway wire-shape + binding verification (blocking pre-req)

- [x] 0.1 Verified against run402-private `origin/main` (`routes/write-auth.ts`, `middleware/write-auth.ts`, `services/write-auth.ts`). **KEY FINDING — the token is action+target-scoped (D3), not a generic approval.** Pinned shapes:
  - `POST .../write-auth/challenges` (cp-session authed) request `{ action: "org.project.create"|"project.deploy"|"project.secret.write" (REQUIRED), org_id (for org-scoped), project_id (for project-scoped), cli_redirect_uri?, code_challenge? (S256), state?, app_origin? }` → `201 { challenge_id, confirm_url, expires_at, action, org_id, project_id, delivery: "cli_loopback"|"postmessage", next_action }`.
  - `POST .../write-auth/cli/token` request `{ code, code_verifier, state }` (**NO redirect_uri** — bound at challenge) → `201 { write_auth_token, token_type: "write_auth", header: "X-Run402-Write-Auth", session }`. **Token expiry lives in `session`.**
  - Header read as `X-Run402-Write-Auth: Bearer <token>` or bare. Capabilities: `org.project.create` (scope=org), `project.deploy`/`project.secret.write` (scope=project). Target gate → `403 WRITE_AUTH_BINDING_MISMATCH`; also `WRITE_AUTH_REQUIRED` / `WRITE_AUTH_SESSION_INVALID` / `WRITE_AUTH_DISABLED`; the `WRITE_AUTH_REQUIRED` envelope is `{ code, error, hint }` (synthesize `next_actions` client-side).
  - Principal selection: write-auth required ONLY for a cp-session bearer (`SIGN-IN-WITH-X` wallet never gated) — wallet path confirmed unaffected.
  - **Still to verify on a LIVE gateway before publishing:** that non-gated routes ignore a malformed/expired approval on reads + don't refresh idle TTL; redirects never forward auth headers off-origin; the exact `session` expiry field name (the cache parses `expires_at`/`absolute_expires_at` defensively, falling back to a 30-min TTL).

---

## PR 1 — Auth plumbing

## 1. Kernel header hardening

- [x] 1.1 `sdk/src/kernel.ts`: case-insensitive `hasHeader(fetchHeaders, k)` merge.
- [x] 1.2 Credential-family atomicity (`AUTH_HEADER_NAMES`); request-owned auth suppresses provider auth. Widened `RequestOptions.authMeta` + `getAuth(path, metadata?)`. 19/19 kernel tests.

## 2. SDK credentials — surface, authMode, deterministic resolution

- [x] 2.1 `credentials.ts`: `getAuth(path, metadata?: AuthRequestMeta { method?, capability?, target? })`; `WriteAuthCapability`/`WriteAuthTarget` types. Threaded `capability`+`target` from `projects.provision` (org.project.create+org) and `deploy.plan`/`deploy.commit` (project.deploy+project).
- [x] 2.2 `NodeCredentialsProvider` gains `{ surface, authMode }` + `resolveAuthMode()` (cli→auto; mcp/sdk→wallet) + deterministic resolution (one class, no silent inter-class fallback).
- [x] 2.3 `auto`/`operator` mode with no wallet → cp-session bearer; `wallet`/MCP never reads the cp/approval caches.
- [x] 2.4 MCP `src/sdk.ts` → `surface:"mcp"`; CLI `cli/lib/sdk.mjs` → `surface:"cli"`. (5 getAuth resolution-matrix tests.)

## 3. SDK — OperatorApprovalRequiredError

- [x] 3.1 `errors.ts`: `OperatorApprovalRequiredError` (`kind`, `principal`, `capability`, `target`, `approveCommand`, synthesized `nextActions`) + `isOperatorApprovalRequired` guard.
- [x] 3.2 `kernel.ts` maps `403` + `{WRITE_AUTH_REQUIRED, WRITE_AUTH_BINDING_MISMATCH, WRITE_AUTH_SESSION_INVALID}` → it, with a resolved `run402 operator approve …` command. Exported from `index.ts` + the node entry. (2 mapping tests.)
- [x] 3.3 Deterministic resolution returns one class; the kernel error names the class via `WRITE_AUTH_*` codes.

## 4. CLI — operator status + plumbing (PR 1)

- [x] 4.1 `run402 operator status` — JSON `{ operator_login, approvals[] }` (action, target, expiry).
- [x] 4.2 `provision`/`deploy` surface `OperatorApprovalRequiredError` (with `approveCommand`) via `reportSdkError` / the typed error.
- [x] 4.3 `sync.test.ts` SURFACE rows `operator_approve` / `operator_status` + `SDK_BY_CAPABILITY` + `exchangeClaimCode` in the ceremony-seam allowlist; sync green.

---

## PR 2 — Approval ceremony

## 5. core — approval token cache with binding

- [x] 5.1 `core/src/write-auth-session.ts`: multi-entry list keyed per `(api_origin, control_plane_session_hash, action, target)`; `saveApproval` (per-key replace, keeps others), `clearApprovals`, `loadLiveApproval`, `approvalFromTokenResponse` (expiry from `session`), `hashControlPlaneSession`.
- [x] 5.2 `core/src/write-auth-session.test.ts` — 10 cases (multi-entry coexist/replace, exact-match, non-match → null, expiry, corrupt-shape throw, 0600). Pass.

## 6. SDK — operator-approval ceremony seams (hardened)

- [x] 6.1 `r.operator.approval` — `requestChallenge({ action, orgId?, projectId?, cliRedirectUri, codeChallenge, state, token? })` + `exchangeClaimCode({ code, codeVerifier, state })` (no redirect_uri, unauth). Isomorphic. (2 seam tests.)
- [x] 6.2 Public types exported via the `export type *` wildcard.

## 7. SDK/Node — gated approval attachment

- [x] 7.1 `NodeCredentialsProvider.getAuth` attaches `X-Run402-Write-Auth` only when operator-mode + `metadata.capability`+`target` exactly match a live cached approval (origin/cp-session bound). Fails closed otherwise.
- [x] 7.2 Tests: match → dual header; read/no-capability → cp-bearer only; wrong-target → cp-bearer only.

## 8. CLI — operator approve, lifecycle invalidation, TTY auto-approve

- [x] 8.1 `run402 operator approve --action <cap> (--org|--project <id>)` (+ hidden `write-auth` alias) — validates action↔scope, requires a live cp-session, `requestChallenge` scoped, validates `confirm_url` same-origin, validates `state`, `exchangeClaimCode`, `saveApproval`, never prints the token, JSON out.
- [x] 8.2 Lifecycle invalidation: `operator login`/`--step-up` clears prior approvals before saving the new session; `operator logout` clears them.
- [x] 8.3 `withAutoApprove(fn)`: on `OperatorApprovalRequiredError` + TTY + CLI surface, derive `(action, target)`, run the scoped ceremony, retry once; never in MCP/CI/non-TTY. Wired into `provision` + `deploy apply` (which now tolerate a wallet-less operator session instead of hard-exiting on a missing wallet).

## 9. Docs

- [x] 9.1 Corrected the stale "write-capable / SIWX-equivalent" comments in `core/src/control-plane-session.ts` + `sdk/src/namespaces/operator.ts`.
- [x] 9.2 Documented the operator-approval model in `cli/llms-cli.txt` (operator approve/status, the wallet-less write path, `WRITE_AUTH_*` codes) + `sdk/llms-sdk.txt` (`r.operator.approval`, surface/authMode, `OperatorApprovalRequiredError`).

## 10. Tests + sync (PR 2)

- [x] 10.1 Ceremony + flag coverage: SDK seam unit tests (paths/bodies/bearer), `operator approve` argv validation in the CI-wired `cli-argv.test.mjs` (bad action / missing target), and CLI smoke (status JSON, BAD_FLAG, help). *(The full loopback+passkey happy-path e2e — stubbed gateway + driven redirect — is the one remaining thin gap; the ceremony logic is covered by the seam + cache + getAuth unit tests.)*
- [x] 10.2 `sync.test.ts` SURFACE + parity green; no approval MCP tool added.
- [x] 10.3 `npm test` green — 1398 unit pass (1 skip, 0 fail) + 677 e2e pass + 43 doc snippets clean; `npm run build` + `build:core` clean.
