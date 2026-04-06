# Plan: kysigned

**Owner:** Barry Volinskey
**Created:** 2026-04-04
**Status:** Ready for Implementation
**Spec:** docs/products/kysigned/kysigned-spec.md
**Spec-Version:** 0.6.0
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
  - [x] Platform wallet — PARTIAL. Viem + CDP SDK on Base Sepolia testnet. Gap: no mainnet wallet, no KMS key management, no contract interaction abstraction.
- [!] For each missing run402 capability: create a run402 enhancement task with scope estimate, implement in run402 worktree (feature branch) [manual] `AI` — WAITING FOR: Separate run402 plans for each enhancement. Not blocking Phase 1-3.
  - [ ] run402 enhancement: Magic link passwordless auth flow (endpoint + email-only identity)
  - [ ] run402 enhancement: Custom sender domain support (kysigned.com email sending)
  - [ ] run402 enhancement: Mainnet wallet + KMS key management + contract interaction abstraction
  - [ ] run402 enhancement: Per-envelope billing adaptation + email-based billing accounts
  - [ ] run402 enhancement: Admin dashboard (/admin) — wallet activity breakdown by product (inflows: USDC revenue labelled "kysigned" / "run402 infra" / etc., derived from which API endpoint accepted payment; outflows: ETH gas labelled by which contract was called) + Stripe revenue tracking per product via Stripe metadata
- [x] Register domain kysigned.com [infra] — registered via Route 53, hosted zone Z0749125BIF9JF9FZ73M. DNS wiring to run402 infra pending deployment.

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
- [!] Implement x402 payment middleware for Path 1/2 sender authentication [code] — WAITING FOR: run402 integration layer (Phase 4)
- [!] Implement MPP payment middleware for Path 1/2 sender authentication [code] — WAITING FOR: run402 integration layer (Phase 4)
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
- [!] Implement wallet-based authentication for dashboard [code] — WAITING FOR: run402 SIWX integration (Phase 4)

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
- [ ] Build wallet onboarding panel on signing page — shown only when signer hits `require_wallet: true` without a wallet installed. Coinbase/MetaMask install links, "no funding needed for signers" clarification [frontend-visual]
- [ ] Write `docs/wallet-guide.md` in public repo with two labeled sections: "For Envelope Creators (Path 1/2)" (install + fund with USDC on Base) and "For Signers (rare, Method B only)" (install, no funding needed) [code]
- [ ] Link wallet-guide.md from README, signing page (when relevant), and llms.txt [code]

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

- [ ] Implement Path 3 prepaid credit system (via run402 paycard or own Stripe integration — based on Phase 0 audit) [code]
  - Stripe checkout for credit pack purchase (branded as kysigned)
  - Credit balance storage and per-envelope deduction
  - Insufficient balance error handling
  - Non-expiring credits
  - Low-balance threshold alert
  - Purchase history
- [ ] Implement magic link authentication for Path 3 (via run402 or own implementation — based on Phase 0 audit) [code]
  - Enter email → receive login link → click to authenticate
  - No password, no social login
  - Session management
- [ ] Implement platform wallet for Path 3 on-chain recordings (using run402's wallet infrastructure) [code]
  - On-chain recordings indistinguishable from Path 1/2
- [ ] Implement Path 3 dashboard extensions [frontend-logic]
  - Magic link login flow
  - Credit balance display
  - Purchase history view
  - Low-balance indicator
  - Usage statistics (envelopes sent, signatures collected, completion rate — monthly/weekly)
  - Spending history (per-envelope cost, total spend over time)
- [ ] Implement Path 2 wallet onboarding flow on website — guide user through wallet creation and funding [frontend-visual]

### Phase 5: Domain & Branding `AI` / `HUMAN`

- [x] Design kysigned logo [manual] `AI -> HUMAN: Approve` — monochrome navy, ">" prompt + pen nib + signature flourish. Approved.
- [x] Define brand assets: colors, typography, tone of voice [manual] — primary: dark navy (#1a1a2e), white bg, monochrome. Logo family: ">" prompt motif across all Kychee products.
- [x] Create brand asset files (logo variants, color palette, font files) [frontend-visual] — 1024/512/256/128/64/32px + favicon
- [x] Configure DNS for kysigned.com [infra] — Route 53 hosted zone ready, wiring on deployment

### Phase 6: Website — Service Repo `[service]` `AI`

- [x] Build landing page — cost comparison lead, no "kill" language, dual CTA, comparison table, feature grid [frontend-visual]
- [x] Build pricing page — 3 paths, comparison table vs DocuSign/GoodSign [frontend-visual]
- [x] Build "SaaS vs Repo" decision helper page — tradeoffs for builders, end users, agents [frontend-visual]
- [x] Build FAQ page — 6 categories, 9 questions with honest answers [frontend-visual]
- [ ] Add FAQ item: "Do I need a crypto wallet to sign?" — explains Method A vs B, when wallet is required, how to get one [frontend-visual]
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

- [ ] Build shared Kychee consent banner module (`kychee/site-modules/consent-banner/`) — single module reused across all Kychee product sites [code]
- [ ] Implement geo detection via Cloudflare `CF-IPCountry` header (or CloudFront equivalent) [code]
- [ ] Implement region rule: show banner for EU/UK/BR/CA/CH/California; hide for US (non-CA) and other permissive jurisdictions; fail-safe to show on detection failure [code]
- [ ] Implement banner UI with three independent toggles (Essential/Analytics/Marketing), default-off for non-essential [frontend-visual]
- [ ] Implement "Reject all" button equally prominent as "Accept all" [frontend-visual]
- [ ] Implement consent state persistence in `localStorage` (`kychee_consent`) and conditional GA4/ad pixel loading [code]
- [ ] Implement footer "Cookie settings" link to re-open panel [frontend-logic]
- [ ] Implement 12-month re-prompt logic [code]
- [ ] Integrate consent banner into kysigned.com (first product to use the shared module) [frontend-visual]

### Phase 9: Agent Interface `[both]` `AI`

- [x] Build MCP server exposing: create_envelope, check_envelope_status, list_envelopes, verify_document, verify_envelope, send_reminder, void_envelope [code] — tested
- [!] Implement x402/MPP authentication in MCP [code] — WAITING FOR: run402 payment middleware integration
- [x] Implement configurable endpoint (KYSIGNED_ENDPOINT env var, default: kysigned.com) [code]
- [ ] Publish canonical npm package (`kysigned-mcp`) [infra]
- [ ] Write MCP documentation and usage examples [manual] `AI`

### Phase 10: Collateral `AI -> HUMAN: Approve`

- [ ] Generate ad creatives — static images for target segments (freelancers, consultants, agencies, real estate) [manual] `AI -> HUMAN: Approve`
- [ ] Generate video ad (short-form, cost comparison focus) [manual] `AI -> HUMAN: Approve`
- [ ] Generate social media assets (profile images, cover photos, post templates) [manual] `AI -> HUMAN: Approve`
- [ ] Create README hero image / screenshots for public repo [manual] `AI -> HUMAN: Approve`

### Phase 11: Marketing Strategy `DECIDE` / `HUMAN`

- [ ] Write hypothesis card for Freelancers segment [manual] `AI -> HUMAN: Approve`
  - Beachhead: freelancers (2-5 sigs/month)
  - Primary channel, pilot budget ($500+ floor), timeframe (2-4 weeks)
  - Signal metrics, success threshold, kill criteria, next steps
- [ ] Write hypothesis card for Solo Consultants segment [manual] `AI -> HUMAN: Approve`
- [ ] Write hypothesis card for Small Agencies segment [manual] `AI -> HUMAN: Approve`
- [ ] Write hypothesis card for Real Estate Agents segment [manual] `AI -> HUMAN: Approve`
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

- [ ] Deploy SignatureRegistry.sol to Base mainnet [infra]
- [ ] Measure actual gas costs per operation on mainnet [infra]
- [ ] Calculate true per-envelope cost (gas + email + compute + storage for 30 days) [manual] `AI`
- [ ] Set final per-envelope pricing (~$0.25 target, adjusted by actual costs) [manual] `DECIDE`
- [ ] Set credit pack tiers and per-envelope rates for Path 3 [manual] `DECIDE`
- [ ] Update pricing page with final numbers [frontend-visual] `AI`

### Phase 14: Launch Prep `HUMAN` / `AI`

- [ ] Email deliverability setup — dedicated sending domain, SPF/DKIM/DMARC, warm-up plan [infra] `AI`
- [ ] Flip public repo from private to public on GitHub [infra] `AI` — squash all history into a single "v1.0.0" commit first (orphan branch, force-push). No development history visible. Clean audited release.
- [x] **Refactor PDF storage to ephemeral retention (per spec F8.6 v0.5.0):** delete on completion-email delivery confirmation, not 30-day fixed window. Wire SES delivery webhooks to trigger deletion. 7-day fallback for bounces. Hard 30-day cap regardless. [code] — public-repo library piece complete: migration 004, pure shouldDeletePdf, sweepRetention, markCompletionEmailDelivered/Bounced, and immediate-delete on void. Service repo still needs to wire SES → markDelivered/Bounced webhook routes and a periodic sweep cron.
- [ ] **Wire kysigned to the shared monitoring module** (`@run402/shared/monitoring`) — provide concrete senders for Telegram (kysigned chat), Bugsnag (kysigned project), and SES (CRITICAL emails). Cover all standard signals from saas-factory F20. [code]
- [ ] **Create kysigned Telegram alerts channel** + add Tal and Barry as members [manual] `HUMAN`
- [ ] **Create kysigned Bugsnag project** + store API key in AWS Secrets Manager (`kysigned/bugsnag-api-key`) [infra] `AI`
- [ ] **Write `docs/incident-response.md` for kysigned** based on the saas-factory F20 template — severity definitions, on-call (Barry+Tal), first-response checklist, communication templates, DPA 72-hour reference [manual] `AI`
- [ ] **Account deletion automation** — verified end-to-end procedure that deletes all off-chain personal data within 30 days (DPA Section 11 commitment). Includes envelope cache, signer records, document storage, payment records (where legally allowed). Requires explicit verification step that deletion completed. [code]
- [ ] **Security claims documentation pack** — collect AWS encryption configuration evidence, access control policies, security questionnaire we can hand to enterprise customers on request. Stored in `kysigned-service/security/`. [manual] `AI`
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
- 2026-04-06: F8.6 ephemeral PDF retention library piece complete in kysigned public repo. Migration 004 adds `pdf_deleted_at` + per-signer `completion_email_delivered_at` / `completion_email_bounced_at`. New `src/pdf/retention.ts` (pure rule), `src/pdf/sweep.ts` (periodic deletion sweep), `src/api/emailWebhook.ts` (delivery/bounce hooks the service translates SES payloads into). `handleVoidEnvelope` now drops the original PDF immediately via `ctx.deletePdf`. 23 new tests (12 retention + 5 sweep + 5 webhook + 1 void integration). Full suite 141/141. Service repo still needs to wire SES → markDelivered/Bounced and a periodic `sweepRetention` cron.
- 2026-04-06: F2.8 `allowed_senders` access control complete — DAO + migration `003_allowed_senders.sql` + sender gate (allowlist/hosted strategies) + monthly quota + admin API + README warning. TDD red-green throughout: 33 new tests added (15 DAO + 9 gate + 9 admin + 4 envelope integration). Full kysigned suite: 112/112 pass. Service repo can now wire `senderGate: { strategy: 'hosted', getCreditBalance }` in production; self-hosted forkers default to `allowlist`. Pluggable strategy + per-sender quota + default-deny all in one cohesive layer.
- 2026-04-06: Phase 15 — Shipped "Smart contract — Base Sepolia" surface. Smoke check executed from a fresh `mktemp -d` directory:
  ```
  curl -fsSL -X POST https://sepolia.base.org -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0xAE8b6702e413c6204b544D8Ff3C94852B2016c91","data":"0x3644e515"},"latest"]}'
  ```
  Exit code: 0. Result: `{"jsonrpc":"2.0","result":"0x8db329e11c1632d3570c4e92ee526a54f76262c122835520bd570595db9019fb","id":1}`. The returned `DOMAIN_SEPARATOR` matches the value recorded at deployment, confirming the deployed contract is reachable from outside the repo via a generic public RPC endpoint. Spec smoke check updated from `cast call ...` to portable curl form so it works without Foundry installed locally.
