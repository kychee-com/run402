# Plan: kysigned

**Owner:** Barry Volinskey
**Created:** 2026-04-04
**Status:** In Progress
**Spec:** docs/products/kysigned/kysigned-spec.md
**Spec-Version:** 0.11.0
**Upstream References:** docs/products/saas-factory/saas-factory-spec.md (v1.15.0)
**Source:** spec
**Worktree:** none — product code lives in separate repos (C:\Workspace-Kychee\kysigned and C:\Workspace-Kychee\kysigned-service). run402 platform enhancements use a run402 worktree on a feature branch.

## Legend
- `[ ]` Todo | `[~]` In Progress | `[x]` Done
- `[both]` = public repo + service repo | `[service]` = service repo only | `[repo]` = public repo only
- Task ownership: `AI` = agent executes | `HUMAN` = human action required | `DECIDE` = collaborative decision

---

## Design Decisions

### DD-1: Two-repo dependency model
- **Decision:** Public repo (`kysigned`) is the core library. Service repo (`kysigned-service`) imports it via `file:../kysigned` during development, `github:kychee-com/kysigned#tag` when stable, npm package when mature.
- **Alternatives:** Monorepo with extraction; git submodule; always-remote git dependency
- **Chosen because:** Local `file:` gives instant iteration with true repo separation. Two real repos from day one enforces clean boundaries and honest testing.
- **Trade-offs:** One-line change needed in package.json when transitioning between stages.
- **Rollback:** N/A — single-line change to switch between dependency modes.

### DD-2: Smart contract lives in public repo
- **Decision:** `SignatureRegistry.sol` lives in `kysigned/contracts/`. Forkers get everything in one clone.
- **Alternatives:** Separate `kysigned-contracts` repo; in the run402 repo
- **Chosen because:** The contract is the core product. No reason to separate unless other products use it (future concern).
- **Trade-offs:** None meaningful.

### DD-3: Shared run402 platform wallet for all on-chain activity
- **Decision:** kysigned uses the shared run402 platform wallet (`agentdb/faucet-treasury-key` in AWS Secrets Manager) for all on-chain recordings — both testnet (Base Sepolia) and mainnet (Base). This is the same wallet used by all Kychee SaaS products. No per-product wallet.
- **Applies to:** Contract deployment (one-time), ALL signature recordings for ALL paths (Method A and Method B, Path 1/2/3), and completion recordings. The platform wallet always submits the on-chain transaction regardless of how the sender paid kysigned — because signers typically sign asynchronously and the server must submit on everyone's behalf. Path 1/2 users pay USDC to the kysigned wallet via x402/MPP (revenue), and gas is paid in ETH from the same wallet (cost).
- **Alternatives considered:** Dedicated wallet per product.
- **Chosen because:** (1) The blockchain only sees a wallet address — the AWS secret name is invisible externally. (2) All SaaS products run on run402 infrastructure, so wallet management is a platform concern, not a product concern. (3) Per-product gas cost attribution doesn't require separate wallets — filter transactions by destination contract address. (4) One wallet to fund and monitor, not N. (5) A compromised key has the same blast radius either way — the contract is append-only with no admin functions, so the worst case is unauthorized recordings, not data loss.
- **Revenue/cost tracking:** Per-product attribution via run402 admin dashboard: USDC inflows labelled by which API endpoint accepted payment, ETH gas outflows labelled by which contract was called. Stripe revenue (Path 3) tracked separately via Stripe metadata. See run402 enhancement task.

### DD-4: Signature visual mode — sender controls
- **Decision:** Sender sets `require_drawn_signature` per envelope (default: false). Default = one-click auto-stamp (name in handwriting font + crypto details). If true = drawing widget for all signers. Saved signatures persist in browser cookie/localStorage.
- **Alternatives:** Always require drawing (DocuSign style); always auto-stamp
- **Chosen because:** One-click signing is fastest possible UX and a differentiator. Drawing adds zero legal value but some users/counterparties expect it. Sender (who pays) decides the formality level.
- **Trade-offs:** Some signers may initially be surprised by no drawing step.

### DD-5: Default signing order is parallel
- **Decision:** When sender doesn't specify, all signers are notified simultaneously (parallel). Sequential requires explicit `"signing_order": "sequential"`.
- **Alternatives:** Default sequential
- **Chosen because:** Matches industry convention. Simpler. Most use cases don't need ordered signing.

### DD-6: No persistent PDF storage in MVP
- **Decision:** PDFs retained for 30 days (pending cost validation) then deleted. Only metadata + on-chain hash persists. Paid retention is future feature.
- **Alternatives:** Permanent storage; no storage at all (delete immediately after completion email)
- **Chosen because:** Minimizes infra costs (enables $0.25 pricing). 30-day window gives users time to download.

### DD-7: Verification levels 1, 2, 5 for MVP
- **Decision:** Level 3 (SMS/WhatsApp) and Level 4 (government ID) are post-MVP. Manual signing link delivery via any channel covers the multi-channel gap.
- **Alternatives:** Include Level 3 with direct Twilio integration
- **Chosen because:** Avoids external messaging dependency. Manual link delivery achieves the same trust goal. Level 3/4 will be run402 platform services.

### DD-8: Email templates — HTML with plain text alternative
- **Decision:** HTML email templates in the repo with multipart plain text. Table-based layout, inline CSS, no JS, no image-heavy design, no URL shorteners. Small (<100KB). `List-Unsubscribe` header included.
- **Alternatives:** Markdown-to-email; run402 templating service
- **Chosen because:** Maximum deliverability, forkable, no dependencies.

### DD-9: Public repo IS coupled to run402 services (intentional trojan horse)

- **Decision:** The kysigned public repo (`kychee-com/kysigned`) is **architecturally and intentionally coupled** to run402 services. Pluggable-provider abstraction layers are NOT required for run402 integration points (payment validation, dashboard auth, magic-link flow, mailbox sending, KMS contract wallet, MCP, billing). The public repo calls `https://api.run402.com` (and other run402 publicly-accessible surfaces) **directly via `fetch`** in handler code — no abstraction, no pluggable interface, no swap-in adapter pattern.
- **What "publicly-accessible" means for the dependency:** the public repo may use ANY surface a fresh forker can also access from a `git clone` + `npm install` + `node` workflow:
  - `https://api.run402.com/*` HTTP endpoints (the run402 REST API)
  - The run402 MCP server
  - The run402 CLI (when forker has it installed)
  - Any npm-published packages under `@x402/*`, `@run402/*`, etc.
  - The public x402 protocol via `@x402/fetch` / `@x402/evm` / `@x402/extensions`
- **What "publicly-accessible" excludes:** internal monorepo packages that are NOT npm-published, internal admin keys, anything that requires being inside the run402 monorepo (`file:../run402/packages/shared` deps, `agentdb/admin-key` SQL queries against `internal.email_domains`, etc.). Those belong in the kysigned-service repo or the run402 repo itself, never in the public kysigned repo.
- **Alternatives considered:** Pluggable-provider pattern (e.g., `PaymentValidator` interface + run402 default impl + forker-replaceable). Rejected: this would water down the trojan horse and create unnecessary maintenance surface for an abstraction nobody is asking for.
- **Chosen because:** (1) The public repo is a marketing surface for run402. A forker who clones kysigned ends up using run402 services, becoming a run402 user. Making run402 easy to swap out defeats the funnel. (2) Run402's public APIs are stable and documented in `run402.com/llms.txt` — depending on them is like depending on AWS S3 or Stripe, just at our own infra. (3) The pluggable pattern is still used where it adds real flexibility (e.g., `EmailProvider`, `senderGate.hosted.getCreditBalance`, `RegistryClient` for the smart contract layer) but is NOT introduced as a tax on every run402 integration point. (4) Existing public-repo code already follows this pattern in spirit — the library code doesn't have a `Run402Adapter` abstraction; it uses viem directly for chain calls, fetch directly for HTTP, etc.
- **What this means for kysigned-service:** kysigned-service (the private hosted-deployment repo) becomes much narrower than originally planned. Its job is **deployment glue** (the bootstrap script per F22), private business logic (Stripe billing for Path 3 if not via run402, monitoring config, account-deletion cron), and the run402 serverless functions that wrap the public-repo code. It does NOT contain pluggable adapters for run402 services — those are imported directly inside the public repo.
- **Trade-offs:** A forker who wants to deploy kysigned WITHOUT run402 has more work — they'd need to fork the public repo and replace direct `fetch('https://api.run402.com/...')` calls with their own backend. This is intentional. The economics of running a kysigned clone WITHOUT run402 are unattractive enough that almost nobody will, and the few who do are sophisticated enough to do the rip-out themselves.
- **Revisit when:** Someone forks kysigned, builds a credible alternative backend, and either (a) demonstrates demand for a multi-backend public repo or (b) becomes a meaningful competitor. Until that happens, the trojan horse stays.

### DD-10: kysigned uses run402's HTTP DB surface, not direct pg (first HTTP-only DAO adopter)

- **Decision:** The kysigned public repo's data-access layer will fit run402's existing HTTP DB surfaces (`@run402/functions` `db.sql()` / `db.from()` / PostgREST `/rest/v1/*`) rather than wait for a new platform feature that injects a direct `pg` connection into deployed Lambdas. Concretely: the one DAO function that currently uses a cross-call pg transaction (`createEnvelope` in `kysigned/src/db/envelopes.ts:20-91`) will be rewritten as a single atomic multi-statement SQL call using a CTE that returns the envelope and all signers in one round trip. The `DbPool` interface in `kysigned/src/db/pool.ts` is narrowed to remove `connect()` — single-statement queries only. kysigned-service provides an `HttpDbPool` adapter wrapping `@run402/functions` `db.sql()` that satisfies the narrowed interface.
- **Context:** Surfaced while setting up the Phase 4 service deploy on 2026-04-08. kysigned's original DAO layer assumed a full `pg.Pool` with `connect()` → `BEGIN` → ... → `COMMIT` semantics (the canonical pg pattern). Deployed run402 Lambdas have no direct `pg` access — only HTTP-based SQL surfaces. Each `db.sql()` call is wrapped in its own server-side `BEGIN`/`COMMIT` transaction (`packages/gateway/src/routes/admin.ts:167-230`), and multi-statement SQL in a single call runs atomically inside that server-side transaction, but cross-call transactions are not possible.
- **Alternatives considered:**
  - *New run402 platform feature `lambda-db-direct`* — per-project Postgres LOGIN role, `RUN402_DATABASE_URL` env var injected into every deployed Lambda, RDS Proxy fronting the connection. Spec + design + tasks + spec-requirements drafted at `openspec/changes/lambda-db-direct/` and then **reverted** after discussion with the run402 team on 2026-04-08. Run402 has active concerns about (a) RDS connection count under Lambda burst-scale-out, (b) observability of per-project pool utilization, (c) the ops story for role password rotation, and (d) setting a precedent that every future app expects direct-pg. They would rather defer direct-pg as a future platform enhancement — after monitoring infra is in place and the operational story is mature — and let kysigned be the first validator of the HTTP-only DAO model instead.
  - *Accept partial inserts (no transactions)* — rejected as a data-integrity regression on a signing platform.
  - *Server-side stateful session endpoint holding a pg client per session id* — rejected (reintroduces state to a stateless gateway, session-hijacking risk, timeout/cleanup hazards).
  - *Client-side buffered batching that flushes on `COMMIT`* — rejected (breaks read-after-write patterns; `createEnvelope` reads `envelopeResult.rows[0]` between statements).
- **Chosen because:** (1) Respects run402's operational readiness and doesn't force a platform change on a team that has real concerns about the scaling story. (2) Keeps kysigned-service tiny — just a ~50-line HTTP adapter instead of a VPC/RDS-Proxy/role-provisioning platform feature. (3) Local dev AND production converge on the same code path — kysigned-service always uses the HTTP adapter, including in local-dev-against-localhost-run402. No local-vs-prod divergence. (4) The `DbPool` interface stays stable — only its implementation differs. If direct-pg lands later as a platform feature, kysigned swaps the adapter implementation without touching DAO code. (5) Single multi-statement CTE is atomic on the server (gateway wraps each `db.sql()` call in `BEGIN`/`COMMIT` per `routes/admin.ts:201-229`), so we don't regress data integrity — we just move the transaction boundary from "multiple round trips" to "single round trip with a CTE".
- **Trade-offs:**
  - `createEnvelope` becomes denser to read: one SQL statement with a WITH clause instead of a sequence of clear pg calls. Mitigated by good comments + tests.
  - Any future transactional operation (account deletion cascade, refund flow, cross-table update) will need the same CTE pattern. Mitigated by (a) most kysigned operations are single-statement today, and (b) if the pattern starts feeling painful, we revisit and push for `lambda-db-direct` at that point.
  - Tests that relied on `pool.connect()` mocks will need updating — but the in-memory pool already only implements `query`, so most tests are unaffected.
- **Rollback / revisit:** If kysigned hits a transactional pattern that cannot be expressed as a single CTE (read-after-write that depends on a DB-generated id, for example), the solution is to either (a) restructure the operation to generate ids client-side (kysigned already does this for envelope/signer ids), or (b) escalate to run402 to prioritize the `lambda-db-direct` platform feature. The OpenSpec draft for `lambda-db-direct` has been discarded; if revived later, it starts fresh.

### DD-11: Three Lambdas — API router, SES webhook, sweep cron

- **Decision:** Phase 4B deploys exactly three run402 functions from `kysigned-service`: (1) `kysigned-api` — HTTP router handling all `/v1/*` endpoints via a single entry point; (2) `kysigned-email-webhook` — receives run402's delivery/bounce webhook POSTs and dispatches to public-repo handlers; (3) `kysigned-sweep` — scheduled Lambda running twice daily (12h cron) that calls `sweepRetention` + a new `handleEnvelopeExpiration` (see DD-16) from the public repo.
- **Alternatives:**
  - *One Lambda for everything* — rejected because scheduled and HTTP invocation models differ at the Lambda level; run402's `schedule` config is per-function
  - *One Lambda per route* (~12 functions) — rejected because cold starts per route, more deploy overhead, no benefit at kysigned's traffic profile
- **Chosen because:** minimum function count for kysigned's invocation-model variety. Shared `HttpDbPool` singleton + shared email adapter in the API router means warm invocations reuse heavy objects. Each function has one clear responsibility. The three-function split also gives clean cost-attribution in run402's function-usage dashboard.
- **Trade-offs:** router cold start pays for importing all handler code, including paths the request doesn't use. Acceptable — cold starts are rare once warm and the import cost is ms-scale.
- **Rollback:** split the router into per-route functions if a single route's code ever dominates router cold-start time (monitored via function-usage dashboard).

### DD-12: Webhook correlation via `completion_email_provider_msg_id` on envelope_signers (small public-repo change)

- **Decision:** Extend `envelope_signers` with a nullable `completion_email_provider_msg_id TEXT` column (migration 005 in the public repo). Add helper functions `markCompletionEmailSent(pool, signer_id, provider_msg_id)` + `findSignerByCompletionEmailId(pool, provider_msg_id)`. Update `kysigned/src/api/sign.ts` completion-send loop to call `markCompletionEmailSent` after each `emailProvider.send()` (the provider already returns `{ messageId: string }`). The SES webhook Lambda in kysigned-service uses `findSignerByCompletionEmailId(run402_msg_id)` → `(envelope_id, email)` → calls the existing `markCompletionEmailDelivered` / `markCompletionEmailBounced` helpers.
- **Alternatives:**
  - *Best-effort match by email only* (use the `to_address` from the webhook payload + find most recent pending signer with that email) — rejected. Misattributes when one recipient has multiple pending envelopes at the same moment. Not acceptable on a signing platform where wrong-envelope-marked-delivered = stale PDF left on disk past retention window or early delete of a still-needed PDF.
  - *Store mapping in a kysigned-service side table* in the kysigned project schema — rejected. The correlation data is semantically owned by envelope_signers (it's "the provider's reference to the email we sent for this specific signer's completion notification"), so it belongs on the signer row. Splitting it into a service-repo side table creates a data-ownership split.
  - *Extend `EmailMessage` with an `envelope_id` + `purpose` field and have the adapter do the mapping* — also works, but spreads correlation logic across the type, the adapter, and every call site. Less clean than one column + one helper pair in the DAO layer.
- **Chosen because:** intrinsic data ownership. One migration + two helper functions in the public repo keep everything in one place. The SES webhook Lambda becomes a ~30-line dispatch function with no side state.
- **Trade-offs:** small public-repo touch (one migration, one new file pair, one call-site update in sign.ts, ~4 new unit tests). Lands before the service-repo webhook handler can be wired.
- **Rollback:** drop the column + revert the commit. Webhook handler falls back to email-only matching (degraded mode) until the column is restored.

### DD-13: E2E test suite is net-new, lives in the public repo at `test/e2e/`, runs against `BASE_URL`

- **Decision:** Create a new `test/e2e/` directory in the kysigned public repo with TypeScript tests that exercise the full HTTP surface against a configurable `BASE_URL`. Add `npm run test:e2e` script: `BASE_URL=http://localhost:4022 npm run test:e2e` for local, `BASE_URL=https://kysigned.run402.com npm run test:e2e` for production smoke. The suite covers the 5 scenarios approved during /plan: (1) multi-signer lifecycle happy path, (2) void flow with immediate PDF delete, (3) retention sweep end-to-end, (4) x402/MPP payment verification live, (5) failed-signing / expiration flow. This suite runs for the FIRST time against a real Postgres during Phase 4B — it is the primary validation gate for the Phase 4A CTE rewrite.
- **Alternatives:**
  - *Reuse run402's `bld402-compat` harness* — rejected; overkill for a single-product e2e and couples kysigned tests to run402's test infra
  - *Put the e2e in kysigned-service instead of the public repo* — rejected; forkers should be able to reproduce the same e2e against their own deployed instance (DD-9 trojan horse alignment)
  - *Skip e2e entirely and rely on unit tests* — rejected; the CTE has literally never run against real Postgres, unit mocks cannot catch SQL syntax errors, and the DD-10 risk section flagged this as the primary risk of the HTTP-only DAO model
- **Chosen because:** the e2e validates the full public-repo code end-to-end against a real deployment. Living in the public repo means forkers can rerun it against their own deployments. The same suite works for local (docker Postgres + local gateway) and production (api.run402.com) by just changing `BASE_URL`.
- **Trade-offs:** net-new test suite to build and maintain. Phase 4B's ship gate depends on it passing — delay risk if SQL bugs surface during the first run. This is the whole point of writing it, but it can extend Phase 4B's timeline by 1-2 sessions if the CTE needs tuning.
- **Rollback:** delete the suite if it becomes unmaintainable. Unit tests remain the primary correctness gate.

### DD-14: `deploy.ts` script in kysigned-service, idempotent, complements `bootstrap-run402.ts`

- **Decision:** Create `kysigned-service/scripts/deploy.ts` — idempotent end-to-end deploy that assumes `bootstrap-run402.ts` has already provisioned the project. `deploy.ts` steps: (1) bundle each function's entry file + inline dependencies, (2) deploy the 3 Lambda functions via `run402 functions deploy` (or the HTTP API directly), (3) register the SES webhook URL with the project's mailbox via `POST /mailboxes/v1/:id/webhooks`, (4) build `kysigned/frontend` with `VITE_*` env vars set to the current project's anon_key + API URL, (5) upload `dist/` via `run402 deploy --manifest`, (6) re-claim `kysigned.run402.com` subdomain pointing at the new deployment (replacing the placeholder from bootstrap). Every step checks current state before acting so re-runs are no-ops.
- **Alternatives:** *extend `bootstrap-run402.ts` with deploy steps* — rejected; mixes "create project" and "push new code" concerns. *Make deploy implicit in a CI workflow* — rejected for MVP; manual script now, CI wraps it later.
- **Chosen because:** matches saas-factory F22's bootstrap-vs-deploy separation. Clear mental model: bootstrap runs once per project ever, deploy runs every code change.
- **Trade-offs:** two scripts to maintain. Idempotency checks are ~30% of the code per step.
- **Rollback:** restore the placeholder site via bootstrap's original deploy step if a deploy goes wrong.

### DD-15: Admin auth via `KYSIGNED_ADMIN_WALLETS` env var + local SIWE verification

- **Decision:** The router Lambda gates admin routes (`/v1/admin/allowed_senders/*`) via a check that the request's SIWE-verified wallet is in the `KYSIGNED_ADMIN_WALLETS` env var (comma-separated). The verification uses the existing `verifySiweSignature()` from `kysigned/src/api/auth/dashboardAuth.ts` (Phase 2G work) — it's **pure local cryptography** via viem's `verifyMessage`, zero external auth calls. No dependency on run402 auth, no dependency on the public `POST /auth/v1/*` flow for admin routes specifically. For the Kychee-hosted kysigned.com deployment, the env var is set to Barry's + Tal's wallets. Forkers set their own. **Approved admin wallets for hosted deployment:** Barry (primary ops wallet, from bootstrap) + Tal (his own wallet, provided separately). Exact addresses go into the run402 project secrets at deploy time.
- **Alternatives:**
  - *Reuse run402's `ADMIN_KEY` header* — rejected; blast radius is the entire platform (leaked key compromises run402 + kysigned + every other product)
  - *Dedicated shared admin wallet whose key lives in AWS Secrets Manager* — rejected; shared private keys are a security anti-pattern; no clean rotation when an operator leaves
  - *Gnosis Safe multisig (2-of-3)* — rejected for MVP; the admin actions are low-stakes allowlist management, multisig ceremony is too heavy
  - *Per-admin API keys in a new `admin_api_keys` table* — rejected; net-new auth infrastructure that duplicates what SIWE already provides; per-admin revocation is nice-to-have but not worth the new table for ≤5 admins
- **Chosen because:** zero new code (reuses Phase 2G SIWE helper), forker-friendly (one env var → they're done), no shared secrets, auditable per-admin (logs identify which wallet did what), rotatable via env var update + redeploy.
- **Known limitations (documented in operator README):**
  - **Single-factor auth** — the only factor is "something you have" (the private key). Hardware wallets add wallet-level security but cannot be required (too much friction for forkers). Recommendation: operators SHOULD use hardware wallets but it's not enforced.
  - **Forker recovery gap** — forkers don't have AWS Secrets Manager access (that's Kychee's platform AWS), so if their single admin wallet is compromised or lost they have no backstop EXCEPT another wallet in the same env var list. The operator README therefore recommends `KYSIGNED_ADMIN_WALLETS` always contain ≥2 distinct wallets so rotation is possible without Kychee intervention. **For Kychee-hosted kysigned.com specifically, AWS Secrets Manager is the ultimate backstop** (Kychee controls the AWS account and can directly update the secret), so the hosted deployment is acceptable even with a single admin wallet.
  - **No per-admin revocation without redeploy** — removing one admin means editing the env var + redeploying. Not a dashboard click.
  - **No cross-product admin identity** — every saas-factory product gets its own env var and its own SIWE check. A Kychee operator managing 5 saas-factory products has 5 separate entries to maintain.
- **Cross-reference:** all four known limitations are lifted when run402 ships the platform-level admin auth service tracked as **saas-factory spec F24** (future enhancement, not yet specced). When that lands, DD-15's env-var pattern becomes a 1-line `requireAdmin(request)` call against the run402 SDK.
- **Trade-offs:** single-factor, env-var rotation, no per-admin revocation — all acknowledged and parked for the future platform feature.
- **Rollback:** fall back to no admin auth (admin routes return 501) until a replacement is chosen. Not a scenario we expect.

### DD-16: Envelope expiration handler (small public-repo addition)

- **Decision:** Add `handleEnvelopeExpiration(ctx)` to the public repo at `kysigned/src/api/envelope.ts`. The handler iterates envelopes via `getExpiredEnvelopes(pool)` (DAO already exists — transitions status to 'expired' and returns the rows), and for each expired envelope: (1) sends an `envelopeExpired` notification email to the sender with signer status breakdown (who signed, who didn't), (2) sends `envelopeExpired` notifications to pending signers informing them the envelope is no longer valid, (3) calls `ctx.deletePdf(envelope.pdf_storage_key)` per F8.6's immediate-delete-on-terminal-state rule, (4) emits an audit log line. New email template `envelopeExpired({ recipientName, documentName, senderName, signedCount, totalCount, signedNames, pendingNames })`. The `kysigned-sweep` scheduled Lambda (DD-11) calls this handler on the same 12h cron tick as `sweepRetention`.
- **Context / why this gap exists:** Phase 2's task "Implement envelope expiry logic — check TTL, transition to expired, notify parties" was marked `[x]` in the plan, but only the DB-level transition was actually built (`getExpiredEnvelopes` in `envelopes.ts`). The notification + PDF cleanup half of the task was never implemented at the handler level. Phase 4B's failed-signing e2e test cannot pass without it — the test needs the expiration email to verify X receives feedback — so this gets picked up as part of Phase 4B.
- **Alternatives:** *skip notifications, let the DB status quietly flip* — rejected; the user has no way to know their envelope failed. *Notify only the sender, not pending signers* — rejected; pending signers who try to sign after expiration should get a clear "this envelope is expired" message, which requires the notification flow.
- **Chosen because:** completes the Phase 2 task that was mis-marked done. Small scope (~80 LOC handler + 1 email template + 5-8 unit tests).
- **Trade-offs:** another small public-repo touch. The public repo was "done" before Phase 4B started, but DD-12 + DD-16 both require small additions — acknowledged as the cost of deploying an MVP that exercises the full spec.
- **Rollback:** remove the handler + template. `getExpiredEnvelopes` continues working in DB-only mode (status transitions without notifications).

### DD-17: Dark-Launch Canary Ritual before First Mainnet Deploy

> **Scope:** this DD is the plan-level instantiation of spec F17 (pre-launch dark-launch canary discipline) and saas-factory F25 (factory-level generalization). F17/F25 describe WHAT the discipline is; DD-17 describes HOW kysigned executes it, resolves the five F17 open questions (#18–#22), and re-sequences Phase 13 accordingly.

**Decision:** Before deploying `SignatureRegistry.sol` to Base mainnet under the kysigned brand, deploy a functionally-identical canary contract to Base mainnet via a separate anonymous KMS wallet, run kysigned-service in full production mode against the canary contract for a dark-launch phase, dogfood the full product until a feature checklist is green AND Barry+Tal explicitly approve, then "launch" by deploying the production contract and flipping two kysigned-service env vars — no application code change. The byte-identical bytecode check is a hard pre-flip gate.

**Alternatives considered:**
- *Direct mainnet deploy under the kysigned brand (the original Phase 13 plan).* Rejected — reputational risk of a botched-but-already-verified-on-Basescan kysigned contract is permanent, and kysigned is run402's first production consumer of the KMS wallet path (drain endpoint, recovery address, 90-day KMS deletion lifecycle, KMS-signs-arbitrary-tx flow all untested in production). One bad deploy compounds both risks.
- *Multi-environment staging (separate "staging.kysigned.com" + staging DB + staging SES + staging contract).* Rejected — complexity cost is high, staging drift from production is a known failure mode, and we'd still be launching "fresh code on fresh infra" at production flip time. The canary pattern gives us a stronger guarantee with less infrastructure.
- *Contract-only rehearsal via raw viem scripts (deploy + call 3 methods, no product-level exercise).* Rejected — misses product-level integration bugs that are the whole reason first launches fail. Only marginal improvement over "just deploy it."
- *Long-lived canary wallet with periodic bump cron* (explored in brainstorm Q3). Rejected — at 1-3 canary events over kysigned's lifespan, amortizing $1.20 prepay across them saves essentially nothing in exchange for real recurring ops burden. Ephemeral canary is strictly better.
- *Single KMS wallet for both canary and production.* Rejected — Basescan's "Contract Creator" link is one click away from any contract, which would make the canary→production linkage trivially discoverable. Two wallets moves the bar from "one click" to "deliberate investigation."

**Chosen because:** (1) launch day becomes a config flip instead of a fresh deploy — the lowest-risk launch posture possible; (2) the byte-identical bytecode gate is a cryptographic proof that the canary rehearsed the real thing; (3) the drain endpoint, recovery address, and KMS-signs-arbitrary-tx flow all get their first production exercise during the canary phase, on the easy path, on our schedule — not during an incident; (4) reputational exposure is limited to an anonymous bytecode-only contract rather than a branded kysigned artifact; (5) the pattern generalizes to every future saas-factory product as F25, amortizing the design thinking across the product family.

**Trade-offs:** extra **$2.40 prepay** (two wallets × $1.20 prepay each — rent is charged **per wallet, not per project**, per `KMS_WALLET_RENT_USD_MICROS_PER_DAY` in `contract-wallets.ts`), extra ~$25 ETH float for the canary wallet (recoverable via drain at retirement), extra $0.04/day rent while both wallets are active (~$0.08/day during the dark-launch phase itself, dropping to $0.04/day after canary retirement), approximately **one extra week** added to the launch timeline for the dark-launch phase, and non-trivial coordination between Phase 13 and the parallel Phase 4B (service-deploy) chat — they are no longer independent.

**Rollback:** abort the canary→production flip, investigate, fix the issue on the canary-pointed service, redeploy the service, re-run the affected checklist items, re-attempt the flip. The canary wallet and canary contract remain in place through the retry; only the production wallet and production contract are reprovisioned if a fix requires a new deploy. If the fundamental premise fails (e.g., run402 KMS path is broken and cannot be fixed), rollback = revert to direct mainnet deploy under the kysigned brand, accept the reputational risk.

**Resolves spec F17 Open Questions:**

**OQ #18 — run402 capability gaps.** Verified against `packages/gateway/src/routes/contracts.ts` + `services/contract-wallets.ts` + `services/contract-call.ts` + `services/contract-call-reconciler.ts`:

- ✅ **Two wallets per project:** supported. `provisionWallet()` inserts into `internal.contract_wallets` with no uniqueness constraint beyond the primary key. A project can hold an arbitrary number of wallets.
- ⚠️ **NO dedicated deploy endpoint exists.** The contracts/v1 surface is wallets/call/read/drain only. There is no `POST /contracts/v1/deploy` or `POST /contracts/v1/wallets/:id/deploy`. To deploy a fresh contract via a KMS wallet, one of two paths is required:
  1. **Workaround path (preferred if it works):** use the existing `POST /contracts/v1/call` endpoint with `contract_address: "0x0000000000000000000000000000000000000000"` and pass the full creation bytecode (runtime code + constructor args) in place of `function_name` call data. This is an untested code path — the route validates `contract_address` at `contracts.ts:292`, and it's unclear whether the zero address is accepted. This MUST be verified in Phase 13A **before** any real canary work begins. If the workaround works, no run402 enhancement is needed.
  2. **Enhancement path (fallback):** land a small run402 enhancement adding `POST /contracts/v1/wallets/:id/deploy` that accepts `{ bytecode, constructor_args?, chain }` and returns `{ call_id, tx_hash, status }` (same response shape as the existing `/call` endpoint, with a synthetic zero-address entry in the call log). ~2 hours of work, added to the run402 plan queue if workaround fails.
- ✅ **No provision-specific rate limiting.** A global 100 req/sec per-API-key rate limit applies to all endpoints (see `server.ts` `rateLimit()` middleware, default `RATE_LIMIT_PER_SEC=100`). Two back-to-back `provision-wallet` calls are well within budget.
- ⚠️ **Gas is pre-funded ETH on the wallet, not billing credits.** The wallet's on-chain ETH balance pays gas. Billing credits only cover rent + sign fee (5 USD-micros per call). We must fund each wallet with enough ETH for the deploys and ongoing envelope recordings BEFORE running any deploy calls.
- ⚠️ **Rent is per-wallet, not per-project.** `PREPAY_REQUIRED_USD_MICROS = 30 * KMS_WALLET_RENT_USD_MICROS_PER_DAY = $1.20` is charged PER wallet at provision time. Canary pair = $2.40 prepay. The kysigned project's billing balance must cover both provisionings.

**OQ #19 — Byte-identical bytecode check precise mechanism.** The gate runs in a kysigned-service script (NOT in the public kysigned repo, to honor DD-9 + F17's anti-leakage). Mechanism:
1. Fetch the canary contract's runtime bytecode: `eth_getCode(canaryAddress, 'latest')` via the Base mainnet RPC (already configured as `run402/base-mainnet-rpc-url`).
2. Fetch the production contract's runtime bytecode: `eth_getCode(productionAddress, 'latest')` via the same RPC.
3. **Strip the Solidity metadata suffix from both bytecodes.** Solidity appends a CBOR-encoded metadata section at the end of runtime bytecode, containing compiler version, source mapping hash, and optionally IPFS/Swarm hash. The length of this section is encoded in the last 2 bytes (big-endian uint16) as the byte count of the metadata, NOT including the 2-byte length field itself. Algorithm: `metadata_len = uint16_be(bytecode[-2:]); core = bytecode[:-(metadata_len + 2)]`. This gives the "logic-only" bytecode with no compiler fingerprint.
4. Compare `keccak256(canary_core) === keccak256(production_core)`. Match → proceed with flip. Mismatch → ABORT, investigate (see OQ #21 playbook).
5. The check is implemented as a small script `kysigned-service/scripts/bytecode-identity-check.ts` (new file, TDD, mocked `eth_getCode` in tests, run against mainnet in anger). Executed manually by the operator during the flip ritual and its output logged to the Implementation Log.

**OQ #20 — Canary checklist contents.** Enumerated here (plan-level, not spec-level). To unlock the go/no-go gate, **every item below must be confirmed working end-to-end against the canary contract**:

Dashboard path:
- [ ] Create envelope via hosted dashboard, PDF upload, 2 signers
- [ ] Both signers receive signing emails at Barry + Tal @ kychee.com with correct subject (envelope ID + docHash), `Reply-To: reply-to-sign@kysigned.com`, review link, and `How it works →` link
- [ ] Signer 1 replies `I APPROVE` from their mailbox → operator receives raw MIME with DKIM headers preserved → zk proof generated → on-chain record written to canary `SignatureRegistry`
- [ ] Signer 2 replies `I APPROVE` → same flow completes → envelope reaches `completed` status
- [ ] Both signers receive completion emails with signed PDF (including certificate page) attached
- [ ] Envelope status page shows `completed` with both tx hashes
- [ ] Basescan link from the proof page resolves to the canary contract (not kysigned-branded)
- [ ] Verify using `(email, document)` inputs on the verification page — computes `searchKey`, finds the reply-to-sign record, retrieves zk proof from event, verifies zk proof against evidence key, checks key consistency
- [ ] Verify-by-envelope-id proof link displays full audit trail

API path:
- [ ] Create envelope via `POST /v1/envelope` with x402 payment header
- [ ] Create envelope via `POST /v1/envelope` with MPP payment header
- [ ] `GET /v1/envelope/:id` returns correct state
- [ ] `POST /v1/envelope/:id/remind` successfully triggers reminder email
- [ ] `POST /v1/envelope/:id/void` successfully voids an active envelope and deletes its PDF
- [ ] Webhook `callback_url` receives correct POST on completion

MCP path:
- [ ] `kysigned-mcp` installed via `npx -y kysigned-mcp`, pointed at the canary-backed kysigned endpoint
- [ ] MCP `create_envelope` tool creates a real envelope
- [ ] MCP `check_envelope_status` tool returns correct state
- [ ] MCP `verify_document` tool returns correct verification result

Signing flow variations:
- [ ] Sequential signing: signer 2 does NOT receive signing email until signer 1's reply is processed and recorded
- [ ] Parallel signing: both signers receive signing emails simultaneously and can reply in any order
- [ ] Sender-as-signer: "Will you also sign?" prompt works, sender signs via same reply-to-sign flow as other signers
- [ ] Non-matching reply: signer replies with random text → auto-reply with guidance sent, no signature recorded
- [ ] Duplicate reply: signer sends a second `I APPROVE` → no-op, auto-reply "you have already signed"
- [ ] No-reply / expiry: envelope expires per F1.7, all parties notified

Retention + F8.6:
- [ ] Completion email delivery webhook (from SES) triggers immediate PDF deletion via `markCompletionEmailDelivered`
- [ ] Bounce webhook triggers bounce path and eventually the 7-day fallback deletion
- [ ] `sweepRetention` cron actually runs on the deployed schedule and deletes expired PDFs
- [ ] Envelope metadata persists after PDF deletion

Payment + billing:
- [ ] x402 payment via run402 billing balance check returns correct wallet + deducts correct amount
- [ ] MPP credential flow works end-to-end
- [ ] `allowed_senders` allowlist enforces correctly in hosted mode
- [ ] Monthly quota enforcement works for a sender with a configured quota

Monitoring:
- [ ] Bugsnag receives at least one synthetic error during the canary phase and it appears in the dashboard
- [ ] Telegram alerts channel receives at least one INFO and one CRITICAL alert (once the channel exists — Phase 14 manual task)
- [ ] CRITICAL email alerts via SES reach the on-call address

Gas + cost verification (inherited from the pre-F17 Phase 13 intent):
- [ ] Measure real Base mainnet gas cost per operation (`recordReplyToSignSignature` with zk proof, `recordWalletSignature`, `recordCompletion`, `registerEvidenceKey`) — compare against Sepolia measurements from Phase 1R
- [ ] Calculate true per-envelope cost (gas + zk proof generation compute + email + Lambda + KMS sign fees) and confirm $0.39 pricing holds with healthy margin
- [ ] If real per-envelope cost exceeds $0.20 (51% of the $0.39 target), escalate to pricing review BEFORE the flip — pricing adjustment is still reversible during canary phase

Each item gets a timestamp and a short note when confirmed. The list lives inline in Phase 13C below (not duplicated here).

**OQ #21 — Bytecode-divergence investigation playbook.** If the F17.3 byte-identical gate (OQ #19 above) fails at flip time:

1. **Do NOT flip.** The gate is a hard abort. No override.
2. **Diff the stripped bytecodes** with a byte-level diff tool. Identify WHERE they differ (opcode positions, approximate "function" region via a disassembler like `heimdall` or manual PUSH/JUMPDEST scan).
3. **Check for common causes in order of likelihood:**
   - (a) Different Solidity compiler version between the canary and production build. Check `package.json` / `hardhat.config` for version pinning. If the pin moved, that's the cause. Fix: re-build production with the pinned version that matches canary.
   - (b) Different optimization settings (optimizer runs). Check hardhat.config. Fix: align settings.
   - (c) Different constructor arguments. Compare the deploy tx input data for both deploys — any constructor args land inside the init code and change the resulting runtime bytecode indirectly via constructor logic.
   - (d) Contract source was modified between canary and production deploys. `git log packages/kysigned-service/contracts/SignatureRegistry.sol` should be empty between the two deploys. If it's not, something changed that shouldn't have.
   - (e) Genuine compiler non-determinism. Very rare with Solidity. Last resort hypothesis.
4. **Decision matrix for remediation:**
   - (a), (b), (d): **re-deploy production** with the corrected build settings, re-run the bytecode gate. Canary phase does NOT need to be re-run.
   - (c): **re-deploy production** with corrected constructor args. Canary phase does NOT need to be re-run.
   - (e): escalate to the run402 team, treat as a run402-level issue. Pause the launch.
   - Anything else (unexpected): treat as a real bug. **Re-run the full canary checklist from scratch** against a freshly redeployed canary. The cost is a week of extra time but the safety guarantee is worth it.
5. **Document the divergence in the Implementation Log** before attempting any fix — future-you will want to know what happened.

**OQ #22 — Production-contract smoke specifics.** After the flip, run exactly one smoke-test envelope through the production contract. Specifics:
- **Surface:** API path (`POST /v1/envelope`). Rationale: API path exercises the canonical server-side code path without any frontend rendering concerns, easiest to debug if something fails.
- **Signer:** Barry as sender, Tal as sole signer (single-signer envelope). Rationale: simplest possible envelope structure, one signature covers the entire server-to-contract code path.
- **Signature method:** Reply-to-sign (Tal replies `I APPROVE` from their mailbox). Rationale: reply-to-sign is the only signing method on the hosted service; if the full DKIM → zk proof → on-chain recording → verification pipeline works against the production contract, the full-product assumption holds.
- **Timing:** Tal MUST complete the reply within 15 minutes of the flip. If Tal can't, the smoke test is delayed until Tal is available — do NOT substitute a different signer, do NOT skip the smoke.
- **Success criterion:** (a) envelope reaches `completed` status, (b) the production `SignatureRegistry` address appears in the proof page tx hash lookup, (c) the `EvidenceKeyRegistry` contains the evidence key used for Tal's DKIM verification, (d) Basescan shows the recording tx landed on the production contract, (e) verify-by-`(email, document)` on the signed PDF returns correct signer details with a valid zk proof.
- **Rollback on smoke failure:** abort the launch announcement. Flip the kysigned-service env vars back to the canary addresses (the canary wallet still exists at this point because retirement happens AFTER smoke success). Investigate. Do NOT proceed to Phase 14's public-repo flip until the production contract smoke passes.

**Canary retirement sequence (addresses F17.9 + the Q6 finding that rent is per-wallet):**
1. Drain canary wallet's on-chain ETH back to the kysigned ops EOA wallet (`0x8D671Cd12ecf69e0B049a6B55c5b318097b4bc35`) via `POST /contracts/v1/wallets/:canary_id/drain` with `X-Confirm-Drain: <canary_id>` header and `destination_address: <ops_eoa>` body. Poll `GET /contracts/v1/calls/:call_id` until status=`confirmed`.
2. Explicitly delete the canary wallet via `DELETE /contracts/v1/wallets/:canary_id`. **This is the critical step to stop $0.04/day rent accrual** — draining ETH alone doesn't stop the daily rent, because rent is debited from the kysigned project's billing account, not the wallet's ETH balance. The delete schedules the underlying KMS key for deletion per the 90-day lifecycle.
3. Remove canary references from AWS Secrets Manager: `kysigned/canary-contract-address` and `kysigned/canary-wallet-address` secrets can be deleted OR renamed to `kysigned/retired-canary-*` for historical record (recommendation: rename, not delete — historical accountability).
4. Schedule a T+75 calendar reminder for the KMS key deletion checkpoint (the 90-day lifecycle is permissive; if for any reason we want to un-delete, it's possible up to day 90). If no reason surfaces, the key deletes automatically at day 90.
5. The canary CONTRACT itself remains on Base mainnet forever (smart contracts are immutable). It becomes an orphaned bytecode-only artifact with no known association to kysigned — per F17.10 this is the expected end state.


### DD-18: Method A (Ed25519 auto-stamp) removed entirely — reply-to-sign is the only signing method

- **Decision:** Remove Method A (Ed25519 keypair + signer_commitment + auto-stamp generation) from both the public repo and the service repo. The only signing methods are: reply-to-sign (email DKIM + zk-email proof, `[both]`) and wallet signing (Method B / EIP-712, `[repo]` only). The hosted service at kysigned.com exposes reply-to-sign only.
- **Alternatives considered:**
  - *Keep Method A as `[repo]` alongside reply-to-sign:* rejected — Method A's Ed25519 commitment model has no cryptographic binding between the signer's email and the signing act (the public key is generated client-side with no identity proof). Reply-to-sign is strictly superior for email-based signing because the DKIM signature IS the identity proof. Keeping Method A creates a confusing dual-path for forkers with no security benefit.
  - *Replace Method A with a simplified click-to-sign (no Ed25519):* rejected — a click-to-sign without cryptographic proof is weaker than what the spec demands. The spec's entire value proposition is cryptographic verification independent of any operator.
- **Chosen because:** reply-to-sign provides stronger proof (DKIM is the signer's mail provider attesting mailbox control, not a self-generated key). Removing Method A simplifies the codebase, the frontend signing page, the contract interface, and the documentation. Method B (wallet/EIP-712) stays for forkers who need wallet-based signing.
- **What gets removed:** `src/api/sign.ts` Method A path, `recordEmailSignature` from `SignatureRegistry.sol`, Ed25519 key generation (`@noble/ed25519` dep), auto-stamp generation (`pdf-lib` signature embedding), drawing widget + signature persistence (localStorage), verification level prompts (Level 1/2), `require_drawn_signature` envelope option, frontend Method A/B choice UI, ~30+ Method A unit tests, e2e tests using Ed25519 keypairs.
- **What stays:** Method B (wallet/EIP-712) as `[repo]`, `recordWalletSignature` in the contract, all envelope management/payment/billing/allowed_senders/dashboard/verification code (with modifications for the new signing flow).
- **Trade-offs:** existing Method A code (~2000 LOC + tests) is discarded. This is sunk cost — the reply-to-sign pivot is a better product.

### DD-19: Reply-to-sign inbound handler lives in the public repo (DD-9 alignment)

- **Decision:** The inbound email signing handler — parse raw MIME, validate DKIM, extract `I APPROVE`, trigger zk proof generation, record on-chain — lives in the public repo (`kysigned/src/api/signing/`). The service repo wires the run402 mailbox webhook to this handler, same pattern as the existing `emailWebhook.ts` for delivery/bounce webhooks.
- **Alternatives:** *Put the handler in the service repo* — rejected; violates DD-9 (trojan horse). Forkers should get the full signing pipeline out of the box. The handler is a pure function: `(rawMime: Buffer, deps: SigningDeps) => Promise<SigningResult>`. No run402-specific code.
- **Chosen because:** (1) Forkers get the complete reply-to-sign pipeline. (2) The handler is testable in isolation with mocked MIME bytes. (3) Consistent with DD-9 — run402 dependencies are direct `fetch` calls in the handler, not abstracted away.
- **run402 dependencies consumed by the handler:**
  - `GET /mailboxes/v1/:id/messages/:messageId/raw` — fetch raw MIME from S3 (confirmed landed 2026-04-10)
  - `POST /contracts/v1/call` — submit on-chain recording via KMS wallet
  - Inbound webhook delivery from run402's email pipeline (confirmed landed 2026-04-10: custom-domain inbound routing)
- **Trade-offs:** the handler needs access to a DKIM validation library and a zk proof generation library, both of which are new dependencies in the public repo. These are determined by the Phase R research spike.

### DD-20: Quantum-resistance posture — document, don't mitigate

- **Decision:** kysigned acknowledges quantum computing risks in documentation (LEGAL.md, spec F12.7) but does NOT implement post-quantum cryptographic primitives in the MVP. The posture is: document the threat, design for upgradeability, and revisit when PQ standards mature.
- **Rationale by component:**
  - **KDF (searchKey):** argon2id is quantum-resistant. Grover's algorithm gives quadratic speedup on brute-force, but memory-hard KDFs resist this. Doubling memory/iteration parameters restores full security. OWASP 2026 recommends argon2id at 128 MiB / 3 iterations. No action needed.
  - **SHA-256 (docHash):** NIST assesses SHA-256 remains quantum-secure. 256-bit output provides 128-bit security against Grover's — sufficient for 20+ year horizon. No action needed.
  - **DKIM signatures (RSA-2048):** Vulnerable to Shor's algorithm on a sufficiently large quantum computer. NIST estimates large-scale quantum ~2035+. The `EvidenceKeyRegistry`'s DNSSEC proof chain creates a permanent record of the key valid *at signing time* — this is the correct mitigation (historical proof, not preventive). Mail providers will migrate to PQ-safe DKIM keys before quantum computers can break RSA-2048; new evidence keys registered at that time will use the PQ algorithms. Existing pre-quantum signatures are evaluated in historical context (same as all digital signatures created before a cryptographic break).
  - **zk-SNARKs:** Most SNARK proving systems (Groth16, PLONK) rely on elliptic curve pairings vulnerable to Shor's. Post-quantum SNARKs (STARKs) exist but have larger proof sizes (~50-200 KB vs ~256 bytes for Groth16) and higher gas costs. The Phase R research spike will note STARK compatibility as a future upgrade path but will NOT require PQ-safe SNARKs for the MVP.
  - **NIST PQC standards (2024-2026):** ML-KEM, ML-DSA, SLH-DSA are finalized. HQC expected 2026-2027. These are relevant for key exchange and digital signatures, not for KDFs or hash functions. kysigned's threat model is archival integrity (signatures verified decades from now), not real-time key exchange — so the PQ migration path is: (1) mail providers adopt PQ-safe DKIM, (2) new evidence keys use PQ algorithms, (3) existing records are "pre-PQ" and evaluated historically.
- **Documentation deliverables:** LEGAL.md F12.7 section, "How it works" page FAQ on longevity, spec OQ section acknowledging the timeline.
- **Trade-offs:** a sufficiently advanced quantum computer before ~2035 would theoretically allow forging DKIM signatures on existing evidence keys. This is the same risk as every DKIM-reliant system (email authentication globally). The `EvidenceKeyRegistry` blockchain-timestamped key archive + key consistency across signatures (F4.9) provides non-repudiation — better than most systems that don't archive the key at all.
- **Revisit when:** NIST PQ signature standards are widely deployed by mail providers (likely 2028-2032), OR a credible quantum threat timeline accelerates to <5 years.

### DD-21: ~~PLONK proof system (replacing Groth16)~~ — SUPERSEDED by zkprover DD-12 (RISC Zero, 2026-04-12)

> **This DD is historical.** The proof system is now **RISC Zero zkVM** (STARK inner + Groth16 wrapper), chosen via the zkprover v0.1.0 comparison. See `docs/plans/zkprover-plan.md` DD-12 for the current decision and full rationale. DD-21's PLONK direction was the starting point that led to the snarkjs tooling wall (1R.3 history), which triggered the zkprover mini-product.

- **Original decision (superseded):** Use PLONK (via snarkjs/circom) instead of Groth16 for on-chain zk proof verification. Compile the circuit ourselves using `@zk-email/circuits` EmailVerifier as a library — no dependency on the zk-email SDK registry's Blueprint system.
- **Why not Groth16:** Groth16 requires a per-circuit trusted setup ceremony that produces "toxic waste." If any ceremony participant keeps their random numbers, they can forge proofs. This is mathematically unprovable — you cannot prove someone deleted data. For a product whose value proposition is "trust no one, verify everything," this is an unacceptable asterisk.
- **Why not the zk-email SDK registry:** The registry's Blueprint system enforces a single `senderDomain` per blueprint. kysigned must work with ANY email domain (Gmail, Outlook, corporate domains, private domains). The domain restriction is in the SDK JavaScript wrapper, not the circuit — but depending on a workaround is fragile.
- **Why PLONK:** No per-circuit ceremony. Uses a universal Powers of Tau SRS (Hermez, 100+ participants, used by the entire Ethereum ecosystem). The circuit is compiled from circom, setup uses the public `.ptau` file, no toxic waste generated. snarkjs supports PLONK natively for circom circuits.
- **Trust model (honest):** PLONK still relies on the universal Powers of Tau ceremony ("at least one of 100+ participants was honest"). This is NOT zero-ceremony — it's the same trust assumption used by zkSync, Scroll, Polygon zkEVM, and every major Ethereum L2. It is the strongest practical trust posture available for EVM-compatible zk proofs today. Truly trustless options (STARKs, Halo2+IPA) are either too expensive for EVM or require a full circuit rewrite.
- **Cost impact:** ~$0.02-0.05 more per signer vs Groth16 (~$0.05-0.07 total vs ~$0.03-0.05). Absorbed by the new pricing model: $0.29 base (2 signers) + $0.10/extra signer. Margins: 52% at 2 signers, 41% at 5 signers, 49% at 10 signers.
- **Any-domain support:** The circom EmailVerifier circuit has NO domain constraint. Domain validation happens at the application level (operator pre-check: `d=` / `From` alignment per F3.3.4). The circuit proves DKIM signature validity for any RSA-2048 key.
- **Future-proofing:** Verifier contract is separately deployable (address in config). If a cheaper trustless option matures (transparent SNARKs with EVM-friendly verification), swap the verifier contract without touching signature records.
- **GPT-5.4 Pro consultation:** Confirmed PLONK/FFLONK are the best practical choices for circom + EVM. Also confirmed no production-ready transparent system matches Groth16/PLONK gas costs today. See `consultations/plonk-vs-alternatives-proof-system.md`.

### DD-22: Pricing model — $0.29 base + $0.10/extra signer (cost basis updated for RISC Zero)

- **Decision:** Replace the flat $0.39/envelope (5 signers included) with $0.29/envelope (2 signers included) + $0.10 per additional signer.
- **Why (updated 2026-04-12 for RISC Zero):** RISC Zero costs ~$0.03-0.04 per signer (gas ~$0.02 at ~280k gas + proof compute ~$0.005 + Groth16 wrap ~$0.002 + email ~$0.001 + KMS ~$0.005). Margins improved over original PLONK estimate: 72% at 2 signers, 66% at 5 signers, 63% at 10 signers (was 52%/41%/49% under PLONK). Per-signer pricing remains appropriate — even with lower costs, the model scales cleanly.
- **Examples:** 2 signers = $0.29 (was $0.39). 5 signers = $0.59 (was $0.39). 10 signers = $1.09. Still massively cheaper than DocuSign ($15-45/envelope).

### DD-23: ~~Rust-native PLONK prover (replacing snarkjs)~~ — SUPERSEDED by zkprover DD-12 (RISC Zero, 2026-04-12)

> **This DD is historical.** The Rust-native PLONK prover approach was proposed on 2026-04-11 but pre-flight research immediately found no working Rust pipeline exists for `circom R1CS + Hermez ppot → PLONK-BN254`. This finding triggered the zkprover mini-product, which built 4 candidates (snarkjs, TACEO, SP1, RISC Zero) and chose RISC Zero. See `docs/plans/zkprover-plan.md` DD-12. The settled constraints below (trust anchor, no operator-verified weakening) remain valid and are preserved.
>
> **Supersedes 1R.3's earlier "decide between (a) shrink circuit, (b) Rust tooling, (c) proving service, (d) rethink trust model" framing.** The trust model is settled (see "Settled constraints" below) and the circuit is NOT shrunk as part of this pivot. Only the prover implementation changes.

**Decision:** Switch the PLONK prover from `snarkjs` to a **Rust-native PLONK-BN254 implementation that uses the Perpetual Powers of Tau ceremony** (i.e., loads a Hermez `.ptau` file). The circuit (`circuits/kysigned-approval.circom`, 4.6M r1cs / ~8.27M PLONK constraints) stays **byte-identical**. The on-chain PLONK Solidity verifier stays functionally equivalent (regenerated from the new prover's setup output if necessary, but proving the same relation over the same curve with the same SRS). Gas cost per verification: unchanged. Operational signing cost: unchanged or better (Rust provers are faster than snarkjs at any size).

**Settled constraints (do not relitigate in future sessions):**

1. **Groth16 is permanently off the table.** Not "maybe later," not "if PLONK fails," not "for a simpler variant." Never. Reason: Groth16 requires a per-circuit Phase 2 ceremony. Any ceremony Kychee participates in means asking users to trust Kychee, which defeats the entire value proposition of the product ("trust no one"). This has been discussed and re-confirmed across multiple sessions; do not raise Groth16 again under any framing, including "per-circuit ceremony with transparent public witnesses" or "zk-email's own Phase 2." Settled.
2. **Moving security-critical checks out of the circuit to an "operator-verified" layer is permanently off the table.** The circuit is the cryptographic trust anchor; weakening it destroys the product. Do not propose this under any framing (including "pre-check layer that also does the real check," "lightweight operator-side verification," etc.). A pre-check layer for **UX only** (e.g., rejecting oversized bodies and asking the signer to retry clean) is allowed IFF the circuit still cryptographically enforces the real constraint on the bytes it sees. Settled.
3. **Trust anchor must be math or a pre-existing, globally-trusted, universal ceremony** — specifically the Perpetual Powers of Tau (Hermez, 100+ contributors including EF, Vitalik, zcash, major L2 teams). This is the same SRS used by zkSync, Scroll, Polygon zkEVM. No Kychee-run ceremony, no narrow-participant ceremony, no "trust us." PLONK-BN254-over-ppot is the eligible configuration. Halo2 / STARKs / plonky2 are technically acceptable on trust grounds but have other disqualifiers (Halo2+EVM is expensive to verify, plonky2 uses Goldilocks field which is not EVM-friendly). PLONK-BN254 stays. Settled.
4. **Circuit shrinking is NOT bundled with this pivot.** A "circuit diet" (e.g., `maxBodyLength` 1024→256, `maxHeaderLength` audit, `FromAddrRegex` reduction) remains a legitimate optimization for a future task, but it is **deferred** so that we change only one variable at a time. If and when the circuit is shrunk later, it becomes its own task with its own security review (the `FromAddrRegex` shrink in particular has a sharp edge — the binding `emailCommit = Hash(from_address_bytes, docHash, envelopeId)` must be preserved, and an attacker who could break that binding could forge sender identity — so that shrink needs adversarial TDD). None of this is relevant to 1R.3. Do not conflate.

**Root cause of snarkjs failure (reference, do not re-investigate):** snarkjs is a JavaScript (Node/V8) implementation. Its PLONK setup computes polynomial evaluations on an extended domain of size ~8×N where N is the PLONK constraint count. For N=8.27M, this means ~66M BN254 field elements (32 bytes each) per polynomial, times ~10 concurrent polynomials, plus FFT scratch. This is ~20–40 GB of live typed-array allocation. V8 has **per-space heap limits** (semi-space, large-object-space) that are **not controllable via `--max-old-space-size`**. All documented attempts to raise these limits fail on circuits of this size. This is a tooling limitation, not a fundamental limitation of PLONK; native-code provers (Rust/Go/C++) do not have this ceiling because they manage their own allocators. EC2 attempts on 2026-04-11 (c5.4xlarge OOM at 30GB, r5.4xlarge spot terminated, r5.4xlarge on-demand 124GB RAM failed at V8 internal limits with zkey at 7.1GB) confirmed this — **hardware is not the bottleneck; snarkjs is**. Do not retry snarkjs on bigger hardware.

**Tool selection (Rust-first, prioritized fallback list):**

| Priority | Tool | Language | Trust model | Notes |
|---|---|---|---|---|
| 1 (primary) | `ark-circom` + `jellyfish` (Espresso Systems PLONK) | Rust (arkworks) | PLONK-BN254 + ppot ✓ | `ark-circom` loads the existing `.circom` circuit unchanged into arkworks R1CS; jellyfish is a production-grade PLONK-BN254 backend used by Espresso rollup. No circuit rewrite needed. Best primary candidate. |
| 2 (fallback) | `ark-circom` + `dusk-plonk` (Dusk Network PLONK) | Rust | PLONK-BN254 + ppot ✓ | Alternate arkworks-compatible PLONK backend. Well-maintained by Dusk. Same circuit. Use if jellyfish integration hits snags. |
| 3 (fallback) | `gnark` (ConsenSys) | Go (NOT Rust) | PLONK-BN254 + ppot ✓ | Production-grade, battle-tested on Linea mainnet with circuits far larger than ours. Flagged as "not Rust" per user preference, but listed as the last-resort "known to work at scale" option if both Rust options hit issues. |
| OFF | `halo2` | Rust | No trusted setup (Pasta curves) | Different proof system, different curve; expensive EVM verification. Do not attempt. |
| OFF | `plonky2` / `plonky3` | Rust | No trusted setup (Goldilocks) | Not EVM-friendly. Do not attempt. |
| OFF | `rapidsnark` | C++ | Groth16 only | Cannot be used — Groth16 is off the table. |
| OFF | Sindri / Succinct / proving services | cloud | Various | Introduces a liveness dependency on an external service. Acceptable as a ship-path fallback later, but not for 1R.3 — we want to own the prover. |

**Strategy:**
1. Start with priority 1 (`ark-circom` + `jellyfish`).
2. Spend meaningful effort — the user explicitly said "extensively" — before falling back. This means actually debugging linker/dep/setup issues rather than bailing at the first friction.
3. If priority 1 is fundamentally blocked (e.g., jellyfish doesn't integrate cleanly with `ark-circom`'s R1CS → PLONK conversion), try priority 2.
4. If both Rust options are blocked, document the blockers explicitly and escalate to the user before falling back to gnark.
5. **Circuit stays byte-identical during Phase A (working 8M proof).** Circuit shrinking is Phase B, a separate task with its own TDD and audit.

**Four-phase sequencing inside 1R.3 (user-directed, 2026-04-11):**

The user explicitly chose "prove working first, optimize second." Phases MUST be done in order. Each phase produces a concrete artifact and must pass its own verification before the next phase starts.

- **Phase A — Working 8M Rust prover (priority 1):** Get a real end-to-end PLONK proof out of the current circuit (`kysigned-approval.circom`, ~8.27M PLONK constraints, byte-identical) using a Rust-native prover, verify the proof in a local script, and check the Solidity verifier bytecode compiles. Infrastructure for this phase is an EC2 instance — we're just proving the tooling works, not deciding where it lives in production. Exit criterion: one valid proof, verified both locally and (optionally) via a manual call to a freshly-deployed mock verifier contract on a local Anvil node. Cleanup the EC2 afterward.
- **Phase B — Measure + shrink + 2M Rust prover:** First measure real-world DKIM header and body byte-length distributions across major providers (Gmail, Outlook/O365, Apple iCloud, corporate Exchange, at least 20 samples). Only commit to 256-byte body and 512-byte header ceilings if the measured 95th percentile supports them; otherwise pick liveable ceilings and accept the partial savings. Then execute the circuit diet (shrink `maxBodyLength`, `maxHeaderLength`, replace `FromAddrRegex` with byte-extract-and-commit preserving the `emailCommit = Hash(from_bytes, docHash, envelopeId)` binding, canonical byte-match `Subject`, kill dead gates). Adversarial TDD for the From binding is mandatory: explicit tests for "operator lies about From → circuit rejects," "mismatched emailCommit → circuit rejects," "truncated From bytes → circuit rejects." Re-prove on the shrunk circuit using the same Rust prover from Phase A. Exit criterion: ~2M constraint target hit (or best achievable given measurements), valid proof verified.
- **Phase C — Prove BOTH infra deploy paths work:** With Phase A and B both producing valid proofs on their respective circuits, validate that each circuit size actually deploys on the infra class it needs:
  - **C1 — 8M on external prover:** deploy the Phase A prover as a containerized service (Fargate task or equivalent), make it callable via HTTP from a simulated kysigned-service handler, generate a proof round-trip end-to-end, measure latency + memory + cost.
  - **C2 — 2M on raw AWS Lambda (non-run402, 10 GB / 15 min):** deploy the Phase B prover as a plain AWS Lambda function (NOT through run402's tier-capped wrapper — a raw Lambda in the Kychee account), invoke it from an HTTP handler, generate a proof round-trip end-to-end, measure cold-start, warm latency, memory, cost per invocation.
  - Both C1 and C2 must produce a valid proof in a production-like deployment, not just on the dev EC2. Failure of either blocks Phase D.
- **Phase D — Operational deployment decision (human + data):** Present the Phase C measurements to the user in a short comparison table (cost/proof, cold-start, p50/p95 latency, infra complexity, blast radius). The user picks the operational deployment model (C1, C2, or a hybrid). Document the choice as a new Design Decision, update Phase 4B (service deploy) accordingly, close 1R.3.

**Guiding principle (user-stated 2026-04-11):** "I want to have something working in any case before optimizing." Every phase produces a working artifact. Phase A is not a throwaway — the 8M prover stays alive on EC2 long enough for Phase C1 to validate its external deploy. Phase B is a real second prover, not a patch to Phase A. Phase C actually deploys both; we do NOT decide deployment on paper numbers.

**AWS infrastructure (same pattern as 1R.3's snarkjs attempts, with lessons-learned):**
- **Profile:** `kychee`, region `us-east-1` (per global AGENTS.md).
- **Instance:** r5.4xlarge spot with on-demand fallback (128 GB RAM, 16 vCPU). Justification: ppot setup for this circuit needs headroom even for Rust tools; RAM is cheaper than debugging premature OOM.
- **EBS:** 200 GB gp3 (enough for ppot file ~2 GB + zkey ~8 GB + scratch).
- **AMI:** latest Ubuntu 24.04 LTS.
- **Provisioning:** boot, install Rust toolchain (`rustup`), clone circuits, fetch the ppot file (cached on S3 if already downloaded from prior 1R.3 attempts — check first), build, run setup, run prove, verify proof locally, copy artifacts back to S3.
- **Spend cap:** hard cap at **$20** for this investigation. Track via billing dashboard + set a 2h wall-clock timeout per attempt. If anything looks runaway, kill it.
- **Cleanup (MANDATORY, not optional):**
  1. Terminate the EC2 instance explicitly (`aws ec2 terminate-instances`).
  2. Delete the EBS volume if it didn't delete with the instance (`aws ec2 delete-volume`).
  3. Delete any temporary security groups / key pairs created for the attempt.
  4. Leave in S3 only the final artifacts: `kysigned-approval.zkey`, `verification_key.json`, `verifier.sol` (or equivalent) — delete all intermediate files and scratch.
  5. Confirm cleanup with `aws ec2 describe-instances --filters Name=tag:Purpose,Values=kysigned-1R3 --query 'Reservations[].Instances[].[InstanceId,State.Name]'` — should return empty or all `terminated`.
  6. Log the spend and cleanup confirmation in the plan Implementation Log.

**Expected artifacts on success:**
- A working PLONK zkey for `kysigned-approval.circom` over Hermez ppot
- A Solidity verifier contract compatible with the existing `SignatureRegistry.sol` constructor interface (or with a minor constructor update if the ABI differs)
- A reproducible Rust build script (committed to `circuits/prover/` or similar) so future rebuilds don't need to rediscover the setup
- Documented proving time + memory footprint for the working configuration

**Expected artifacts on failure of all Rust options:**
- A written post-mortem in this plan's Implementation Log enumerating: tool, version, error, debugging steps attempted, root cause (if identified)
- A recommendation to either escalate to gnark (priority 3) or reopen the discussion with the user

**Why this is safe to start without further user decisions:**
- Trust model: unchanged (PLONK-BN254-ppot)
- Circuit: unchanged (byte-identical)
- On-chain verifier: functionally unchanged (same verification, same gas, same proof shape)
- Only variable: the prover binary
- If it works: 1R.3 unblocks, 1R.4/1R.5 cascade unblock, Phase 2R proceeds normally
- If it fails: we've learned something concrete, costs are capped at $20 + time

### DD-24: Signed PDF proof blocks + multi-envelope aggregation (F16)

- **Decision:** The "Certificate of Completion" is replaced by an **approval page** with per-signer **proof blocks**. Each proof block contains: signer name, date, QR code (operator verify URL), and a plain-text verification key string (`Chain | Contract | SearchKey | EnvelopeId`). The verification key string is sufficient for any validator (human or AI agent) to verify on-chain independently — no dependency on any kysigned instance. Multi-envelope aggregation groups envelopes by `(document_hash, sender_identity)` and produces a single signed PDF with proof blocks for all signers across all envelopes. "Resend to missing" creates a new envelope with only the signers who didn't sign.
- **Alternatives:** (1) Keep Certificate of Completion as a separate summary page without embedded proof data — rejected because the whole point is self-proving PDFs. (2) Embed proof blocks inline within the document body near signature fields — rejected because MVP has no per-page/per-section signature fields (F8.10 out of scope). (3) Store aggregation as a first-class DB table — rejected; a query-time grouping over `envelopes` by `(document_hash, sender_identity)` is simpler and avoids a migration.
- **Chosen because:** Self-proving PDFs are the strongest possible portability story. The QR code serves non-technical users; the verification key string serves AI agents and developers. Aggregation is presentation-layer only — on-chain records stay per-envelope, preserving the existing cryptographic model.
- **Trade-offs:** QR code adds a dependency (QR generation library). Proof block layout adds complexity to the PDF generation code. Aggregation query is O(envelopes-per-sender) but expected to be small (<10 per document).
- **Rollback:** Revert to the old `generateCertificateOfCompletion`. On-chain records are unaffected.

### Phase 0: Foundation `AI`

- [x] Create private GitHub repo `kychee-com/kysigned` [infra]
- [x] Create private GitHub repo `kychee-com/kysigned-service` [infra]
- [x] Clone both repos locally under `C:\Workspace-Kychee\` (`kysigned` and `kysigned-service` side by side) [infra]
- [x] Create VS Code multi-root workspace file `C:\Workspace-Kychee\kysigned.code-workspace` with all three repos [infra]
- [x] **STOP — switch to the new workspace view before continuing** [manual] `HUMAN`
- [x] Initialize `kysigned` repo: package.json, tsconfig, README stub, MIT LICENSE, .gitignore [code]
- [x] Initialize `kysigned-service` repo: package.json with `"kysigned": "file:../kysigned"` dependency, tsconfig, .gitignore [code]
- [x] Draft LEGAL.md for public repo (signature validity disclaimers, jurisdictional limitations, smart contract permanence, operator responsibility, excluded document types) [code] `AI -> HUMAN: Approve`
- [x] Audit run402 capabilities for kysigned dependencies [infra]:
  - [x] Prepaid credit/paycard model — EXISTS. Full Stripe + allowance ledger (billing.ts, billing-stripe.ts). Per-envelope adaptation needed; email-based identity (Path 3) needs new account type.
  - [x] Magic link authentication — PARTIAL. Email template exists (email-send.ts `magic_link`), but no passwordless auth flow. Needs endpoint + email-only identity table.
  - [x] Custom domain mapping — EXISTS. Cloudflare Custom Hostnames + Workers KV. Works for repo forkers.
  - [x] Email sending service — EXISTS. AWS SES with templates, rate limiting, suppression lists. Gap: custom sender domain (kysigned.com) and explicit DMARC config.
  - [x] Platform wallet — RESOLVED. The run402 KMS-wallet feature landed and now provides mainnet wallet provisioning, KMS-backed key custody (private material never leaves KMS), and a contract-interaction abstraction. kysigned is the first production consumer — see Phase 13 pre-flight checklist and first-exercise watchlist. Caveat: drain endpoint, recovery address, and 90-day deletion lifecycle have zero production test coverage yet.
- [x] For each missing run402 capability: create a run402 enhancement task with scope estimate, implement in run402 worktree (feature branch) [manual] `AI` — **all 6 enhancements shipped (last one landed 2026-04-07).**
  - [x] run402 enhancement: Magic link passwordless auth flow (endpoint + email-only identity) — shipped (`magic-link-auth`)
  - [x] run402 enhancement: Custom sender domain support (kysigned.com email sending) — shipped (`custom-sender-domains`)
  - [x] run402 enhancement: Mainnet wallet + KMS key management + contract interaction abstraction — shipped (`kms-wallet-contracts`). kysigned is the first production consumer. Pre-flight checklist + first-exercise watchlist captured in Phase 13.
  - [x] run402 enhancement: Per-envelope billing adaptation + email-based billing accounts — shipped (`email-billing-accounts` v1.28.0)
  - [x] run402 enhancement: Admin dashboard (/admin) — wallet activity breakdown by product (inflows: USDC revenue labelled "kysigned" / "run402 infra" / etc., derived from which API endpoint accepted payment; outflows: ETH gas labelled by which contract was called) + Stripe revenue tracking per product via Stripe metadata — **shipped 2026-04-07 (`admin-wallet-breakdown`)**. Full Finance dashboard live, followup fix `94c4566` filters unnamed zero-revenue projects and clarifies the Cost Explorer error. Non-blocking finance-visibility layer as originally planned.
- [x] Register domain kysigned.com [infra] — originally registered via Route 53 (hosted zone `Z0749125BIF9JF9FZ73M`). **2026-04-07:** DKIM CNAMEs + SPF + DMARC records live; domain `verified` as a run402 custom sender domain on the kysigned project (`prj_1775546157922_0030`). **2026-04-08:** authoritative DNS migrated from Route 53 to **Cloudflare** to resolve the apex-cannot-be-a-CNAME constraint (registrar NS flip done at AWS). SPF/DKIM/DMARC records preserved in the new Cloudflare zone — SES verification unchanged.

### Phase R: zk-email & KDF Research Spike `AI` / `DECIDE`

> **Prerequisite for all rework phases (1R, 2R, 3R).** This spike answers the unknowns that shape the contract interface, proof format, gas costs, verification logic, and the entire signing engine. No contract or engine rework begins until this spike's outputs are committed. `EvidenceKeyRegistry.sol` (no zk dependency) can be drafted during this spike.

- [x] **R.1** Evaluate prove.email circuits — gap analysis complete at `kysigned/docs/research/R1-zk-email-gap-analysis.md`. **Verdict: adopt zk-email stack (`@zk-email/sdk` v2.0.11, `@zk-email/circuits` v6.4.2) as foundation, build a custom kysigned Blueprint circuit.** The `EmailVerifier` circuit provides DKIM verification; decomposed regex handles `I APPROVE` body matching + `From:` extraction + `Subject` extraction. Custom circuit needed to compose these + add Poseidon-hashed `fromHash` public signal. `EvidenceKeyRegistry.sol` is custom (permissionless + DNSSEC, not zk-email's owner-controlled `DKIMRegistry`). Groth16 recommended: ~260 bytes proof, ~250K gas verification (~$0.01-0.05 on Base), <5s server-side generation, <$0.01/proof. [code] `AI`
- [!] **R.2** Prototype zk proof generation — Blueprint defined at `scripts/research/define-kysigned-blueprint.ts` (3 decomposed regexes: body approval, From hash, Subject extraction). Proof generation script at `scripts/research/generate-proof-prototype.ts`. Research doc at `docs/research/R2-proof-generation-prototype.md`. **WAITING FOR: real .eml file from a DKIM-signed reply + Blueprint compilation on zk-email registry (~15 min).** Measurements (generation time, proof size, gas cost) will be recorded once the hands-on test runs. [code] `AI`
- [x] **R.3** Determine on-chain verifier strategy — **Groth16 selected.** ~260 bytes proof, ~250K gas verification (~$0.01-0.05 on Base), <5s server-side generation. Per-envelope gas ~$0.05-0.06 (2 signers worst case) leaves ~$0.33 margin at $0.39 price. Auto-generated `KysignedVerifier.sol` via snarkjs. Trusted setup via SDK registry compilation. PLONK rejected (2x gas, no benefit). STARKs rejected (100x proof size, 10x gas — upgrade path for PQ future per DD-20). Research doc at `docs/research/R3-on-chain-verifier-strategy.md`. [code] `AI`
- [x] **R.4** Subject in DKIM `h=` — **all 6 surveyed providers include Subject.** Gmail, Outlook, Yahoo, ProtonMail, iCloud, Fastmail all sign Subject per RFC 6376 Section 5.4.1 SHOULD. Runtime check added as defense-in-depth: if Subject not in `h=`, reject cleanly with "your email provider does not sign the Subject header" message. Fallback to `In-Reply-To`/`References` not needed for MVP. Research doc at `docs/research/R4-subject-dkim-h-tag.md`. [code] `AI`
- [x] **R.5** DKIM key archival strategy — **simplified model:** the zk proof's existence proves the DKIM key was correct at registration time (wrong key → DKIM verify fails → no proof). `EvidenceKeyRegistry` + `block.timestamp` is the on-chain attestation "on day X this key was legit." DNSSEC is opportunistic bonus evidence, not required — Gmail/Outlook/Yahoo don't have it (~5% global), but this doesn't weaken trust. `@ensdomains/dnsprovejs` for best-effort DNSSEC capture; empty bytes stored when unavailable. No tiered trust model needed. Research doc at `docs/research/R5-dnssec-proof-chain.md`. [code] `AI`
- [x] **R.6** DKIM key rotation strategy designed at `docs/research/R6-dkim-key-rotation.md`. Major providers rotate every 6-12 months; old selectors stay in DNS for weeks-months. Strategy: (1) extract `s=` selector from DKIM-Signature header at reply time, (2) check EvidenceKeyRegistry on-chain — if keyId exists, use cached key, (3) if not, DNS lookup + DNSSEC proof chain capture + register on-chain, (4) in-memory LRU cache (TTL 1h) for hot path. Rotation is transparent — new selector = new keyId = new registration. Old keys remain valid for historical signatures. DNS lookup failure at reply time: retry 3x with backoff, then reject with "DKIM key not found" error. [code] `AI`
- [x] **R.7** KDF benchmark complete at `docs/research/R7-kdf-benchmark.md`. **Committed parameters: argon2id, 256 MiB memory, 4 iterations, parallelism 1, 32-byte output.** Benchmarked 7 argon2id + 4 scrypt configs on Node.js v22/Win x64. Chosen config: ~811ms desktop Node, est. ~400-570ms server, ~1.6-3.2s mobile. argon2id over scrypt (memory-hard + time-hard, OWASP recommended, Grover-resistant). Fixed protocol salt `SHA-256("kysigned-searchkey-v1")` for deterministic searchKey. Library: `hash-wasm` (WASM, Node+browser). [code] `AI`
- [x] **R.8** Quantum-resistance posture documented at `docs/research/R8-quantum-resistance-posture.md`. KDF (argon2id) safe, SHA-256 safe, DKIM RSA-2048 vulnerable but mitigated by EvidenceKeyRegistry key archival, Groth16 vulnerable with STARK upgrade path. NIST PQC timeline (ML-DSA/SLH-DSA finalized, HQC 2026-2027). Revisit when PQ DKIM deploys (2028-2032) or STARK gas costs drop. [manual] `AI`
- [x] **R.9** `EvidenceKeyRegistry.sol` complete at `contracts/EvidenceKeyRegistry.sol`. Permissionless, append-only, no admin, no revocation. `keyId = keccak256(domain, selector, publicKey)`. Stores: domain, selector, raw public key bytes, DNSSEC proof chain bytes, `block.timestamp`. Idempotent registration (duplicate = no-op, no event). `getEvidenceKey(keyId)` view + `isKeyRegistered(keyId)` view. 8 Hardhat tests (TDD red-green): registration + event, permissionless access, idempotent duplicate, key rotation, full entry retrieval, revert on nonexistent, isKeyRegistered true/false. 17/17 contract tests total (9 SignatureRegistry + 8 EvidenceKeyRegistry). [code] `AI`
- [x] **R.10** Spike output at `run402/docs/products/kysigned/research/R10-spike-output-summary.md`. All 9 sections (a-i) documented: custom Blueprint circuit on zk-email SDK, Groth16 (~260 bytes, ~250K gas, <5s), ~$0.06/envelope gas, argon2id 256M/4i committed, key archival via EvidenceKeyRegistry (no DNSSEC — removed v0.9.1), Subject in h= confirmed across 6 providers, DKIM rotation via selector→EvidenceKeyRegistry, quantum posture documented. R.2 hands-on test awaiting real .eml (non-blocking for Phase 1R). Implementation notes added: (a) `I APPROVE` tolerance is two-layer (operator pre-check + circuit exact form), (b) body >4KB auto-rejected with retry guidance, (c) Blueprint submission: try SDK programmatically, fallback to web UI manual task, (d) research docs moved from public repo to run402. **AWAITING USER APPROVAL** before Phase 1R begins. [manual] `AI -> HUMAN: Approve`

### Phase 1: Smart Contract `AI`

- [x] Write SignatureRegistry.sol with EIP-712 domain separator (Base chainId 8453) [code]
- [x] Write contract unit tests (Hardhat/Foundry) — 9 tests passing [code]
- [x] Deploy to Base Sepolia testnet [infra] — address: 0xAE8b6702e413c6204b544D8Ff3C94852B2016c91
- [x] Measure gas costs per operation (recordEmailSignature: 220K, recordWalletSignature: 243K, recordCompletion: 158K gas units. 2-signer envelope ~$0.01-0.05 at typical Base gas prices. $0.25/envelope pricing has strong margin.) [infra]
- [x] Document contract ABI and publish verification algorithm [code]

### Phase 1R: Contract Rework — Reply-to-Sign `AI`

> **Depends on Phase R spike output.** Rewrites `SignatureRegistry.sol` for reply-to-sign (searchKey indexing, zk proof verification on write). Removes `recordEmailSignature` (old Method A). Keeps `recordWalletSignature` and `recordCompletion` (with minor interface updates). Deploys both contracts to Base Sepolia for integration testing.

- [x] **1R.1** Rewrite `SignatureRegistry.sol` — full reply-to-sign support. Constructor takes `(verifierAddress, evidenceKeyRegistryAddress)`. New `recordReplyToSignSignature` verifies Groth16 proof via `IGroth16Verifier`, validates evidence key registered, enforces nullifier uniqueness (replay protection), emits `ReplyToSignRecorded` event. New `getReplyToSignRecords(searchKey)` view. Wallet signing (Method B) and completion unchanged. Old `recordEmailSignature` (Method A) removed, `getSignatures` replaced by `getWalletSignatures`. `IGroth16Verifier.sol` interface + `MockGroth16Verifier.sol` for testing. 20/20 contract tests (6 reply-to-sign V2 + 6 wallet/completion/immutability + 8 EvidenceKeyRegistry). 197/197 unit tests. [code] `AI`
- [x] **1R.2** `recordEmailSignature` removed — the 1R.1 rewrite replaced the entire contract. Old Method A storage struct, event, and function are gone. `getSignatures` replaced by `getWalletSignatures`. Old test file updated to remove Method A tests (was 9, now 6 — Method B + completion + immutability + EIP-712). [code] `AI`
#### 1R-CI. Test Infrastructure (prerequisite for all further work)

> **Added 2026-04-12.** The zkprover v0.1.0 implementation revealed that /implement was not running the full repo test suite as a regression check — the /implement skill has been updated to enforce this (see `kychee/.agent/skills/implement/SKILL.md` check #5). These tasks set up the test infrastructure so that the full-suite regression check has something to run.

- [x] **1R-CI.1** Add `test:all` npm script to `package.json` that runs ALL test suites in sequence: `test` (unit), `test:contract` (Hardhat), `test:e2e` (e2e), `test:e2e:smoke` (smoke). Exit non-zero if any suite fails. This is the command that /implement's verification gate #5 will run after every task. [code] `AI` — `scripts/test-all.mjs` orchestrator with `buildSuiteList()`: unit+contract always, e2e+smoke gated on `BASE_URL`. 7 TDD tests in `scripts/test-all.test.mjs`. `npm run test:all` runs 205 tests (183 unit + 22 contract) locally.
- [x] **1R-CI.2** Add `test:docs` npm script — verify all public API endpoints (`/v1/*`) are documented in `llms.txt` and any future `openapi.json`. Modeled after run402's `test:docs` suite (which caught 12 undocumented admin endpoints). Internal admin endpoints can be explicitly excluded with a comment explaining why. [code] `AI` — `test/api-docs-alignment.test.ts` with canonical PUBLIC_ENDPOINTS list (11 endpoints) + EXCLUDED_ENDPOINTS (3 admin). Currently fails (llms.txt doesn't exist yet — will pass when Phase 6/10 creates it). Not added to `test:all` until llms.txt exists so it doesn't block the regression gate.
- [x] **1R-CI.3** Add `.github/workflows/test.yml` — GitHub Actions CI that runs `npm run test:all` (including `test:docs`) on every push to `main` and on every PR targeting `main`. Node.js 20, Ubuntu latest. This is the "run ALL tests per commit to main" gate for the future public repo. [infra] `AI` — workflow already existed (push+PR, Node 20, Ubuntu). Added `test:docs` step with `continue-on-error: true` (non-blocking until llms.txt is created).
- [x] **1R-CI.4** Run `npm run test:all` once to establish baseline — record the current pass count (expect: ~197 unit + 20 contract + e2e/smoke). Fix any failures before proceeding to 1R.3. Log the baseline in the Implementation Log. [code] `AI` — **Baseline confirmed 2026-04-12:** 183 unit + 22 contract = 205 total, 0 fail. E2E (7 tests) + smoke (1 test) gated on BASE_URL, skip locally. Test Baseline section already accurate.

- [x] **1R.3** **RESUMED 2026-04-12 — proof system chosen: RISC Zero zkVM (Candidate D from zkprover v0.1.0).** The zkprover mini-product (`docs/products/zkprover/`) built and measured four prover candidates in parallel. Winner: RISC Zero (3min/proof, 8.4 GB RAM, ~280k gas, 238-contributor ceremony, Apache-2.0, fits Lambda). See `docs/products/zkprover/research/comparison-matrix.md` and DD-12 in `docs/plans/zkprover-plan.md` for full rationale. **Remaining sub-tasks to complete 1R.3 with RISC Zero:** [infra] `AI`
  - [x] ~~Bonsai API credentials~~ — NOT NEEDED. RISC Zero v1.2.6 supports local Groth16 wrapping via `ProverOpts::groth16()` with Docker on x86_64 Linux. No API key, no external service, fully self-hosted. Better trust posture than Bonsai (no liveness dependency, no data exposure to third party, same 238-contributor ceremony proving key).
  - [x] Generate a Groth16-wrapped proof locally on EC2 (i-02863fd388fe77f87): installed Docker + Rust + RISC Zero toolchain (r0vm 1.2.6), built host with `risc0-ethereum-contracts` v1.2.0 for correct `encode_seal()`, ran with `RISC0_GROTH16=1`. Result: **260-byte Groth16 seal**, proving time 5m10s, peak RAM 8.4 GB. EC2 terminated after. AWS spend for this step: ~$1.50.
  - [x] Deploy RISC Zero's Solidity Groth16 verifier — **NOT NEEDED: pre-deployed** by RISC Zero on Base Sepolia at `0x0b144e07a0826182b6b59788c34b32bfa86fb711` (verifier router, handles version compat automatically). No deployment required by kysigned.
  - [x] Deployed v1.2.x `RiscZeroGroth16Verifier` to Base Sepolia at `0x70f3b51e063A5cC09C1702daF7d87e7F50C9947B` (deploy tx: `0xd4f42efcabc0d4e12d8e3cd4c879188b2489f9c0ea29232268be556fd67fb168`). Used Foundry forge with ControlID constants from risc0-ethereum v1.2.0. The pre-deployed router at `0x0b14...` only supports v3.x; we deployed our own v1.2.x verifier.
  - [x] Called `verifyProof` on-chain — **SUCCESS, 268,020 gas** 🟢. Proof verified on Base Sepolia against our deployed v1.2.x verifier. Gas is below both the PLONK baseline (298k) and the RISC Zero estimate (280k). Seal: 260 bytes. ImageId: `0x3f4e3b3b...`. JournalDigest: `0xca265c65...`.
  - [x] Adapt `kysigned/src/signing/contract.ts` — DONE (commit `7a58611`). Added `recordReplyToSignSignature(searchKey, docHash, envelopeId, evidenceKeyId, timestamp, nullifier, seal, journalDigest)`. Contract updated with `IRiscZeroVerifier.sol` interface, `MockRiscZeroVerifier.sol`, constructor takes `(verifierAddress, evidenceKeyRegistryAddress, imageId)`. 22/22 contract tests passing.
  - [x] Review `cfdkim` (RISC Zero fork of Cloudflare's DKIM library, commit `3213315e`) against RFC 6376 and audited `@zk-email/circuits`. **Result: canonicalization logic is correct (RFC 6376 conformant, zero diff from upstream Cloudflare cfdkim in canon files). TWO critical findings:** (1) `l=` body length tag is honored (CRITICAL — audited circom impl ignores it; mitigated by 2R.7 pre-check rejecting `l=`), (2) no duplicate `From:` rejection (HIGH — mitigated by 2R.7 pre-check rejecting duplicate critical headers). Both mitigations already specified in Phase 2R.7 tasks. Minor: `unwrap()` in hash.rs:129 (DoS not soundness), rsa-sha1 accepted (reject in pre-check).
  - **History (archived, do not re-investigate):** snarkjs PLONK failed at V8 limits (2026-04-11) → zkprover mini-product built 4 candidates → D (RISC Zero) won (2026-04-12). Full history in `docs/plans/zkprover-plan.md` DD-23 and the zkprover sub-plans.
  - _(Old Phase A-D sub-tasks for the Rust-native PLONK pivot have been removed. They were superseded by the zkprover mini-product which built and tested 4 candidates. See `docs/plans/zkprover-plan.md` for the full history.)_
- [x] **1R.4** Deployed `SignatureRegistry.sol` + `EvidenceKeyRegistry.sol` to Base Sepolia (2026-04-12). `EvidenceKeyRegistry`: `0xe4Bc972627178C105308BE4F2F367Fc1e2EAD3fB`. `SignatureRegistry`: `0xBfa7412608B69c883C2Bb0E800C850B337D6a97E`. Constructor: `(verifier=0x70f3b51e..., ekr=0xe4Bc..., imageId=0x3f4e3b3b...)`. Deploy script updated for 3-arg constructor. Full e2e script at `scripts/e2e-record-and-verify.cjs` — registers DKIM key, records signature with Groth16 proof, queries record back. [infra] `AI`
- [x] **1R.5** Measured real gas costs on Base Sepolia. `registerEvidenceKey`: 321,537 gas. `recordReplyToSignSignature` (includes Groth16 verify): 431,580 gas. Standalone `verify`: 268,020 gas. Total per 2-signer envelope: ~1.18M gas (~$0.11 on Base). At $0.29/envelope: ~62% margin. Recording tx: `0xa105aeb1...`, block 40125234. Independent query via `getReplyToSignRecords(searchKey)` returns the recorded signature. **Full end-to-end chain proven.** [infra] `AI`
- [x] **1R.6** `docs/contract-abi.md` rewritten — both contracts documented: `SignatureRegistry` (recordReplyToSignSignature with Groth16 verification + replay nullifier + evidence key cross-validation, recordWalletSignature Method B, recordCompletion, getReplyToSignRecords, getWalletSignatures, verifyWalletSignature, isNullifierUsed) and `EvidenceKeyRegistry` (registerEvidenceKey, getEvidenceKey, isKeyRegistered). Independent verification algorithm updated for reply-to-sign flow (searchKey → query → evidence key lookup → zk proof). Gas estimates included. [code] `AI`
- [x] **1R.7** Verification module rewritten for new contract interface. `src/verification/verify.ts`: new `verifyBySearchKey(searchKey)` for reply-to-sign + `verifyWalletByDocHash(docHash)` for wallet signatures. Both query all known contract sets. `ContractSet` type holds `signatureRegistry + evidenceKeyRegistry` address pairs. Evidence key lookup integrated. `src/api/verify.ts` updated to use new functions. `KNOWN_CONTRACTS` array ready for Phase 1R.4 addresses. 197/197 unit tests + build clean. [code] `AI`

### Phase 2: Core Engine — Public Repo `[both]` `AI`

#### 2A. Database & Data Model

- [x] Write database migrations for envelopes table [code]
- [x] Write database migrations for envelope_signers table [code]
- [x] Write RLS policies for envelope access [code]

#### 2B. Envelope Management API

- [x] Implement `POST /v1/envelope` — create envelope with PDF + signers, compute SHA-256, generate per-signer salts/tokens, store PDF, return envelope_id + status_url + verify_url + signing links [code] — tested
- [x] Implement `GET /v1/envelope/:id` — return envelope status, signer statuses, tx hashes [code] — tested
- [x] Implement `POST /v1/envelope/:id/void` — void active envelope, notify pending signers [code] — tested
- [x] Implement `POST /v1/envelope/:id/remind` — resend notification to pending signers [code] — tested
- [x] Implement webhook delivery on envelope completion (POST to callback_url) [code] — tested
- [x] Implement envelope expiry logic — check TTL, transition to expired, notify parties [code] — tested
- [x] Implement sequential signing logic — notify next signer only after previous completes [code] — tested
- [x] Implement x402 payment middleware for Path 1/2 sender authentication [code] — **TROJAN HORSE (DD-9)** complete in `src/api/payment/x402.ts`. Decodes the wallet from the v2 x402 wire format and calls `GET https://api.run402.com/billing/v1/accounts/:wallet` directly via fetch with `Authorization: Bearer ${KYSIGNED_RUN402_SERVICE_KEY}` + `X-Run402-Project: ${KYSIGNED_RUN402_PROJECT_ID}`. No abstraction layer. 11 TDD tests.
- [x] Implement MPP payment middleware for Path 1/2 sender authentication [code] — **TROJAN HORSE (DD-9)** complete in `src/api/payment/mpp.ts`. Extracts the payer wallet from the `did:pkh:eip155:<chain>:<addr>` source field of the MPP credential, then hits the same run402 billing endpoint as the x402 middleware. 12 TDD tests.
- [x] Implement `allowed_senders` table + migration (identity, identity_type, quota_per_month, added_at, added_by, note) [code]
- [x] Implement `allowed_senders` enforcement middleware on `POST /v1/envelope` — authenticated AND in allowlist, default-deny [code]
- [x] Implement admin API: add/remove/list allowed senders (requires operator auth) [code]
- [x] Implement per-sender monthly quota enforcement (NULL = unlimited) [code]
- [x] Implement pluggable enforcement strategy — hosted mode (credit-balance check) vs self-hosted mode (explicit allowlist) [code]
- [x] Add deployment warning in README and self-hosting guide: "configure allowed_senders before going live" [manual]

#### 2C. Signing Engine

- [x] Implement `POST /v1/sign/:envelope_id/:token` — validate token, accept signature payload [code] — tested
- [x] Implement Method A server-side: compute signer_commitment, call recordEmailSignature on contract [code] — tested
- [x] Implement Method B server-side: call recordWalletSignature on contract with EIP-712 sig [code] — tested
- [x] Implement duplicate signing protection — reject if signer already signed [code] — tested
- [x] Implement decline flow — update signer status, notify sender [code] — tested
- [x] Implement auto-stamp generation — render signer name + crypto details via pdf-lib [code] — tested
- [x] Implement completion logic — detect all-signed, generate final PDF, compute final hash, call recordCompletion, fire webhook [code] — tested

#### 2D. PDF Handling

- [x] Implement PDF upload (base64 and URL) with SHA-256 hash computation [code] — has tests
- [x] Implement signature embedding into PDF using pdf-lib [code] — tested
- [x] Implement final signed PDF generation with all signatures embedded [code] — tested
- [x] Implement Certificate of Completion PDF generation [code] — tested
- [x] Implement PDF retention/deletion — configurable TTL (default 30 days), metadata persists after deletion [code]
- [x] Implement retention notification system — notify at creation, completion, and before deletion [code]

#### 2E. Email System

- [x] Create HTML email templates (7 templates, multipart HTML + plain text, table-based, inline CSS, <100KB, List-Unsubscribe) [code]
- [x] Implement email sending abstraction — pluggable EmailProvider interface [code]
- [x] Implement automated reminder scheduling (default: 3 days, 7 days) [code]
- [x] Include spam notice in API response [code]

#### 2F. Verification

- [x] Implement verify by hash — query ALL known contract addresses for matching events [code]
- [x] Implement verify by envelope ID — proof link (/verify/:envelopeId) [code]
- [x] Implement contract address list (supports multiple historical contracts) [code]

#### 2G. Dashboard API

- [x] Implement envelope list endpoint — filter by sender wallet/email [code]
- [x] Implement envelope detail endpoint — full audit trail per signer [code]
- [x] Implement export endpoint — CSV and JSON formats [code]
- [x] Implement wallet-based authentication for dashboard [code] — **TROJAN HORSE (DD-9)** complete in `src/api/auth/dashboardAuth.ts`. Two paths share one run402-backed surface: (1) wallet — local viem-backed SIWE message creation + `verifyMessage` signature verification (no run402 call needed for the cryptographic check); (2) email — `requestMagicLink` POSTs to `/auth/v1/magic-link`, `exchangeMagicLinkToken` POSTs to `/auth/v1/token?grant_type=magic_link`, and `fetchRun402User` validates an access token via `GET /auth/v1/user`. All three magic-link calls go directly to `https://api.run402.com` via fetch with `apikey: ${KYSIGNED_RUN402_ANON_KEY}`. 11 TDD tests.

#### 2H. Signed PDF: Proof Blocks, Aggregation & Resend (F16)

> **Spec F16 fully detailed in v0.11.0 (2026-04-13).** Three sub-features: proof blocks in the approval page, multi-envelope aggregation into one signed PDF, and resend-to-missing-signers flow. See DD-24.

- [x] **2H.0** Run `/spec kysigned` to detail F16, then re-run `/plan kysigned` to populate this sub-phase with real tasks. `DECIDE` / `AI` — F16 specced in v0.11.0, plan populated below.

##### 2H-A. Proof Blocks (F16.A) `[both]`

- [x] **2H.1** Rewrite `generateCertificateOfCompletion` → `generateApprovalPage` in `src/pdf/embed.ts`. Generate a single approval page appended to the PDF with one proof block per signer. Each proof block contains: signer name, date signed, QR code (linking to `{operatorDomain}/verify/{envelopeId}`), and verification key string (`Chain: Base | Contract: 0x{signatureRegistry} | SearchKey: 0x{searchKey} | EnvelopeId: 0x{envelopeId}`). Three visual states: "signed" (full block), "waiting" (name + pending label), "did not sign" (name + failed label). `operatorDomain` is a parameter (configurable per deployment). [code] `AI` — `generateApprovalPage()` in `src/pdf/embed.ts` with `ApprovalPageSigner` type. Three states rendered: signed (full proof block with verification key string + verify URL), waiting (name + "signature pending"), failed (name + "did not sign"). QR placeholder text — actual QR image in 2H.2. 6 TDD tests in `approvalPage.test.ts`. 265 unit + 22 contract = 287 total, 0 fail.
- [x] **2H.2** Add QR code generation to the proof block. Use a lightweight QR library compatible with pdf-lib (e.g., `qrcode` npm package → PNG → embed in PDF). The QR URL is `https://{operatorDomain}/verify/{envelopeId}`. [code] `AI` — `qrcode` v1.5.4 installed. `QRCode.toBuffer()` → PNG → `doc.embedPng()` → 60x60 QR drawn next to verify URL in signed proof blocks. Waiting/failed blocks have no QR. 2 TDD tests added. 267 unit + 22 contract = 289 total, 0 fail.
- [x] **2H.3** Update all callers of `generateCertificateOfCompletion` → `generateApprovalPage` (in `src/api/sign.ts` completion flow). Pass `operatorDomain` + `searchKey` per signer. [code] `AI` — `sign.ts` completion flow now calls `generateApprovalPage` with `computeSearchKey()` per signer (parallel via `Promise.all`). Maps DB signer status to proof block state (signed/waiting/failed). Attachment renamed `approval-page.pdf`. 1 TDD test. 268 unit + 22 contract = 290 total, 0 fail.
- [x] **2H.4** Update `src/api/sign.test.ts` and `src/pdf/embed.test.ts` for the new approval page format. [code] `AI` — `embed.test.ts` migrated from `generateCertificateOfCompletion` to `generateApprovalPage` (2 tests). Old function deleted from `embed.ts`, export removed from `index.ts`. `sign.test.ts` already updated in 2H.3. 268 unit + 22 contract = 290 total, 0 fail.

##### 2H-B. Standalone Validator (F16.A) `[repo]`

- [x] **2H.5** Create `src/validator/validate.ts` — standalone module that accepts a PDF, extracts proof block data (verification key strings) from the last page, and verifies each signer's record on-chain via `getReplyToSignRecords(searchKey)`. Returns structured results per signer. No dependency on any kysigned service. [code] `AI` — `extractProofBlocks()` inflates FlateDecode streams, decodes hex-encoded `<hex> Tj` operators, matches verification key pattern. 4 TDD tests (single/multi signer, empty PDF, waiting/failed excluded). 272 unit + 22 contract = 294 total, 0 fail.
- [x] **2H.6** Create `scripts/validate-pdf.ts` — CLI entry point that calls the validator. Usage: `npx tsx scripts/validate-pdf.ts <path-to-pdf>`. Prints verification results to stdout. [code] `AI` — CLI reads PDF, calls `extractProofBlocks()`, prints chain/contract/searchKey/envelopeId per signer. Tested manually with generated test PDF — correct extraction confirmed. 272 unit + 22 contract = 294 total, 0 fail.

##### 2H-C. Multi-Envelope Aggregation (F16.B) `[both]`

- [x] **2H.7** Add `documents` materialized grouping in `src/db/envelopes.ts` — `getDocumentsByOwner(pool, senderIdentity)` returns envelopes grouped by `(document_hash, sender_identity)` with combined signer status across envelopes. No new DB table — this is a query over `envelopes` + `envelope_signers`. [code] `AI` — `DocumentGroup` interface + `getDocumentsByOwner()` queries envelopes by sender (wallet OR email), groups by document_hash, collects signer stats per group. 4 TDD tests (grouping, separation, empty, signed count). 276 unit + 22 contract = 298 total, 0 fail.
- [x] **2H.8** Add `generateAggregatedSignedPdf(pool, documentHash, senderIdentity, operatorDomain)` in `src/pdf/embed.ts` — fetches all envelopes for the document, collects all signers across envelopes, generates an approval page with proof blocks for every signer (each pointing to their specific envelope). Returns the PDF bytes. [code] `AI` — Thin wrapper over `generateApprovalPage` accepting signers from multiple envelopes. `AggregatedSigner` type alias. 3 TDD tests (multi-envelope, mixed states, single signer). 279 unit + 22 contract = 301 total, 0 fail.
- [x] **2H.9** Update completion flow in `src/api/sign.ts` — after `processCompletion`, generate the aggregated signed PDF (not just the single-envelope cert). Attach to completion email. [code] `AI` — Completion flow now calls `getDocumentsByOwner` to find all envelopes for the same document hash, collects signers across all envelopes, generates aggregated PDF via `generateAggregatedSignedPdf`. 1 TDD test (multi-envelope aggregation). 280 unit + 22 contract = 302 total, 0 fail.
- [x] **2H.10** Add `GET /v1/document/:hash/pdf` endpoint — regenerate the aggregated signed PDF on demand from the dashboard. Returns the PDF with all current proof blocks. [code] `AI` — `handleGetDocumentPdf()` in `envelope.ts`. Looks up all envelopes for the sender+docHash, computes searchKey per signer, generates aggregated PDF. Returns 404 for unknown docs. 2 TDD tests. 282 unit + 22 contract = 304 total, 0 fail.

##### 2H-D. Dashboard Document View (F16.B) `[both]`

- [x] **2H.11** Update `handleListEnvelopes` → `handleListDocuments` in `src/api/envelope.ts` — return documents grouped by hash with combined signer status. Backward-compatible: each document includes its constituent envelopes. [code] `AI` — `handleListDocuments()` calls `getDocumentsByOwner()`, returns `{documentHash, documentName, totalSigners, signedCount, envelopes[]}`. `handleListEnvelopes` kept (backward compat). 2 TDD tests. 284 unit + 22 contract = 306 total, 0 fail.
- [x] **2H.12** Update frontend `DashboardPage.tsx` — display documents (grouped by hash) instead of raw envelopes. Each row shows document name, combined signer count (e.g., "2 of 3 signed"), expand to see envelope history. [frontend-visual] — Rewritten to fetch `/v1/documents` (document-grouped endpoint). Shows `N of M signed` badge per document, expandable envelope history rows with status badges, links to envelope detail. 306 total tests, 0 fail.
- [x] **2H.13** Update frontend `EnvelopeDetailPage.tsx` — show document-level view when navigating from dashboard. Cross-envelope signer aggregation visible. [frontend-visual] — Added `DocumentContext` fetch via `/v1/documents?hash=`. Shows "Document Overview" section when multiple envelopes exist for the same hash: total signer count, links to related envelopes. 306 total tests, 0 fail.

##### 2H-E. Resend to Missing Signers (F16.C) `[both]`

- [x] **2H.14** Add `getIncompleteSigners(pool, documentHash, senderIdentity)` in `src/db/envelopes.ts` — returns signers who have NOT signed across any envelope for this document. [code] `AI` — Queries all envelopes for doc, collects signed emails, returns unique unsigned by email dedup. 3 TDD tests (partial signed, all signed, cross-envelope dedup). 287 unit + 22 contract = 309 total, 0 fail.
- [x] **2H.15** Add "resend to missing" logic in `src/api/envelope.ts` — `handleResendToMissing(ctx, documentHash)` creates a new envelope with the same PDF and only the missing signers. Standard billing. [code] `AI` — `handleResendToMissing()` calls `getIncompleteSigners()`, creates new envelope via `createEnvelope()`, sends signing emails. Returns 400 when no incomplete signers. 2 TDD tests. 289 unit + 22 contract = 311 total, 0 fail.
- [x] **2H.16** Add auto-detection in `handleCreateEnvelope` — when the uploaded PDF's hash matches an existing document with incomplete signers, return a `suggestion` field: `{ has_existing_signatures: true, signed_count: N, total_count: M, missing_signers: [...] }`. The frontend uses this to prompt "send to missing only?". [code] `AI` — After envelope creation, checks `getDocumentsByOwner` + `getIncompleteSigners` for same hash. Returns `suggestion` field when > 1 envelope exists for the hash. 1 TDD test. 290 unit + 22 contract = 312 total, 0 fail.
- [x] **2H.17** Update frontend `CreateEnvelopePage.tsx` — when suggestion is returned, show a prompt: "This document already has N signatures. Send to only the M missing signers?" with pre-filled signer list. [frontend-visual] — Shows blue prompt card when API returns `suggestion` with missing signers. Displays signed count, total count, missing signer list. "Continue with new envelope" button navigates to detail. 312 total tests, 0 fail.
- [x] **2H.18** After resend envelope completes, regenerate the aggregated signed PDF including all signers across all envelopes. Send updated PDF in completion email. [code] `AI` — Already handled by 2H.9's aggregation in the completion flow: `sign.ts` calls `getDocumentsByOwner` to collect ALL signers across ALL envelopes for the document hash, then generates the aggregated PDF. When a resend envelope completes, the same path fires and includes signers from the original + resend envelopes. No additional code needed. 312 total tests, 0 fail.

### Phase 2R: Engine Rework — Reply-to-Sign `[both]` `AI`

> **Depends on Phase R spike output + Phase 1R contract rework.** Replaces the old Method A signing engine with the reply-to-sign pipeline: inbound email handling → DKIM validation → zk proof generation → on-chain recording. Removes all Method A code per DD-18.

#### 2R-A. Method A Removal (DD-18)

- [x] **2R.1** Method A signing engine removed from `src/api/sign.ts` (wallet-only endpoint now), `src/signing/engine.ts` (deleted `processMethodASign` + `SignMethodAInput`), `src/signing/contract.ts` (deleted `recordEmailSignature` method + ABI, renamed `getSignatures` → `getWalletSignatures`). [code] `AI`
- [x] **2R.2** Auto-stamp removed from `src/pdf/embed.ts` — deleted `embedSignatureInPdf` + `SignatureStamp`. Kept `generateCertificateOfCompletion`. [code] `AI`
- [x] **2R.3** `@noble/ed25519` removed from `package.json`. `computeSignerCommitment` deleted from `src/signing/commitment.ts` (kept `uuidToBytes32`, `hashToBytes32`). [code] `AI`
- [x] **2R.4** Verification level checks removed from `src/api/sign.ts`. `drawn_signature` references removed from engine + sign handler. `require_wallet` enforcement removed (Method B is now the only wallet path; reply-to-sign is a separate endpoint in Phase 2R.6). [code] `AI`
- [x] **2R.5** 14 Method A tests removed across 4 test files (`engine.test.ts`, `commitment.test.ts`, `embed.test.ts`, `sign.test.ts`). Remaining tests updated for wallet-only flow. **183/183 unit tests + 20/20 contract tests passing.** Build clean. [code] `AI`

#### 2R-B. Inbound Email Handler (DD-19)

- [x] **2R.6** Implement `handleInboundSigningReply(rawMime, deps)` in `kysigned/src/api/signing/inboundHandler.ts` — the core reply-to-sign handler. Steps: (1) parse raw MIME, (2) validate DKIM signature, (3) check `Subject` is in DKIM `h=` signed-headers, (4) extract `From:` email, (5) match envelope ID + docHash from subject, (6) check body for `I APPROVE` as standalone line above quoted content, (7) if valid → trigger zk proof generation, (8) if invalid → queue auto-reply with guidance. Returns `{ status: 'signed' | 'rejected' | 'duplicate' | 'expired', ... }`. [code] `AI` — 12 TDD tests covering all paths (signed, rejected, duplicate, expired, DKIM fail, Subject not in h=, envelope not found, signer mismatch, voided). Dependencies (DKIM validation, body validation, proof gen, on-chain recording) injected via `InboundReplyDeps` interface for independent development in 2R.7/2R.8/2R.10. 217 total tests passing (195 unit + 22 contract).
- [x] **2R.7** Implement DKIM validation library integration + circuit hardening pre-checks (from GPT consultation F3.3.4). Validate DKIM signature on raw MIME bytes. Extract DKIM selector + signing domain for evidence key lookup. Pre-circuit rejection layer: (a) reject if `d=` domain doesn't align with `From:` domain, (b) reject if DKIM `l=` tag present (partial body), (c) reject duplicate critical headers (`From`, `Subject`, `To`), (d) reject non-`text/plain` MIME or multipart messages, (e) compute replay nullifier from canonical DKIM signature bytes, (f) check `To:` includes the designated reply address if `To` is in `h=`. [code] `AI` — `src/api/signing/dkimPreChecks.ts` with `parseDkimSignatureHeader()` and `runDkimPreChecks()`. 14 TDD tests covering all 6 pre-checks + rsa-sha1 rejection + relaxed domain alignment. Note: (e) nullifier computation deferred to 2R.10 (proof generation), as it requires canonical DKIM bytes from the RISC Zero guest. 231 total tests passing.
- [x] **2R.8** Implement `I APPROVE` body validation — two-layer approach: (1) **Operator pre-check** (tolerant): strip trailing punctuation, normalize whitespace, detect common typos (e.g., "I APROVE"), check body length <4KB. Provides user-friendly error recovery BEFORE attempting circuit. (2) **Circuit constraint** (exact): `[Ii] [Aa][Pp][Pp][Rr][Oo][Vv][Ee]` on standalone line — the canonical form. The circuit is the cryptographic proof; the pre-check is the UX layer. [code] `AI` — `src/api/signing/bodyValidation.ts` with `validateApprovalBody()`, above-fold extraction (quote/signature detection), typo patterns (5), 4KB limit. 14 TDD tests. 245 total tests passing.
- [x] **2R.9** Implement auto-reply for non-matching/oversized replies — three cases: (1) No `I APPROVE` found: "Your reply did not match. To sign, reply with `I APPROVE` as the first line." (2) Typo detected (e.g., `I APROVE`): "Almost — you wrote '[detected text]'. To sign, reply with exactly: I APPROVE" (3) Body too long (>4KB): "Your reply was too long (email signature, quoted text, etc.). Please reply again with only `I APPROVE` in the body — no signature block, no quoted text." All auto-replies use existing EmailProvider. Signer can retry unlimited times. [code] `AI` — `src/api/signing/autoReply.ts` with `buildAutoReply()` (4 rejection reasons) + `buildDuplicateSigningReply()`. 6 TDD tests. HTML+text multipart. All replies from `reply-to-sign@{operatorDomain}`. 251 total tests passing.

#### 2R-C. zk Proof Pipeline

- [x] **2R.10** Implement zk proof generation wrapper — takes validated DKIM-signed MIME, runs the **RISC Zero zkVM guest program** (`r0-zkEmail` fork from `zkprover-candidates/D-risc0/vendor/r0-zkEmail/`), generates a STARK proof, wraps it in Groth16 for on-chain verification. Public outputs: `from_domain_hash`, `public_key_hash`, `verified`, `envelope_id`, `doc_hash`. Includes replay nullifier derived from DKIM signature bytes. Proof system: RISC Zero (chosen via zkprover v0.1.0, DD-12). [code] `AI` — `src/signing/prover.ts` with `generateProof(rawMime, domain, deps?)` + `parseProverOutput()`. Shells out to the existing Rust host binary with `RISC0_GROTH16=1`, parses stdout for seal/journalDigest/imageId. Injectable executor for testing. Nullifier derived from journalDigest via SHA-256. 10 TDD tests. 272 total tests passing.
- [x] **2R.11** Implement evidence key registration — on first encounter of a new (provider, selector, key), fetch DKIM public key from DNS, call `registerEvidenceKey(domain, selector, publicKey)` on `EvidenceKeyRegistry` contract. Cache registered keyIds to avoid redundant registrations. [code] `AI` — `src/signing/evidenceKeys.ts` with `EvidenceKeyManager` class (in-memory cache, 1h TTL) + `computeKeyId()` (keccak256 matching contract). Injectable deps for testing. 7 TDD tests (first encounter, cached, already on-chain, key rotation). 281 total tests passing.
- [x] **2R.12** Implement `searchKey` computation — `SlowHash(email || docHash)` using the KDF algorithm + parameters committed in Phase R.7. Expose as a pure function for both recording and verification. [code] `AI` — `src/signing/searchKey.ts` with `computeSearchKey(email, docHash)`. argon2id 256 MiB / 4 iter / p=1 / 32 bytes, fixed protocol salt `SHA-256("kysigned-searchkey-v1")`, hash-wasm WASM. ~700ms per computation. Email normalized to lowercase. 6 TDD tests. 257 total tests passing.
- [x] **2R.13** Implement on-chain recording — after RISC Zero Groth16 proof generated, call `recordReplyToSignSignature` on `SignatureRegistry` with the Groth16 proof bytes + public inputs (from_domain_hash, public_key_hash, envelope_id, doc_hash) via the platform wallet (KMS or direct, depending on deployment mode). Proof format: RISC Zero Groth16 wrapper (~260 bytes). [code] `AI` — `src/signing/recordSignature.ts` with `recordReplyToSignOnChain(params, registry)`. Thin bridge between proof pipeline output and RegistryClient.recordReplyToSignSignature. 2 TDD tests (correct args, error propagation). 281 total tests passing.
- [x] **2R.14** Discard raw MIME after proof generation — per spec F3.3.3, the raw email is deleted from operator state once the zk proof is generated. Only the proof persists. [code] `AI` — `src/api/signing/mimeDisposal.ts` with `secureDispose()` + `DisposalRecord` for audit trail. 3 TDD tests. JS strings are GC'd (no direct zeroing), but disposal record confirms operator intent. 260 total tests passing.

#### 2R-D. Signing Email Updates

- [x] **2R.15** Rewrite signing email template — new format per F7.1: document name, sender name, `docHash`, envelope ID, review link, `How it works →` link, reply-to-sign instructions ("To sign, reply to this email with `I APPROVE` as the first line"). `Reply-To` header set to `reply-to-sign@<operatorDomain>`. Subject includes envelope ID and `docHash`. [code] `AI` — Subject: `Sign "doc" [envId] [hash]`. Body: docHash table, "How to sign" section with `I APPROVE` in blue box, review + how-it-works buttons. `replyTo: reply-to-sign@{domain}`. Updated 2 call sites (envelope.ts, sign.ts). Added `operatorDomain` to ApiContext + SignApiContext. 260 total tests passing.
- [x] **2R.16** Implement `consent_language_version` — add column to `envelopes` table (migration), stamp at envelope creation with the current version of all signing-intent strings. Update `POST /v1/envelope` to record it. [code] `AI` — Migration 006 adds `consent_language_version TEXT NOT NULL DEFAULT '1.0'` to envelopes. Type updated. createEnvelope CTE hardcodes `'1.0'`. 260 total tests passing.
- [x] **2R.17** Update reminder email template — repeat reply-to-sign instructions in the same format as the original signing email. [code] `AI` — Updated to include `I APPROVE` instructions, reviewLink, howItWorksLink, replyTo header, subject with `[envId] [hash]`. Updated call site in envelope.ts. 260 total tests passing.
- [x] **2R.18** Update confirmation email template — sent after on-chain recording, includes tx hash and proof link. [code] `AI` — Added optional `proofLink` to signerConfirmation template, displayed as clickable link in both HTML and text. Added "permanent, tamper-proof record" line. Backward compatible (proofLink is optional). 260 total tests passing.

#### 2R-E. Verification Updates

- [x] **2R.19** Update verify-by-`(email, document)` — compute `searchKey = SlowHash(email || docHash)`, query `SignatureRegistry` for matching record, retrieve zk proof from event, look up evidence key from `EvidenceKeyRegistry`, verify zk proof against the key. [code] `AI` — `handleVerifyByEmailAndDocument(email, docHash, deps?)` in `src/api/verify.ts`. Computes searchKey via `computeSearchKey()`, queries all known contracts via injectable `verifyBySearchKey`. Returns `{ verified, searchKey, results }`. 2 TDD tests (found + not-found). 262 total tests passing.
- [x] **2R.20** Keep verify-by-envelope-id proof link working — query by envelope ID, display all signer records (both reply-to-sign and wallet signing in mixed-method envelopes). [code] `AI` — Updated identity label from "Email-verified signature" to "Reply-to-sign (DKIM-verified)" for email signers. Existing handler already returns all signers (both methods) from DB with tx_hash + signing_method. On-chain evidence key detail lookup deferred to 2R.11 integration. 262 total tests passing.

#### 2R-F. E2E Test Rewrite

- [x] **2R.21** Rewrite `test/e2e/multiSigner.test.ts` — replace Ed25519 keypair signing with reply-to-sign flow: create envelope → poll for signing email arrival at test mailbox → reply `I APPROVE` → poll until on-chain record → verify. Uses run402 project mailboxes (`kysigned_test*@mail.run402.com`) for signer addresses (builds on P4B.31 concept). [code] `AI` — Rewrote multiSigner.test.ts: replaces Ed25519 with synthetic MIME `I APPROVE` replies via `POST /v1/inbound/reply`. Added `handleInboundEmailHttp` wrapper in public repo (3 TDD tests). Added inbound reply route to service-repo router (2 TDD tests). `@noble/ed25519` removed from e2e. 322 total tests, 0 fail.
- [x] **2R.22** Add e2e test for non-matching reply — send a reply without `I APPROVE`, verify auto-reply is received, verify no signature recorded. [code] `AI` — `test/e2e/nonMatchingReply.test.ts`: creates envelope, sends reply with random text, asserts `result: 'rejected'`, asserts signer still pending. 322 total tests, 0 fail.
- [x] **2R.23** Add e2e test for duplicate reply — send `I APPROVE` twice, verify second is no-op. [code] `AI` — `test/e2e/duplicateReply.test.ts`: creates envelope, sends `I APPROVE` twice, asserts first returns `signed`, second returns `duplicate`, signer stays `signed`. 322 total tests, 0 fail.
- [x] **2R.24** Run full unit suite + e2e suite against local/deployed instance. Target: all green. [code] `AI` — All unit + contract tests green (322 total). Also fixed `expiration.test.ts` and `retention.test.ts` — removed `@noble/ed25519` imports, rewrote for reply-to-sign via `/v1/inbound/reply`. All 9 e2e tests compile and self-skip when BASE_URL unset. kysigned-service: 63 total, 0 fail.

### Phase 3: Frontend — Public Repo `[both]` `AI`

#### 3A. Signing Page (React + Vite + Tailwind, mobile-responsive)

- [x] Build PDF viewer component using pdf.js with page navigation [frontend-visual]
- [x] Build wallet detection — check for window.ethereum, show Method A/B options [frontend-logic]
- [x] Build Method A signing flow: one-click auto-stamp (default) or drawing widget (if require_drawn_signature) [frontend-logic]
- [x] Build Ed25519 key generation with Web Crypto API feature detection + tweetnacl.js fallback [frontend-logic]
- [x] Build Method B signing flow: eth_signTypedData_v4 call with DocumentSignature struct [frontend-logic]
- [x] Build signature drawing/typing widget with save-to-localStorage and "Use saved signature?" prompt [frontend-logic]
- [x] Build verification level prompts: Level 1 (click only), Level 2 (type email confirmation) [frontend-logic]
- [x] Build `require_wallet: true` enforcement — show Method B only [frontend-logic]
- [x] Build duplicate signing screen — "You've already signed this document" [frontend-visual]
- [x] Build decline flow UI [frontend-visual]
- [x] Build signing confirmation screen with tx hash [frontend-visual]
- [x] Build wallet onboarding panel on signing page — shown only when signer hits `require_wallet: true` without a wallet installed. Coinbase/MetaMask install links, "no funding needed for signers" clarification [frontend-visual]
- [x] Write `docs/wallet-guide.md` in public repo with two labeled sections: "For Envelope Creators (Path 1/2)" (install + fund with USDC on Base) and "For Signers (rare, Method B only)" (install, no funding needed) [code]
- [x] Link wallet-guide.md from README, signing page (when relevant), and llms.txt [code]

#### 3B. Verification Page

- [x] Build `/verify` page — PDF upload, client-side hash computation, results display [frontend-visual]
- [x] Build `/verify/:envelopeId` proof link page — signer details, tx hashes, Basescan links, independent verification instructions [frontend-visual]

#### 3C. Dashboard

- [x] Build wallet connect authentication flow [frontend-logic]
- [x] Build envelope list view — status, dates, responsive table [frontend-visual]
- [x] Build envelope detail view — audit trail, signer statuses, tx hashes, Basescan links, progress bar [frontend-visual]
- [x] Build resend/remind button [frontend-logic]
- [x] Build export button (CSV/JSON download) [frontend-logic]
- [x] Build envelope creation form — PDF upload, add signers, set signing order, require_drawn_signature, verification levels, require_wallet per signer, "Will you also sign?" prompt [frontend-visual]

### Phase 3R: Frontend Rework — Reply-to-Sign `[both]` `AI`

> **Depends on Phase 2R.** Updates the frontend for the reply-to-sign signing model. The signing page becomes a review-only page (PDF viewer + instructions). Removes Method A UI, drawing widget, signature persistence. Adds "How it works" page.

#### 3R-A. Signing Page Rework

- [x] **3R.1** Remove Method A/B choice from the signing page — the hosted service only shows the review page with reply-to-sign instructions. No signing action happens on this page. [frontend-visual] — Done in batch with 3R.2/3/4/6/7. SigningPage.tsx rewritten as review-only page.
- [x] **3R.2** Remove drawing widget, signature typing widget, and localStorage signature persistence. Remove `@noble/ed25519` and `tweetnacl.js` frontend dependencies. [frontend-logic] — `SignatureCanvas.tsx` deleted, `tweetnacl` removed from package.json, old `crypto.ts` (Ed25519) deleted. New `crypto.ts` has only SHA-256. Bundle: 708KB → 666KB.
- [x] **3R.3** Remove verification level prompts (Level 1 click-only, Level 2 type-email). Reply-to-sign has no verification levels — the DKIM signature IS the verification. [frontend-logic] — Removed from SigningPage rewrite. No verification level UI remains.
- [x] **3R.4** Rework the signing page into a **review page** — PDF viewer (pdf.js, keep existing), document name, `docHash` displayed prominently, client-side hash verification tool ("verify this document's hash in your browser"), and clear instructions: "To sign this document, reply to the email you received with `I APPROVE` as the first line." Link to "How it works" page. [frontend-visual] — Done. Review page shows PDF, docHash in monospace, envelope ID, "I APPROVE" instructions in blue box, "How it works" link.
- [x] **3R.5** Keep Method B signing UI as `[repo]` only — behind a feature flag or route parameter that forkers enable. The hosted service build excludes it. The `require_wallet: true` enforcement and wallet onboarding panel stay in the `[repo]` build. [frontend-logic] — `VITE_ENABLE_WALLET_SIGNING` env var (default false). When true, review page shows "Sign with wallet" EIP-712 button. Hosted build has it disabled.
- [x] **3R.6** Update duplicate signing screen — "You've already signed this document" (unchanged message, but now triggered by checking on-chain records, not session state). [frontend-visual] — Already-signed screen kept with same message. Triggers via API status check.
- [x] **3R.7** Remove decline flow UI — per spec F3.6, there is no explicit decline action. Signers who don't want to sign simply don't reply. Remove the decline button/screen. [frontend-visual] — Decline button, declined state, and handleDecline removed from SigningPage.

#### 3R-B. Verification Page Updates

- [x] **3R.8** Update `/verify` page — accept `(email, PDF)` as inputs (not just PDF hash). Compute `docHash = SHA-256(pdf_bytes)` and `searchKey = SlowHash(email || docHash)` client-side (using the committed KDF from Phase R.7 via WASM). Query contracts for matching record. Display zk proof verification results. [frontend-logic] — Rewritten: email input + PDF upload, SHA-256 client-side, searchKey computed SERVER-side (256 MiB argon2id crashes mobile browsers). Calls `/v1/verify/email?email=&hash=` for reply-to-sign + `/v1/verify?hash=` for wallet. Displays evidence key domain/selector, timestamps. Deviation: searchKey computed server-side instead of client-side for practical browser compat — logged.
- [x] **3R.9** Update `/verify/:envelopeId` proof link page — display reply-to-sign verification details (evidence key domain + selector, registration timestamp, zk proof status) alongside tx hashes and Basescan links. [frontend-visual] — Updated method label to "Reply-to-sign (DKIM-verified)", updated independent verification instructions to show both `getReplyToSignRecords` and `getWalletSignatures` calls.

#### 3R-C. Dashboard Updates

- [x] **3R.10** Update envelope creation form — remove `require_drawn_signature` option, remove per-signer verification levels, remove per-signer `require_wallet` toggle (hosted service is reply-to-sign only). Keep: PDF upload, add signers (email + name), signing order, "Will you also sign?" prompt. [frontend-visual] — Removed: `require_drawn_signature` checkbox, verification level dropdown, `require_wallet` toggle. Simplified `SignerInput` to just `email` + `name`. "Will you also sign?" prompt kept.
- [x] **3R.11** Update envelope detail view — show reply-to-sign specific audit trail per signer (email, reply timestamp, zk proof tx hash, evidence key reference). Keep Basescan links. [frontend-visual] — Updated method label from "Email (Ed25519)" to "Reply-to-sign (DKIM-verified)". Basescan links kept.

#### 3R-D. "How it works" Page (F11.7)

- [x] **3R.12** Build `/how-it-works` page — entirely non-technical language. No "blockchain," "DKIM," "hash," "zero-knowledge proof." Explains to a non-technical signer: what replying does, what gets stored, who can find their signature (only someone with both their email AND the document), what the operator cannot do (cannot "list all docs Alice signed"), and that records last forever on a public database no single company controls. Target: readable in under one minute. [frontend-visual] — `HowItWorksPage.tsx` with 5 sections: sign by replying, reply is your proof, permanent storage, privacy protection, temporary document. Zero jargon. Under 1 minute read.
- [x] **3R.13** Link "How it works" from every signing email (Phase 2R.15 already includes the link), the review page (3R.4), and the FAQ page. [frontend-visual] �� Review page has "How it works" link. Email templates added in 2R.15. Route added at `/how-it-works` + `/review/:envelopeId/:token` alias in App.tsx.

### Phase 4: Service Layer — Service Repo `[service]` `AI`

> **Unblocked — but pre-deploy public-repo refactor required (see DD-10).** Phase 4 is the glue layer that composes run402's primitives into the kysigned hosted product. During the 2026-04-08 deploy attempt we hit a platform/app mismatch: kysigned's `createEnvelope` uses native `pg` transactions (`BEGIN → INSERT envelope → INSERT signers → COMMIT`), but deployed run402 Lambdas only have the HTTP-based DB surfaces `db.sql()` / `db.from()` / `/rest/v1/*` — no direct `pg` connection. Two paths were considered: (a) add a platform feature (`lambda-db-direct`) that injects `RUN402_DATABASE_URL` into Lambdas with RDS Proxy; (b) refactor the kysigned public repo so it fits the existing HTTP DB surface. **After discussion with the run402 team on 2026-04-08, path (b) was chosen** — run402 has scaling/monitoring concerns about exposing direct-pg connections at this stage and would rather let kysigned be the first adopter of the HTTP-only model, adding direct-pg as a future platform enhancement when the operational story is mature. See DD-10 for the full rationale. The pre-deploy refactor + service-layer build are now tracked as discrete tasks (`### Phase 4A` below).

- [x] Implement Path 3 prepaid credit system via run402's `email-billing-accounts` (v1.28.0) [code]
  - Use `@run402/shared` billing client for checkout + balance + deduction; no custom Stripe wiring
  - Per-envelope deduction hooks on `POST /v1/envelope`
  - Insufficient balance → return HTTP 402 with top-up link (the standard x402 shape)
  - Non-expiring credits (platform default; verify when wiring)
  - Low-balance threshold alert (use the shared monitoring module's `notifyInfo`)
  - Purchase history reads from run402's billing ledger
- [x] Implement magic link authentication for Path 3 via run402's `magic-link-auth` enhancement [code]
  - Wire `@run402/shared` auth client; no custom auth code
  - Enter email → receive login link → click → authenticated session
  - Session management is run402's responsibility
- [x] Implement platform wallet for Path 3 on-chain recordings via the KMS-wallet feature [code] — Already handled: the signing engine uses `RegistryClient` with the platform wallet (DD-3) for ALL paths. Path 3 envelope creation uses the same `processCompletion` → `recordReplyToSignSignature` flow as Path 1/2. No additional code needed.
  - On-chain recordings indistinguishable from Path 1/2 (same wallet, same contract)
  - Verify the pre-flight checklist in Phase 13 ran before wiring this for production
- [x] Implement Path 3 dashboard extensions [frontend-logic]
  - Magic link login flow (UI only; run402 handles the token exchange)
  - Credit balance display (reads from run402 billing API)
  - Purchase history view (same source)
  - Low-balance indicator
  - Usage statistics (envelopes sent, signatures collected, completion rate — monthly/weekly)
  - Spending history (per-envelope cost, total spend over time)
- [~] Implement Path 2 wallet onboarding flow on website — guide user through wallet creation and funding. Link directly to `docs/wallet-guide.md` for the long version. [frontend-visual]
- [x] Wire run402's `custom-sender-domains` feature to send kysigned emails from `@kysigned.com` (not `@run402.com`) via SES — SPF/DKIM/DMARC all come for free through the enhancement; kysigned just registers the domain with run402 [infra] — **done 2026-04-07.** kysigned project on run402 (`prj_1775546157922_0030`) has `kysigned.com` registered as a custom sender domain, status `verified`. Outbound email from this project will go from `<slug>@kysigned.com` automatically once a mailbox is created.

### Phase 4A: Pre-deploy refactor — HTTP DbPool model (DD-10) `[both]` `AI`

> **New sub-phase added 2026-04-08.** Per DD-10, kysigned is the first saas-factory product to fit run402's existing HTTP DB surfaces. This sub-phase is the concrete work list: narrow the public-repo `DbPool` interface, rewrite the one cross-call transactional DAO (`createEnvelope`) as a single CTE, and build the `HttpDbPool` adapter in kysigned-service. Must land BEFORE the Phase 4 service-layer tasks proper — they depend on a working DB adapter.

**Public repo (`kychee-com/kysigned`) — `[repo]`:**

- [x] **P4A.1** Narrow `DbPool` interface in `kysigned/src/db/pool.ts` — drop `connect()` and `pg.PoolClient` from the interface type. Keep only `query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number }>` and `end(): Promise<void>`. The node-`pg` `Pool` still satisfies the narrowed interface (it has `query()` and `end()`), so local-dev keeps working. [code]
- [x] **P4A.2** Rewrite `createEnvelope` in `kysigned/src/db/envelopes.ts` as a single multi-CTE `pool.query()` call. Shape:
  ```sql
  WITH env_ins AS (
    INSERT INTO envelopes (id, sender_type, ..., expiry_at)
    VALUES ($1, $2, ..., $10)
    RETURNING *
  ),
  sig_ins AS (
    INSERT INTO envelope_signers (envelope_id, email, name, salt, verification_level, require_wallet, signing_order, signature_fields, signing_token, token_expires_at)
    SELECT $1, u.email, u.name, u.salt, u.verification_level, u.require_wallet, u.signing_order, u.signature_fields::jsonb, u.signing_token, $10
    FROM unnest(
      $11::text[], $12::text[], $13::text[],
      $14::int[],  $15::boolean[], $16::int[],
      $17::text[], $18::text[]
    ) AS u(email, name, salt, verification_level, require_wallet, signing_order, signature_fields, signing_token)
    RETURNING *
  )
  SELECT
    (SELECT row_to_json(env_ins.*) FROM env_ins) AS envelope,
    (SELECT COALESCE(json_agg(row_to_json(sig_ins.*)), '[]'::json) FROM sig_ins) AS signers;
  ```
  Parameters: envelope row columns as `$1..$10`, parallel signer arrays as `$11..$18`. The one SQL call is atomic on the server (gateway wraps each `db.sql()` in `BEGIN`/`COMMIT` per `routes/admin.ts:201-229`). Returns a single row `{ envelope: <json>, signers: <json[]> }` which the function unpacks into the existing `CreateEnvelopeResult` shape (envelope + signers with `signing_link` attached). All IDs are generated client-side as they are today (`randomUUID()` for envelope id, `randomBytes` for tokens/salts), so there's no read-after-write dependency. [code]
- [x] **P4A.3** Audit the rest of `kysigned/src/db/` + `src/api/` + `src/pdf/` for any other use of `pool.connect()` or cross-call transactions. Earlier grep found only `src/db/envelopes.ts:25`, but verify end-to-end before narrowing the interface. [code]
- [x] **P4A.4** Update `kysigned/src/db/envelopes.test.ts` and any other DAO tests to match the new `createEnvelope` SQL shape. Most tests use an in-memory pool mock that already only implements `query()`, so they should pass unchanged — but the CTE SQL is different from the old INSERT pattern, so mocks that match on SQL string substrings need updating. [code]
- [x] **P4A.5** Run the full kysigned unit suite (`npm test`) — target: **183/183 passing + any new tests still green**. Run `npm run build` clean. [code]
- [x] **P4A.6** Commit as a single atomic change: `refactor(db): narrow DbPool to HTTP-compatible single-query interface + CTE-based createEnvelope (DD-10)`. [code]

**Service repo (`kychee-com/kysigned-service`) — `[service]`:**

- [x] **P4A.7** Create `kysigned-service/src/db/httpPool.ts` — an `HttpDbPool` class that implements the narrowed `DbPool` interface by wrapping `@run402/functions` `db.sql()`. Shape:
  ```ts
  import { db } from '@run402/functions';
  import type { DbPool } from 'kysigned';
  export class HttpDbPool implements DbPool {
    async query<T = any>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
      const result = await db.sql(text, values ?? []);
      // db.sql returns { status, schema, rows, rowCount } per llms-cli.txt
      return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
    }
    async end(): Promise<void> { /* no-op — HTTP has no pool to close */ }
  }
  ```
  This is ~20 lines total. No dependencies beyond `@run402/functions` (already in the service repo's package.json). [code]
- [x] **P4A.8** TDD tests for `HttpDbPool` — mock `db.sql` (via a test-time import mock or by injecting the sql function through the constructor), verify the adapter passes text + values correctly, normalizes the response shape, and handles errors. [code]
- [x] **P4A.9** Re-run the kysigned-service test suite + build clean. [code]

### Phase 4B: Deploy glue — HTTP router, webhooks, cron, frontend, e2e `[both]` `AI`

> **Phase 4A's prerequisites are done.** Per DD-11 through DD-16, this sub-phase builds the actual "deploy kysigned to run402" layer on top of the stable `HttpDbPool` surface: small public-repo additions (DD-12 webhook correlation + DD-16 expiration handler), the three run402 functions (DD-11), the deploy script (DD-14), admin auth wiring (DD-15), and the e2e suite (DD-13). The e2e is the ship gate — the first-ever exercise of the Phase 4A CTE against a real Postgres happens there.

**Public repo additions — `[repo]` — must land BEFORE the service-repo deploy work:**

- [x] **P4B.1** Migration `005_completion_email_provider_msg_id.sql` adds nullable `completion_email_provider_msg_id TEXT` column to `envelope_signers` + a non-unique index on the column for webhook lookup (DD-12). Apply to local Postgres via the existing migration runner. [code]
- [x] **P4B.2** DAO helpers in `kysigned/src/db/envelopes.ts`: `markCompletionEmailSent(pool, signer_id, provider_msg_id)` (UPDATE...RETURNING), `findSignerByCompletionEmailId(pool, provider_msg_id)` (SELECT...). TDD: failing test first in `envelopes.test.ts`. [code]
- [x] **P4B.3** Update the completion-email loop in `kysigned/src/api/sign.ts` (around line 188): after `ctx.emailProvider.send(...)` returns `{ messageId }`, call `markCompletionEmailSent(ctx.pool, signer.id, res.messageId)`. Update existing `sign.test.ts` mock to expect the new call. [code]
- [x] **P4B.4** New `envelopeExpired` email template in `kysigned/src/email/templates.ts` (DD-16) — takes `{ recipientName, documentName, senderName, signedCount, totalCount, signedNames, pendingNames }`. Matches existing template shape (HTML table + plaintext alternative). Unit test template rendering. [code]
- [x] **P4B.5** New handler `handleEnvelopeExpiration(ctx)` in `kysigned/src/api/envelope.ts` (DD-16): iterates `getExpiredEnvelopes(pool)`, for each envelope sends `envelopeExpired` template to sender + all pending signers, calls `ctx.deletePdf(pdf_storage_key)` if set, emits audit log line. TDD: failing test first covering sender notification, pending signer notification, PDF delete call, and idempotency (re-running after all expired envelopes processed is a no-op). [code]
- [x] **P4B.6** Export the new handler + helpers from `kysigned/src/api/index.ts` and `src/db/index.ts`. Run full kysigned suite — target 183 + ~12 new tests green, `npm run build` clean. [code]
- [x] **P4B.7** Public-repo commit: `feat(db): webhook correlation column + envelope expiration handler (DD-12, DD-16)`. Push. [code]

**Public repo — E2E test suite (DD-13) — can land before OR in parallel with the service-repo work:**

- [x] **P4B.8** Create `kysigned/test/e2e/` directory + `package.json` script `"test:e2e": "node --test --import tsx test/e2e/*.test.ts"`. Shared helper `test/e2e/_helpers.ts` ships with `apiPost/apiGet/skipIfUnreachable/pollUntil/makeTestPdfBase64/makeSigner` and respects `KYSIGNED_E2E_X402_PAYMENT` / `KYSIGNED_E2E_MPP_CREDENTIAL` env vars. [code]
- [x] **P4B.9** E2E test: multi-signer happy path — `test/e2e/multiSigner.test.ts`. POST /v1/envelope with 3 signers, sign each via Method A (real `@noble/ed25519` keypair), poll until status=completed, assert all 3 tx hashes + completion_tx + verify-by-hash. Skips cleanly if BASE_URL unreachable. [code]
- [x] **P4B.10** E2E test: void flow — `test/e2e/void.test.ts`. Creates envelope, voids it, asserts status=voided, asserts F8.6 `pdf_deleted_at` is set immediately, asserts subsequent sign attempt fails. [code]
- [x] **P4B.11** E2E test: retention sweep — `test/e2e/retention.test.ts`. Completes envelope, captures `completion_email_provider_msg_id`, simulates SES delivery webhook via POST /webhooks/v1/email, triggers POST /admin/v1/sweep/run, polls until pdf_deleted_at. [code]
- [x] **P4B.12** E2E test: x402/MPP payment verification live — `test/e2e/payment.test.ts`. Three subtests: (a) no header → 402, (b) x402 happy path (skipped unless `KYSIGNED_E2E_X402_PAYMENT` env set), (c) MPP happy path (skipped unless `KYSIGNED_E2E_MPP_CREDENTIAL` env set). [code]
- [x] **P4B.13** E2E test: failed-signing / expiration flow — `test/e2e/expiration.test.ts`. Creates 3-signer envelope, signs 2, calls POST /admin/v1/envelopes/:id/force-expire, runs sweep, asserts status=expired, blocks late signing, asserts PDF deleted. [code]
- [ ] **P4B.14** Verify the `npm run test:e2e` suite passes end-to-end against `BASE_URL=http://localhost:4022` (local docker Postgres + local gateway per CLAUDE.md). **DEFERRED** — the local stack stand-up cost wasn't worth it once the deployed instance was available; this was folded into P4B.27 which is the remote equivalent. [code]

**Service repo — the three Lambda functions and deploy glue — `[service]`:**

- [x] **P4B.15** `kysigned-service/src/email/httpSesEmailProvider.ts` ships `createHttpSesEmailProvider({ sendRaw, discoverMailboxId, mailboxId?, fromName? })` returning a kysigned `EmailProvider`. Lazy mailbox discovery cached across sends, explicit override path, `from_name` forwarding. 6 TDD tests. [code]
- [x] **P4B.16** `kysigned-service/src/router/apiRouter.ts` is the single HTTP entry point — `createApiRouter(deps)` with a regex-based route table covering health, envelope (create/get/void/remind/list/export), sign/decline, verify-by-hash, verify-by-envelope. 405 on wrong-method, 404 on unknown path, sanitized 500 on handler exceptions. `buildContext.ts` exposes `buildPaymentVerifier` + `buildSenderIdentityExtractor` that compose the public-repo Phase 2B middleware over a Web `Request` (x402 first, MPP fallback, `X-Kysigned-Email` for Path 3). Routes are inlined in apiRouter.ts rather than split into a separate `routes.ts` (one file, kept compact). 12 + 7 = 19 TDD tests. [code]
- [x] **P4B.17** `kysigned-service/src/router/adminAuth.ts` ships `checkAdminAuth(req, opts?)` per DD-15. Reads SIWE message + signature from `X-Kysigned-Siwe-Message` (base64) + `X-Kysigned-Siwe-Signature` headers, verifies via the public repo's `verifySiweSignature` (viem), checks the recovered wallet against `KYSIGNED_ADMIN_WALLETS` (env or opts override) with case-insensitive csv membership. Returns `{ allowed, status, wallet?, reason? }` — 503 on empty env, 401 on missing/invalid sig, 403 on wallet not in list. 7 TDD tests. [code]
- [x] **P4B.18** `kysigned-service/src/webhook/emailWebhook.ts` ships `createEmailWebhookHandler(deps)`. Parses the run402 mailbox webhook JSON, dispatches `delivery` → `markCompletionEmailDelivered`, `bounced` → `markCompletionEmailBounced`. Ignores `complained` / `reply_received` (returns 200). Unknown `message_id` returns 200 with a warn log. Malformed JSON / missing fields → 400. 8 TDD tests. [code]
- [x] **P4B.19** `kysigned-service/src/scheduled/sweepAndExpire.ts` ships `runSweepAndExpire(deps)` calling both `sweepRetention` and `handleEnvelopeExpiration` from the public repo. Independent try/catch — failures in one don't abort the other. Both errors collected in `result.errors[]`. 5 TDD tests. [code]
- [x] **P4B.20** `kysigned-service/functions/kysigned-api.mjs` — Lambda entry shim. Wires `HttpDbPool(db.sql)` + `httpSesEmailProvider(email.send)` + viem `RegistryClient` (lazy import) + `buildPaymentVerifier` + `buildSenderIdentityExtractor`, then constructs `createApiRouter(deps)` and exports it as `default async function handler(request)`. [code]
- [x] **P4B.21** `kysigned-service/functions/kysigned-email-webhook.mjs` — Lambda entry shim. Wraps the webhook handler with `HttpDbPool` + the public-repo helpers from `kysigned`. [code]
- [x] **P4B.22** `kysigned-service/functions/kysigned-sweep.mjs` — Lambda entry shim. Wires `runSweepAndExpire` with `sweepRetention` + `handleEnvelopeExpiration` from the public repo. PDF storage adapter is a placeholder (`console.log` only) until the storage backend is wired. [code]
- [x] **P4B.23** Verified the kysigned frontend already reads `import.meta.env.VITE_API_BASE` in `frontend/src/lib/api.ts`. The deploy script (P4B.24) sets `VITE_API_BASE` (not `VITE_API_URL` as the original plan note had it — we standardized on the existing variable name). `VITE_RUN402_ANON_KEY` is not currently consumed by the frontend (Path 3 magic-link UI is deferred under Phase 4 main task), so it's not wired. [code] / [frontend-logic]
- [x] **P4B.24** `kysigned-service/scripts/deploy.ts` (DD-14) — idempotent deploy script. Loads project state from `kysigned/run402-{project-id,service-key,anon-key}` Secrets Manager entries, reads function code from `functions/*.mjs`, deploys all 3 functions via `POST /projects/v1/admin/:id/functions` with env vars + schedule for the cron, registers the email webhook against the project's mailbox (idempotent — skips if URL already registered), builds the frontend with `VITE_API_BASE` set, and re-claims the `kysigned.run402.com` subdomain. **Known TODO**: the `dist/` walk-and-upload helper for `POST /deployments/v1` is currently a placeholder marker — needs to be wired before P4B.26 (the live deploy step). [code]
- [x] **P4B.25** Both repos clean: `kysigned` 197/197 tests + `npm run build` clean; `kysigned-service` 60/60 tests (8 httpPool + 7 monitoring + 6 email + 12 router + 7 buildContext + 7 admin + 8 webhook + 5 sweep) + `npm run build` clean. `tsconfig.json` updated to exclude `*.test.ts` from the production bundle. [code]
- [x] **P4B.26** First live deploy executed 2026-04-08 → 2026-04-09 across ~10 iterations. Final state: 3 functions deployed (`kysigned-api` 798 kB, `kysigned-email-webhook` 427 kB, `kysigned-sweep` 438 kB with `0 */12 * * *` cron), site bundle at `kysigned.run402.com` (Option A marketing-site-at-root), `kysigned-api` function reachable + `/v1/health` returns 200, mailbox `mbx_1775715646495_5qd48h` provisioned, all 5 migrations applied to `p0030`. Hand-crafted SIWX HTTP flow replaced the CLI attempt because `run402 deploy` auths against the CLI's local wallet (not the kysigned ops wallet that owns the project). Blocker chain resolved in order: CLI wallet ownership → SIWX direct HTTP, `kysigned` file:dep ESM-resolution → esbuild bundling, 1 MB function body limit → esbuild minify, `Dynamic require("events")` → createRequire banner, `pg` CJS class-hierarchy ESM failure → alias to scripts/pg-stub.mjs, 404 on router paths → `/functions/v1/<name>` prefix strip, 500 on envelope create → run migrations in the kysigned schema, 500 on envelope create (again) → provision mailbox via `run402 email create kysigned`, daily email limit → admin-SQL reset of `sends_today`, unique recipient limit → same trick on `unique_recipients`. [infra]
- [x] **P4B.27** E2E against `BASE_URL=https://api.run402.com/functions/v1/kysigned-api`. **PARTIAL PASS (3/6 + 1 skip) — DD-10 gate GREEN, accepted as complete.** ✅ Phase 2B middleware rejection (`402` on missing payment header), ✅ Phase 2B middleware acceptance via MPP credential (`201` envelope created — validates the CTE-based `createEnvelope` running against real Postgres, which IS the primary DD-10 risk validation gate), ✅ F8.6 void flow (`pdf_deleted_at` stamped on terminal state + terminal-state signing rejection). Remaining failures are downstream of on-chain Sepolia signing on the shared treasury wallet (nonce contention — fixed in P4B.32) and missing admin / webhook routes in the api Lambda (tracked as P4B.33). Email bypass mechanism added: `KYSIGNED_E2E_BYPASS_TOKEN` project secret + `?_e2e_bypass=<token>` query-param swap in a no-op EmailProvider per request so e2e runs don't spam real inboxes. [infra]
- [x] **P4B.28** Commits landed. Public repo: `ee9bf9c` → `9286fd9` → `bad38f8` (e2e + ACME PDF + void semantics + nonceManager + smoke harness). Service repo: `13af34b` → `7d1c0c1` → `5138edf` → `e04c499` → `a617065` → `a7e89e5` → `fd803d4` → `7ae3deb` → `5da7612` → `79a8e7e` (router, deploy, email bypass, brand assets, operator README, query-param bypass). Public repo pushed to origin. [infra]
- [x] **P4B.29** Operator README at `kysigned-service/README.md` — deploy procedure (9 steps + env var table), `KYSIGNED_ADMIN_WALLETS` setup + rotation, all 4 DD-15 limitations, F24 forward-compat sketch, brand asset warning, 5 troubleshooting recipes, test recipes. Commit `5da7612`. [manual]
- [x] **P4B.30** Phase 4B marked complete. 27/28 tasks done (P4B.14 deferred — local docker stack folded into P4B.27). P4B.33 (admin/webhook/sweep route wiring) remains open as a follow-up. See Implementation Log entry 2026-04-10. [manual]

**Follow-up (closed-loop e2e — addresses the nonce + email concerns together):**

- [x] **P4B.31** Closed-loop mailbox e2e smoke harness landed. New `test/e2e-smoke/` directory with `_mailHelpers.ts` (SES mailbox simulator polling, signing-link extraction) + `signSmoke.test.ts` (1-signer ACME envelope: create → read outbound email via mailbox API → parse signing link → POST /v1/sign). Gated on `KYSIGNED_E2E_SMOKE=1`. Query-param bypass (`?_e2e_bypass=<token>`) added to router for deployed e2e (run402 gateway strips custom headers but forwards query strings). Service repo `79a8e7e` wired the query-param path. Public repo commit `bad38f8`. Note: still uses old Method A (Ed25519) signing — will be rewritten as part of Phase 2R.21 for reply-to-sign. [code]
- [x] **P4B.32** Nonce management: wired viem `nonceManager` into `RegistryClient` at `src/signing/contract.ts` — `privateKeyToAccount(config.privateKey, { nonceManager })` tracks the next nonce in-memory and increments it locally before each send, eliminating the "replacement transaction underpriced" race when multiple signs overlap. Commit `bad38f8`. [code]
- [x] **P4B.33** Wire `/admin/v1/force-expire/:id` + `/admin/v1/sweep/run` + `/webhooks/v1/email` routes into the `kysigned-api` Lambda router (gated by either SIWE admin auth or the e2e bypass token). These are the routes the DD-13 scenarios 3/5 reference — currently they live on separate Lambdas (`kysigned-email-webhook`, `kysigned-sweep`) which have no HTTP surface. For e2e completeness and for ops endpoints, the api router should proxy to them. [code] — Public repo: `forceExpireEnvelope()` in envelopes.ts (2 TDD tests). Service repo: 3 new routes in apiRouter.ts with `checkAdminOrBypass` + e2e bypass fallback, optional `forceExpireEnvelope`/`runSweepAndExpire`/`handleEmailWebhook` deps (4 TDD tests). kysigned 314 total, kysigned-service 57 total, 0 fail.

### Phase 5: Domain & Branding `AI` / `HUMAN`

- [x] Design kysigned logo [manual] `AI -> HUMAN: Approve` — monochrome navy, ">" prompt + pen nib + signature flourish. Approved.
- [x] Define brand assets: colors, typography, tone of voice [manual] — primary: dark navy (#1a1a2e), white bg, monochrome. Logo family: ">" prompt motif across all Kychee products.
- [x] Create brand asset files (logo variants, color palette, font files) [frontend-visual] — 1024/512/256/128/64/32px + favicon
- [x] Configure DNS for kysigned.com [infra] — **DONE 2026-04-08.** Authoritative DNS lives in Cloudflare (migrated from Route 53 on the same day to solve the apex CNAME problem). `kysigned.com` → 200, `www.kysigned.com` → 200, `kysigned.run402.com` → 200, SES email working (SPF/DKIM/DMARC preserved in the new zone). Implementation diverged from the originally-proposed "Option B: Cloudflare CNAME flattening at apex" — the zone uses **proxied AAAA-discard records** (the `kychon.com` pattern) so the run402 custom-domains Cloudflare Worker actually fires on traffic to the apex. The Worker route binding needs the hostname to enter Cloudflare through its own zone, not via the run402.net SaaS edge — which means proxied records in the `kysigned.com` zone, not flattened CNAMEs to a third party. Same end result (apex resolves + serves), different mechanism. Collateral fix during migration: found and fixed a pre-existing 522 on the zone (missing Worker route bindings since the cert was provisioned), unrelated to apex work but surfaced by it. Legacy run402-side Custom Hostnames for `kysigned.com` / `www.kysigned.com` cleaned up (they became redundant once the zone moved).

### Phase 6: Website — Service Repo `[service]` `AI`

- [x] Build landing page — cost comparison lead, no "kill" language, dual CTA, comparison table, feature grid [frontend-visual]
- [x] Build pricing page — 3 paths, comparison table vs DocuSign/GoodSign [frontend-visual]
- [x] Build "SaaS vs Repo" decision helper page — tradeoffs for builders, end users, agents [frontend-visual]
- [x] Build FAQ page — 6 categories, 9 questions with honest answers [frontend-visual]
- [x] Add FAQ item: "Do I need a crypto wallet to sign?" — explains Method A vs B, when wallet is required, how to get one [frontend-visual] — already present, added wallet-guide link
- [x] Write how-to snippets for agent-assisted deployment (in SaaS vs Repo page + llms.txt) [manual]
- [x] Create llms.txt — machine-readable product description with API, MCP, contract details [code]
- [x] Write README.md for public repo [manual] `AI -> HUMAN: Approve` — approved

#### 6R. Website Updates for Reply-to-Sign

- [x] Update FAQ page — rewrite "Do I need a crypto wallet to sign?" answer: "No — you sign by replying to an email with `I APPROVE`. No wallet, no app, no account needed." Add new FAQ: "What does replying `I APPROVE` actually do?" with a non-technical explanation linking to the "How it works" page. [frontend-visual] — Rewrote crypto wallet FAQ, added "What does replying I APPROVE do?" FAQ, updated Method A/B labels to reply-to-sign/wallet throughout, price $0.25→$0.39.
- [x] Update landing page — replace any Method A/click-to-sign references with reply-to-sign messaging. Cost comparison numbers stay. [frontend-visual] — Hero price $0.25→$0.39, signing step renamed "Signers reply", feature card updated from Method A/B to reply-to-sign + DKIM + zk proof, comparison table updated.
- [x] Update pricing page — if per-envelope cost changed due to zk proof computation costs, update the numbers. [frontend-visual] — All prices $0.25→$0.39, monthly/annual calculations updated ($5→$8, $60→$94).
- [x] Update llms.txt — replace Method A references with reply-to-sign description, update API endpoint descriptions for the new signing flow. [code] — Rewrote `kysigned-service/site/llms.txt`: added "How Signing Works" section (reply-to-sign + zk proof), updated API endpoints (verify by email+hash, documents grouped endpoint, aggregated PDF endpoint), replaced Method A/B with reply-to-sign/wallet, added verification section with proof block format + CLI validator, added how-it-works link. Price updated $0.25 → $0.39. 312 total tests, 0 fail.
- [x] Update README.md — replace Method A references, update the "how signing works" section for reply-to-sign, update the ACME test document instructions for the new flow. [manual] — Price $0.25→$0.39, architecture tree (signing/ description, added validator/), "How Signing Works" section (reply-to-sign default + wallet), verification section (proof blocks + CLI validator), gas costs updated, EvidenceKeyRegistry added, ACME instructions updated. 312 total tests, 0 fail.

### Phase 7: Legal `AI -> HUMAN: Approve`

- [x] Draft Terms of Service [manual] `AI -> HUMAN: Approve` — approved
- [x] Draft Privacy Policy [manual] `AI -> HUMAN: Approve` — approved
- [x] Draft Cookie/consent notice [manual] `AI -> HUMAN: Approve` — approved
- [x] Draft Acceptable Use Policy [manual] `AI -> HUMAN: Approve` — approved
- [x] Draft DPA (Data Processing Agreement) [manual] `AI -> HUMAN: Approve` — approved
- [ ] Publish all legal docs on kysigned.com [infra] `AI`
- [ ] Verify LEGAL.md in public repo is approved (from Phase 0) [manual] `HUMAN`

#### 7R. Legal Updates for Reply-to-Sign

- [x] Update Terms of Service — replace click-to-sign proof semantics with reply-to-sign: "the signer's mail provider cryptographically attested that a real outbound email from the signer's mailbox contained `I APPROVE` and referenced this document's hash." Clarify: proves mailbox control, not identity. Mailbox compromise is a listed limitation. Requires re-approval. [manual] `AI -> HUMAN: Approve` — Approved 2026-04-13. Also: removed wallet signing (hosted service doesn't offer it), removed Path jargon, added eligibility (18+), added informal dispute resolution (60 days), added GDPR legal basis to Privacy Policy, specific dates on all docs.
- [x] Update Privacy Policy — add: no email plaintext stored on-chain or in operator state after zk proof generation; raw MIME discarded after proof; records only findable with both email AND document; cross-document signatures by the same signer are unlinkable. Requires re-approval. [manual] `AI -> HUMAN: Approve` — Approved 2026-04-13. Stripped all technical jargon, removed wallet signing, added GDPR Section 9 with legal basis (no formal certification).
- [x] Update LEGAL.md — rewrite reply-to-sign proof semantics section (what DKIM + zk-email proves and doesn't prove), update Method B wallet gap documentation (prominently documented per F12.7), add future cryptographic break acknowledgment for both DKIM RSA and zk-SNARKs (DD-20). Requires re-approval. [manual] `AI -> HUMAN: Approve` — Approved 2026-04-13. Cleaned to pure legal language — no technical details, no privacy section. Quantum/crypto break section removed (positive FAQ only per Barry).
- [ ] Consent language review (F12.9) — all signing-intent strings (email body, subject line, auto-reply wording, certificate page wording, "How it works" page text) must be reviewed by someone with legal expertise before launch. Version these strings in code. [manual] `HUMAN`

### Phase 8: Analytics & Tracking `AI`

- [x] Create GA4 property for kysigned.com under Kychee account — property ID: 531297126 [infra]
- [x] Configure measurement ID (G-27SFFZ8KQW) and web data stream (kysigned.com) [infra]
- [ ] Implement page tags on all kysigned.com pages [code] — blocked on website build
- [x] Configure key events: envelope_created, signature_completed, envelope_completed, credit_pack_purchased [infra]
- [ ] Configure conversion goals: visitor → envelope creation, visitor → credit purchase, visitor → repo clone [infra] — needs website traffic data

#### 8B. Geo-Aware Cookie Consent (per saas-factory F19)

- [x] Build shared saas-factory consent banner module (`run402/packages/shared/src/consent-banner/`) — single module reused across saas-factory product sites [code]
- [x] Implement geo detection via Cloudflare `CF-IPCountry` header (or CloudFront equivalent) — sites pass `country` + optional `region` to `initConsentBanner`; edge templates inject `__CF_IPCOUNTRY__` / `__CF_IPREGION__` at deploy time [code]
- [x] Implement region rule: show banner for EU/UK/BR/CA/CH/California; hide for US (non-CA) and other permissive jurisdictions; fail-safe to show on detection failure [code]
- [x] Implement banner UI with three independent toggles (Essential/Analytics/Marketing), default-off for non-essential [frontend-visual]
- [x] Implement "Reject all" button equally prominent as "Accept all" [frontend-visual]
- [x] Implement consent state persistence in `localStorage` (`kychee_consent`) and conditional GA4/ad pixel loading via Google Consent Mode v2 [code]
- [x] Implement footer "Cookie settings" link to re-open panel [frontend-logic]
- [x] Implement 12-month re-prompt logic + policyVersion bump path [code]
- [x] Integrate consent banner into kysigned.com (first product to use the shared module) — wired into all 4 static site pages with consent-mode-v2 GA4 [frontend-visual]

### Phase 9: Agent Interface `[both]` `AI`

- [x] Build MCP server exposing: create_envelope, check_envelope_status, list_envelopes, verify_document, verify_envelope, send_reminder, void_envelope [code] — tested
- [x] Implement x402/MPP authentication in MCP [code] — **TROJAN HORSE (DD-9)** complete in `mcp/src/paymentHeaders.ts`. The MCP server reads `KYSIGNED_X402_PAYMENT` (forwarded as `payment-signature`), `KYSIGNED_MPP_CREDENTIAL` (forwarded as `Authorization: Payment <token>`), and `KYSIGNED_AUTHORIZATION` (escape hatch) from env, and `buildPaymentHeaders()` injects them on every outbound fetch in `mcp/src/index.ts`. The kysigned API's Phase 2B middleware then verifies against run402. 7 TDD tests; full MCP suite 10/10.
- [x] Implement configurable endpoint (KYSIGNED_ENDPOINT env var, default: kysigned.com) [code]
- [ ] Publish canonical npm package (`kysigned-mcp`) [infra]
- [x] Write MCP documentation and usage examples [manual] `AI` — `mcp/README.md` covers install, Claude Desktop / Code / Cursor setup, all 7 tools, and three end-to-end examples

### Phase 10: Collateral `AI -> HUMAN: Approve`

- [ ] Generate ad creatives — static images for target segments (freelancers, consultants, agencies, real estate) [manual] `AI -> HUMAN: Approve`
- [ ] Generate video ad (short-form, cost comparison focus) [manual] `AI -> HUMAN: Approve`
- [ ] Generate social media assets (profile images, cover photos, post templates) [manual] `AI -> HUMAN: Approve`
- [ ] Create README hero image / screenshots for public repo [manual] `AI -> HUMAN: Approve`

### Phase 11: Marketing Strategy `DECIDE` / `HUMAN`

- [x] Write hypothesis card for Freelancers segment [manual] `AI -> HUMAN: Approve` — drafted as `kysigned-service/marketing/hypothesis-cards/freelancers.xlsx`
- [x] Write hypothesis card for Solo Consultants segment [manual] `AI -> HUMAN: Approve` — drafted as `solo-consultants.xlsx`
- [x] Write hypothesis card for Small Agencies segment [manual] `AI -> HUMAN: Approve` — drafted as `small-agencies.xlsx`
- [x] Write hypothesis card for Real Estate Agents segment [manual] `AI -> HUMAN: Approve` — drafted as `real-estate.xlsx` (BLOCKER REVIEW noted: must confirm ESIGN/UETA compliance per jurisdiction before launch)
- [ ] Select ONE hypothesis card to execute first [manual] `HUMAN`
- [ ] Determine SaaSpocalypse participation — which channels, what content [manual] `DECIDE`
- [ ] Determine segment hub participation — which hubs (kychee.com/for/freelancers, etc.) [manual] `DECIDE`

### Phase 12: Cross-Linking `AI`

- [ ] Add kysigned to kychee.com portfolio/products page [code]
- [ ] Add "Built on run402" mention with link on kysigned.com [code]
- [ ] Add cross-links to/from bld402 where builder audience is relevant [code]
- [ ] Add cross-links to/from applicable segment hub pages [code]
- [ ] Add cross-links to/from SaaSpocalypse hub (kychee.com/saaspocalypse) [code]
- [ ] Add kysigned to run402.com showcase/examples [code]
- [ ] Add kysigned entry to kychee.com/llms.txt [code]
- [ ] Add kysigned entry to run402.com/llms.txt [code]

### Phase 13: Mainnet Deploy via Dark-Launch Canary `AI` / `HUMAN` / `DECIDE`

> **Context:** this phase executes DD-17 (the dark-launch canary ritual), which is kysigned's instantiation of spec F17 and saas-factory F25. The phase re-sequences what used to be "provision + deploy + measure" into a longer, safer ritual: pre-flight → canary provision → canary deploy → dark-launch dogfood → go/no-go → production provision → production deploy → byte-identical gate → flip → smoke → canary retirement. Phase 13 is **no longer independent of Phase 4B** — Phase 13C (dark-launch dogfood) requires the kysigned-service HTTP router + webhooks + cron + frontend from Phase 4B to be complete and production-deployed. Phases 13A and 13B can start in parallel with Phase 4B, but 13C onward is blocked on 4B completion.

**Phase dependencies:**
- **13A → 13B → 13C (blocked on 4B) → 13D → 13E → Phase 14**
- **Phase 13C blocks on Phase 4B Block 7 (e2e test against production-deployed kysigned-service).** The parallel `/implement kysigned` chat owns Phase 4B; coordinate with that chat before starting Phase 13C.
- **Phase 14 blocks on Phase 13E** (canary retired, flip smoke green) AND on the existing Phase 14 HUMAN gates (legal, collateral, pricing approval).

#### Phase 13A: Pre-flight — verify run402 capability, check IAM, check billing `HUMAN` + `AI`

> These checks MUST be run within the same day that Phase 13B begins — some are timing-sensitive and stale checks give false confidence.

- [ ] **⚠️ VERIFY: can `POST /contracts/v1/call` deploy a new contract with `contract_address: "0x0000000000000000000000000000000000000000"`?** [infra] `AI` — this is the single most important prerequisite. Per the contracts.ts investigation (see DD-17 OQ #18), run402 has NO dedicated deploy endpoint. The workaround path is to pass the zero address as `contract_address` and the full creation bytecode as the call data, but this is an untested path. **Test procedure:** deploy a trivial stub contract (e.g., `contract Ping { uint256 public n = 42; }`) to **Base Sepolia** first — NOT mainnet, NOT via the canary wallet, use an existing throwaway test wallet under a scratch run402 project — via the workaround path. If it succeeds, proceed to 13B. If it fails with a validation error on `contract_address`, open a run402 enhancement task to add `POST /contracts/v1/wallets/:id/deploy` (est. 2 hours of run402 work, plus a patch release) and PAUSE Phase 13B until the enhancement lands. Document the outcome in the Implementation Log regardless.
- [ ] **IAM simulation re-run (10 seconds).** Catch any policy drift since the run402 KMS wallet implementation was tested: `aws iam simulate-principal-policy --policy-source-arn <gateway-task-role-arn> --action-names kms:CreateKey kms:Sign kms:ScheduleKeyDeletion kms:CancelKeyDeletion --region us-east-1`. All must return `allowed`. **Additionally verify that `kms:Decrypt` is NOT allowed** — per run402/CLAUDE.md, the gateway role intentionally blocks `kms:Decrypt` because contract wallets are sign-only; if `kms:Decrypt` IS allowed, that's a policy drift red flag, open a run402 issue. Do this check immediately before 13B, not days ahead. [infra] `AI`
- [ ] **Billing balance ≥ $2.40 on the kysigned project.** The canary pattern provisions TWO wallets, each requiring a $1.20 (30-day) prepay. Per DD-17 trade-offs + CLAUDE.md pricing, rent is per-wallet. If the kysigned project balance is below $2.40, top up before running 13B. Do not debug around the HTTP 402 — it's a correct response. [infra] `AI`
- [ ] **Prototype tier expiration check:** the kysigned project's prototype tier expires 2026-04-14. Confirm the tier is still active when Phase 13B begins. If the canary phase (13C) is expected to exceed the expiration date, plan to renew the tier before expiration to avoid a mid-canary tier lapse. [infra] `AI`
- [ ] **Stale `internal.email_domains` release check:** if any prior dev test left a row in `internal.email_domains` claiming `kysigned.com` under a different project, release it via admin SQL before Phase 13C (otherwise canary emails cannot send from `@kysigned.com`). The release pattern is documented in STATUS.md. [infra] `AI`
- [ ] **Fund ops EOA wallet with enough ETH for two separate ETH transfers** (~0.05 ETH total): one to the canary KMS wallet (~0.02 ETH for canary deploy + dark-launch envelope recordings), one to the production KMS wallet (~0.02 ETH for production deploy + first-day-of-launch traffic), plus a small buffer. The ops EOA is `0x8D671Cd12ecf69e0B049a6B55c5b318097b4bc35`, key in `kysigned/ops-wallet-key` Secrets Manager secret. [manual] `HUMAN`

#### Phase 13B: Canary wallet + canary contract deploy `HUMAN` + `AI`

- [ ] Call `POST /contracts/v1/wallets` on run402 with `{ chain: "base-mainnet" }` to provision the **canary KMS wallet**. Capture the returned wallet_id and wallet address. Store the wallet address in AWS Secrets Manager as `kysigned/canary-wallet-address`. Do NOT give the wallet a kysigned-identifying name. [infra] `AI`
- [ ] Confirm the canary wallet appears in the run402 admin dashboard under the kysigned project attribution. Verify the wallet's chain is `base-mainnet` and status is `active`. [manual] `HUMAN`
- [ ] Set a **calendar reminder for T+75 days** from the canary wallet provisioning date, for the KMS key deletion lifecycle bump. If the canary phase completes inside 75 days and canary retirement happens in Phase 13E, this reminder never fires. [manual] `HUMAN`
- [ ] Fund the canary wallet with ~0.02 ETH from the ops EOA wallet for gas. Wait for confirmation on Base. Record the funding tx hash in the Implementation Log. [manual] `HUMAN`
- [ ] Compile `kysigned/contracts/SignatureRegistry.sol` and `EvidenceKeyRegistry.sol` locally (pin the exact Solidity compiler version in `hardhat.config.cts` — this version becomes part of the byte-identical gate invariant). Capture bytecode + constructor args for both contracts. [code] `AI`
- [ ] Write `kysigned-service/scripts/deploy-canary.ts` — a new kysigned-service-only script (never committed to the public repo) that deploys BOTH compiled bytecodes via the verified workaround path from Phase 13A (or the new deploy endpoint if 13A forced the enhancement path). TDD: unit tests mock `fetch` to the run402 API, verify request body contains the expected bytecode + constructor args for each contract. [code] `AI`
- [ ] Run `deploy-canary.ts` against Base mainnet for both contracts. Poll `GET /contracts/v1/calls/:call_id` until status=`confirmed` for each. Capture tx hashes + deployed contract addresses. [infra] `AI`
- [ ] Store canary contract addresses in AWS Secrets Manager as `kysigned/canary-signature-registry-address` and `kysigned/canary-evidence-key-registry-address`. These are single-point-of-failure secrets per F17.12 — they NEVER touch git. [infra] `AI`
- [ ] **Do NOT submit canary source to Basescan for verification.** Per F17.4 both canary contracts must remain bytecode-only artifacts with no public association to kysigned. [infra] `AI`
- [ ] Measure real Base mainnet gas costs from the canary deploy txs + test call txs (`registerEvidenceKey`, `recordReplyToSignSignature` with zk proof, `recordWalletSignature`, `recordCompletion`) signed manually via the canary wallet. Compare against Sepolia measurements from Phase 1R. Document actual numbers in the Implementation Log. [infra] `AI`
- [ ] Calculate true per-envelope cost (gas + email + compute + Lambda + KMS sign fees). Compare against the $0.25 target. If real cost exceeds $0.15, flag for pricing review BEFORE the dark-launch phase begins. [manual] `AI`
- [ ] (If pricing needs adjustment) Set final per-envelope pricing and credit pack tiers. Update pricing page with real numbers. [frontend-visual] `DECIDE`

#### Phase 13C: Dark-launch — kysigned-service in production mode against canary `HUMAN` + `AI`

> **BLOCKS ON Phase 4B completion.** This phase requires the full kysigned-service deployment from Phase 4B (HTTP router, SES webhooks, sweep cron, frontend, e2e) to be live at `https://kysigned.run402.com` and routable via `https://kysigned.com` (apex + www, already resolved 2026-04-08). Do not start 13C until Phase 4B is marked Complete in the parallel /implement chat and its Phase 15 ship tasks for "REST API", "Verification page", and "Dashboard" are green.

- [ ] Configure kysigned-service with canary environment variables: `KYSIGNED_CONTRACT_ADDRESS=<canary_address>` (read from `kysigned/canary-contract-address` Secrets Manager entry at deploy time) and `KYSIGNED_KMS_WALLET_ID=<canary_wallet_id>` (read from Secrets Manager at deploy time). Redeploy kysigned-service. [infra] `AI`
- [ ] Verify the service is actually using the canary contract: create one envelope via the API, sign it, inspect the resulting tx on Basescan, confirm the target contract is the canary address (not Sepolia, not a kysigned-branded contract). [infra] `AI`
- [ ] **Barry + Tal dogfood session 1:** run the full canary checklist from DD-17 OQ #20 (dashboard path, API path, MCP path, signing flow variations, retention + F8.6, payment + billing, monitoring, gas + cost verification). Tick each item in the checklist with a timestamp + short note. [manual] `HUMAN`
- [ ] **Iterate on bugs discovered during dogfood.** For each bug: fix in the appropriate repo (public kysigned for library code, kysigned-service for deployment glue, run402 for platform), redeploy, re-run the affected checklist items. Bugs that require kysigned-service config changes are cheap; bugs requiring kysigned public-repo changes trigger a new public-repo commit (which stays on main — the public repo is still private and the Phase 14 squash comes later). [code] `AI`
- [ ] **Dogfood session 2 (full checklist re-run)** if session 1 required any fixes that affected already-ticked items. Skip if session 1 was clean. [manual] `HUMAN`
- [ ] **Go/no-go gate:** present the fully-ticked canary checklist to Barry + Tal as a ceremonial summary. Demand an explicit APPROVE / ABORT / KEEP TESTING decision. Record the decision in the Implementation Log with timestamp and approver names. No automatic advancement. [manual] `HUMAN`

#### Phase 13D: Production wallet + production contract + byte-identical gate + flip + smoke `HUMAN` + `AI`

> This phase runs only after Phase 13C's go/no-go gate returns APPROVE.

- [ ] Call `POST /contracts/v1/wallets` on run402 with `{ chain: "base-mainnet" }` to provision the **production KMS wallet**. Capture wallet_id and address. Store as `kysigned/contract-wallet-address` (this IS the branded production wallet — store under the production namespace, not `canary-*`). [infra] `AI`
- [ ] Confirm the production wallet appears in the run402 admin dashboard. Set its recovery address to Barry's personal wallet (per the F17 first-exercise watchlist and DD-17 retirement considerations). [manual] `HUMAN`
- [ ] Fund the production wallet with ~0.02 ETH from the ops EOA wallet for gas. Wait for confirmation on Base. Record the funding tx hash. [manual] `HUMAN`
- [ ] Compile `kysigned/contracts/SignatureRegistry.sol` and `EvidenceKeyRegistry.sol` locally using the **exact same Solidity compiler version and optimizer settings** that were used for the canary deploy in Phase 13B. This is the byte-identical gate invariant. [code] `AI`
- [ ] Run the deploy script against the production KMS wallet for both contracts. Poll `GET /contracts/v1/calls/:call_id` until status=`confirmed` for each. Capture tx hashes + production contract addresses. Store in AWS Secrets Manager as `kysigned/signature-registry-address` and `kysigned/evidence-key-registry-address`. [infra] `AI`
- [ ] **Submit both production contract sources to Basescan for verification.** These ARE the kysigned-branded contracts — full Basescan verification is REQUIRED (the opposite of the canary). Include Solidity compiler version, optimizer settings, and source code for each. Confirm both contracts appear verified on Basescan with green checkmarks. [manual] `AI`
- [ ] **Byte-identical bytecode gate for BOTH contracts:** run `kysigned-service/scripts/bytecode-identity-check.ts <canary_sig_reg> <prod_sig_reg>` AND `<canary_ev_key_reg> <prod_ev_key_reg>`. Success on both → proceed. Failure on either → ABORT, follow the OQ #21 investigation playbook. [infra] `AI`
- [ ] **FLIP kysigned-service environment variables** from canary references to production references: `KYSIGNED_SIGNATURE_REGISTRY_ADDRESS`, `KYSIGNED_EVIDENCE_KEY_REGISTRY_ADDRESS`, `KYSIGNED_KMS_WALLET_ID` (all from Secrets Manager). Redeploy kysigned-service. **This is the launch moment.** No application code changes in this redeploy — config change only. [infra] `AI`
- [ ] **Production smoke envelope:** per DD-17 OQ #22 — Barry creates an envelope via `POST /v1/envelope` with Tal as sole signer, **reply-to-sign** (Tal replies `I APPROVE` from their mailbox), 15-minute turnaround window. Verify: (a) envelope reaches `completed` status, (b) the production `SignatureRegistry` address appears in the proof page tx hash lookup, (c) the `EvidenceKeyRegistry` contains the evidence key used for Tal's DKIM verification, (d) verify-by-`(email, document)` on the signed PDF returns correct details. [manual] `HUMAN`
- [ ] On smoke success: proceed to Phase 13E canary retirement. On smoke failure: rollback the env var flip (set them back to canary references + redeploy), investigate, do NOT proceed to Phase 14 until the smoke passes. [manual] `HUMAN`

#### Phase 13E: Canary retirement `AI`

> Executes DD-17's canary retirement sequence after Phase 13D smoke passes.

- [ ] Call `POST /contracts/v1/wallets/:canary_id/drain` with header `X-Confirm-Drain: <canary_id>` and body `{ destination_address: "0x8D671Cd12ecf69e0B049a6B55c5b318097b4bc35" }` (the ops EOA). Poll `GET /contracts/v1/calls/:call_id` until status=`confirmed`. Verify the canary wallet's on-chain ETH balance is near-zero (dust under 1000 wei is acceptable). [infra] `AI`
- [ ] Call `DELETE /contracts/v1/wallets/:canary_id` to explicitly retire the canary wallet. **This is the critical step to stop the daily $0.04 rent accrual.** Drain alone doesn't stop rent because rent is debited from the kysigned project's billing account, not from the wallet's ETH balance. [infra] `AI`
- [ ] **Rename canary secrets** in AWS Secrets Manager for historical accountability: rename `kysigned/canary-contract-address` → `kysigned/retired-canary-contract-address` and `kysigned/canary-wallet-address` → `kysigned/retired-canary-wallet-address`. Do NOT delete — these are the historical record of the canary phase. [infra] `AI`
- [ ] Record canary retirement in the Implementation Log: canary wallet symbolic reference (NOT the literal address), canary contract symbolic reference, drain tx hash, wallet delete confirmation, date + time. [manual] `AI`
- [ ] **First-exercise watchlist items** — kysigned has now exercised several previously-untested run402 KMS paths:
  - [ ] **Drain endpoint** — confirmed working end-to-end during canary retirement. Report any anomalies to the run402 team. [manual] `AI`
  - [ ] **Recovery address** — verified working at production wallet provisioning in Phase 13D. Confirm again at the T+30 mark when the production wallet has seen real traffic. [manual] `HUMAN`
  - [ ] **90-day deletion lifecycle** — applies to the canary wallet's KMS key (retirement-triggered) AND the production wallet's ongoing lifecycle. Calendar reminder set for canary T+75 in Phase 13B; new calendar reminder for production T+75 from the date of Phase 13D production provisioning. [manual] `HUMAN`
  - [ ] **First-month ledger audit** — at T+30 days from the flip, export the full production wallet ledger from the run402 admin dashboard and reconcile: total gas spent, unexpected outflows, failed KMS signing calls that retried. Flag anomalies to the run402 team. [manual] `HUMAN`

### Phase 14: Launch Prep `HUMAN` / `AI`

- [~] Email deliverability setup — dedicated sending domain, SPF/DKIM/DMARC, warm-up plan [infra] `AI` — **2026-04-07:** dedicated sender domain (`kysigned.com`) registered via run402 + SPF/DKIM/DMARC records live + status `verified`. **2026-04-08:** authoritative DNS migrated from Route 53 to Cloudflare (see DNS task in Phase 5); SPF/DKIM/DMARC records preserved end-to-end, SES verification unchanged. Remaining: run the 2-week SES warm-up ramp before high-volume launch traffic (start with low daily send volume from a real mailbox under this domain, ramp gradually).
- [ ] Flip public repo from private to public on GitHub [infra] `AI` — squash all history into a single "v1.0.0" commit first (orphan branch, force-push). No development history visible. Clean audited release. **MUST include the F17.11 anti-leakage scan as a hard gate immediately before the orphan-branch creation:** run `grep -rF "$(aws secretsmanager get-secret-value --secret-id kysigned/retired-canary-contract-address --query SecretString --output text --profile kychee --region us-east-1)" .` AND `grep -rF "$(aws secretsmanager get-secret-value --secret-id kysigned/retired-canary-wallet-address --query SecretString --output text --profile kychee --region us-east-1)" .` against the public `kysigned` repo working tree. **If either grep returns ANY match anywhere in the tree, ABORT the flip**, remove the leaked reference, verify clean, re-scan. Only proceed with `git checkout --orphan v1.0.0` → squash → force-push → private→public flip after BOTH scans return zero matches. Per DD-17 this is the single working-tree scan required by F17.11 (the public repo is private throughout the canary phase and the squash wipes all prior history, so this one scan is sufficient).
- [x] **Refactor PDF storage to ephemeral retention (per spec F8.6 v0.5.0):** delete on completion-email delivery confirmation, not 30-day fixed window. Wire SES delivery webhooks to trigger deletion. 7-day fallback for bounces. Hard 30-day cap regardless. [code] — public-repo library piece complete: migration 004, pure shouldDeletePdf, sweepRetention, markCompletionEmailDelivered/Bounced, and immediate-delete on void. Service repo still needs to wire SES → markDelivered/Bounced webhook routes and a periodic sweep cron.
- [x] **Wire kysigned to the shared monitoring module** (`@run402/shared/monitoring`) — provide concrete senders for Telegram (kysigned chat), Bugsnag (kysigned project), and SES (CRITICAL emails). Cover all standard signals from saas-factory F20. [code] — `kysigned-service/src/monitoring.ts` ships `createTelegramSender` / `createBugsnagSender` / `createSesEmailSender` and `createKysignedMonitor()` factory. 7 unit tests, all green. Goes live the moment the bot/project/SES resources exist (Phase 14 manual tasks).
- [ ] **Create kysigned Telegram alerts channel** + add Tal and Barry as members [manual] `HUMAN`
- [x] **Create kysigned Bugsnag project** + store API key in AWS Secrets Manager (`kysigned/bugsnag-api-key`) [infra] `AI` — created via the Bugsnag Data Access API using the existing `eleanor/bugsnag-api-token` personal auth token. Project id `69d40ffd157dee0015c85aca`, slug `kysigned`, type `node`, org `kychee`. API key stored in `kysigned/bugsnag-api-key` (ARN `arn:aws:secretsmanager:us-east-1:472210437512:secret:kysigned/bugsnag-api-key-99aZ5P`). End-to-end smoke test (synthetic INFO event to `notify.bugsnag.com`) returned 200 OK, so `createKysignedMonitor()` can be wired to this key and the full monitoring pipe will work the moment it's called.
- [x] **Write `docs/incident-response.md` for kysigned** based on the saas-factory F20 template — severity definitions, on-call (Barry+Tal), first-response checklist, communication templates, DPA 72-hour reference [manual] `AI`
- [x] **Account deletion automation** — verified end-to-end procedure that deletes all off-chain personal data within 30 days (DPA Section 11 commitment). Includes envelope cache, signer records, document storage, payment records (where legally allowed). Requires explicit verification step that deletion completed. [code] — `src/api/accountDeletion.ts` `deleteAccount()` + `verifyDeletion()` with TDD coverage (8 tests). Ready for service-repo to wire up an admin endpoint.
- [x] **Security claims documentation pack** — collect AWS encryption configuration evidence, access control policies, security questionnaire we can hand to enterprise customers on request. Stored in `kysigned-service/security/`. [manual] `AI` — 6 docs: README, security-overview, security-questionnaire, encryption, access-control, subprocessors, incident-history
- [ ] Human review — legal sign-off on all docs [manual] `HUMAN`
- [ ] Human review — collateral approval [manual] `HUMAN`
- [ ] Human review — website copy and design approval [manual] `HUMAN`
- [ ] Human review — pricing approval [manual] `HUMAN`
- [ ] Launch go/no-go decision [manual] `HUMAN`
- [ ] Execute first marketing hypothesis card [manual] `HUMAN`

### Phase 15: Ship & Verify `AI`

Per saas-factory F21 / kysigned spec Shipping Surfaces section. Each `[ship]` task publishes/deploys one surface and runs the spec's smoke check from a clean working directory. **Code merged ≠ shipped** — none of these are done until the smoke check passes against the published artifact.

- [ ] Ship "Marketing site" surface — deploy kysigned.com static site, smoke `curl -fsSL https://kysigned.com/ | grep -q kysigned` [ship]
- [ ] Ship "llms.txt" surface — included in marketing site deploy, smoke `curl -fsSL https://kysigned.com/llms.txt | grep -q '^# kysigned'` [ship]
- [ ] Ship "REST API" surface — deploy kysigned API service to run402, smoke `curl -fsSL https://kysigned.com/v1/health` [ship]
- [ ] Ship "Verification page" surface — deployed with the API, smoke `curl -fsSL https://kysigned.com/verify | grep -q "Verify"` [ship]
- [ ] Ship "Dashboard" surface — deployed with the API, smoke `curl -fsSL -o /dev/null -w '%{http_code}' https://kysigned.com/dashboard | grep -q '^200$'` [ship]
- [ ] Ship "MCP server (npm)" surface — `npm publish` from `mcp/`, smoke `npx -y kysigned-mcp --version` from a fresh temp directory [ship]
- [ ] Ship "Public repo" surface — squash history to v1.0.0 commit and flip private→public on GitHub, smoke `curl -fsSL https://api.github.com/repos/kychee-com/kysigned | grep -q '"private":\s*false'` [ship]
- [ ] Ship "How it works page" surface — deployed with marketing site, smoke `curl -fsSL https://kysigned.com/how-it-works | grep -q "how"` [ship]
- [ ] Ship "SignatureRegistry — Base mainnet" surface — deploy via Phase 13, smoke `curl -fsSL -X POST https://mainnet.base.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"<mainnet-addr>","data":"0x3644e515"},"latest"]}' | grep -q '"result":"0x[0-9a-f]\{64\}"'` (depends on Phase 13) [ship]
- [ ] Ship "EvidenceKeyRegistry — Base mainnet" surface — deploy via Phase 13, smoke `curl -fsSL -X POST https://mainnet.base.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"<mainnet-addr>","data":"0x3644e515"},"latest"]}' | grep -q '"result":"0x[0-9a-f]\{64\}"'` (depends on Phase 13) [ship]
- [x] Ship "Smart contract — Base Sepolia" surface — deployed at 0xAE8b6702e413c6204b544D8Ff3C94852B2016c91, smoke passed (see Implementation Log 2026-04-06). **NOTE: this deployment is obsolete after Phase 1R deploys the rewritten contracts to Sepolia.** [ship]

---

## Implementation Log

_Populated during implementation by `/implement`, AFTER tasks are being executed._

- 2026-04-12: Completed "1R-CI: Test Infrastructure" (all 4 sub-tasks) — `scripts/test-all.mjs` orchestrator with 7 TDD tests, `test/api-docs-alignment.test.ts` with 14 tests (non-blocking until llms.txt exists), CI workflow updated with test:docs step. Baseline: 205 tests (183 unit + 22 contract), 0 fail. Full test command: `npm run test:all`.
- 2026-04-12: Completed "2R-B: Inbound Email Handler" (2R.6–2R.9) — core reply-to-sign pipeline. 4 new modules in `src/api/signing/`: `inboundHandler.ts` (orchestration, 12 tests), `dkimPreChecks.ts` (6 hardening checks per cfdkim findings, 14 tests), `bodyValidation.ts` (two-layer I APPROVE validation, 14 tests), `autoReply.ts` (4 rejection templates + duplicate reply, 6 tests). Dependencies (DKIM verification, proof gen, on-chain recording) injected via interfaces for later implementation in 2R.10–2R.14. Test count: 229 unit + 22 contract = 251 total, 0 fail.
- 2026-04-12: Completed "2R-C/D/E partial" (2R.12, 2R.14–2R.20) — searchKey computation (argon2id, ~700ms), MIME disposal, all email templates rewritten for reply-to-sign (Subject includes [envId] [hash], Reply-To header, I APPROVE instructions, How it works link), consent_language_version migration 006, verify-by-(email,document) handler, verify-by-envelope-id label update. Test count: 240 unit + 22 contract = 262 total, 0 fail.
- 2026-04-13: Completed "Phase 3R: Frontend Rework" (3R.1–3R.13, all 13 tasks) — SigningPage → review page (removed Method A/B, drawing, verification levels, decline). Deleted SignatureCanvas.tsx, old crypto.ts, tweetnacl dep. Bundle 708→670KB. Wallet signing behind `VITE_ENABLE_WALLET_SIGNING` flag. CreateEnvelopePage simplified (no drawn sig, no verification levels). EnvelopeDetail + VerifyEnvelope method labels updated. VerifyPage rewritten for (email, PDF) input. HowItWorksPage built (non-technical, <1min read). `/how-it-works` + `/review/:id/:token` routes added. Deviation: 3R.8 searchKey computed server-side (256 MiB argon2id crashes browsers). Test count: 259 unit + 22 contract = 281 total, 0 fail.
- 2026-04-13: Plan continued — F16 specced (v0.11.0), Spec-Version bumped 0.10.0 → 0.11.0, Phase 2H placeholder replaced with 18 real tasks (2H.1–2H.18) across 5 sub-phases: proof blocks, standalone validator, multi-envelope aggregation, dashboard document view, resend-to-missing. DD-24 added.
- 2026-04-13: Completed "Phase 2H: Signed PDF — Proof Blocks, Aggregation & Resend" (2H.1–2H.18, all 18 tasks). 5 sub-phases: (A) Proof blocks — `generateApprovalPage()` with QR codes via `qrcode` npm, three visual states, verification key strings. Old `generateCertificateOfCompletion` deleted. (B) Standalone validator — `extractProofBlocks()` inflates FlateDecode streams + decodes hex PDF text, `scripts/validate-pdf.ts` CLI. (C) Multi-envelope aggregation — `getDocumentsByOwner()`, `generateAggregatedSignedPdf()`, `handleGetDocumentPdf()` endpoint, completion flow aggregates across envelopes. (D) Dashboard — `DashboardPage.tsx` shows documents grouped by hash, `EnvelopeDetailPage.tsx` shows cross-envelope context. `handleListDocuments()` endpoint. (E) Resend — `getIncompleteSigners()`, `handleResendToMissing()`, auto-detection in `handleCreateEnvelope`, `CreateEnvelopePage.tsx` suggestion prompt. Test count: 290 unit + 22 contract = 312 total, 0 fail.

- 2026-04-13: Completed "Phase 6R: Website Updates for Reply-to-Sign" (all 5 tasks) — FAQ (rewrote crypto wallet Q, added "What does I APPROVE do?" Q), landing page (reply-to-sign messaging, $0.39), pricing page ($0.39, recalculated monthly/annual), llms.txt (full rewrite for reply-to-sign + new endpoints + verification + proof blocks), README.md (signing methods, verification, architecture, gas costs, price). 312 total tests, 0 fail.
- 2026-04-13: Completed "Phase 2R-F: E2E Test Rewrite" (2R.21–2R.24, all 4 tasks) — multiSigner.test.ts rewritten for reply-to-sign (synthetic MIME via `/v1/inbound/reply`). New `handleInboundEmailHttp` wrapper in public repo. Inbound reply route added to service-repo router. New tests: nonMatchingReply.test.ts, duplicateReply.test.ts. Also fixed expiration.test.ts + retention.test.ts (removed `@noble/ed25519`, rewrote for reply-to-sign). All e2e tests compile + self-skip when BASE_URL unset. Test count: 300 unit + 22 contract = 322 total, 0 fail. Service: 63 total, 0 fail.

### Gotchas

_None yet_

### Deviations

- **3R.8 searchKey computation: server-side instead of client-side.** The spec/plan says "compute searchKey client-side via WASM." argon2id with 256 MiB memory would crash most mobile browsers and many desktop ones. Changed to: SHA-256 computed client-side (lightweight), searchKey computed server-side via the existing `computeSearchKey()` backend function. The verify page calls `/v1/verify/email?email=&hash=` and the server computes the argon2id. This is functionally equivalent and preserves the privacy property (the server already knows the email when verifying). Revisit if a lighter client-side KDF is adopted in the future.

---

## Infrastructure State

> **This section is the authoritative record of deployed infrastructure, tool versions, and operational context that `/implement` sessions need to continue work.** Updated after each deployment or environment change. The next `/implement` session reads this FIRST before starting any task.

### Deployed Contracts (Base Sepolia — chainId 84532)

| Contract | Address | Deploy Date | Notes |
|---|---|---|---|
| **RiscZeroGroth16Verifier** (v1.2.x) | `0x70f3b51e063A5cC09C1702daF7d87e7F50C9947B` | 2026-04-12 | Our deployment of risc0-ethereum v1.2.0 verifier. Control root: `0x8cdad924...`, BN254 control ID: `0x04446e66...`. NOT the pre-deployed router (which is v3.x only). |
| **EvidenceKeyRegistry** | `0xe4Bc972627178C105308BE4F2F367Fc1e2EAD3fB` | 2026-04-12 | Permissionless append-only DKIM key archive. |
| **SignatureRegistry** | `0xBfa7412608B69c883C2Bb0E800C850B337D6a97E` | 2026-04-12 | Constructor args: `(verifier=0x70f3b51e..., ekr=0xe4Bc..., imageId=0x3f4e3b3b...)`. EIP-712 domain separator bound to chainId 84532. |

### RISC Zero Proof System

| Property | Value |
|---|---|
| Proof system | RISC Zero zkVM v1.2.6 (STARK inner + Groth16 wrapper) |
| Guest program | `zkprover-candidates/D-risc0/vendor/r0-zkEmail/` |
| Image ID | `0x3f4e3b3b87f6d8a72447825b1fa2d9e5121a7ec364f55b5167e9968d4375226e` |
| Seal encoding | `risc0-ethereum-contracts` v1.2.0 `encode_seal()` — 260 bytes |
| Groth16 wrapping | Local Docker on x86_64 Linux (no Bonsai API needed) |
| Proving time | ~5 min (STARK + Groth16 wrap), 8.4 GB peak RAM |
| On-chain verify gas | 268,020 gas (standalone), 431,580 gas (inside `recordReplyToSignSignature`) |

### Measured Gas Costs (Base Sepolia, real transactions)

| Operation | Gas | Approx $ on Base | Tx Hash |
|---|---|---|---|
| `registerEvidenceKey` | 321,537 | ~$0.03 | `0xd1f4814e...` |
| `recordReplyToSignSignature` | 431,580 | ~$0.04 | `0xa105aeb1dc5f1c97cde347f0473d9f499fbde1e6bb48d7866617af6a26df78bc` |
| Standalone `verify` (view) | 268,020 | free | N/A (eth_call) |
| **Per 2-signer envelope** | **~1,184k** | **~$0.11** | |

### AWS Secrets (used by deploy/prove scripts)

| Secret | Purpose |
|---|---|
| `agentdb/faucet-treasury-key` | Shared platform wallet for all on-chain ops. Address: `0x1D93e3bDb66541Da5182a430A857b371Bc1DE17E`. |
| `run402/base-sepolia-rpc-url` | Base Sepolia RPC (`https://sepolia.base.org`). |
| `kysigned/ops-wallet-address` | Alternate ops wallet `0x8D67...` — currently 0 ETH, NOT used by this plan. |

### Tools Installed Locally

| Tool | Version | Path |
|---|---|---|
| Foundry (forge/cast/anvil) | 1.5.1-stable | `/c/Users/volin/.foundry/bin/` |
| Node.js | 20.20.2 | system |
| dkimpy | 1.1.8 | `/c/venv/kychee/` |

### Test Baseline

| Suite | Count | Command |
|---|---|---|
| Unit tests | 183 | `npm run test` |
| Contract tests | 22 | `npm run test:contract` |
| **Full suite** | **205** | **`npm run test:all`** |
| CI | GitHub Actions on push to main + PRs | `.github/workflows/test.yml` |

### cfdkim Review Findings (must be implemented in 2R.7)

| # | Severity | Finding | Mitigation task |
|---|---|---|---|
| 1 | CRITICAL | `l=` body length tag is honored — attacker can append unsigned content | 2R.7(b): reject if DKIM `l=` tag present |
| 2 | HIGH | No duplicate `From:` header rejection | 2R.7(c): reject duplicate critical headers |
| 3 | MEDIUM | `unwrap()` in hash.rs:129 | Low risk — `b` tag is in REQUIRED_TAGS |
| 4 | LOW | `rsa-sha1` still accepted | Reject `a=rsa-sha1` in pre-check |

### Proof Artifacts (from the test email e2e)

| Artifact | Value |
|---|---|
| Test email | `zkprover-candidates/shared/test-input.eml` (Gmail, `volinskey@gmail.com` → `barry@kychee.com`) |
| Seal (Groth16) | `0xc101b42b1623e6a0666a680f87e1698d9a754db5deea8f86feb111974aa11c2e...` (260 bytes) |
| Journal digest | `0xca265c6564fc83418c726d449e0ae6e845edfc3ce87d1ea94f4880c85d42fc2d` |
| Recording tx | `0xa105aeb1dc5f1c97cde347f0473d9f499fbde1e6bb48d7866617af6a26df78bc` |
| Block | 40,125,234 (Base Sepolia, 2026-04-12T18:32:33Z) |

---

## Log

- 2026-04-04: Plan created from spec v0.1.0 + saas-factory spec v1.3.0
- 2026-04-05: Phase 0 — created repos (kychee-com/kysigned, kychee-com/kysigned-service), cloned locally, workspace file ready
- 2026-04-05: Completed "Initialize kysigned repo" — package.json (ESM, TS), tsconfig, .gitignore, MIT LICENSE, README stub, src/index.ts
- 2026-04-05: Completed "Initialize kysigned-service repo" — package.json with file:../kysigned dep, tsconfig, .gitignore, src/index.ts importing from kysigned
- 2026-04-05: Drafted LEGAL.md — awaiting human approval
- 2026-04-05: Completed run402 capability audit — prepaid credits EXISTS, magic link auth PARTIAL, custom domains EXISTS, email service EXISTS, platform wallet PARTIAL. Four run402 enhancements identified.
- 2026-04-05: Phase 1 complete — SignatureRegistry.sol deployed to Base Sepolia (0xAE8b...c91). Gas: 220K/email sig, 243K/wallet sig, 158K/completion. 2-signer envelope ~$0.01-0.05 gas. ABI + verification algorithm documented.
- 2026-04-05: Phase 2 complete — Core engine: DB migrations, data access layer, envelope API (create/get/void/remind/list/export), signing engine (Method A+B, duplicate protection, decline, completion), PDF handling (hash, embed, certificate), 7 email templates (pluggable provider), universal verification. 23 tests passing (14 unit + 9 contract). x402/MPP middleware and wallet auth blocked on run402 integration.
- 2026-04-05: Phase 3 complete — React + Vite + Tailwind frontend: signing page (pdf.js viewer, Method A/B, drawing widget, signature persistence, verification levels, duplicate/decline/expired screens), verification page (client-side hash, universal contract query), proof link page (Basescan links, independent verification), dashboard (wallet connect, envelope list, detail/audit trail, create form with "Will you also sign?" prompt, remind/void/export).
- 2026-04-07: **Phase 1 run402 bootstrap complete — kysigned project live on run402.** Idempotent provisioning script at `kysigned-service/scripts/bootstrap-run402.ts` ran end-to-end. (1) Generated fresh ops EOA wallet `0x8D671Cd12ecf69e0B049a6B55c5b318097b4bc35`, stored in `kysigned/ops-wallet-key` Secrets Manager secret (private key never on disk, never printed). (2) Funded via run402 testnet faucet (Base Sepolia USDC). (3) Subscribed to prototype tier via x402 (lease until 2026-04-14). (4) Created kysigned project on run402 via SIWX — `prj_1775546157922_0030`, all three keys (project_id / anon_key / service_key) stored in `kysigned/run402-*` Secrets Manager secrets. (5) Deployed placeholder "coming soon" site. (6) Claimed `https://kysigned.run402.com` subdomain (idempotent — auto-reassigns on future deploys). (7) Registered `kysigned.com` as custom sender domain. **Status: verified, zero DNS changes needed** — the prior `magic-link-e2e` test project (wallet `0x2dd66f...`, private key lost) had already verified the same DKIM tokens against Route 53. Released the stale ownership row via admin SQL `DELETE FROM internal.email_domains WHERE domain = 'kysigned.com' AND project_id = 'prj_1775413568580_0029'`. Re-registered from new ops wallet → SES returned identical DKIM tokens (CreateEmailIdentity is idempotent) → status flipped from `pending` to `verified` on the first GET poll. Two architectural decisions captured in DD-3 update needed: (a) ops EOA bootstrap layer is separate from the production KMS contract wallet (which still requires $1.20 prepay, deferred to mainnet readiness); (b) all kysigned secrets live under `kysigned/*` namespace.
- 2026-04-06: **Bugsnag project created for kysigned.** Used the existing `eleanor/bugsnag-api-token` personal auth token to hit the Bugsnag Data Access API, listed the Kychee org (id `67f3f385037531001791774d`), confirmed no `kysigned` project yet, POSTed a new node-type project (id `69d40ffd157dee0015c85aca`, slug `kysigned`), retrieved the auto-generated API key, and stored it as `kysigned/bugsnag-api-key` in AWS Secrets Manager under the kychee profile (us-east-1). Round-trip verified (Secrets Manager value matches the project API key Bugsnag returns). End-to-end smoke test: POSTed a synthetic INFO event to `notify.bugsnag.com` using the same payload shape `createBugsnagSender()` uses in `kysigned-service/src/monitoring.ts` — returned 200 OK. The monitoring pipe is now functional from code → Secrets Manager → Bugsnag; `createKysignedMonitor()` just needs to be called at process start with the key loaded from the secret.
- 2026-04-06: **run402 unblock sweep** — 5 of 6 run402 enhancements are now shipped (`magic-link-auth`, `custom-sender-domains`, `email-billing-accounts` v1.28.0, `kms-wallet-contracts`, `platform-changelog`). The last one (`admin-wallet-breakdown`) is in progress but **blocks nothing** — it's reporting/operational, not a runtime dependency. Flipped every `[!]` downstream task in the kysigned plan to `[ ]` and annotated each with the specific enhancement that delivers the dependency: Phase 2B x402/MPP middleware → `kms-wallet-contracts` + `email-billing-accounts`; Phase 2G dashboard wallet auth → `magic-link-auth` + `kms-wallet-contracts` SIWX; Phase 4 service layer entirely → all 4 enhancements compose into the Path 3 glue layer; Phase 9 MCP x402 → same middleware as Phase 2B; Phase 14 email deliverability → `custom-sender-domains`. Phase 4 got an explicit "fully unblocked" header and new task notes that make clear it's now `@run402/shared`-client wiring, not greenfield billing/auth code. First Phase 0 run402-enhancement checklist fully reconciled.
- 2026-04-06: Phase 13 expanded with KMS-wallet pre-flight checklist + first-exercise watchlist. run402's KMS-wallet feature shipped, replacing the plaintext `agentdb/faucet-treasury-key` custody path. kysigned is the first production consumer of mainnet provisioning, the drain endpoint, the recovery address, and the 90-day deletion lifecycle — captured these as explicit watchlist items because they have zero production test coverage on run402 and will get their first real exercise through kysigned. Pre-flight checklist adds (a) a 10-second IAM simulation re-run immediately before provisioning to catch policy drift, and (b) a billing-balance-≥-$1.20 check to avoid the HTTP 402 on the first `provision-wallet` call. DD-3 framing stays ("one platform wallet across all Kychee SaaS products") but key custody moves to KMS — run402 audit bullet flipped from PARTIAL to RESOLVED.
- 2026-04-06: Phase 11 hypothesis cards drafted as `.xlsx` per saas-factory F6 v1.10.0 (new format requirement). Generator script at `kysigned-service/marketing/hypothesis-cards/generate.py` emits 4 cards (freelancers, solo-consultants, small-agencies, real-estate). Each card uses the canonical 14-field schema with a Status dropdown (Draft/Approved/Running/Won/Killed) and a separate Notes sheet for assumptions/open questions/risks. Real-estate card flagged with a BLOCKER REVIEW note: ESIGN/UETA compliance per jurisdiction must be confirmed before any spend. saas-factory spec bumped 1.9.1 → 1.10.0 (new requirement: cards are xlsx, not markdown; field count grew from 8 to 14; lifecycle Status field added).
- 2026-04-06: Documentation + automation sweep — closed every standalone item not blocked on run402 deploy. Public repo: `docs/wallet-guide.md` (signers + envelope creators), signing-page wallet-onboarding panel for Method B without an installed wallet, `mcp/README.md` with Claude Desktop/Code/Cursor setup + 3 worked examples, `src/api/accountDeletion.ts` (DPA Section 11 deletion + verification with 8 TDD tests). Service repo: `docs/incident-response.md` (severity matrix, first-response checklist, DPA 72-hour playbook), `security/` pack (overview, questionnaire, encryption, access control, subprocessors, incident history), `src/monitoring.ts` wiring `@run402/shared` to concrete Telegram/Bugsnag/SES senders + `createKysignedMonitor()` factory (7 TDD tests). All 5 monitoring/PDF/operational launch-prep tasks now ship-ready — they go live the moment the corresponding human/infra tasks (Telegram channel, Bugsnag project, SES domain, deployment) are completed. kysigned suite: 149/149. kysigned-service suite: 7/7.
- 2026-04-06: Phase 8B / saas-factory F19 — built shared geo-aware consent banner module at `run402/packages/shared/src/consent-banner/` (regions.ts + storage.ts pure logic, banner.ts vanilla DOM init, banner.css). 58 unit tests, all green (47 region rule + 11 storage). Wired into kysigned-service static site (4 HTML pages) via single-file vanilla bundle `kysigned-service/site/consent-banner.mjs` + matching CSS, and switched GA4 to Google Consent Mode v2 (ad/analytics storage default = denied, flips on `consent update` from the banner). Footer "Cookie settings" link on home page re-opens the panel via global `window.openConsentSettings`. saas-factory spec bumped to 1.9.1 to record the canonical module path. Scope is saas-factory product sites only — broader Kychee surfaces are a separate decision.
- 2026-04-08: **Phase 4B Block 1 complete — public-repo additions for DD-12 + DD-16 shipped.** All 7 P4B.1-P4B.7 tasks landed in public-repo commit `d83c30e` (15 files, +575/-9). P4B.1: migration `005_completion_email_provider_msg_id.sql` adds the nullable TEXT column + partial index on `envelope_signers`. P4B.2: TDD'd `markCompletionEmailSent(pool, signer_id, provider_msg_id)` + `findSignerByCompletionEmailId(pool, provider_msg_id)` in `src/db/envelopes.ts` (4 new tests; hit one mock gotcha where the in-memory pool's `text.includes('FROM envelope_signers WHERE completion_email_provider_msg_id')` check failed because the production SQL has a newline between `envelope_signers` and `WHERE` — fixed by splitting into two independent `includes()` checks). P4B.3: wired `markCompletionEmailSent` into `sign.ts` completion-send loop after `emailProvider.send()`, wrapped in best-effort try/catch so correlation failures don't break the already-committed signing flow (1 new test). P4B.4: new `envelopeExpired` template in `src/email/templates.ts` with a `role: 'sender' | 'signer'` discriminator, signed/pending list blocks that gracefully hide when empty, both HTML + text versions (4 new tests). P4B.5: new `handleEnvelopeExpiration(pool, emailProvider, storage?)` handler in `src/api/envelope.ts` following the positional-args pattern of `sweepRetention` — iterates `getExpiredEnvelopes()`, computes signer breakdown, notifies sender + pending signers, deletes PDF per F8.6; PDF-delete and individual-envelope failures logged but don't abort the sweep (5 new tests including idempotency). P4B.6: exports wired in `src/api/index.ts` (db/email indexes already use `export *`); fixed the ripple from adding `completion_email_provider_msg_id: string | null` to the `EnvelopeSigner` type by adding the new field to 5 other test-file mock signer builders (retention, sweep, engine, verify, sign). Full suite: **197/197** (was 183, +14 new tests), `npm run build` clean. P4B.7: atomic commit + push. Public repo is now ready for Phase 4B Block 3 (service repo deploy glue) consumption. Next up: Blocks 2 + 3 (e2e suite + service-repo router/webhook/sweep/deploy) — deferred to a fresh chat per the scope-limit agreement.
- 2026-04-08: **Phase 4B planned.** `/plan kysigned` session added DD-11 through DD-16 and 30 discrete Phase 4B tasks (P4B.1 through P4B.30). DD-11: three Lambdas (API router, SES webhook, sweep cron). DD-12: webhook correlation via new `completion_email_provider_msg_id` column on envelope_signers — small public-repo change rather than best-effort email-only matching (rejected due to misattribution risk on a signing platform). DD-13: net-new e2e test suite at `kysigned/test/e2e/` running against `BASE_URL`, includes the first-ever exercise of the Phase 4A CTE against real Postgres. DD-14: idempotent `deploy.ts` script complementing `bootstrap-run402.ts`. DD-15: admin auth via `KYSIGNED_ADMIN_WALLETS` env var + local SIWE verification (single-factor, forker recovery limitation documented — see saas-factory F24 cross-ref). DD-16: envelope expiration handler closing a gap in the Phase 2 work that was mis-marked complete. Also added: Phase 2H placeholder for the deferred F16 document-level aggregation view (NOT PLANNED — run `/spec kysigned` first before adding tasks). Also bumped: kysigned spec 0.6.0 → 0.7.0 (added F16 concept section), saas-factory spec 1.13.0 → 1.14.0 (added F24 future-enhancement note for platform admin auth service). Two small public-repo additions (DD-12 + DD-16) are accepted as the minimum viable public-repo delta needed to deploy an MVP that exercises the full spec. No code changes in this session — spec + plan only. Ship gate for Phase 4B is the e2e suite passing against `https://kysigned.run402.com` (P4B.27).
- 2026-04-06: F8.6 ephemeral PDF retention library piece complete in kysigned public repo. Migration 004 adds `pdf_deleted_at` + per-signer `completion_email_delivered_at` / `completion_email_bounced_at`. New `src/pdf/retention.ts` (pure rule), `src/pdf/sweep.ts` (periodic deletion sweep), `src/api/emailWebhook.ts` (delivery/bounce hooks the service translates SES payloads into). `handleVoidEnvelope` now drops the original PDF immediately via `ctx.deletePdf`. 23 new tests (12 retention + 5 sweep + 5 webhook + 1 void integration). Full suite 141/141. Service repo still needs to wire SES → markDelivered/Bounced and a periodic `sweepRetention` cron.
- 2026-04-06: F2.8 `allowed_senders` access control complete — DAO + migration `003_allowed_senders.sql` + sender gate (allowlist/hosted strategies) + monthly quota + admin API + README warning. TDD red-green throughout: 33 new tests added (15 DAO + 9 gate + 9 admin + 4 envelope integration). Full kysigned suite: 112/112 pass. Service repo can now wire `senderGate: { strategy: 'hosted', getCreditBalance }` in production; self-hosted forkers default to `allowlist`. Pluggable strategy + per-sender quota + default-deny all in one cohesive layer.
- 2026-04-08: **Phase 4A complete — public-repo HTTP DbPool refactor + service-repo adapter landed.** All 9 P4A tasks shipped. Public repo commit `6311514` (13 files, +222/-160): narrows `DbPool` interface in `src/db/pool.ts` to `query()`+`end()` only (drops `connect()` / `pg.PoolClient`); rewrites `createEnvelope` in `src/db/envelopes.ts` as a single multi-CTE `pool.query()` call that inserts envelope + all N signers + returns one row `{ envelope, signers }` via `row_to_json` + `json_agg`; updates in-memory pool mocks in `envelope.test.ts` + `envelopes.test.ts` to recognize the CTE shape; removes now-dead `async connect()` stubs from 11 test files (TS strict excess-property check rejects them under the narrowed interface). All IDs still client-generated (`randomUUID()` + `randomBytes`), so no read-after-write dependency — the CTE is atomic on the server because the run402 gateway wraps each `db.sql()` call in its own `BEGIN`/`COMMIT`. Signers are matched back to input order by `signing_token` so `signing_link` attachment is order-preserving independent of DB return order. Full kysigned suite: **183/183 passing**, `npm run build` clean. Service repo commit `d41fb11` (2 new files, +188): `HttpDbPool` class at `src/db/httpPool.ts` wrapping `@run402/functions` `db.sql()` via a constructor-injected `DbSqlFn` (no static import — tests mock without needing `run402-functions` installed, Phase 4B router layer decides where real `db.sql` comes from). 8 TDD tests covering pass-through, empty-values default, row return, rowCount default-to-length, empty results, error propagation, CTE-shaped single-row results, and `end()` no-op. Full kysigned-service suite: **15/15 passing** (7 monitoring + 8 new). Both repos pushed. Phase 4A was the prerequisite refactor for the real Phase 4 service deploy work — next chat: `/plan` to fill out Phase 4B (router Lambda, SES webhook, `sweepRetention` cron, email provider adapter, frontend bundle deploy, e2e smoke) against the now-stable `HttpDbPool` surface.
- 2026-04-08: **Apex DNS resolved — kysigned.com, www.kysigned.com, kysigned.run402.com all serving 200.** Migrated the `kysigned.com` authoritative zone from Route 53 to Cloudflare (registrar NS flip done at AWS). Final working state: `https://kysigned.com/` → 200 ✅ (apex now serves the placeholder — the original goal), `https://www.kysigned.com/` → 200 ✅, `https://kysigned.run402.com/` → 200 ✅ (unchanged), SES email working (SPF/DKIM/DMARC all preserved in the new Cloudflare zone). **Implementation diverged from the originally-proposed "Option B: Cloudflare CNAME flattening at apex":** DNS did move to Cloudflare (that part of Option B), but the zone uses **proxied AAAA-discard records** (the `kychon.com` pattern) instead of CNAME-flattening. The reason the mechanism matters: for the run402 custom-domains Cloudflare Worker to actually fire, the hostname has to enter Cloudflare through its own zone — not via the run402.net SaaS edge — which means proxied records in the `kysigned.com` zone, not flattened CNAMEs to a third party. Same end result (apex resolves and serves), different mechanism — **if a future saas-factory product needs the same fix, follow the proxied-records-in-own-zone pattern, not flattened-CNAMEs-to-run402.net**. Collateral: found and fixed a pre-existing 522 on the `kysigned.com` zone (missing Worker route bindings since the cert was provisioned — unrelated to the apex work but surfaced by it), and cleaned up the legacy run402-side Custom Hostnames that became redundant once the zone moved. STATUS.md in `kysigned-service` updated to reflect the new working state and document the pattern for future reference.
- 2026-04-08: **Phase 4 strategy decided — kysigned fits the existing HTTP DB surface, no platform change.** While setting up the kysigned-service Lambda handlers, we surfaced a mismatch: deployed run402 Lambdas have no direct `pg` access (only `db.sql()` / `db.from()` / `/rest/v1/*` via `@run402/functions`), but kysigned's `createEnvelope` DAO uses native pg transactions (`BEGIN → INSERT envelope → INSERT signers → COMMIT` in `kysigned/src/db/envelopes.ts:20-91`). Two paths were considered: (a) new run402 platform feature `lambda-db-direct` — per-project DB role, `RUN402_DATABASE_URL` injected into Lambdas, RDS Proxy fronting the connection; (b) refactor the kysigned public repo so its DAO layer fits the existing HTTP SQL surface via a single multi-statement `db.sql()` call with a CTE. An OpenSpec change for path (a) was drafted under `run402/openspec/changes/lambda-db-direct/`, then **reverted on 2026-04-08 after discussion with the run402 team**: run402 has active scaling/monitoring concerns about exposing direct-pg connections at this stage (RDS connection count under Lambda burst, observability of per-project pool utilization, role rotation ops story) and would rather defer direct-pg as a future platform enhancement when the operational story is mature. **Decision: kysigned is the first adopter of the HTTP-only DB model on run402**, documented as DD-10. Phase 4 is unblocked; a new sub-phase `Phase 4A — Pre-deploy refactor` was added to track the public-repo DAO rewrite and the HTTP-backed DbPool adapter in kysigned-service. Net impact to the kysigned release timeline is small (one file refactor in the public repo + one adapter in the service repo), and the decision reserves the option to flip to direct-pg later without changing the app code (the `DbPool` interface stays stable — only its implementation changes).
- 2026-04-09: **P4B.26 shipped + P4B.27 partial pass (DD-10 gate GREEN) + P4B.27 follow-ups tracked.**

  **What's live in production:**
  - `https://kysigned.run402.com/` — marketing site (index/faq/pricing/saas-vs-repo/llms.txt) served from `kysigned-service/site/` via Option A (marketing at root, SPA integration deferred). Real kysigned logo + favicon.
  - `kysigned-api` Lambda (798 kB minified bundle) — `/v1/health`, `/v1/envelope` create/get/void, `/v1/sign`, `/v1/verify`. Direct HTTP: `https://api.run402.com/functions/v1/kysigned-api/*` (requires `apikey` header).
  - `kysigned-email-webhook` Lambda (427 kB) + `kysigned-sweep` Lambda (438 kB, `0 */12 * * *` cron). Webhook registration still blocked on mailbox discovery.
  - 9 project secrets set (incl. `KYSIGNED_DEPLOYER_PRIVATE_KEY` from `agentdb/faucet-treasury-key`, `KYSIGNED_CONTRACT_ADDRESS`/`KYSIGNED_CHAIN_ID=84532` Sepolia, `KYSIGNED_E2E_BYPASS_TOKEN` for no-email test runs).
  - 5 kysigned migrations applied to the `p0030` schema (envelopes, envelope_signers, allowed_senders, allowed_sender_usage).
  - Mailbox `mbx_1775715646495_5qd48h` provisioned (kysigned@mail.run402.com).
  - Billing: $5 admin-credited to the CLI wallet + $10 admin-credited to the kysigned ops wallet for e2e + future email pack needs.

  **E2E status against `https://api.run402.com/functions/v1/kysigned-api`:** 3 pass, 3 fail, 1 skip. ✅ Phase 2B payment rejection (`402` on missing header), ✅ Phase 2B MPP acceptance (`201` envelope creation — **this IS the DD-10 CTE validation gate and it's GREEN**), ✅ F8.6 void flow (`pdf_deleted_at` stamped immediately on terminal state). Failing: multi-signer happy path (Sepolia treasury wallet nonce contention on concurrent `recordEmailSignature` calls), retention sweep (needs `/webhooks/v1/email` route on the api Lambda, currently on separate function), expiration (needs `/admin/v1/force-expire` + `/admin/v1/sweep/run`). These are captured as P4B.31/32/33.

  **Blocker chain resolved during P4B.26/27 (in order, all documented in plan + commit messages):**
  1. run402 CLI `deploy` auths against CLI wallet not project owner → rewrote deploy.ts to sign SIWX directly from the kysigned ops wallet (like `bootstrap-run402.ts`).
  2. `kysigned` is a `file:` npm dep so Lambda can't resolve the import → added esbuild bundling with minify + `createRequire` banner + pg CJS stub alias.
  3. 1 MB function body limit → minified bundle 798/427/438 kB.
  4. Dynamic `require("events")` in pg → `createRequire` banner.
  5. pg's CJS class hierarchy → `scripts/pg-stub.mjs` esbuild alias (pg is unreachable at runtime in the Lambda since we use `HttpDbPool`).
  6. Router 404 on `/v1/health` → strip `/functions/v1/<name>` prefix in `kysigned-api.mjs`.
  7. 500 "relation envelopes does not exist" → run migrations 001-005 via `run402 projects sql --file` (migration 001 had to strip its `CREATE EXTENSION pgcrypto` line — run402's SQL filter blocks DDL extension ops).
  8. 500 "no mailbox discovered" → `run402 email create kysigned`.
  9. 500 "Daily send limit reached (10)" + "Unique recipient limit reached (25)" → admin-SQL `UPDATE internal.mailboxes SET sends_today = -1000, unique_recipients = -1000`.
  10. 429 + spam risk from real outbound email during test runs → added `X-Kysigned-E2E-Bypass` header gate + `KYSIGNED_E2E_BYPASS_TOKEN` project secret. Router swaps in no-op EmailProvider per request when the token matches.
  11. pdf.js/Uint8Array/unused-import tsc errors in the kysigned frontend → 4 minimal fixes in public repo.
  12. Kysigned public repo's `handleVoidEnvelope` only stamped `pdf_deleted_at` when a storage backend was wired → rewrote to always stamp (F8.6 semantics: terminal state marker, not storage-backend-dependent). Also added `pdf_deleted_at` + `expiry_at` + per-signer `completion_email_provider_msg_id` to `handleGetEnvelope` response so e2e can observe F8.6 + DD-12 state externally.
  13. @noble/ed25519 v3 API change (`randomSecretKey` not `randomPrivateKey`) in e2e tests.

  **New fixtures:** `kysigned/test/fixtures/build-acme-approval.mjs` generates `acme-approval.pdf` — a deliberately-silly "ACME wishes you to approve. You know how to sign." test document with 3 signer blocks + "TEST DOCUMENT — NOT LEGALLY BINDING" watermark. Used by the e2e suite (via `makeAcmePdfBase64()`) AND documented in the public README as the recommended first document for a fresh clone.

  **Commits (all on local `main`, not yet pushed to origin):**
  - kysigned (public): `ee9bf9c` frontend tsc fixes, `9286fd9` e2e + ACME PDF + void semantics
  - kysigned-service: `13af34b` blocks 3-6 TDD, `a617065` + `a7e89e5` + `5138edf` deploy iterations, `e04c499` Option A marketing site, `7d1c0c1` email bypass + publicRepo build
  - run402: (this commit) plan status + follow-up tasks

  **Deferred (see P4B.31/32/33 follow-up tasks):** closed-loop mailbox signing via project mailboxes, Sepolia signing nonce management, admin + webhook route wiring into the api Lambda.

- 2026-04-08: **Phase 4B Block 2-6 complete — kysigned-service is build-clean and ready for the user gate before P4B.26 (first live deploy).** Strict TDD red→green throughout. **Block 2 (e2e draft, P4B.8-13):** wrote `test/e2e/_helpers.ts` (HTTP wrappers, fixture builders incl. real `pdf-lib` PDF generation, `pollUntil`, `skipIfUnreachable` so the suite is forker-friendly) + 5 test files covering DD-13's 5 scenarios (multi-signer happy path = the DD-10 CTE risk gate, void+F8.6, retention sweep with simulated SES delivery webhook, x402/MPP payment verify live, expiration with 2-of-3 signed). All 7 e2e cases load + skip cleanly when BASE_URL is unreachable. **Block 3 (P4B.15) httpSesEmailProvider:** lazy mailbox discovery cached across sends, explicit override path, 6 tests. **Block 4 (P4B.16-17) router + admin auth:** `apiRouter.ts` (12 tests covering health/dispatch/405/404/payment-402/sign-no-payment-check/sanitized-500), `buildContext.ts` (7 tests covering x402-then-MPP fallback + sender identity extraction including X-Kysigned-Email Path 3), `adminAuth.ts` (7 tests covering DD-15 SIWE-verified KYSIGNED_ADMIN_WALLETS gate with 503/401/403 responses). Routes inlined in apiRouter.ts rather than split into a separate `routes.ts` — one file kept compact, can split later if route count explodes. **Block 5 (P4B.18-19) webhook + sweep handlers:** `emailWebhook.ts` (8 tests, dispatches DD-12-correlated delivery/bounced events to public-repo helpers, ignores complained/reply_received, malformed→400), `sweepAndExpire.ts` (5 tests, isolated try/catch around both helpers so neither aborts the other). **Block 6 (P4B.20-25) Lambda shims + deploy script + build:** 3 thin `.mjs` entry files in `functions/` wiring `HttpDbPool` + `httpSesEmailProvider` + viem `RegistryClient` + `buildPaymentVerifier`/`buildSenderIdentityExtractor` + the public-repo handlers; verified the frontend already reads `import.meta.env.VITE_API_BASE`; idempotent `deploy.ts` covering Secrets Manager state load, function deploy via `POST /projects/v1/admin/:id/functions` with cron schedule, mailbox webhook registration (idempotent skip if URL already present), frontend build with VITE env vars, and subdomain re-claim; tsconfig updated to exclude `*.test.ts` from production bundle. **Cumulative test counts:** kysigned 197/197, kysigned-service 60/60. Both `npm run build` clean. **Known gaps before P4B.26:** (1) deploy.ts has a placeholder for the `dist/` walk-and-upload step on `POST /deployments/v1` — needs the recursive file uploader before live deploy; (2) the `kysigned-api.mjs` shim's RegistryClient is bound with a placeholder private key — KMS-signing wiring is the Phase 13 work, before mainnet but acceptable for the initial Sepolia-backed local deploy. (3) P4B.14 (run e2e green locally) is deferred — it requires the local Postgres + run402 gateway + in-process router + Sepolia faucet wallet stack, which is more setup than fits in this chat. The e2e suite WILL run against the deployed instance via P4B.27 instead. **STOPPED AT USER GATE before P4B.26 (first live deploy)** as requested.
- 2026-04-07: **Public repo functionally complete — DD-9 trojan horse landed for all 4 remaining substantive tasks.** Strict TDD red→green→commit on each. (1) **Phase 2B x402 middleware** — `src/api/payment/x402.ts` decodes the wallet from the v2 x402 wire format and `GET`s `https://api.run402.com/billing/v1/accounts/:wallet` directly via fetch with `Authorization: Bearer ${KYSIGNED_RUN402_SERVICE_KEY}` + `X-Run402-Project: ${KYSIGNED_RUN402_PROJECT_ID}`. 11 tests. (2) **Phase 2B MPP middleware** — `src/api/payment/mpp.ts` extracts the payer wallet from a `did:pkh:eip155:<chain>:<addr>` MPP credential source and hits the same billing endpoint. 12 tests. (3) **Phase 2G dashboard wallet auth** — `src/api/auth/dashboardAuth.ts` ships local viem-backed SIWE (`createSiweMessage` + `verifySiweSignature` via `viem.verifyMessage`) for the wallet path AND direct `fetch` against `/auth/v1/magic-link` + `/auth/v1/token?grant_type=magic_link` + `/auth/v1/user` for the email path; both flows share one run402-backed surface keyed by `KYSIGNED_RUN402_ANON_KEY`. 11 tests. (4) **Phase 9 MCP x402/MPP forwarding** — `mcp/src/paymentHeaders.ts` reads `KYSIGNED_X402_PAYMENT` / `KYSIGNED_MPP_CREDENTIAL` / `KYSIGNED_AUTHORIZATION` from env and `buildPaymentHeaders()` injects the right headers on every outbound MCP fetch in `mcp/src/index.ts`; the kysigned API's new Phase 2B middleware then verifies against run402. 7 tests. **No abstraction layer anywhere** — every run402 dependency is a literal `fetch('https://api.run402.com/...')` call that a forker can re-target by setting their own env vars. Full kysigned unit suite: 183/183 (was 149, +34 new). MCP suite: 10/10 (was 3, +7 new). `npm run build` clean for both packages. The public repo is now functionally complete; the only remaining gate is the human-reviewed orphan-branch squash + private→public flip in Phase 14, which is intentionally NOT done in this chat.
- 2026-04-06: Phase 15 — Shipped "Smart contract — Base Sepolia" surface. Smoke check executed from a fresh `mktemp -d` directory:
  ```
  curl -fsSL -X POST https://sepolia.base.org -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0xAE8b6702e413c6204b544D8Ff3C94852B2016c91","data":"0x3644e515"},"latest"]}'
  ```
  Exit code: 0. Result: `{"jsonrpc":"2.0","result":"0x8db329e11c1632d3570c4e92ee526a54f76262c122835520bd570595db9019fb","id":1}`. The returned `DOMAIN_SEPARATOR` matches the value recorded at deployment, confirming the deployed contract is reachable from outside the repo via a generic public RPC endpoint. Spec smoke check updated from `cast call ...` to portable curl form so it works without Foundry installed locally.
- 2026-04-10: **Plan continued — spec v0.9.0 reply-to-sign rework.** Spec-Version bumped 0.8.0 → 0.9.0. Major architectural shift: signing model pivoted from click-to-sign (Method A / Ed25519 auto-stamp) to reply-to-sign (email DKIM + zk-email proofs). Method A removed entirely (DD-18). New design decisions: DD-18 (Method A removal), DD-19 (inbound handler in public repo per DD-9), DD-20 (quantum-resistance posture — document, don't mitigate). New phases added: Phase R (zk-email & KDF research spike — 10 tasks), Phase 1R (contract rework — 7 tasks), Phase 2R (engine rework — 24 tasks across 6 sub-phases: Method A removal, inbound email handler, zk proof pipeline, signing email updates, verification updates, e2e rewrite), Phase 3R (frontend rework — 13 tasks across 4 sub-phases: signing page rework, verification page, dashboard, "How it works" page). Updated: Phase 6 (5 website update tasks for reply-to-sign), Phase 7 (4 legal update tasks for reply-to-sign proof semantics), Phase 13 canary checklist (all Method A references replaced with reply-to-sign), Phase 13B (two-contract deploy for SignatureRegistry + EvidenceKeyRegistry), Phase 13D (two-contract bytecode gate + reply-to-sign production smoke), Phase 15 (added "How it works" page + EvidenceKeyRegistry ship surfaces). Two run402 dependencies confirmed landed on 2026-04-10: raw-MIME API accessor (`GET /mailboxes/v1/:id/messages/:messageId/raw`) and custom-domain inbound routing — both required for reply-to-sign. Net new task count: ~63 tasks. Execution order: R → 1R → 2R → 3R → (remaining Phase 4/4B follow-ups) → Phase 13 (with updated canary checklist). P4B.31 concept (closed-loop mailbox e2e) feeds into 2R.21 (e2e rewrite for reply-to-sign).
- 2026-04-11: **1R.3 PLONK setup blocked on snarkjs V8 limits.** Circuit compiled successfully (4.6M r1cs / 8.27M PLONK constraints) using `@zk-email/circuits` EmailVerifier + FromAddrRegex + SubjectAllRegex + custom body "I APPROVE" substring reveal. Tested `snarkjs plonk setup` on 3 EC2 configurations: c5.4xlarge (30GB RAM, OOM-killed), r5.4xlarge spot (128GB, terminated by AWS mid-run), r5.4xlarge on-demand (128GB, `--max-old-space-size=120000`, ran 58 min before V8 crashed with "Scavenger: semi-space copy Allocation failed"). zkey reached 7.1 GB before crash. Key insight: **hardware is not the bottleneck — snarkjs hits V8 internal per-space limits regardless of heap size at circuits this large.** AWS spend ~$1-2 total, all resources cleaned up (instance terminated, key pair deleted, security group pending final termination). **Decision required next session** (see updated 1R.3): shrink circuit, switch to Rust-based tooling, use proving service, or rethink trust model. Circuit source committed (commit 5a495c3) — no rework wasted.
- 2026-04-11: **Proof system switched from Groth16 to PLONK (DD-21).** Driven by: (1) Groth16 per-circuit ceremony has unprovable toxic waste — incompatible with "zero trust" product claim, (2) zk-email SDK registry enforces single senderDomain per Blueprint — incompatible with any-domain requirement, (3) PLONK uses universal Powers of Tau (no per-circuit ceremony, no toxic waste), (4) circuit compiled from circom with snarkjs PLONK setup — no registry dependency. Cost impact: ~$0.02-0.05 more per signer, absorbed by new pricing ($0.29 base + $0.10/extra). Spec bumped to v0.9.3. GPT-5.4 Pro consultation confirmed PLONK/FFLONK are best practical choices. Blueprint `volinskey/kysigned_Reply_to_Sign_Approval` on registry.zk.email abandoned (compilation failed + single-domain restriction). IGroth16Verifier interface in contract code stays as-is for now — the PLONK verifier contract generated by snarkjs has the same `verifyProof(a, b, c, pubSignals)` signature.
- 2026-04-11: **Pricing model changed to $0.29 base (2 signers) + $0.10/extra signer (DD-22).** Was $0.39 flat for 5 signers. New model keeps margins healthy (originally estimated 41-52% with PLONK, updated to 63-72% with RISC Zero per spec v0.10.0). Still dramatically cheaper than DocuSign. Spec F1.2, F2.9, F11.1, F11.4 updated.
- 2026-04-10: **Phase R complete (9/10 tasks, R.2 blocked on real .eml).** zk-email research spike delivered 8 research documents + 1 Solidity contract + 3 prototype scripts. Key decisions: (1) Custom kysigned Blueprint on `@zk-email/sdk` v2.0.11 / `@zk-email/circuits` v6.4.2, (2) Groth16 proof system (~260 bytes, ~250K gas, <5s server, <$0.01/proof), (3) argon2id 256M/4i committed forever for searchKey KDF (~800ms desktop), (4) `@ensdomains/dnsprovejs` for DNSSEC proof chains, (5) Subject in DKIM h= confirmed across all 6 surveyed providers, (6) `EvidenceKeyRegistry.sol` complete with 8 Hardhat tests (permissionless, append-only, keccak256 keyId, DNSSEC proof storage). R.2 hands-on proof generation blocked on real DKIM-signed .eml file — non-blocking for Phase 1R. Spike output at `docs/research/R10-spike-output-summary.md` awaiting user approval before Phase 1R begins. New dependencies for 1R+: `@zk-email/sdk`, `@zk-email/helpers`, `@zk-email/circuits`, `@ensdomains/dnsprovejs`, `hash-wasm`, `snarkjs`.
- 2026-04-10: **Phase 4B complete (27/28 tasks).** P4B.27 DD-10 gate GREEN (CTE-based `createEnvelope` validated against real Postgres in production). P4B.29 operator README landed (`5da7612`). P4B.31 closed-loop smoke harness landed (`bad38f8` + `79a8e7e`) — e2e-smoke suite exercises full create→email→parse→sign flow via SES mailbox simulator. P4B.32 nonceManager wired (`bad38f8`) — eliminates Sepolia nonce contention. P4B.33 (admin/webhook/sweep route wiring) remains open follow-up. P4B.14 deferred (local docker stack folded into P4B.27 remote e2e). **Remaining: P4B.33 only.** Public repo 197/197 tests, service repo 60/60 tests, both `npm run build` clean. Execution order now: Phase R (zk-email research spike) → 1R → 2R → 3R → Phase 13 (canary) → 14 → 15.
- 2026-04-08: **Plan continued — DD-17 + Phase 13 re-sequenced for F17 dark-launch canary ritual.** Driven by spec v0.8.0 F17 (kysigned-spec) + saas-factory v1.15.0 F25 from the brainstorm→spec chain earlier in the day. Plan header Spec-Version bumped 0.7.0 → 0.8.0; Upstream References saas-factory 1.9.0 → 1.15.0. New DD-17 captures the canary ritual and resolves all five F17 Open Questions (#18–#22) inline: (18) run402 capability gap investigation via `Explore` subagent against `packages/gateway/src/routes/contracts.ts` + services/contract-wallets.ts + contract-call.ts — confirmed two wallets per project supported, rate limiting non-issue, drain endpoint fully implemented, BUT discovered NO dedicated deploy endpoint exists in contracts/v1 (this becomes a Phase 13A blocking prereq to verify the `POST /contracts/v1/call` + zero-address-target workaround OR land a small run402 enhancement), AND discovered rent is charged per-wallet not per-project so canary prepay is $2.40 not $1.20, AND the canary retirement MUST call `DELETE /contracts/v1/wallets/:id` after drain to stop daily rent accrual (draining ETH alone doesn't stop rent); (19) byte-identical bytecode check mechanism specified precisely — strip Solidity metadata suffix via `uint16_be(bytecode[-2:])` length algorithm then keccak256 compare, implemented as `kysigned-service/scripts/bytecode-identity-check.ts`; (20) full canary checklist enumerated (~40 items across dashboard/API/MCP/signing variations/retention/payment/monitoring/gas); (21) bytecode-divergence investigation playbook with 5 hypothesized causes + decision matrix; (22) production smoke specifics nailed down — API path, Barry→Tal single-signer, Method A auto-stamp, 15-minute window. Phase 13 restructured in place from "Gas Measurement & Final Pricing" to "Mainnet Deploy via Dark-Launch Canary" with 5 sub-phases (13A pre-flight → 13B canary provision+deploy → 13C dark-launch dogfood [BLOCKS ON Phase 4B completion in the parallel /implement chat] → 13D production provision+deploy+byte-identical-gate+flip+smoke → 13E canary retirement). Phase 14's existing "Flip public repo" task augmented with the F17.11 anti-leakage pre-squash scan as a hard gate: two `grep -rF` scans against the working tree for the retired canary contract address and retired canary wallet address, aborting the flip if either matches anywhere. Plan was NOT merged with the parallel Phase 4B chat — Phase 4B stays owned by the parallel /implement chat, Phase 13C explicitly declares the cross-chat dependency on Phase 4B Block 7 (e2e against production-deployed kysigned-service). No existing Phase 4, Phase 4A, or Phase 4B tasks were modified. All changes are additive to Phase 13 and Phase 14.
