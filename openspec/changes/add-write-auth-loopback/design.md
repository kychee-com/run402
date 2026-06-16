## Context

Two gateway commits raised the bar for wallet-less human writes:

- **v1.85 (`016b7f8c`)** — passkey approval for humans: a passkey-fresh approval mints a short-lived token (transport: `X-Run402-Write-Auth`), distinct from the control-plane session.
- **v1.87 (`2b2055f4`)** — headless delivery of that token to the CLI over an RFC-8252 loopback + PKCE exchange.

Gateway dual-header gate `requireWriteAuthCovers(<op>)` protects `provision` (`org.project.create`) and `apply`/`deploy` (`project.deploy`). It requires **both** `Authorization: Bearer <control-plane session>` **and** `X-Run402-Write-Auth: Bearer <approval token>`. A control-plane session alone returns `403 WRITE_AUTH_REQUIRED`. The SIWX wallet path is unaffected.

Public state (verified):

- `core/control-plane-session.ts` caches the cp session. Its "write-capable … accepted everywhere a SIWX wallet is" comment is now **stale** for `provision`/`deploy`.
- `cli/lib/operator.mjs` runs the loopback-PKCE login (`pkce`, a 127.0.0.1 one-shot server with state validation + socket teardown, `buildCliAuthorizeUrl`, `exchangeCliToken`, `saveControlPlaneSession`).
- `sdk/src/namespaces/operator.ts` exposes the isomorphic session seams.
- **`NodeCredentialsProvider.getAuth(path)` returns only `getAllowanceAuthHeaders(path)` — wallet/SIWX or `null`.** No control-plane-session fallback. The cached cp-session is consumed only by explicit operator commands.
- The kernel merges provider headers with `if (!(k in fetchHeaders))` — **case-sensitive**, no overwrite of explicit headers.

This design incorporates an external design review (GPT-5.5 Pro; transcript in `run402-private/docs/consultations/write-auth-loopback-design-review.md`). Its headline: **keep the substrate, change the semantics** — surface the public concept as *operator approval*, never let it become ambient agent authority, and harden the credential path rather than claiming "no kernel change."

## Goals / Non-Goals

**Goals:**
- A wallet-less human, after a one-time passkey approval, can `run402 provision` and `run402 deploy apply` from the **CLI**.
- The human approval is a **bounded, revocable, surface-aware** credential — never ambient in agent (MCP) tool calls.
- Deterministic credential resolution (exactly one class, no silent inter-class fallback); a typed, actionable error that names the class.
- Keep the SIWX wallet (agent) path byte-for-byte unchanged.

**Non-Goals:**
- An MCP tool for the ceremony; MCP returns a structured approval-required result instead.
- The wallet/SIWX path or agent flow.
- Server changes — the gateway shipped.
- Long-lived write authority — the approval is short-lived, session-bound, and re-minted on expiry.

## Decisions

### Decision 1 — Surface-aware, deterministic credential resolution (no ambient approval)

`NodeCredentialsProvider` takes `{ surface: "cli" | "mcp" | "sdk", authMode?: "auto" | "wallet" | "operator" | "none" }`. Resolution selects **exactly one** credential class and **never silently falls back** between classes:

- `auto` (CLI default): wallet allowance if present; else the live control-plane session (operator). If the selected class's request fails, throw a typed error naming the class — do **not** retry under another class.
- `wallet` (**MCP default**): wallet/SIWX only. A write needing approval surfaces `OperatorApprovalRequiredError`; the agent relays it. The human's cached approval is **never** spent by an MCP tool call.
- `operator`: control-plane session (+ approval) only.
- `none`: no auth.

Rationale (review #2, #4): the product vision is bounded, revocable agent delegation — not ambient human authority leaking into model tool calls. Default-by-surface makes "exactly one credential class" the contract, not an accident. **Alternative — implicit wallet→cp→approval everywhere** (the prior Decision 1): rejected; it leaks human approval into MCP and hides which class authorized a call.

### Decision 2 (REVISED) — Capability-driven dual-header attachment, not blanket

`getAuth(path, metadata?)` gains a second argument: `{ method, mutates?, capability? }`, supplied by the typed SDK method. In `operator`/`auto`-selected mode, the kernel attaches the cp bearer and `X-Run402-Write-Auth` **only when the metadata marks a mutating/gated capability** (e.g. `mutates: true` or `capability: "project.deploy"`). It is never attached blanket on every cp-session request, and never via a client-side path allowlist.

Rationale (review #5): operation intent lives on the typed method; the client should not own a brittle path list nor broadcast the approval token to read endpoints. **Alternatives:** (a) attach on all cp-session requests (prior Decision 2) — rejected (over-broadcast); (b) client path allowlist — rejected (brittle: a new gated route → silent 403). Reads carry only the cp bearer; gated writes carry the dual header.

### Decision 3 — Small kernel hardening (no endpoint-specific logic)

Reframe "no kernel change" → "no endpoint-specific kernel logic, plus two hardening fixes":
1. **Case-insensitive merge.** Replace `!(k in fetchHeaders)` with a case-insensitive `hasHeader(fetchHeaders, k)` so explicit `authorization` and a provider `Authorization` cannot coexist.
2. **Credential-family atomicity.** If the request already set any auth header (`Authorization` / `SIGN-IN-WITH-X` / `X-Run402-Write-Auth`, any casing), the kernel does not merge provider auth — the request owns its credentials.

Rationale (review #3): once two credentials exist, a case-sensitive merge can ride duplicate/contradictory auth headers. This is endpoint-agnostic correctness, not per-route logic.

### Decision 4 — Approval cache bound to session, origin, and target

`core/src/write-auth-session.ts` keeps the `control-plane-session.ts` discipline (atomic temp-file+rename, 0600, `selfHealPermissions`, base config dir, strict-shape read, relative→absolute expiry) and **adds binding fields**: `control_plane_session_hash`, `control_plane_principal_id`, `api_origin`, `scopes`, `org_id?`, `project_id?`, `minted_at`. `loadLiveApproval(...)` returns `null` on: cp-session-hash mismatch, principal mismatch, api-origin mismatch, scope/target mismatch, or expiry (with skew).

Rationale (review #6): the approval is target-scoped and dies with the cp-session; the client cache should enforce that locally so a stale or cross-origin approval is never replayed. Cache shape: `{ write_auth_token, token_type, header: "X-Run402-Write-Auth", principal_id, amr, expires_at, control_plane_session_hash, control_plane_principal_id, api_origin, scopes, org_id?, project_id?, minted_at }`. `RUN402_WRITE_AUTH_SESSION_PATH` overrides for tests. *(Which binding fields the gateway actually emits — `scopes`, target — is verified in task 0.1; the client persists what it has and binds defensively.)*

### Decision 5 — Approval invalidated on every cp-session lifecycle change

The approval is cleared whenever the cp-session it pairs with changes: `operator logout` clears it; `operator login`/`--step-up` clears the old approval **before** saving the new cp-session; provider load ignores/deletes it on cp-session-hash mismatch. Rationale (review #7): a hard invalidation rule, not just logout, prevents a stale approval from outliving its session.

### Decision 6 — Ceremony seams are isomorphic and hardened

`r.operator.approval.requestChallenge(...)` / `.exchangeClaimCode(...)` are pure request seams (no `fs`/loopback), mirroring `buildCliAuthorizeUrl`/`exchangeCliToken`. Hardening (review #11): `exchangeClaimCode` sends `redirect_uri` (not just code/verifier/state); the CLI validates `confirm_url` (same-origin as `apiBase`) before opening it; the loopback handler validates `state` **before** rendering success HTML; the server clears its timer and destroys sockets on the first terminal result; the challenge/code is treated single-use and short-lived; the token is never printed.

### Decision 7 — Public concept is "operator approval"; transport stays write-auth

The CLI verb is **`run402 operator approve`** (with a hidden `run402 operator write-auth` alias for muscle memory). The SDK seam is **`r.operator.approval`**. The error is **`OperatorApprovalRequiredError`**. The header (`X-Run402-Write-Auth`), gateway code (`WRITE_AUTH_REQUIRED`), endpoint paths (`/write-auth/...`), and internal cache file stay write-auth — buried transport. Rationale (review #1, #8): the user-facing noun→verb is a human approving a mutating capability, not "write-auth."

### Decision 8 — Structured, class-naming errors

`OperatorApprovalRequiredError` (mapped from `403` + `WRITE_AUTH_REQUIRED`, beside `STEP_UP_REQUIRED` / `NOT_AUTHORIZED`) carries `{ code: "WRITE_AUTH_REQUIRED", principal: "operator", capability, next_actions: [{ command: "run402 operator approve" }] }`. A deterministic-resolution auth failure (Decision 1) likewise names the credential class used. Rationale (review #4, #8): agents get the next call, not a guess.

### Decision 9 — `operator status` and TTY-only auto-approve

- **`run402 operator status`** (review #9): prints operator-login state, approval state + expiry, scopes, and org/project target (human + JSON) — makes the model legible.
- **Auto-approve-and-retry** (review #10): `provision`/`deploy apply`, when approval is missing AND `stderr.isTTY`, prompt to open the browser, run the ceremony, retry once. **Never** in MCP, CI, or non-TTY — they return the structured error. Delightful human DX without violating the agent-first trust model.

## Risks / Trade-offs

- **Gateway wire shapes + binding semantics assumed from a source read** → blocking task 0.1, expanded to verify origin isolation, scope/target binding, idle-TTL on non-gated routes, and principal-selection safety **before** building.
- **Surface-default behavior is a real product decision** (MCP wallet-only) → covered by explicit per-surface resolution tests; documented so agent hosts know writes need out-of-band approval.
- **Capability metadata must be threaded onto write methods** → start with `provision` + `apply`/`deploy`; a method missing the flag simply won't attach approval (fails closed with the typed error), never over-attaches.
- **Kernel hardening touches a hot path** → endpoint-agnostic; covered by header-merge unit tests (mixed casing, pre-set auth).
- **CLI e2e needs a stubbed gateway + loopback** → stub the seams, drive the redirect locally, assert cache write + dual-header on a gated follow-up and cp-only on a read.

## Migration Plan

Additive, client-only, non-breaking. Implemented as **two PRs under this one change**:

- **PR 1 — auth plumbing:** kernel header hardening; provider `{ surface, authMode }` + deterministic resolution; `getAuth(path, metadata)` + capability-driven attachment; CLI-only cp-session fallback; `OperatorApprovalRequiredError`; `operator status`; tests. (Ships value on its own: wallet-less humans get cp-session-authorized reads + clean typed write errors.)
- **PR 2 — approval ceremony:** `write-auth-session.ts` cache + binding; `operator approve` (+ alias) + loopback ceremony; lifecycle invalidation; TTY auto-approve; e2e + docs.

Ships in the normal lockstep release. Rollback = revert the client commit(s); the gateway endpoints are independent and already live. No persisted-state migration (a new cache file; absence = "no approval," current behavior).

## Open Questions

- **Live wire shapes + binding (blocking, task 0.1):** confirm the `challenges` / `cli/token` field names AND whether the gateway returns `scopes`/target on the token, whether non-gated routes refresh the idle TTL, and that off-origin redirects never forward auth headers.
- **`mutates`/`capability` source:** derive from a per-method annotation in the namespaces, or a small static map keyed by SDK method? Lean annotation-on-method so it travels with the call.
- **Auto-chain default:** prompt-by-default on TTY, or require an explicit `--approve` flag? Lean prompt-with-`[Y/n]`; revisit if it surprises scripts that are a TTY but non-interactive.
