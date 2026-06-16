## Context

Two gateway commits raised the bar for wallet-less human writes:

- **v1.85 (`016b7f8c`)** — passkey write-auth for humans: a passkey-fresh approval mints a short-lived **write-auth token**, distinct from the control-plane session.
- **v1.87 (`2b2055f4`)** — headless delivery of that token to the CLI over an RFC-8252 loopback + PKCE exchange.

Gateway-side the dual-header gate `requireWriteAuthCovers(<op>)` now protects `provision` (`org.project.create`) and `apply`/`deploy` (`project.deploy`). It requires **both** `Authorization: Bearer <control-plane session>` **and** `X-Run402-Write-Auth: Bearer <write-auth token>`. A control-plane session alone returns `403 WRITE_AUTH_REQUIRED`. The SIWX wallet path is unaffected.

Public state (verified):

- `core/control-plane-session.ts` caches the cp **session** (Bearer, `loopback_pkce`, `amr`, `expires_at`). Its header comment claims the session is "write-capable … accepted everywhere a SIWX wallet is" — **now stale** for `provision`/`deploy`.
- `cli/lib/operator.mjs` runs the loopback-PKCE login (`generatePkce`, a 127.0.0.1 one-shot server, `buildCliAuthorizeUrl`, `exchangeCliToken`, `saveControlPlaneSession`).
- `sdk/src/namespaces/operator.ts` exposes the isomorphic session seams (`buildCliAuthorizeUrl`, `exchangeCliToken`).
- **`NodeCredentialsProvider.getAuth(path)` returns only `getAllowanceAuthHeaders(path)` — wallet/SIWX or `null`.** It has **no** control-plane-session fallback. The cached cp-session is consumed only by explicit operator commands (e.g. `node/operator-claim.ts` reads `loadLiveControlPlaneSession` and passes the token by hand). So `provision`/`deploy` never see the session at all for a wallet-less human.
- The kernel (`kernel.ts`) merges whatever `getAuth` returns into the request headers without overwriting explicit ones — so additional headers (like `X-Run402-Write-Auth`) need **no kernel change**.

## Goals / Non-Goals

**Goals:**
- A wallet-less human, after a one-time browser ceremony, can `run402 provision` and `run402 deploy apply` from the CLI/MCP.
- Mint, cache, and inject the write-auth token; inject the control-plane session it pairs with.
- Keep the SIWX wallet path byte-for-byte unchanged.
- A typed, actionable error when a write needs (or has an expired) write-auth token.

**Non-Goals:**
- Changing the kernel, the wallet/SIWX path, or any agent-facing flow.
- An MCP tool for the ceremony (it is inherently browser + loopback; MCP inherits the cached credential).
- Server changes — the gateway shipped.
- Long-lived write authority — the token is deliberately short-lived; re-mint on expiry.

## Decisions

### Decision 1 — Inject via `getAuth` control-plane fallback; no kernel change

`NodeCredentialsProvider.getAuth(path)` becomes: (1) if wallet allowance headers exist, return them unchanged (the agent path is untouched); (2) else, if a **live** control-plane session is cached, return `Authorization: Bearer <session>` and — when a **live** write-auth token is also cached — add `X-Run402-Write-Auth: Bearer <token>`. The kernel already merges these, so the dual header rides every request automatically. No `withWriteAuth` flag, no per-callsite change, no kernel edit.

- **Alternative — compose a provider only inside the `provision`/`deploy` CLI commands.** Rejected as the default: it leaves every *other* wallet-less command (status, list, schema, …) still broken for humans, and duplicates credential assembly per command. The `getAuth` fallback fixes the whole surface once.

### Decision 2 — Send the write-auth header whenever it exists in cp-session mode (not a path allowlist)

In control-plane mode, when a live write-auth token is cached, `getAuth` includes `X-Run402-Write-Auth` on **all** requests, not just a hardcoded provision/deploy prefix list.

- Rationale: the gateway ignores the header on non-gated routes; a client-side write-path allowlist is brittle (a new gated route → silent `403`). The token is short-lived and same-trust-domain, so the marginal exposure of attaching it to read requests is acceptable.
- **Alternative — path allowlist** (`/projects/v1` POST, `/apply/v1/*`). Rejected: brittle and duplicates gateway authority knowledge the client shouldn't own.

### Decision 3 — Token cache mirrors `control-plane-session.ts` exactly

`core/src/write-auth-session.ts` copies the proven discipline of `control-plane-session.ts`: atomic temp-file+rename, mode 0600, `selfHealPermissions`, base config dir (principal-scoped, shared across named wallets), strict-shape read that throws a fix-it on corruption, `loadLiveWriteAuthSession` returning `null` past expiry, `writeAuthSessionFromTokenResponse` mapping the gateway's relative `expires_in` to an absolute `expires_at`. Cache shape: `{ write_auth_token, token_type, header: "X-Run402-Write-Auth", principal_id, amr, expires_at }`. `RUN402_WRITE_AUTH_SESSION_PATH` overrides for tests.

### Decision 4 — Ceremony seams are isomorphic; orchestration is Node/CLI

`r.operator.writeAuth.requestChallenge(...)` and `.exchangeClaimCode(...)` are pure request seams in `namespaces/operator.ts` (no `fs`, no loopback) — exactly like `buildCliAuthorizeUrl` / `exchangeCliToken`. `requestChallenge` sends the cp-session bearer (default cred or explicit `token`) and the `cli_redirect_uri` + `code_challenge` (S256) + `state`. The loopback server, PKCE generation, browser-open, and caching live in `cli/lib/operator.mjs`, reusing the existing helpers.

### Decision 5 — Distinct CLI verb `operator write-auth`, requires an existing session

`run402 operator write-auth` is its own verb (it mints the **token**, a different artifact from the session that `login` mints). It requires a live cp-session and errors with guidance to run `operator login --loopback` first if absent. The ceremony: PKCE+state → loopback server → `requestChallenge` → open `confirm_url` (passkey approval) → capture `code`+`state` on the redirect → `exchangeClaimCode` → `saveWriteAuthSession`.

- **Alternative — fold into `login --loopback`** (mint session + write-auth in one browser dance). Recorded as an Open Question DX nicety; kept out of the core verb so the two credentials stay conceptually separate and the token can be re-minted without re-logging-in.

### Decision 6 — Map `403 WRITE_AUTH_REQUIRED` to `WriteAuthRequiredError`

A new `Run402Error` subclass, mapped in the kernel's 403 branch by `envelopeCode === "WRITE_AUTH_REQUIRED"` (beside the existing `STEP_UP_REQUIRED` / `NOT_AUTHORIZED` branches), carrying the gateway envelope and a message that points at `run402 operator write-auth`. This distinguishes "you need a write-auth token / it expired" from a generic authz denial.

## Risks / Trade-offs

- **Gateway wire shapes assumed from a source read, not a live call** → Mitigation: a blocking task to verify `challenges` / `confirm` / `cli/token` request+response and the `WRITE_AUTH_REQUIRED` envelope against a live/staging gateway **before** building; the seams are thin and isolate any shape surprises.
- **cp-session fallback is a broad behavior change** (every wallet-less command now attaches a session) → Mitigation: gated on "no wallet allowance present"; agents with a wallet are byte-for-byte unaffected; covered by `getAuth` unit tests for both modes.
- **Write-auth token attached to read requests** (Decision 2) → Mitigation: short-lived, same trust domain, gateway-ignored; documented.
- **Stale "write-capable" comment misleads implementers/users** → Mitigation: explicit doc-fix task + the dual-credential model in `llms-*` docs.
- **CLI e2e needs a stubbed gateway + loopback** (no real passkey in CI) → Mitigation: stub `requestChallenge`/`exchangeClaimCode` and drive the loopback redirect locally, asserting the cache write + dual-header on a follow-up request; register the new e2e file in the `package.json` allow-list.

## Migration Plan

Additive, client-only, non-breaking. New `core` file, new SDK seams, an extended `getAuth`, a new CLI verb, doc fixes. Ships in the normal lockstep `run402-mcp` / `run402` / `@run402/sdk` release. Rollback = revert the client commit; the gateway endpoints are independent and already live. No persisted-state migration (a new cache file; absence = "no write-auth," the current behavior).

## Open Questions

- **Live wire shapes (blocking):** confirm the exact field names of the `write-auth/challenges` response (`confirm_url`? `redirect_to`? `delivery`?) and the `write-auth/cli/token` response (`write_auth_token`, `expires_in`, `header`, `session`?) against the running gateway before coding the seams + cache.
- **Does `walletAuthOrWriteAuthProvision` accept a *fresh* cp-session without a write-auth token?** The subagent read says no (cp-session alone → `403`). Verify; if a sufficiently-fresh/step-up session is in fact accepted for some ops, the `requireWriteAuthCovers` matrix per op should be documented so the CLI only forces the ceremony where truly required.
- **Auto-chain from `login --loopback`?** Optional DX: after a successful loopback login, immediately run the write-auth ceremony so the human does one browser visit. Kept out of the core verb for separation; decide during implementation.
- **Verb naming:** `operator write-auth` vs `operator login --write-auth`. Leaning to the distinct verb (Decision 5); confirm with the reviewer.
