## Context

The gateway shipped `first-class-orgs` (v1.82): `POST /orgs/v1` (create, empty, prototype, `display_name` only), `GET /orgs/v1/:org_id` (returns `role`), `PATCH /orgs/v1/:org_id` (rename), `POST /projects/v1 { org_id }` (provision into an org), and a wallet-org **claim** (`POST /agent/v1/operator/claim-wallet-org/challenge` + `…/claim-wallet-org`). The gateway also made `org` the public noun — `/orgs/v1` speaks `org_id`; `billing_account`/`billing_account_id` are now internal-only and MUST NOT appear on the wire.

The client today (`sdk/src/namespaces/org.ts`, `cli/lib/org.mjs`, `src/tools/orgs.ts`) is built entirely on `billing_account_id`: every method threads `billingAccountId` positionally, `OrgMembership.billing_account_id`, a `requireBa()` helper, CLI `<billing_account>` positionals with `ba_abc` examples. It is misaligned with the platform's own vocabulary and has no create/get/rename/claim verbs.

We are pre-launch with no users (the user has explicitly accepted breaking the shipped client surface). The gateway is already deployed, so the client ships independently with no coordination window.

The contract facts below were confirmed against the shipped v1.82 impl ([#451 comment](https://github.com/kychee-com/run402/issues/451#issuecomment-4661351869)) and drive the decisions.

## Goals / Non-Goals

**Goals:**
- The optimal client DX for orgs, not a compatibility-preserving one. `org_id` everywhere; the namespace mirrors the established `r.projects` / `r.project(id)` idiom.
- The claim flow's choreography is owned by the client (challenge → sign → dual-proof submit → `select_org` re-submit → step-up guidance), with a clean isomorphic/Node split.
- Parity across SDK / CLI / MCP, plus `cli/llms-cli.txt` and the `sync.test.ts` surface gates.

**Non-Goals:**
- Org *merge* (combining two real orgs) — deferred gateway-side; not a client concern here.
- Paid-tier-at-create or a tier-change flow — create is prototype-only by contract.
- Driving the WebAuthn step-up ceremony from the SDK — step-up is the browser/loopback login's job; the client *detects* `STEP_UP_REQUIRED` and points at the existing `operator login --step-up`.
- Renaming the gateway's `/billing/v1/accounts/:account_id` route (the public-vocabulary collision is a gateway concern; out of scope for the client).

## Decisions

### D1 — Full `org_id` rename, no compatibility shim
`billing_account_id` is removed from the entire client surface (SDK params + types, CLI positionals, MCP inputs). `OrgMembership = { org_id, display_name, role, status }`.
- **Why:** pre-launch, no users; a dual-read shim would permanently half-migrate the vocabulary and contradict the platform's own "`billing_account` never on the wire" rule.
- **Alternative (rejected):** tolerant dual-read (`org_id` + optional `billing_account_id`) to survive a gateway-skew window. Rejected because the gateway is already deployed and there are no published consumers to protect.

### D2 — SDK namespace = collection + instance (`r.orgs` / `r.org(id)`)
`r.orgs.create` / `list` / `whoami` (collection + identity); `r.org(id).get` / `rename` / `members.*` / `invites.*` / `audit` (instance, id pre-bound). `r.org(id)` returns a resource-scoped sub-client.
- **Why:** exact mirror of the shipped `r.projects` / `r.project(id)` idiom — the id is bound once instead of threaded into every member/invite/audit call. "Find the optimal DX" (per #451) over "stay additive."
- **Alternative (rejected):** flat-add (`r.org.create`, `r.org.get(id)`, `r.org.members.list(id)`). Non-breaking, but keeps the grab-bag shape (`list()` on a singular `org`, id threaded everywhere) the shipped surface accreted. We took the break in D1, so there is no reason to preserve it.
- **`whoami` stays on `r.orgs`** (continuity with today's `r.org.whoami`); it does not collide with the local network-free `r.whoami()`.

### D3 — CLI keeps a flat singular `org` group
`run402 org <verb> <org_id>` — rename `<billing_account>` → `<org>`, add `create`/`get`/`rename`. The SDK's callable-scope idiom (`r.org(id)`) has no CLI analog; the CLI mirrors the existing `run402 <group> <verb>` shape.
- **Consequence:** SDK says `r.orgs`/`r.org(id)`, CLI says `run402 org` — an intentional divergence, each idiomatic to its surface. Documented in `llms-cli.txt`.

### D4 — Claim seam: isomorphic raw steps + Node orchestration convenience
- **Isomorphic** (`r.operator`, no Node APIs): `claimWalletOrg.challenge({ wallet }) → { nonce }` and `claimWalletOrg.submit({ token, siwx, orgId?, displayName? }) → ClaimResult`. `submit` sends `Authorization: Bearer <token>` (control-plane session) **and** `SIGN-IN-WITH-X: <siwx>` (wallet proof) on one request.
- **Node convenience** (`sdk/node`): orchestrates challenge → sign nonce → submit, pulling the control-plane session from its on-disk cache and signing with the local allowance. Returns the discriminated `ClaimResult`; does **not** attempt step-up (surfaces `STEP_UP_REQUIRED` for the CLI).
- **Why the split:** SIWX signing needs the allowance private key (Node-only), exactly like `signCiDelegation`. The isomorphic seam keeps the kernel runtime-agnostic and lets a sandbox caller that already holds a signed proof call `submit` directly.

### D5 — SIWX construction reuses `buildSIWxAuthHeaders`; no canonical statement
The gateway verifies the wallet proof through the same path as `walletAuth`: `domain ∈ {api host}`, `issuedAt ≤ 5 min`, `expirationTime` not past, signature recovers the wallet, and **`nonce` == the challenge nonce**. There is **no** canonical statement string to reconstruct (unlike CI delegation). So the Node signer is `buildSIWxAuthHeaders({ allowance, domain: <apiBase host>, uri: <apiBase>, nonce: <challenge nonce>, issuedAt: now, expirationTime: now + 5m })` → take `SIGN-IN-WITH-X`.
- **Why:** confirmed contract (#451 answer 2). Simpler than `signCiDelegation` — no `buildClaimStatement`/resource-URI machinery.

### D6 — `select_org` is a discriminated result; the nonce + siwx are reused
`ClaimResult = { status: "claimed"; org_id; … } | { status: "select_org"; selectable_orgs: { org_id; display_name; tier }[] }`. The SDK returns it, never throws on `select_org` and never prompts. The challenge nonce binds to `(human, wallet, action)` — **not** to an org — so the org-selected re-submit reuses the **same `token` + same `siwx`**, just adding `orgId`. The CLI prints the `selectable_orgs` table and re-runs with `--org`.
- **Why:** confirmed contract (#451 answer 1) — no re-challenge, no re-sign on selection. The only constraint is the SIWX `issuedAt` 5-min window, which the human's pick comfortably fits.

### D7 — Step-up: detect, guide, retry — client robust to either gateway gating choice
`STEP_UP_REQUIRED` (HTTP 403, `details.op_class = "org.claim_wallet"`, `required_amr = ["passkey"]`, `max_age_seconds = 300`, `challenge_url`) is surfaced as a recognizable error. The CLI catches it on the claim, tells the user to run `run402 operator login --step-up`, and re-runs (the nonce is still live). The SDK's claim handler treats `STEP_UP_REQUIRED` from *any* call identically, so the client is correct whether the gateway gates the *challenge* endpoint or only the claim.
- **Cross-repo recommendation (gateway-side, the user's call):** relax the **challenge** endpoint to auth-only and keep step-up on the **claim**. Rationale: the challenge nonce is inert (no `org_id`, written only on success) and useless without both the wallet signature and a stepped-up claim, so gating it is defense-in-depth that buys ~nothing; relaxing lets the CLI do all prep (challenge + sign + a "you are about to claim **{display_name}** ({org_id}, {tier})" preview) *before* demanding the passkey ceremony at the moment of transfer — the ideal confirm-to-execute UX — and shrinks the 300 s freshness window to just the claim + the `select_org` re-submit. **Revisit-if:** only if org *discovery* ever moves to challenge-time (returning `selectable_orgs` from the challenge), at which point the challenge reveals something and should be re-gated.

### D8 — Claim bearer is the control-plane session only
The Node convenience pulls specifically from the **control-plane session** cache (`core/control-plane-session.ts`, loopback-PKCE, carries `amr`). The read-only device-flow operator session is structurally rejected by the route, and a `device_flow`-provenance control-plane session fails step-up. The CLI surfaces a clear "run `run402 operator login --loopback` first" when no control-plane session is cached.

### D9 — `provision --org` threads `orgId`; tier is org-governed
`ProvisionOptions.orgId?` → body `{ org_id }`; `run402 provision --org <id>`; MCP provision tool gains `org_id`. Caller authorization (`developer`+) is gateway-enforced; the client passes `org_id` and surfaces the `403`. Omitting `--org` sends no `org_id` and preserves the cold-start body byte-for-byte. Tier is governed by the org/billing account, and the shipped `POST /v1/projects` ignores any client-supplied `tier` ("account tier is authoritative" — confirmed in `routes/projects.ts`), so `--org` simply adds `org_id`; there is no `--tier`/`--org` conflict to guard. The CLI rejects an empty `--org` locally.

## Risks / Trade-offs

- **[Two freshness clocks on the claim — passkey 300 s + SIWX `issuedAt` 5 min — can expire mid-flow on a slow `select_org` pick.]** → Sign with a full 5-min `expirationTime`; on `select_org`, the CLI re-submits immediately after the pick (reusing nonce + siwx). If either clock has expired, the error is recognizable (`STEP_UP_REQUIRED` or `WALLET_PROOF_INVALID`) and the CLI re-runs the relevant step; the nonce stays live for the re-sign.
- **[The breaking org rename lands in the same release as unrelated lockstep packages.]** → It is genuinely breaking for any out-of-tree consumer of the org namespace; mitigated by pre-launch (no users) and a clear changelog/`BREAKING` note at publish.
- **[SDK/CLI naming divergence (`r.orgs`/`r.org(id)` vs `run402 org`) could confuse.]** → Each is idiomatic to its surface and already precedented by `r.project(id)` vs `run402 project`; documented in `llms-cli.txt`.
- **[`select_org` modeled as a non-thrown discriminated result breaks the "errors throw" reflex.]** → It is a success (HTTP 200) status, not an error; the discriminated union + the `scoped.test.ts`-style drift guard and unit tests pin the contract.

## Migration Plan

1. Land the full client change (SDK reshape + claim seam + CLI + MCP + docs + sync surface) in one PR. Breaking is accepted.
2. Gateway is already deployed (v1.82) — no client/gateway coordination needed; the client can be exercised against prod immediately.
3. Publish the lockstep packages (`run402-mcp` / `run402` / `@run402/sdk`) via `/publish` (requires its own explicit authorization).
4. **Rollback:** revert the client PR; the gateway is unaffected. No data migration is involved (purely client surface).

## Open Questions

1. **RESOLVED — `--tier` + `--org` (D9):** the shipped `POST /v1/projects` ignores any client-supplied `tier` (account tier is authoritative — verified in `routes/projects.ts`), so there is no conflict and no local guard is needed; `--org` only adds `org_id`.
2. **Claim symbol shape:** `r.operator.claimWalletOrg.{challenge,submit}` (chosen) vs a callable hero mirroring `deploy.apply`. Settled on explicit `.challenge`/`.submit` because the orchestration is Node-only; revisit only if a callable form proves more ergonomic at implement time.
3. **Gateway challenge gating (D7):** awaiting the user's call on relaxing the challenge endpoint to auth-only. The client ships correctly either way; this only affects the gateway and the size of the 300 s window.
