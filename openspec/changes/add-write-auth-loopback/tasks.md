## 0. Gateway wire-shape + binding verification (blocking pre-req)

- [ ] 0.1 Against a live/staging gateway — or by reading `packages/gateway/src/routes/write-auth.ts` + `services/write-auth.ts` on run402-private `origin/main` — pin the exact shapes and behaviors before coding:
  - `POST /agent/v1/control-plane/write-auth/challenges` request (does it take `cli_redirect_uri`/`code_challenge`/`state`?) + response (`confirm_url`/`redirect_to`? `delivery`? `challenge_id`?).
  - `POST /agent/v1/control-plane/write-auth/cli/token` request (`code`/`code_verifier`/`redirect_uri`/`state`?) + response (`write_auth_token`, `token_type`, `header`, `expires_in`, `scopes`? `org_id`/`project_id` target? `session`?).
  - The `403 WRITE_AUTH_REQUIRED` envelope (does it carry `capability`/`next_actions`?).
  - **Binding/safety checks** (review #12): SIWX wallet auth still provisions/deploys with NO approval; approval alone fails; approval + wrong cp-session fails; approval target/scope mismatch fails; SIWX + a stray `X-Run402-Write-Auth` does not change principal selection; non-gated routes ignore a malformed/expired approval (don't reject reads) and do not refresh its idle TTL; redirects never forward auth headers off-origin.

---

## PR 1 — Auth plumbing

## 1. Kernel header hardening

- [ ] 1.1 In `sdk/src/kernel.ts`, replace the case-sensitive `if (!(k in fetchHeaders))` merge with a case-insensitive `hasHeader(fetchHeaders, k)` check.
- [ ] 1.2 Add credential-family atomicity: if the request already set any of `Authorization` / `SIGN-IN-WITH-X` / `X-Run402-Write-Auth` (any casing), do NOT merge provider auth headers. Unit-test mixed casing + pre-set auth.

## 2. SDK credentials — surface, authMode, deterministic resolution

- [ ] 2.1 In `sdk/src/credentials.ts`, widen `getAuth` to `getAuth(path: string, metadata?: { method?: string; mutates?: boolean; capability?: string }): Promise<Record<string,string> | null>` (back-compatible — metadata optional). Thread the metadata from each namespace call site (start with provision + apply/deploy) through the kernel into `getAuth`.
- [ ] 2.2 Add `{ surface: "cli" | "mcp" | "sdk", authMode?: "auto" | "wallet" | "operator" | "none" }` to `NodeCredentialsProvider`. Implement deterministic resolution (exactly one class; no silent inter-class fallback). Defaults: CLI `auto`, MCP `wallet`, SDK Node `auto` only when explicitly constructed so.
- [ ] 2.3 In `auto`/`operator` mode with no wallet allowance, return `Authorization: Bearer <live cp-session>`; do NOT yet attach the approval (that's PR 2, gated on metadata). Ensure MCP (`wallet`) never reads the cp-session/approval caches.
- [ ] 2.4 Construct the SDK with the right `surface` at each edge: MCP (`src/sdk.ts`) → `"mcp"`; CLI (`cli/lib/sdk.mjs`) → `"cli"`.

## 3. SDK — OperatorApprovalRequiredError

- [ ] 3.1 Add `OperatorApprovalRequiredError` to `sdk/src/errors.ts` (extends `Run402Error`; fields `code: "WRITE_AUTH_REQUIRED"`, `principal: "operator"`, `capability`, `next_actions`).
- [ ] 3.2 In `sdk/src/kernel.ts`, map `403` + `envelopeCode === "WRITE_AUTH_REQUIRED"` to it (before the generic 401/403 → `Unauthorized`); synthesize `next_actions` (referencing `run402 operator approve`) if the gateway omits them. Export from `index.ts`.
- [ ] 3.3 Make deterministic-resolution auth failures (2.2) throw a typed error naming the credential class used.

## 4. CLI — operator status + plumbing (PR 1)

- [ ] 4.1 Add `run402 operator status` in `cli/lib/operator.mjs`: report operator-login state, approval state + expiry + scopes + target (human to stderr, JSON to stdout). In PR 1 the approval section reads "none" until PR 2 lands.
- [ ] 4.2 Ensure `provision` / `deploy apply` surface `OperatorApprovalRequiredError` through `reportSdkError` with `next_actions` intact (no auto-approve yet).
- [ ] 4.3 PR-1 tests: kernel header-merge hardening; resolution matrix (CLI auto wallet/cp; MCP wallet-only never touches cp cache); `403 WRITE_AUTH_REQUIRED` → `OperatorApprovalRequiredError`; `operator status` output. `sync.test.ts` SURFACE for `operator:status`.

---

## PR 2 — Approval ceremony

## 5. core — approval token cache with binding

- [ ] 5.1 Add `core/src/write-auth-session.ts` mirroring `control-plane-session.ts` discipline, with shape `{ write_auth_token, token_type, header, principal_id, amr, expires_at, control_plane_session_hash, control_plane_principal_id, api_origin, scopes, org_id?, project_id?, minted_at }`; `getWriteAuthSessionPath()` (`RUN402_WRITE_AUTH_SESSION_PATH` override), `read/save/clear`, `loadLiveApproval(...)` returning `null` on cp-hash / principal / api-origin / scope-target mismatch or expiry, `writeAuthSessionFromTokenResponse` (relative→absolute, captures binding).
- [ ] 5.2 Add `core/src/write-auth-session.test.ts`: round-trip, each binding mismatch → null, expiry, corrupt-shape throw, 0600.

## 6. SDK — operator-approval ceremony seams (hardened)

- [ ] 6.1 In `sdk/src/namespaces/operator.ts`, add an `Approval` sub-class exposed as `r.operator.approval` — `requestChallenge({ cliRedirectUri, codeChallenge, state, token? })` and `exchangeClaimCode({ code, codeVerifier, redirectUri, state, token? })` (includes `redirect_uri`). Isomorphic; honor explicit `token`. Field names per task 0.1.
- [ ] 6.2 Export the public types from the SDK type-surface entry.

## 7. SDK/Node — gated approval attachment

- [ ] 7.1 In `NodeCredentialsProvider.getAuth`, when resolution selects operator mode AND the request metadata marks a mutating/gated capability AND a live bound approval exists (`loadLiveApproval`), add `X-Run402-Write-Auth: Bearer <token>` alongside the cp bearer. Never attach on non-mutating requests; never via a path allowlist.
- [ ] 7.2 Tests: gated method → dual header; read method → cp-bearer only; expired/mismatched approval → cp-bearer only.

## 8. CLI — operator approve, lifecycle invalidation, TTY auto-approve

- [ ] 8.1 Add `run402 operator approve` (hidden alias `write-auth`) reusing `pkce` + the loopback server: require a live cp-session (else guidance to `login --loopback`); validate `confirm_url` is same-origin as `apiBase` before opening; validate `state` before rendering success; `exchangeClaimCode`; `saveWriteAuthSession` with binding; never print the token; JSON to stdout.
- [ ] 8.2 Lifecycle invalidation: `operator login`/`--step-up` clears any prior approval before saving the new cp-session; `operator logout` clears the approval too; update `operator status` to show the live approval.
- [ ] 8.3 TTY-only auto-approve: in `provision`/`deploy apply`, when `OperatorApprovalRequiredError` is hit AND `stderr.isTTY` AND surface is CLI, prompt `[Y/n]`, run the ceremony, retry once. Never in MCP/CI/non-TTY.

## 9. Docs

- [ ] 9.1 Fix the stale `core/src/control-plane-session.ts` comment (drop SIWX-equivalence-for-writes; note the operator-approval requirement for provision/deploy).
- [ ] 9.2 Document the operator-approval model in `cli/llms-cli.txt` + `sdk/llms-sdk.txt`: `operator approve` / `operator status`, surface/authMode semantics (MCP no-ambient-approval), the wallet-less write path, TTY auto-approve, and `WRITE_AUTH_*` as transport codes.

## 10. Tests + sync (PR 2)

- [ ] 10.1 CLI e2e (`cli-operator-approve.test.mjs`): stub the gateway seams + drive the loopback redirect; assert bound approval cached, a gated follow-up carries the dual header, a read carries cp-only, state-mismatch aborts, and `operator login` clears a prior approval. Register the file in the `package.json` test allow-list.
- [ ] 10.2 `sync.test.ts` SURFACE for `operator:approve` (+ alias note); keep CLI/OpenClaw parity; confirm no handoff/approval MCP tool was added.
- [ ] 10.3 `npm test` green; `npm run build` + `npm run build:core` clean.
