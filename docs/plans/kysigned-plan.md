# Plan: kysigned

**Owner:** Barry Volinskey
**Created:** 2026-04-04
**Status:** Ready for Implementation
**Spec:** docs/products/kysigned/kysigned-spec.md
**Spec-Version:** 0.7.0
**Upstream References:** docs/products/saas-factory/saas-factory-spec.md (v1.9.0)
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

---

## Tasks

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

### Phase 1: Smart Contract `AI`

- [x] Write SignatureRegistry.sol with EIP-712 domain separator (Base chainId 8453) [code]
- [x] Write contract unit tests (Hardhat/Foundry) — 9 tests passing [code]
- [x] Deploy to Base Sepolia testnet [infra] — address: 0xAE8b6702e413c6204b544D8Ff3C94852B2016c91
- [x] Measure gas costs per operation (recordEmailSignature: 220K, recordWalletSignature: 243K, recordCompletion: 158K gas units. 2-signer envelope ~$0.01-0.05 at typical Base gas prices. $0.25/envelope pricing has strong margin.) [infra]
- [x] Document contract ABI and publish verification algorithm [code]

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

#### 2H. Document-Level Aggregation View — NOT PLANNED (deferred to future spec)

> ⚠️ **NOT PLANNED — run `/spec kysigned` first before adding tasks here.**
>
> This placeholder exists to reserve a Phase 2 slot for the document-level aggregation feature captured in `kysigned-spec.md` F16 (added 2026-04-08, concept-only, AC=TBD). The feature introduces a new conceptual layer above envelopes: a **document** identified by `(document_hash, creator_identity)` that aggregates all envelopes a creator has sent against the same PDF. Surfaces the "failed-envelope → resend to missing signers only" flow as a first-class history view on both the sender dashboard and the verify page. See spec F16 for the concept summary and open questions.
>
> **Before implementation:** run `/spec kysigned` to fully detail F16 (acceptance criteria, data model decisions, UI routes, email templates, billing interaction) — likely bumps the spec to 0.8.0. Then re-run `/plan kysigned` to replace this placeholder with the actual implementation tasks under Phase 2H.
>
> **Why deferred:** scope needs brainstorm + spec; orthogonal to Phase 4B service deploy; you can ship current kysigned (single-envelope model) to run402 without this feature, and the aggregation layer slots in later without breaking the existing data model.

- [ ] **2H.0** Run `/spec kysigned` to detail F16, then re-run `/plan kysigned` to populate this sub-phase with real tasks. Do NOT implement any aggregation code until the spec session is complete and AC exist. `DECIDE` / `AI`

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

### Phase 4: Service Layer — Service Repo `[service]` `AI`

> **Unblocked — but pre-deploy public-repo refactor required (see DD-10).** Phase 4 is the glue layer that composes run402's primitives into the kysigned hosted product. During the 2026-04-08 deploy attempt we hit a platform/app mismatch: kysigned's `createEnvelope` uses native `pg` transactions (`BEGIN → INSERT envelope → INSERT signers → COMMIT`), but deployed run402 Lambdas only have the HTTP-based DB surfaces `db.sql()` / `db.from()` / `/rest/v1/*` — no direct `pg` connection. Two paths were considered: (a) add a platform feature (`lambda-db-direct`) that injects `RUN402_DATABASE_URL` into Lambdas with RDS Proxy; (b) refactor the kysigned public repo so it fits the existing HTTP DB surface. **After discussion with the run402 team on 2026-04-08, path (b) was chosen** — run402 has scaling/monitoring concerns about exposing direct-pg connections at this stage and would rather let kysigned be the first adopter of the HTTP-only model, adding direct-pg as a future platform enhancement when the operational story is mature. See DD-10 for the full rationale. The pre-deploy refactor + service-layer build are now tracked as discrete tasks (`### Phase 4A` below).

- [ ] Implement Path 3 prepaid credit system via run402's `email-billing-accounts` (v1.28.0) [code]
  - Use `@run402/shared` billing client for checkout + balance + deduction; no custom Stripe wiring
  - Per-envelope deduction hooks on `POST /v1/envelope`
  - Insufficient balance → return HTTP 402 with top-up link (the standard x402 shape)
  - Non-expiring credits (platform default; verify when wiring)
  - Low-balance threshold alert (use the shared monitoring module's `notifyInfo`)
  - Purchase history reads from run402's billing ledger
- [ ] Implement magic link authentication for Path 3 via run402's `magic-link-auth` enhancement [code]
  - Wire `@run402/shared` auth client; no custom auth code
  - Enter email → receive login link → click → authenticated session
  - Session management is run402's responsibility
- [ ] Implement platform wallet for Path 3 on-chain recordings via the KMS-wallet feature [code]
  - On-chain recordings indistinguishable from Path 1/2 (same wallet, same contract)
  - Verify the pre-flight checklist in Phase 13 ran before wiring this for production
- [ ] Implement Path 3 dashboard extensions [frontend-logic]
  - Magic link login flow (UI only; run402 handles the token exchange)
  - Credit balance display (reads from run402 billing API)
  - Purchase history view (same source)
  - Low-balance indicator
  - Usage statistics (envelopes sent, signatures collected, completion rate — monthly/weekly)
  - Spending history (per-envelope cost, total spend over time)
- [ ] Implement Path 2 wallet onboarding flow on website — guide user through wallet creation and funding. Link directly to `docs/wallet-guide.md` for the long version. [frontend-visual]
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

- [ ] **P4B.1** Migration `005_completion_email_provider_msg_id.sql` adds nullable `completion_email_provider_msg_id TEXT` column to `envelope_signers` + a non-unique index on the column for webhook lookup (DD-12). Apply to local Postgres via the existing migration runner. [code]
- [ ] **P4B.2** DAO helpers in `kysigned/src/db/envelopes.ts`: `markCompletionEmailSent(pool, signer_id, provider_msg_id)` (UPDATE...RETURNING), `findSignerByCompletionEmailId(pool, provider_msg_id)` (SELECT...). TDD: failing test first in `envelopes.test.ts`. [code]
- [ ] **P4B.3** Update the completion-email loop in `kysigned/src/api/sign.ts` (around line 188): after `ctx.emailProvider.send(...)` returns `{ messageId }`, call `markCompletionEmailSent(ctx.pool, signer.id, res.messageId)`. Update existing `sign.test.ts` mock to expect the new call. [code]
- [ ] **P4B.4** New `envelopeExpired` email template in `kysigned/src/email/templates.ts` (DD-16) — takes `{ recipientName, documentName, senderName, signedCount, totalCount, signedNames, pendingNames }`. Matches existing template shape (HTML table + plaintext alternative). Unit test template rendering. [code]
- [ ] **P4B.5** New handler `handleEnvelopeExpiration(ctx)` in `kysigned/src/api/envelope.ts` (DD-16): iterates `getExpiredEnvelopes(pool)`, for each envelope sends `envelopeExpired` template to sender + all pending signers, calls `ctx.deletePdf(pdf_storage_key)` if set, emits audit log line. TDD: failing test first covering sender notification, pending signer notification, PDF delete call, and idempotency (re-running after all expired envelopes processed is a no-op). [code]
- [ ] **P4B.6** Export the new handler + helpers from `kysigned/src/api/index.ts` and `src/db/index.ts`. Run full kysigned suite — target 183 + ~12 new tests green, `npm run build` clean. [code]
- [ ] **P4B.7** Public-repo commit: `feat(db): webhook correlation column + envelope expiration handler (DD-12, DD-16)`. Push. [code]

**Public repo — E2E test suite (DD-13) — can land before OR in parallel with the service-repo work:**

- [ ] **P4B.8** Create `kysigned/test/e2e/` directory + `package.json` script `"test:e2e": "BASE_URL=${BASE_URL:-http://localhost:4022} node --test --import tsx test/e2e/*.test.ts"`. Add a shared helper `test/e2e/_helpers.ts` with `apiPost/apiGet`, test-wallet creation for x402, envelope-fixture builders. [code]
- [ ] **P4B.9** E2E test: multi-signer happy path. POST /v1/envelope with 3 signers, retrieve signing links, POST /v1/sign for each, poll /v1/envelope/:id until status=completed, assert all 3 tx hashes present, assert completion_tx present, GET /v1/verify?hash= returns the envelope. **This is the first-ever exercise of the CTE createEnvelope against a real Postgres — the primary DD-10 risk validation gate.** [code]
- [ ] **P4B.10** E2E test: void flow. Create envelope, POST /v1/envelope/:id/void, assert status=voided, assert 410 on subsequent sign attempts, assert PDF was deleted (storage key returns 404). [code]
- [ ] **P4B.11** E2E test: retention sweep. Create + complete an envelope, simulate the SES delivery webhook by POSTing to the kysigned-email-webhook function with a crafted payload (see P4B.15), run the sweep function, assert PDF was deleted and retention metadata is correct. [code]
- [ ] **P4B.12** E2E test: x402/MPP payment verification live. Requires a test wallet with prepaid balance on the kysigned project (setup in a beforeAll hook via `run402 billing credit`). POST /v1/envelope with a real x402 payment header, assert the Phase 2B middleware verified the payment against run402 billing before the envelope was created. [code]
- [ ] **P4B.13** E2E test: failed-signing / expiration flow. Create envelope with 3 signers, sign 2 of them, fast-forward expiry by directly UPDATEing `envelopes.expiry_at` in the past via `run402 projects sql`, run the expiration handler function, assert sender received expiration email with signer status breakdown (2 signed, 1 pending), assert pending signer's subsequent sign attempt returns 410, assert PDF was deleted. **Note: the re-send-to-missing-signer flow is NOT tested here — that's deferred under F16 / Phase 2H.** [code]
- [ ] **P4B.14** Verify the `npm run test:e2e` suite passes end-to-end against `BASE_URL=http://localhost:4022` (local docker Postgres + local gateway per CLAUDE.md). **If the CTE fails here, fix before proceeding** — this is the blast radius for Phase 4A SQL bugs. [code]

**Service repo — the three Lambda functions and deploy glue — `[service]`:**

- [ ] **P4B.15** Create `kysigned-service/src/email/httpSesEmailProvider.ts` — implements kysigned's `EmailProvider` interface by wrapping `@run402/functions` `email.send()` (discovered via lazy mailbox discovery per the helper's `_discoverMailbox()` pattern). Maps `EmailMessage → EmailRawOptions` (to, subject, html, text). Returns `{ messageId: result.id }`. Constructor injection of the run402 email function for tests. TDD. [code]
- [ ] **P4B.16** Create `kysigned-service/src/router/` directory with: `apiRouter.ts` (the single HTTP router entry point — default export, takes a Web Request, dispatches to kysigned handlers), `buildContext.ts` (constructs `ApiContext` per request with singleton HttpDbPool + EmailProvider + per-request baseUrl + senderType/senderIdentity from x402 or MPP verification), `routes.ts` (URL → handler map). TDD: test the URL routing, method matching, 404 on unknown paths, 405 on wrong method, x402 precheck on POST /v1/envelope returning 402 when verification fails. [code]
- [ ] **P4B.17** Wire admin auth per DD-15. Create `kysigned-service/src/router/adminAuth.ts` — middleware that extracts the SIWE signature from request headers, calls `verifySiweSignature()` from the public repo's `dashboardAuth`, then checks the recovered address against `process.env.KYSIGNED_ADMIN_WALLETS.split(',')`. On admin routes (`/v1/admin/*`), the router calls this middleware before dispatching. TDD: test happy path (wallet in list → allowed), denied (wallet not in list → 403), missing signature (→ 401), empty env var (→ 503 "admin routes not configured"). [code]
- [ ] **P4B.18** Create `kysigned-service/src/webhook/emailWebhook.ts` — the SES webhook handler function entry. Default export takes a Web Request, parses the run402 webhook JSON payload (`{ event, mailbox_id, message_id, to_address, bounce_type }`), uses `findSignerByCompletionEmailId(pool, message_id)` to get `(envelope_id, email)`, then calls `markCompletionEmailDelivered` / `markCompletionEmailBounced` based on event type. Ignores `complained` and `reply_received` events (return 200 OK). TDD: test delivery event dispatch, bounced event dispatch, unknown message_id (log warning, return 200 OK), malformed payload (return 400). [code]
- [ ] **P4B.19** Create `kysigned-service/src/scheduled/sweepAndExpire.ts` — the scheduled Lambda function entry. Default export takes no args (scheduled invocation), constructs an ApiContext, and calls (1) `sweepRetention(ctx)` from the public repo, (2) `handleEnvelopeExpiration(ctx)` from the public repo (new in P4B.5). Logs summary counts. TDD: test both handlers are called and errors from one don't abort the other. [code]
- [ ] **P4B.20** Create `kysigned-service/functions/kysigned-api.mjs` — thin Lambda entry that imports `apiRouter` from `dist/router/apiRouter.js` and exports a handler wrapping it in the run402 Web Request → Lambda event shim. Follows the shim pattern from `run402/packages/functions-runtime/shim.ts`. [code]
- [ ] **P4B.21** Create `kysigned-service/functions/kysigned-email-webhook.mjs` — thin Lambda entry for the webhook handler. [code]
- [ ] **P4B.22** Create `kysigned-service/functions/kysigned-sweep.mjs` — thin Lambda entry for the scheduled handler. [code]
- [ ] **P4B.23** Frontend build integration in deploy script: `cd kysigned/frontend && VITE_API_URL=https://kysigned.run402.com VITE_RUN402_ANON_KEY=<anon> npm run build` produces `dist/` ready to upload. Verify existing frontend code reads `import.meta.env.VITE_API_URL` (may need small updates to the frontend src). [code] / [frontend-logic]
- [ ] **P4B.24** Create `kysigned-service/scripts/deploy.ts` (DD-14) — idempotent deploy script. Steps: (1) load current project state from kysigned/* secrets, (2) deploy the 3 functions via `POST /projects/v1/admin/:id/functions` (check current code_hash before replacing), (3) POST a webhook registration to `/mailboxes/v1/:mbxid/webhooks` with the kysigned-email-webhook URL + events `["delivery", "bounced"]` (skip if already registered), (4) set required env vars on the api function (`KYSIGNED_RUN402_PROJECT_ID`, `KYSIGNED_RUN402_SERVICE_KEY`, `KYSIGNED_RUN402_ANON_KEY`, `KYSIGNED_ADMIN_WALLETS`, contract registry addresses), (5) build frontend bundle, (6) upload dist/ via `POST /deployments/v1`, (7) claim `kysigned.run402.com` subdomain pointing at the new deployment. Every step idempotent. [code]
- [ ] **P4B.25** Run `npm run build` in kysigned-service + unit suite — all new TDD tests passing, tsc clean. [code]
- [ ] **P4B.26** Execute `deploy.ts` for the FIRST time against the live kysigned project on run402. Confirm: 3 functions visible in `run402 functions list`, webhook registered in `GET /mailboxes/v1/:id/webhooks`, frontend bundle deployed, `kysigned.run402.com` now serves the real app (not the placeholder). [infra]
- [ ] **P4B.27** Run `BASE_URL=https://kysigned.run402.com npm run test:e2e` against the deployed instance. All 5 e2e scenarios from DD-13 must pass. **This is the ship gate for Phase 4B.** If the e2e fails here but passed locally at P4B.14, the issue is environment-specific (missing env var, IAM perm, webhook wiring) — investigate and iterate. [infra]
- [ ] **P4B.28** Service repo commit + push: `feat(deploy): Phase 4B — router, webhook, sweep, frontend deployed (DD-11 through DD-16)`. Public-repo P4B.7 commit should already be in; verify both repos are in sync. [infra]
- [ ] **P4B.29** Update operator README at `kysigned-service/README.md` (or `docs/operator-guide.md` if one doesn't exist) with: deploy procedure, `KYSIGNED_ADMIN_WALLETS` setup + rotation procedure (forker-friendly), known admin-auth limitations per DD-15, cross-reference to saas-factory F24. [manual]
- [ ] **P4B.30** Mark Phase 4B complete in the Implementation Log with commit SHAs, e2e pass evidence (smoke command + output), and any deviations from the plan. [manual]

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

### Phase 7: Legal `AI -> HUMAN: Approve`

- [x] Draft Terms of Service [manual] `AI -> HUMAN: Approve` — approved
- [x] Draft Privacy Policy [manual] `AI -> HUMAN: Approve` — approved
- [x] Draft Cookie/consent notice [manual] `AI -> HUMAN: Approve` — approved
- [x] Draft Acceptable Use Policy [manual] `AI -> HUMAN: Approve` — approved
- [x] Draft DPA (Data Processing Agreement) [manual] `AI -> HUMAN: Approve` — approved
- [ ] Publish all legal docs on kysigned.com [infra] `AI`
- [ ] Verify LEGAL.md in public repo is approved (from Phase 0) [manual] `HUMAN`

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

### Phase 13: Gas Measurement & Final Pricing `AI` / `DECIDE`

> **Context: run402 KMS wallet.** The mainnet wallet is now provisioned via run402's new KMS-wallet feature, not a plaintext `agentdb/faucet-treasury-key` Secrets Manager entry. This is a DD-3 material change — DD-3 is kept for the "one platform wallet across all Kychee SaaS products" principle, but the **key custody** moves from plaintext Secrets Manager to AWS KMS with run402 as the signing intermediary. The private key material never leaves KMS. kysigned is the **first production consumer** of the KMS wallet path, so several operations (drain, recovery address, 90-day deletion lifecycle) get their first real exercise through kysigned usage. See "Pre-flight checklist" below.

**Pre-flight checklist — MUST run BEFORE `run402 contracts provision-wallet --chain base-mainnet`:** `HUMAN`

- [ ] **IAM simulation re-run (10 seconds).** Catch any policy drift since the run402 KMS wallet implementation was tested: `aws iam simulate-principal-policy --policy-source-arn <role-arn> --action-names kms:CreateKey kms:Sign kms:Decrypt --region us-east-1`. All three actions must return `allowed`. Do this immediately before the provision call, not days ahead.
- [ ] **Billing balance ≥ $1.20 on the kysigned project.** The first `provision-wallet` call returns HTTP 402 (Payment Required) if the balance is insufficient. If this happens, the wallet does not yet exist — top up the project, then retry. Do not debug around the 402; it is a correct response.
- [ ] Run `run402 contracts provision-wallet --chain base-mainnet` [manual] `HUMAN`
- [ ] Capture the resulting wallet address and confirm it appears in the run402 admin dashboard under the kysigned project attribution [manual] `HUMAN`
- [ ] Fund the wallet with ETH for gas (start small — `~0.02 ETH` is enough for the mainnet deploy plus hundreds of envelope recordings at Base's fees) and with USDC for the initial operating float if Path 1/2 x402 payments will route through it [manual] `HUMAN`

**Deploy + measure:** `AI`

- [ ] Deploy SignatureRegistry.sol to Base mainnet via the KMS-signed wallet [infra]
- [ ] Measure actual gas costs per operation on mainnet [infra]
- [ ] Calculate true per-envelope cost (gas + email + compute + storage for 30 days) [manual] `AI`
- [ ] Set final per-envelope pricing (~$0.25 target, adjusted by actual costs) [manual] `DECIDE`
- [ ] Set credit pack tiers and per-envelope rates for Path 3 [manual] `DECIDE`
- [ ] Update pricing page with final numbers [frontend-visual] `AI`

**First-exercise watchlist — kysigned is the first production consumer of these KMS-wallet operations:** `AI` / `HUMAN`

The following paths have ZERO production test coverage on run402 and will get their first real exercise through kysigned in the first month of live traffic. Watch ledger entries closely.

- [ ] **Drain endpoint** — verify it works end-to-end the first time we need to sweep the wallet (e.g., before migrating to a fresh wallet, or during an incident). Do not assume it works because the test suite passes. Dry-run it on a small balance before committing a real drain.
- [ ] **Recovery address** — confirm the configured recovery address is correct, reachable, and controlled by the intended party (Barry). Check this ONCE at provisioning time and then again at the 30-day mark when the wallet has seen real use.
- [ ] **90-day deletion lifecycle** — the KMS key deletion policy is scheduled, not permanent. If the wallet goes idle, at day ~75 we should either bump it (any signed transaction resets the clock) or explicitly extend the deletion schedule. Add a calendar reminder the day the mainnet wallet is provisioned so day 75 doesn't come as a surprise.
- [ ] **First-month ledger audit** — at T+30 days from first mainnet envelope, export the full wallet ledger from the run402 admin dashboard and reconcile: total gas spent, total USDC received, any unexpected outflows, any failed KMS signing calls that retried. Flag anything unusual to the run402 team so they can harden the paths that kysigned is the first to touch.

### Phase 14: Launch Prep `HUMAN` / `AI`

- [~] Email deliverability setup — dedicated sending domain, SPF/DKIM/DMARC, warm-up plan [infra] `AI` — **2026-04-07:** dedicated sender domain (`kysigned.com`) registered via run402 + SPF/DKIM/DMARC records live + status `verified`. **2026-04-08:** authoritative DNS migrated from Route 53 to Cloudflare (see DNS task in Phase 5); SPF/DKIM/DMARC records preserved end-to-end, SES verification unchanged. Remaining: run the 2-week SES warm-up ramp before high-volume launch traffic (start with low daily send volume from a real mailbox under this domain, ramp gradually).
- [ ] Flip public repo from private to public on GitHub [infra] `AI` — squash all history into a single "v1.0.0" commit first (orphan branch, force-push). No development history visible. Clean audited release.
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
- [ ] Ship "Smart contract — Base mainnet" surface — deploy SignatureRegistry.sol to Base mainnet, smoke `curl -fsSL -X POST https://mainnet.base.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"<mainnet-addr>","data":"0x3644e515"},"latest"]}' | grep -q '"result":"0x[0-9a-f]\{64\}"'` (depends on Phase 13) [ship]
- [x] Ship "Smart contract — Base Sepolia" surface — deployed at 0xAE8b6702e413c6204b544D8Ff3C94852B2016c91, smoke passed (see Implementation Log 2026-04-06) [ship]

---

## Implementation Log

_Populated during implementation by `/implement`, AFTER tasks are being executed._

### Gotchas

_None yet_

### Deviations

_None yet_

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
- 2026-04-08: **Phase 4B planned.** `/plan kysigned` session added DD-11 through DD-16 and 30 discrete Phase 4B tasks (P4B.1 through P4B.30). DD-11: three Lambdas (API router, SES webhook, sweep cron). DD-12: webhook correlation via new `completion_email_provider_msg_id` column on envelope_signers — small public-repo change rather than best-effort email-only matching (rejected due to misattribution risk on a signing platform). DD-13: net-new e2e test suite at `kysigned/test/e2e/` running against `BASE_URL`, includes the first-ever exercise of the Phase 4A CTE against real Postgres. DD-14: idempotent `deploy.ts` script complementing `bootstrap-run402.ts`. DD-15: admin auth via `KYSIGNED_ADMIN_WALLETS` env var + local SIWE verification (single-factor, forker recovery limitation documented — see saas-factory F24 cross-ref). DD-16: envelope expiration handler closing a gap in the Phase 2 work that was mis-marked complete. Also added: Phase 2H placeholder for the deferred F16 document-level aggregation view (NOT PLANNED — run `/spec kysigned` first before adding tasks). Also bumped: kysigned spec 0.6.0 → 0.7.0 (added F16 concept section), saas-factory spec 1.13.0 → 1.14.0 (added F24 future-enhancement note for platform admin auth service). Two small public-repo additions (DD-12 + DD-16) are accepted as the minimum viable public-repo delta needed to deploy an MVP that exercises the full spec. No code changes in this session — spec + plan only. Ship gate for Phase 4B is the e2e suite passing against `https://kysigned.run402.com` (P4B.27).
- 2026-04-06: F8.6 ephemeral PDF retention library piece complete in kysigned public repo. Migration 004 adds `pdf_deleted_at` + per-signer `completion_email_delivered_at` / `completion_email_bounced_at`. New `src/pdf/retention.ts` (pure rule), `src/pdf/sweep.ts` (periodic deletion sweep), `src/api/emailWebhook.ts` (delivery/bounce hooks the service translates SES payloads into). `handleVoidEnvelope` now drops the original PDF immediately via `ctx.deletePdf`. 23 new tests (12 retention + 5 sweep + 5 webhook + 1 void integration). Full suite 141/141. Service repo still needs to wire SES → markDelivered/Bounced and a periodic `sweepRetention` cron.
- 2026-04-06: F2.8 `allowed_senders` access control complete — DAO + migration `003_allowed_senders.sql` + sender gate (allowlist/hosted strategies) + monthly quota + admin API + README warning. TDD red-green throughout: 33 new tests added (15 DAO + 9 gate + 9 admin + 4 envelope integration). Full kysigned suite: 112/112 pass. Service repo can now wire `senderGate: { strategy: 'hosted', getCreditBalance }` in production; self-hosted forkers default to `allowlist`. Pluggable strategy + per-sender quota + default-deny all in one cohesive layer.
- 2026-04-08: **Phase 4A complete — public-repo HTTP DbPool refactor + service-repo adapter landed.** All 9 P4A tasks shipped. Public repo commit `6311514` (13 files, +222/-160): narrows `DbPool` interface in `src/db/pool.ts` to `query()`+`end()` only (drops `connect()` / `pg.PoolClient`); rewrites `createEnvelope` in `src/db/envelopes.ts` as a single multi-CTE `pool.query()` call that inserts envelope + all N signers + returns one row `{ envelope, signers }` via `row_to_json` + `json_agg`; updates in-memory pool mocks in `envelope.test.ts` + `envelopes.test.ts` to recognize the CTE shape; removes now-dead `async connect()` stubs from 11 test files (TS strict excess-property check rejects them under the narrowed interface). All IDs still client-generated (`randomUUID()` + `randomBytes`), so no read-after-write dependency — the CTE is atomic on the server because the run402 gateway wraps each `db.sql()` call in its own `BEGIN`/`COMMIT`. Signers are matched back to input order by `signing_token` so `signing_link` attachment is order-preserving independent of DB return order. Full kysigned suite: **183/183 passing**, `npm run build` clean. Service repo commit `d41fb11` (2 new files, +188): `HttpDbPool` class at `src/db/httpPool.ts` wrapping `@run402/functions` `db.sql()` via a constructor-injected `DbSqlFn` (no static import — tests mock without needing `run402-functions` installed, Phase 4B router layer decides where real `db.sql` comes from). 8 TDD tests covering pass-through, empty-values default, row return, rowCount default-to-length, empty results, error propagation, CTE-shaped single-row results, and `end()` no-op. Full kysigned-service suite: **15/15 passing** (7 monitoring + 8 new). Both repos pushed. Phase 4A was the prerequisite refactor for the real Phase 4 service deploy work — next chat: `/plan` to fill out Phase 4B (router Lambda, SES webhook, `sweepRetention` cron, email provider adapter, frontend bundle deploy, e2e smoke) against the now-stable `HttpDbPool` surface.
- 2026-04-08: **Apex DNS resolved — kysigned.com, www.kysigned.com, kysigned.run402.com all serving 200.** Migrated the `kysigned.com` authoritative zone from Route 53 to Cloudflare (registrar NS flip done at AWS). Final working state: `https://kysigned.com/` → 200 ✅ (apex now serves the placeholder — the original goal), `https://www.kysigned.com/` → 200 ✅, `https://kysigned.run402.com/` → 200 ✅ (unchanged), SES email working (SPF/DKIM/DMARC all preserved in the new Cloudflare zone). **Implementation diverged from the originally-proposed "Option B: Cloudflare CNAME flattening at apex":** DNS did move to Cloudflare (that part of Option B), but the zone uses **proxied AAAA-discard records** (the `kychon.com` pattern) instead of CNAME-flattening. The reason the mechanism matters: for the run402 custom-domains Cloudflare Worker to actually fire, the hostname has to enter Cloudflare through its own zone — not via the run402.net SaaS edge — which means proxied records in the `kysigned.com` zone, not flattened CNAMEs to a third party. Same end result (apex resolves and serves), different mechanism — **if a future saas-factory product needs the same fix, follow the proxied-records-in-own-zone pattern, not flattened-CNAMEs-to-run402.net**. Collateral: found and fixed a pre-existing 522 on the `kysigned.com` zone (missing Worker route bindings since the cert was provisioned — unrelated to the apex work but surfaced by it), and cleaned up the legacy run402-side Custom Hostnames that became redundant once the zone moved. STATUS.md in `kysigned-service` updated to reflect the new working state and document the pattern for future reference.
- 2026-04-08: **Phase 4 strategy decided — kysigned fits the existing HTTP DB surface, no platform change.** While setting up the kysigned-service Lambda handlers, we surfaced a mismatch: deployed run402 Lambdas have no direct `pg` access (only `db.sql()` / `db.from()` / `/rest/v1/*` via `@run402/functions`), but kysigned's `createEnvelope` DAO uses native pg transactions (`BEGIN → INSERT envelope → INSERT signers → COMMIT` in `kysigned/src/db/envelopes.ts:20-91`). Two paths were considered: (a) new run402 platform feature `lambda-db-direct` — per-project DB role, `RUN402_DATABASE_URL` injected into Lambdas, RDS Proxy fronting the connection; (b) refactor the kysigned public repo so its DAO layer fits the existing HTTP SQL surface via a single multi-statement `db.sql()` call with a CTE. An OpenSpec change for path (a) was drafted under `run402/openspec/changes/lambda-db-direct/`, then **reverted on 2026-04-08 after discussion with the run402 team**: run402 has active scaling/monitoring concerns about exposing direct-pg connections at this stage (RDS connection count under Lambda burst, observability of per-project pool utilization, role rotation ops story) and would rather defer direct-pg as a future platform enhancement when the operational story is mature. **Decision: kysigned is the first adopter of the HTTP-only DB model on run402**, documented as DD-10. Phase 4 is unblocked; a new sub-phase `Phase 4A — Pre-deploy refactor` was added to track the public-repo DAO rewrite and the HTTP-backed DbPool adapter in kysigned-service. Net impact to the kysigned release timeline is small (one file refactor in the public repo + one adapter in the service repo), and the decision reserves the option to flip to direct-pg later without changing the app code (the `DbPool` interface stays stable — only its implementation changes).
- 2026-04-07: **Public repo functionally complete — DD-9 trojan horse landed for all 4 remaining substantive tasks.** Strict TDD red→green→commit on each. (1) **Phase 2B x402 middleware** — `src/api/payment/x402.ts` decodes the wallet from the v2 x402 wire format and `GET`s `https://api.run402.com/billing/v1/accounts/:wallet` directly via fetch with `Authorization: Bearer ${KYSIGNED_RUN402_SERVICE_KEY}` + `X-Run402-Project: ${KYSIGNED_RUN402_PROJECT_ID}`. 11 tests. (2) **Phase 2B MPP middleware** — `src/api/payment/mpp.ts` extracts the payer wallet from a `did:pkh:eip155:<chain>:<addr>` MPP credential source and hits the same billing endpoint. 12 tests. (3) **Phase 2G dashboard wallet auth** — `src/api/auth/dashboardAuth.ts` ships local viem-backed SIWE (`createSiweMessage` + `verifySiweSignature` via `viem.verifyMessage`) for the wallet path AND direct `fetch` against `/auth/v1/magic-link` + `/auth/v1/token?grant_type=magic_link` + `/auth/v1/user` for the email path; both flows share one run402-backed surface keyed by `KYSIGNED_RUN402_ANON_KEY`. 11 tests. (4) **Phase 9 MCP x402/MPP forwarding** — `mcp/src/paymentHeaders.ts` reads `KYSIGNED_X402_PAYMENT` / `KYSIGNED_MPP_CREDENTIAL` / `KYSIGNED_AUTHORIZATION` from env and `buildPaymentHeaders()` injects the right headers on every outbound MCP fetch in `mcp/src/index.ts`; the kysigned API's new Phase 2B middleware then verifies against run402. 7 tests. **No abstraction layer anywhere** — every run402 dependency is a literal `fetch('https://api.run402.com/...')` call that a forker can re-target by setting their own env vars. Full kysigned unit suite: 183/183 (was 149, +34 new). MCP suite: 10/10 (was 3, +7 new). `npm run build` clean for both packages. The public repo is now functionally complete; the only remaining gate is the human-reviewed orphan-branch squash + private→public flip in Phase 14, which is intentionally NOT done in this chat.
- 2026-04-06: Phase 15 — Shipped "Smart contract — Base Sepolia" surface. Smoke check executed from a fresh `mktemp -d` directory:
  ```
  curl -fsSL -X POST https://sepolia.base.org -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0xAE8b6702e413c6204b544D8Ff3C94852B2016c91","data":"0x3644e515"},"latest"]}'
  ```
  Exit code: 0. Result: `{"jsonrpc":"2.0","result":"0x8db329e11c1632d3570c4e92ee526a54f76262c122835520bd570595db9019fb","id":1}`. The returned `DOMAIN_SEPARATOR` matches the value recorded at deployment, confirming the deployed contract is reachable from outside the repo via a generic public RPC endpoint. Spec smoke check updated from `cast call ...` to portable curl form so it works without Foundry installed locally.
