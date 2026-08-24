# Changelog

All notable changes to `@run402/sdk`, `run402` (CLI), and `run402-mcp`. Versions are kept in lockstep across the three packages in this repo. `@run402/functions` lives in the public `run402-core` repo and publishes on its own cadence.

## Unreleased — JSON is always the default

- **BREAKING — `run402 errors` emits JSON by default.** Every output path (list,
  single-fingerprint detail, the `--fail-on-new` promote gate, and the `--watch`
  variants of each) now writes the gateway envelope verbatim to stdout with no
  flag. The human-rendered view moved behind `--human`, matching `run402 up`;
  `--human` combined with `--json` is a `BAD_USAGE` error. Exit codes are
  unchanged: 1 on new fingerprints, 0 clean, 2 on gate misuse. If you piped
  `run402 errors` and read prose, add `--human`; if you passed `--json`, you can
  drop it.
- **`--json` is a documented universal no-op.** Every command accepts it and it
  never changes stdout. It was already accepted everywhere structurally; what
  changes is that no command may now *branch* output on it. The single exception
  stays `assets put --json`, a deprecated alias for `--stream`.
- **Cleanup:** `cloud archives status` dropped a vacuous `--json` gate that was
  always true, leaving zero `--json` output bindings across the CLI.
- **Tests:** new `cli-json-noop-contract.test.mjs` enforces the rule on four
  axes — structural acceptance, byte-identical stdout with and without the flag,
  a static scan that fails on any reintroduced output gate, and an in-process
  mocked-gateway check of the `errors` default. The scan and the `errors` checks
  were both verified to fail against the pre-change code.

## Unreleased — first-party skill distribution

- **`run402 up` manifest parity:** a release-shaped `run402.json` now follows
  the same ReleaseSpec normalization as `deploy apply`; app-shaped files keep
  the app-install graph, and malformed app manifests fail with a field-specific
  `APP_SPEC_INVALID` result instead of an internal `undefined.functions` crash.
- **Windows-safe function bodies:** `functions invoke --body` now validates JSON
  before network access, including empty and shell-corrupted values.
  `--body-file <path>` is the shell-independent canonical path for managed
  agents and Windows `cmd.exe`; inline/file source conflicts fail locally.

- **Agent skills:** Run402 now builds a deterministic, content-addressed skill
  index for `run402` and `run402-buzz`, with immutable artifacts designed for
  hosting on `run402.com`. Buzz installs can use the first-party domain as the
  canonical source, avoiding GitHub, raw-content, and registry availability on
  the happy path.
- **Install guidance:** documented per-agent targets use the actual installer
  names (`claude-code`, `codex`, `goose`, or `universal`) and retain GitHub only
  as a transport fallback. Digest mismatches fail closed and never fall back.
- **Tests:** deterministic rebuild, archive safety, retained-version behavior,
  every documented target, transport fallback, and pre-mutation integrity
  failure are covered by package and installer smoke tests.
- **Buzz doctor:** `run402 doctor --buzz --buzz-agent <subject>` now checks the
  exact managed agent, executable/runtime compatibility, first-party origins,
  released Buzz capabilities, and pinned public relay connectivity before any
  setup mutation. Failures carry destination-specific, copyable repairs; the
  optional diagnostic funnel stores aggregate enum counters only and supports
  `RUN402_TELEMETRY=0`.
- **Buzz acceptance correction:** a safely contained relay transport or TLS
  failure is now an actionable warning for founder-agent setup instead of a
  global blocker. Unsafe destinations still block before a dial, and community
  discovery/enrollment remain unavailable until live relay proof succeeds.
  TLS failures name the public hostname/certificate repair instead of telling
  the user to reconnect the same broken URL. The apex Buzz page now points
  pre-install agents to `https://run402.com/buzz/install.txt`, whose receipt
  requires the observed first-party digest, runtime target, and workspace path.
- **Natural-language install routing:** a Buzz user can now say only
  `Please install the run402.com skill`. Apex guidance and discovery metadata
  route the managed Buzz context to `run402-buzz`; bootstrap URLs, runtime
  targets, and installer commands remain agent-only implementation details.
- **One-request Buzz onboarding:** that canonical sentence now continues in the
  same turn after the inert file copy. The managed agent loads the verified
  installed skill directly, runs preflight, initializes and links its public
  identity, then asks about one contextual demo. It never stops at “available
  next turn” or asks the human to repeat the setup request; an explicit
  files-only instruction remains the opt-out.
- **Buzz CLI convergence:** onboarding now treats Run402 v4.17.2 as the minimum
  semantic client because that release made safe relay availability warning-only
  for founder setup. A missing or older user-global CLI is upgraded and verified
  agent-side before doctor runs; the human is no longer sent a stale relay repair.
- **Cross-platform Buzz installation:** the agent bootstrap now treats the
  installer working directory, `DO_NOT_TRACK` child environment, and command as
  separate values, with explicit POSIX, PowerShell, and `cmd.exe` renderings.
  Windows agents are no longer given Bash-only `NAME=value command` syntax.
- **Windows Buzz runtime:** released-Buzz capability probes now match command
  semantics instead of the platform-rendered `buzz`/`buzz.exe` program name.
  The setup helper invokes npm's `npm-cli.js` and Run402's `cli.mjs` through the
  exact managed Node executable with `shell: false`, including install/upgrade,
  and classifies a refused process boundary separately from an npm repair.
- **Demo-first adoption:** the SDK and `run402 buzz adopt offer` expose durable,
  inert HTTPS ownership handoffs after a verified deployment. The short Buzz
  signing attempt is created only after direct human login and fresh passkey;
  the existing direct-adoption flow remains an explicitly advanced fallback.
- **MCP and skill:** `whoami` renders pending offer handoffs without adding a
  signing mutation, and the `run402-buzz` skill now demonstrates a contextual
  deployment before offering human co-ownership. Testnet faucet/tier plumbing
  stays in structured receipts instead of conversational price language, and
  the founder agent remains an owner after adoption.

## Unreleased — a paid call says what it paid

- **SDK:** `ResponseEnvelope` gains an optional `settlement` (`network`,
  `transaction`, `payer`, `success`), decoded from the response's
  `PAYMENT-RESPONSE` receipt. The key is **omitted entirely** when no payment
  settled, so envelope shapes are unchanged for every existing consumer.
  `GenerateImageResult` gains `payment: PaymentSettlement | null`.
- **MCP (fix):** `generate_image` reported only `Generated square image
  (image/png)` after moving money — no amount, payer, transaction or network.
  Because the documented quickstart faucet-funds Base Sepolia, a buyer could
  watch a payment succeed with no way to learn it was test money, and the
  claims wall would then refuse the transaction they had just made. It now
  reports what settled and, on a testnet, says plainly that it is not a real
  payment. `pay_url` in the same server already did this.
- **Observed, never inferred:** the testnet warning keys on the settlement
  receipt's network, not on local wallet config — a buyer holding mainnet funds
  would make a config-derived guess wrong.
## Unreleased — the mainnet on-ramp is visible from the tool surface

- **MCP (fix):** `allowance_export`'s description and `init`'s buyer next-step
  now state that `request_faucet` funds Base **Sepolia** only, and that paying
  with real USDC on Base **mainnet** means sending USDC to the exported address.
  The path already existed and was documented in `llms-mcp.txt`, but nothing in
  the tool surface mentioned it — so an agent running
  `RUN402_MCP_PROFILE=buyer`, which exists precisely so it can work from the
  tool surface alone, would follow the faucet, settle on testnet, and never
  discover that a real payment was possible.

## Unreleased — buyer-profile guidance stops naming tools it withholds

- **MCP (fix):** under `RUN402_MCP_PROFILE=buyer`, guidance no longer recommends
  tools the profile does not register. `allowance_status` / `allowance_export` /
  `request_faucet` pointed at `allowance_create`, and `init` closed with
  *"Next: use `set_tier`"* — none of which a buyer has, and a tier is not what
  someone buying a $0.03 image came for. They now point at `init` and
  `generate_image` respectively. The full (default) surface is unchanged.
- **MCP (internal):** `TOOL_PROFILES` moves to `src/tool-profiles.ts` so tool
  modules can ask `isToolAvailable()` before naming a tool, with a shared
  `noAllowanceHint()` for the sentence five call sites needed.
- **Tests:** new `profile-guidance.test.mjs` fails the build if guidance
  reachable under a profile names a tool that profile withholds. It is
  reachability-aware (a tool outside the profile cannot show its own guidance)
  and scans whole statements rather than lines.

## Unreleased — `npx run402-mcp` can pay

- **MCP (fix):** `run402-mcp` now declares `@x402/evm`, `@x402/fetch`, `viem`
  and `mppx` as real `dependencies`. Three were in `devDependencies` and `mppx`
  was absent entirely, so `npx run402-mcp` — the install line in the MCP
  registry entry, the README, `llms-mcp.txt` and our docs — could not make a
  paid request: `generate_image` returned the raw `402` challenge and never
  paid. A dev-only declaration is present exactly where tests run and absent
  exactly where users install, so the paid path passed CI while being unusable
  by every consumer.
- **Tests:** `cli-paid-stack-deps.test.mjs` becomes `paid-stack-deps.test.mjs`
  and now gates **every published application** (CLI *and* MCP server), not
  just the CLI, adding an assertion that no paid-stack peer hides in
  `devDependencies`. The previous gate's own docstring described this failure
  happening once before in the CLI; it was pointed at only one of the two
  packages it needed to cover.

## Unreleased — binary-safe content sources

- **SDK:** string sources paired with known binary paths or MIME types now fail
  locally with `BINARY_CONTENT_REQUIRES_BYTES` before hashing or network
  traffic. Raw bytes, browser `Blob`/`File`, streams, and filesystem helpers
  remain byte-exact; textual formats including SVG continue to accept strings.
- **Docs/tests:** upload guidance now states that CAS validates the submitted
  bytes, not any bytes discarded by a prior text decode, with canonical Node,
  browser, raw `/content/v1`, and directory-helper paths. Regression tests pin
  byte-exact filesystem hashing and the pre-network guard.

## Unreleased — Buzz community control plane

- **SDK/CLI:** added capability-detecting `buzz` status, human-adoption, community-installation, and per-agent enrollment namespaces plus goal-shaped `run402 buzz ...` workflows. All mutation commands use idempotency keys, JSON stdout, zero-spend receipts, and reject secret-shaped input locally.
- **MCP/OpenClaw:** `whoami` and project reads render independent Buzz lifecycle/provenance state and exact CLI handoffs. Signing and authority mutations remain intentionally absent from MCP.
- **Buzz skill:** setup now derives the normalized community from Buzz's released relay context, discovers Run402-verified active defaults, and offers bounded enrollment before org-of-one provisioning without selecting ambiguously or reusing another agent's profile. Buzz itself remains unchanged. Fizz/Honey examples document pending, denial, drift, revoke, and fallback outcomes.

## Unreleased — public Buzz/Nostr agent attribution

- **Human and agent attribution:** public identity links now use one
  protocol-discriminated `idlnk_…` representation for human and agent
  principals. A principal may hold multiple distinct Nostr subjects; each
  active subject remains globally unique. Human creation/revocation is the
  browser/passkey/Buzz flow, while the existing EOA-plus-kind-1 CLI/SDK flow
  remains the agent ceremony.
- **Adoption lifecycle:** completed human adoption is a terminal consent
  receipt with two separately revocable effects: a public human identity link
  and an ordinary owner membership. Only membership grants organization
  authority; revoking either effect does not rewrite the receipt or revoke the
  other.
- **Public reads and guidance:** SDK types, CLI output, MCP renderers, skills,
  and documentation preserve link id, subject, proof protocol, and lifecycle,
  and explicitly distinguish public attribution from organization authority.
- **SDK:** added `r.identityLinks` with staged Nostr challenge/complete, list, public-proof read, and revoke operations. The Node credential provider signs only the server-authored EIP-191 bytes with the active Run402 EOA; it rejects secret-shaped Nostr input locally.
- **CLI/OpenClaw:** added `run402 identity link nostr begin|complete` and `identity link list|show|revoke`, with exact JSON stdout, structured recovery errors, and raw seven-field Buzz event ingestion.
- **Existing reads:** whoami, project, deployment, and transfer renderers preserve additive immutable identity/actor provenance without treating linked identities as authentication, authorization, ownership, payment, or transfer authority.
- **Buzz integration:** moved the single self-contained `run402-buzz` skill to top-level `buzz/`, added idempotent user-global CLI/profile/link setup and verified `Deployment: none` readiness, then an approval-gated contextual test offer. Released-client fixtures, the no-shell helper, golden vector, and security guidance move with the installed package; the fixed feedback-board demo is removed.

## Unreleased — email code authentication

- **SDK:** `requestMagicLink` accepts `delivery: "link" | "code" | "both"`
  with a conditional redirect requirement and now returns
  `MagicLinkRequestResult` (`message`, warnings, optional `challengeId`). Added
  `verifyEmailCode(projectId, { challengeId, code })`, the project-scoped
  wrapper, typed provider `magic_link.deliveryModes`, and link-only fallback
  for older discovery responses. Ordinary await-and-ignore callers keep
  working; callers or mocks explicitly constrained to `Promise<void>` must
  update their annotation/result.
- **CLI/MCP/OpenClaw:** the existing request operation accepts delivery mode;
  the existing verify operation accepts exactly a link token or challenge/code
  pair. Output preserves accepted wording, warnings, and opaque handle. No
  duplicate command or MCP tool was added, and code verification is never
  automatically retried or persisted.
- **Rate limits:** email-auth sends now use the gateway's durable shared
  email/project/IP policy. An exact project test identity omits only the
  per-email bucket; project and IP protection remain.

## Unreleased — arbitrary x402 buyer

- **Verified merchant evidence:** SDK `requireReceipt`, CLI
  `--require-receipt`, and MCP `require_receipt` verify direct wallet-rooted
  `offer-receipt` evidence and return one canonical
  `x402-commerce-result.v1`. Pre-payment failures move no funds;
  post-settlement `PaymentPolicyError` preserves the paid response and never
  recommends another payment. Delegated authorization remains fail-closed
  until the standards package carries an interoperable authorization.
- **Caller-keyed recovery:** trusted Run402 managed/deployment-host pending
  responses preserve payment ids, dedupe/movement/delivery facts, exact
  pending/drain/fence/destination errors, and gateway `next_actions`. The
  mode-0600 journal records only a caller-key digest, payment id, and retry
  timing—never the raw key or signed proof. Custom domains fail closed.
- **Safe rollout errors:** `PAYMENT_CALLER_IDENTITY_NOT_ACTIVE` is preserved as
  an exact buyer error with keep-the-key guidance; clients never downgrade an
  unseen keyed purchase to proof-only behavior.
- **SDK:** added `r.pay.fetch(url, init?, { maxUsdMicros?, idempotencyKey? })`, with a $0.10 default ceiling, unpriced pass-through, faithful settlement receipts, and structured `PaymentBuyerError` codes.
- **Retry safety:** the Node buyer retains signed proofs only in memory and re-presents the byte-identical proof for an identical retry after an ambiguous transport failure. Used-proof responses report `already_settled` without inventing a transaction receipt; durable attempt journals remain proof-free.
- **CLI/MCP/OpenClaw:** added `run402 pay <url>` and `pay_url` as thin SDK shims, including exact USD-to-micros CLI parsing and Idempotency-Key forwarding.
- **Docs/tests:** unit coverage pins price ceilings, insufficient funds, unsupported networks, self-pay rejection, settlement receipts, proof reuse, CLI/MCP delegation, sync parity, and an opt-in live paid-route test. SDK docs include the raw challenge → proof → settlement → identical-proof retry protocol.

## Unreleased — Telegram notification channel + routing rules

- **SDK:** added `r.admin.channels.{connectTelegram, list, revokeTelegram}` and `r.admin.rules.{list, create, update, delete}` (self-serve Telegram push on top of the v1.55 operator-notifications substrate). `admin.testNotification(opts?)` now accepts `{ source?, eventType? }` and its result carries `telegram.destinations[]`, the per-binding delivery outcome for the synthetic event.
- **CLI:** `run402 notifications channels connect telegram [--label X]` prints the connect/connect-group deep links and polls `channels list` until the binding activates or the code expires; `channels list`/`channels revoke <binding_id>`; `notifications rules add --binding <id> [--project <id>] [--source app|platform] [--type a,b] [--class a,b]` / `rules list` / `rules rm <rule_id>`; `notifications test` gained `--source`/`--type`. `--help` on `channels`/`rules` teaches the full rule model (ANDed match dimensions, absent = wildcard, one rule -> one chat, no rules -> no Telegram traffic, mandatory email floor untouched).
- **MCP:** added `list_notification_channels`, `list_notification_rules`, `create_notification_rule`, `delete_notification_rule`; `test_notification` gained optional `source`/`event_type` params. Connecting/revoking a Telegram binding stays CLI/SDK-only (blocks on a human tapping a Telegram deep link out-of-band).
- **Docs/tests:** CLI/SDK/MCP references and `llms-*.txt` document the new surface; `sync.test.ts` SURFACE/SDK_BY_CAPABILITY cover it end-to-end.

## Unreleased — resilient x402 balance preflight

- **Node SDK:** x402 USDC balance reads now use bounded retry/backoff with independent Base and Base Sepolia RPC failover. RPC exhaustion remains an unknown balance and never collapses to numeric zero.
- **Errors/recovery:** `X402BalanceError` distinguishes timeout, rate-limit, general RPC-unavailable, and confirmed-insufficient states. Only pre-payment RPC errors are marked `safeToRetry`, and transient failures are not permanently cached by lazy paid-fetch initialization.
- **Tests/docs:** deterministic tests cover retry, provider failover, faithful insufficient-funds classification, and recovery on the next request; SDK references document the stable codes and no-secret error details.

## Unreleased — deterministic x402 payer selection

- **Node SDK:** `run402({ allowancePath, credentials })` now uses the explicit allowance as the x402 payer while retaining the supplied provider for API auth. Custom providers with `readAllowance()` also fund paid fetch without rereading the ambient wallet.
- **Opaque signers:** `paymentSigner` supports async Base x402 signers backed by KMS/HSM-style providers without exposing raw private keys; conflicting explicit signer/path configuration fails with `PAYMENT_SOURCE_CONFLICT`. `r.paymentPayer()` reports only safe source/rail/public-address/network provenance.
- **Recovery/tests:** lazy paid-fetch initialization retries after the selected allowance/provider becomes available, while successful initialization remains cached. Focused tests cover path/provider precedence, fail-closed behavior, conflicts, opaque signer provenance, and recovery.

## Unreleased — phase-aware durable x402 attempts

- **Node SDK:** automatic x402 failures now throw `PaymentAttemptError` with a stable `paymentAttemptId`, phase, canonical code, retry safety, mutation state, and structured next actions instead of leaking raw `@x402/fetch` `TypeError`s.
- **Safety:** a sanitized mode-0600 intent is committed before the payment-bearing request. Failures before provider dispatch are `not_started` and safe to retry; transport failures and non-success responses after dispatch are `ambiguous`, never safe to retry, and require polling/reconciliation by attempt id. Signed payment headers, keys, raw paths, request bodies, query strings, and raw causes are never journaled or serialized; URL paths are represented only by SHA-256 fingerprints.
- **Correlation:** the reserved `X-Run402-Payment-Attempt-Id` is claimed atomically across processes and attached only to the payment-bearing request, with redirects disabled for that request so neither the correlation id nor signed payment authorization can cross to a redirect target. Existing and malformed attempt ids fail closed before network dispatch to prevent accidental payment replay. `readPaymentAttempt()` and `listPaymentAttempts()` expose the local redacted journal for diagnostics and surface corrupt records distinctly from missing ones; corruption is payment-safe but not advertised as automatically retryable.

## Unreleased — function runtime compatibility metadata

- **SDK/CLI:** function-list records now type and preserve the deployed `runtime_version`, gateway `runtime_current_version`, guaranteed `runtime_minimum_version`, and `runtime_stale` fields.
- **MCP:** `list_functions` renders those fields as a compatibility table, includes legacy/unknown deployed versions, and points stale rows at `functions_rebuild`.
- **Docs/tests:** public references explain that the `3.7.0` minimum includes `getRoutedPaymentContext()` for priced routes and cover SDK, CLI, and MCP pass-through/rendering.

## Unreleased — paid function idempotency

- **SDK:** `functions.invoke()` accepts `idempotencyKey` for paid direct invocations and preserves the real HTTP status, including 202 run handles. Passing `wait` polls the returned run and replays the same key for the retained result.
- **CLI/MCP:** `run402 functions invoke` and `invoke_function` expose the same paid-call contract: stable key in, pollable run id or final replayed result out, with structured errors left intact for agents to branch on.
- **Docs/tests:** CLI, SDK, MCP, OpenClaw, and agent references now document paid invoke retry safety and cover replay-after-wait.

## Unreleased — propagation-aware app verification

- **SDK/CLI:** app-manifest HTTP verification now distinguishes fresh Run402 edge propagation misses from permanent failures. `run402 up` and `r.up()` report `propagation_pending` with diagnostics, warnings, `next_action`, and per-check `propagation_wait_ms` while a managed subdomain/custom domain is still converging; `--propagation-budget-s` / `propagationBudgetSeconds` control the wait and `--no-propagation-wait` / `propagationWait: false` return immediately.
- **CLI/SDK:** `run402 up verify` and `r.up({ verifyOnly: true })` rerun app HTTP verification without uploading, deploying, creating projects, or mutating resources.
- **MCP/docs:** deploy resolve/diagnose surfaces now preserve `edge_propagation` diagnostics and non-settled retry guidance so agents can tell propagation from an actual broken deploy.

## Unreleased — data snapshots, branches, and apply rehearsal

- **SDK:** added typed `snapshots` and `branches` namespaces, scoped project helpers, `p.apply.rehearse(planId, { teardown })`, and deploy response types for `rehearsal`, `restore_point`, and `snapshot_skipped_reason`.
- **CLI/OpenClaw:** added `run402 apply --rehearse`, `run402 deploy rehearse`, `run402 snapshots create|list|get|restore|delete`, `run402 branches create|list|renew|delete`, and archive aliases `projects export` / `core projects apply`.
- **MCP/docs:** added `deploy_rehearse`, project snapshot tools, branch tools, and sync coverage for the new public surface.

## 4.0.0 — ProjectDomain lifecycle and retired split domain commands

- **SDK:** `domains.ensure/get/list/check/apply/repair/testReceive/wait/activate/disconnect` now target the project-scoped ProjectDomain API (`/projects/v1/:project_id/domains/:domain`) with control-plane auth and no local project-key cache preflight. Legacy `domains.add/status/remove` and `senderDomain.*` fail locally with `COMMAND_REMOVED` and replacement guidance.
- **CLI:** `run402 domains connect/list/status/dns/check/apply/repair/test-receive/wait/activate/disconnect` is the canonical custom-domain workflow. Removed `run402 domains add`, `run402 domains delete`, and all `run402 sender-domain *` subcommands now return machine-readable `COMMAND_REMOVED` envelopes.
- **MCP/OpenClaw/docs:** ProjectDomain tools and docs replace the old sender-domain/inbound-domain split, including DNS/check output, receive tests, repair actions, managed fallback, first-contact inbound policy, suppression management, and validation-safe raw send behavior.

## Unreleased — content-tracked deploy migrations

- **SDK/CLI/MCP:** deploy migration authoring now accepts exactly one of `id` or `name`. `id` keeps the existing immutable versioned semantics; `name` is content-tracked and compiles client-side to `<name>_<sha256(sql)[0:16]>` from inline SQL, post-build `sql_path`/`sql_file` bytes, or `sql_ref.sha256`. The gateway wire spec still receives only `id`.
- **Typed configs:** `sqlFile(path, { name })` exposes the same content-tracked path for generated/idempotent SQL.
- **Docs/schemas:** release/app schemas, examples, CLI/SDK/MCP references, and recovery guidance now document the idempotency contract and the `id` -> `name` recovery path for generated SQL that hit `MIGRATION_CHECKSUM_MISMATCH`.

## Unreleased — remove `projects.json` as project truth

- **CLI/SDK:** normal project reads and active selection are now server-authoritative. `run402 projects use <id>` / `r.projects.use(id)` validate through the control plane and store only an active project id; `r.project(id)` no longer requires local key-cache membership before server-capable operations.
- **Credential cache:** local anon/service-key material moved behind explicit `run402 credentials project-keys list|status|import|export|remove` commands. Redacted reads identify `source: "local_cache"`; secret export requires `--reveal`, and imports use stdin/env rather than literal argv secrets. Legacy `projects.json` is one-way migration input only.
- **Domains:** custom-domain commands default to principal auth with explicit `project_id`; `--auth service-key` opts into the local service-key cache path and reports `PROJECT_CREDENTIAL_NOT_FOUND` when the selected profile lacks keys.
- **Tests/docs:** sync now tracks the new local credential-cache commands and guards custom-domain handlers against local cache preflights; CLI docs, README, SDK README, SKILL, and OpenClaw docs teach the server-vs-cache split.

## Unreleased — CLI update awareness and client metadata

- **CLI:** `run402 up` and other deploy-oriented flows can now surface cached stale-CLI notices without changing success stdout or exit code. Notices are structured JSON on stderr, or `cli.update_available` NDJSON events in `--json-stream`, with install-context-aware `upgrade_client` actions for local, global, npx/npm exec, pnpm/yarn/bun, and custom-path invocations. `run402 doctor --refresh` is the explicit bounded live npm check.
- **SDK:** `@run402/sdk/node` attaches bounded unprefixed `Run402-Client` metadata on gateway requests (`surface`, client version, SDK version). Direct Node SDK callers identify as `sdk`; CLI-created clients identify as `cli`; browser/isomorphic clients remain header-free unless explicitly opted in.
- **Tests/docs:** added update-check cache/fail-open/install-context coverage, CLI stdout/stderr channel tests, SDK metadata tests, and docs for the advisory update contract.

## Unreleased — self-hosted Core target config

- **CLI:** `run402 init --api-base=<url>` now persists the active API target for the current profile without creating a Cloud allowance, requesting faucet funds, or requiring a Cloud tier. `run402 projects provision --name ...` and `run402 deploy apply --manifest ...` use that configured Core target and active project. `run402 up` now exits nonzero when app HTTP verification fails after deployment instead of looking successful while recording the app install as failed.
- **SDK/MCP:** `@run402/sdk/node` and the MCP SDK singleton inherit the same configured API base by default; explicit constructor options or `RUN402_API_BASE` still override it. Function capabilities now flow through SDK/CLI manifest normalization, the ReleaseSpec schema documents the same function metadata accepted by the normalizer, and the Astro release slice marks SSR functions with `capabilities: ["astro.ssr.v1"]` for Core compatibility.
- **Tests/docs:** added focused Core-target coverage for init, project provision, deploy apply, SDK config loading, and config precedence; CLI/OpenClaw/SDK docs now show the self-hosted Core command path.

## Unreleased — close final CLI plain-text default

- **CLI:** `run402 allowance export` now emits `{ "address": "0x..." }` instead of a bare address. The CLI contract is JSON-by-default for machine-readable commands; raw/text stdout requires an explicit raw/file-output mode, while help/version/dev remain human surfaces.
- **Tests/docs/spec:** `cli-output-contract.test.mjs` now subprocess-checks `allowance export`, and the CLI docs/spec no longer advertise a plain-text default-output carve-out.

## Unreleased — configurable mailbox footer policy

Adds downstream parity for gateway issue `configurable-email-footer` / run402#474.

- **SDK:** mailbox records now type the footer policy fields (`footer_policy`, `effective_footer_policy`, `footer_policy_locked_reason`) and `r.email.updateMailbox(projectId, { mailbox?, footer_policy })` PATCHes `/mailboxes/v1/:mailbox_id`.
- **CLI/MCP/OpenClaw:** `run402 email update <slug|mbx_id> --footer-policy run402_transparency|none` and MCP `update_mailbox` expose the same mailbox update path. Existing mailbox reads surface configured/effective footer policy.
- **Docs/tests:** parity tests cover the new SDK/CLI/MCP/OpenClaw capability, and docs call out the tier gate: `none` is hobby/team-only; prototype projects remain locked to `run402_transparency` and surface `FOOTER_POLICY_TIER_REQUIRED`.

## 3.4.0 — SDK call-shape conventions (scope handles + options objects)

Codifies one call-shape rule — at most one leading id/handle positional; no same-type positional pair and no boolean positional — and closes the audited gaps. Additive: every reshaped method keeps its positional overload, now `@deprecated`, which emits a one-time **stderr** notice (silence with `RUN402_SUPPRESS_DEPRECATIONS=1`). No removals.

- **New scope handles.** `r.wallet(address)` (`getLabel()` / `setLabel(label)`) and, on the existing `r.admin`, `r.admin.org(orgId)` (`pinLease()` / `unpinLease()`) and `r.admin.project(projectId)` (`archive(opts?)` / `reactivate()` / `finance(opts?)`).
- **Boolean trap removed.** `admin.setLeasePerpetual(orgId, perpetual)` → `r.admin.org(orgId).pinLease()` / `.unpinLease()`.
- **Options-object reshapes.** `domains.add(projectId, { domain, subdomainName })`, `subdomains.claim({ name, deploymentId, ...opts })`, `secrets.set(projectId, key, { value })`, `org.members.setRole(principalId, { role })`, `admin.transfers.cancel(transferId, { reason })`, and `projects.rest(table, { query })` (the bare-string query is deprecated). Each new form is byte-identical on the wire to its deprecated positional form.
- **First-party canonical-only.** All CLI (`cli/lib/*`) and MCP (`src/tools/*`) callers use the new shapes; a `sync.test.ts` source guard fails the build if a fully-deprecated method reappears in first-party code.

## Unreleased — project transfer to owned org

Adds the public client surface for gateway issue `project-transfer-to-owned-org` / run402#469.

- **SDK:** `r.admin.transfers.initiate` now accepts a third typed recipient shape, `{ projectId, toOrgId, message? }`, posting `{ to_org_id }` to the existing `/projects/v1/:project_id/transfers` endpoint. The response is typed as an immediate accepted result with returned project keys; the SDK persists those keys via `saveProject` + `setActiveProject` when available.
- **CLI/MCP:** `run402 transfer init --to-org <org_id> --project <project_id>` and MCP `initiate_project_transfer { to_org_id }` route through the same SDK primitive. Client-side validation enforces exactly one of wallet/email/org recipients and keeps wallet-only flags (`--billing-policy`, `--kysigned` / `billing_policy`, `kysigned_record_id`) and email-only retention on their rails.
- **Docs/tests:** OpenClaw inherits the CLI re-export; SDK, CLI, MCP, skill, OpenSpec, and drift tests document/pin the three-recipient transfer model.

## Unreleased — agent ergonomics: optional project_id + working service-key REST

Public-repo quick wins surfaced by the MCPMark run (no backend changes).

- **DB tools default to the active project.** `run_sql`, `get_schema`, and `rest_query` now take an **optional** `project_id`; when omitted they resolve the active project (set by provisioning or `run402 projects use <id>`). Removes the per-call id tax for an agent working against one project — an explicit id still wins, and a clear error is returned when neither is available. (`src/active-project.ts`, `src/tools/{run-sql,get-schema,rest-query}.ts`)
- **`rest_query` `key_type: "service"` works again.** The SDK was sending the service key to the public PostgREST path (`/rest/v1/*`), which the gateway rejects with `ADMIN_REQUIRED`. Service-key REST now routes through the admin REST route (`/admin/v1/rest/*`), so RLS-bypassing reads/writes succeed; the tool's path label reflects the route actually used. Anon keys are unchanged. (`sdk/src/namespaces/projects.ts`, `src/tools/rest-query.ts`)

Tests: active-project fallback in `src/tools/run-sql.test.ts`; admin REST routing in `sdk/src/namespaces/projects.test.ts`.

## 2.38.1 — `run402-mcp` SQL feedback + 403 hint fixes

Two `run402-mcp` tool fixes surfaced while benchmarking the MCP server against MCPMark. `@run402/sdk` and `run402` (CLI) have **no code changes** — the CLI already emits the raw `{ rows, rowCount }` JSON.

- **`run_sql` no longer reports "0 rows returned" for mutations and DDL.** The handler built its summary from `rows.length` and ignored the `rowCount` the gateway returns, so an `INSERT`/`UPDATE`/`DELETE` that changed N rows — and every `CREATE TABLE`/`CREATE INDEX` — printed "0 rows returned", which reads to an agent like the statement no-op'd (and burns round-trips re-checking). Now keyed on the gateway's row semantics: a result set → "N rows returned" + table; a mutation without `RETURNING` → "N rows affected" (singularized); a no-match mutation or empty result → "0 rows"; DDL (`rowCount: null`) → "Statement executed". (`src/tools/run-sql.ts`)
- **403 errors no longer claim "the project lease may have expired" for blocked operations.** `FORBIDDEN` (blocked SQL such as `CREATE ROLE`/`CREATE SCHEMA`/`CREATE EXTENSION`/`GRANT`) and `ADMIN_REQUIRED` (e.g. `service_role` on `/rest/v1/*`) now get accurate, code-specific next-step guidance instead of the generic lease-expiry text that sent agents on a dead-end `get_usage`/`set_tier` detour. Code-less 403s (e.g. with a `renew_url`) keep the lease hint. (`src/errors.ts`)

Drift-protection tests added in `src/tools/run-sql.test.ts` and `src/errors.test.ts`.

## Unreleased — Pre-launch JSON-only cleanup, part 2 (6 commands)

Follow-up to the 2.23.0 cleanup. Closes the remaining "text-by-default with `--json` opt-in" violations across 6 commands. Since there are no users yet, this is pre-launch cleanup shipped as a minor — no migration guidance needed. `@run402/sdk` and `run402-mcp` have **no code changes**.

Affected commands (all now JSON-by-default; the `--json` flag is removed):

- **`run402 cache inspect`** — stdout was a multi-line indented text report; now the JSON cache-row object.
- **`run402 cache invalidate`** — stdout was `Invalidated N cache row(s) on HOST for PATH (generation: G)`; now `{ deleted, host?, path?, generation }`.
- **`run402 doctor`** — stdout was a ✓/⚠/✗ checkmark report; now `{ ok, checks: [...] }` (the per-check `status` strings inside `checks[]` are payload data, not the forbidden top-level envelope).
- **`run402 init`** (default rail setup) — stdout was a human banner; now the JSON summary (`{ config_dir, allowance, rail, network, balance, tier, projects_saved, next_step }`). Progress lines (`Config / Allowance / Balance / Tier / Next`) stay visible to humans — they go to stderr.
- **`run402 init astro <dir>`** — stdout was `Scaffolded ... / Files created: / Next steps:` prose; now the JSON summary (`{ dir, files_created, created, next_steps }`). Progress lines moved to stderr.
- **`run402 logs --request-id <req>`** — stdout was `[ts] [fn] msg` aggregated text lines + a footer; now the JSON envelope (`{ ok, request_id, project_id, scanned, entries, errors? }`).

Drift-protection tests added in `cli-argv.test.mjs` suite "CLI JSON-only output contract (v3.x cleanup)" pin the new shapes.

### Other fixes shipped in the same release

- **Scaffold template fix**: `run402 init astro` was writing `src/pages/[slug].astro` with `import { db, getUser, cache } from "@run402/functions"`. Under `@run402/functions@3.0+`, the `getUser` bare export throws `R402_AUTH_UNKNOWN_EXPORT` at runtime — so the scaffolded template would fail the first time a user ran it. The template now imports only `db` (the `getUser` and `cache` imports were dead anyway — the template body didn't call them).
- **`run402 logs` aggregated entries unwrap**: the SDK's `functions.logs(...)` returns `{ logs: FunctionLogEntry[] }`, but the aggregator in `cli/lib/logs.mjs` wasn't unwrapping `.logs` — meaning the emitted JSON had `entries[i]` as the wrapper `{ logs: [...] }` object instead of the actual log entry. Same place: the timestamp sort read `e.ts` (a key that doesn't exist on `FunctionLogEntry`), so entries were never sorted. Both surfaced when the new JSON-by-default contract was test-covered; both are fixed.

## Unreleased — CLI JSON-only output cleanup (breaking)

Follow-up to 2.16.0: tightens the CLI's machine-readable contract by closing four "mixed-shape" violations of the JSON-only-by-default stance. `@run402/sdk` and `run402-mcp` have **no code changes**.

The historical plain-text carve-out is no longer part of the current CLI contract. This change reclassifies the previously-undocumented binary/text-leak paths as **not** carve-outs:

- **`run402 functions invoke` now JSON-wraps the result by default.** Stdout is `{ http_status, body, duration_ms }`. The HTTP status is exposed as `http_status` (not `status`) so the payload stays clean of the reserved top-level `status` field used in the stderr error envelope. Add `--raw` to opt back into the previous shape — string body → text + trailing newline; JSON body → pretty-printed JSON — useful when piping a CSV / binary-blob function response straight to a file: `run402 functions invoke prj_abc csv --raw > export.csv`.
- **`run402 functions logs --follow` now emits NDJSON** — one JSON log entry per line, no `[ts] message` text formatting. The non-follow batch path still emits a single `{ logs: [...] }` JSON object (unchanged). Shell consumers that grepped the old `[ts] msg` format need to switch to per-line JSON parsing (`| jq -c '.message'`).
- **`run402 email get-raw` now requires `--output <file>`.** Previously, omitting `--output` wrote raw MIME bytes directly to stdout — binary on stdout breaks pipes. Now `--output` is mandatory; stdout is the JSON envelope `{ message_id, bytes, output }`. Scripts that ran `run402 email get-raw msg_x > file.eml` need to switch to `run402 email get-raw msg_x --output file.eml`.
- **`run402 assets put` flag `--json` renamed to `--stream`.** The old name was misleading — both with and without the flag, stdout is JSON; `--stream` only controls whether per-file NDJSON progress events are emitted instead of the final results array. `--json` is preserved as a deprecated alias that prints a one-line warning to stderr; scheduled for removal in a future major.

Drift-protection tests in `cli-argv.test.mjs` (suite "CLI JSON-only output contract (v3.x cleanup)") pin each new shape.

### Compatibility-check checklist

If your automation parses any of these commands' stdout:

- `run402 functions invoke …` — read `body` from the envelope, or add `--raw` to keep the old verbatim-body behavior.
- `run402 functions logs … --follow` — parse each stdout line as a separate JSON object instead of regexing `[ts] msg`.
- `run402 email get-raw …` — add `--output <file>` to every call; read MIME bytes from disk, not stdin.
- `run402 assets put … --json` — rename to `--stream` to silence the stderr deprecation notice (behavior is identical).

## 2.16.0 — unreleased — CLI stdout envelope normalization

Drops the `status: "ok"` wrapper from every `run402` CLI success-path stdout emission, unifying an envelope that was applied to roughly half the subcommands and absent from the other half. The current contract lives in [`cli/llms-cli.txt`](cli/llms-cli.txt).

`@run402/sdk` and `run402-mcp` have **no code changes** in this release. Only the CLI's machine-readable stdout shape moved. Per the lockstep release policy, all three packages bump to 2.16.0 together.

### Compatibility note (read this if you parse CLI JSON output)

The `run402` CLI was agent-first and JSON-only by design, but its stdout envelope was never documented — about half of subcommands wrapped success payloads as `{ status: "ok", ...payload }`, the other half emitted the raw payload. The wrapper has been dropped across the board, the contract is now explicit in [`cli/llms-cli.txt`](cli/llms-cli.txt), and a drift-protection test (`cli-output-contract.test.mjs`, wired into `npm test`) prevents the inconsistency from coming back.

If you have automation parsing CLI output:

- **Drop any `.status === "ok"` checks.** They were never load-bearing for half the commands, and now load-bear for none. Gate on exit code (`0` = success, non-zero = error) instead.
- **Mutations with no natural payload now echo identifier + state field:**

  ```
  # Before
  $ run402 secrets set prj_abc FOO bar
  {"status":"ok","message":"Secret 'FOO' set for project prj_abc."}

  # After
  $ run402 secrets set prj_abc FOO bar
  {"key":"FOO","project_id":"prj_abc","set":true}
  ```

- **`run402 status` and `run402 allowance status` move special statuses into typed nullable payload fields and exit 0 when absent** (was exit 1 with `status: "no_allowance"` / `status: "no_wallet"`):

  ```
  # Before
  $ run402 allowance status      # exit 1
  {"status":"no_wallet","message":"No agent allowance found. Run: run402 allowance create"}

  # After
  $ run402 allowance status      # exit 0
  {"wallet":null,"hint":"Run: run402 allowance create"}
  ```

- **What did NOT change:** stderr error envelopes (still `{ status: "error", code, message, ... }` with non-zero exit), all SDK return types, all MCP tool output shapes, per-item `status` fields inside payload objects (e.g. `run402 doctor`'s `checks[].status`).

### Added

- `cli/llms-cli.txt` now leads with an explicit "Output Contract" section documenting the stdout / stderr / exit-code shape across every subcommand.
- `cli-output-contract.test.mjs` — drift-protection test that fails CI on any new top-level `JSON.stringify({ status: ... })` emission outside `cli/lib/sdk-errors.mjs`.

### Changed

- 68 success-path emit sites across 19 `cli/lib/*.mjs` files dropped their `status: "ok"` wrapper. Three `console.error(JSON.stringify({ status: "error", ... }))` sites in `cli/lib/init.mjs`, `cli/lib/projects.mjs`, and `cli/lib/sites.mjs` now route through `fail()` in `cli/lib/sdk-errors.mjs` instead of emitting the error envelope inline.
- `~50` test assertions in `cli-e2e.test.mjs` migrated from `parsed.status === "ok"` to assertions on the new payload-specific fields. The two `CLI status exit codes (GH-191)` tests now assert the new exit-0 typed-null behavior for absent local state.

## 2.4.0 — unreleased

Surfaces the v1.56 gateway verification-no-silent-fail bundle ([parent change: `verification-no-silent-fail` in run402-private](https://github.com/kychee-com/run402-private/tree/main/openspec/changes/verification-no-silent-fail)). Closes a class of UX bugs where SES auth-verdict rejections silently failed operator email verification with no signal to the operator. Additive — old clients silently ignore the new fields.

### Added

- **`run402 doctor` surfaces per-attempt verification failure detail** (`cli/lib/doctor.mjs`). When `operator_email` is `pending` and the gateway's `email_verification.last_challenge.hint` is populated, doctor renders it inline: `operator email not verified (1/5 attempts used, 4 remaining): SES reported FAIL on: spf. Fix the corresponding DNS records on <domain> and reply again. 4 more attempts remain.` — instead of the previous generic "email not verified" message that gave the operator no actionable signal.
- **`run402 agent status` includes `email_verification.last_challenge` block** (`cli/lib/agent.mjs`). Best-effort fetch from `/agent/v1/operator/status` is merged into the response so a single command surfaces the full challenge state: `attempts[]` with per-reason `at`, `from_address`, `reason` (one of `trust_rejected | from_mismatch | threading_miss | code_mismatch`), `sender_trust` verdicts, plus `attempt_count`, `remaining_attempts`, and the gateway-computed `hint`. Older gateways silently keep the original response shape.

### Changed

- **Doctor's `operator_health` check is now strictly more informative** when `email_status !== "verified"`. No behavior change for already-verified operators. The threshold for "warning" status is unchanged; only the message detail improves.

### Out of scope (deliberate carve-out)

- No SDK type changes — `email_verification` is consumed dynamically because the v1.55 SDK already returns the rest of the operator-status response as `unknown`-shaped JSON pass-through, and adding strict types here would force a parallel public-repo edit on every gateway-side field addition. Future work: type the operator-status response shape end-to-end.

## 3.7.0 — unreleased

### Added

- **Typed deploy config DX.** `@run402/sdk/config` and `@run402/sdk/node/config` expose `defineConfig`, `dir`, `file`, `sqlFile`, `nodeFunction`, `Run402ExecutionMode`, and the Node executable config loader. JSON data manifests still auto-discover as `run402.deploy.json` / `app.json`; executable `.ts/.js` configs require explicit `--manifest`.
- **Reviewed deploy modes on existing commands.** `run402 up` and `run402 deploy apply` now expose `--check`, `--print-spec`, `--plan`, and `--require-plan <plan_id>` without adding a new command family. `--check` / `--print-spec` are local-only; `--plan` returns gateway-reviewed `plan_id` / `plan_fingerprint`; `--require-plan` applies only the reviewed intent.

### Changed

- **Agent docs prefer explicit modes over bare dry-run wording.** README, CLI, SDK, MCP, OpenClaw, and `llms*.txt` now show the canonical `up --manifest run402.deploy.ts --check -> --plan -> --require-plan` path.

## 2.3.0 — unreleased

Surfaces the v1.49 gateway image-variant pipeline ([run402#392](https://github.com/kychee-com/run402/issues/392), parent change: [`asset-image-variants` in run402-private](https://github.com/kychee-com/run402-private/tree/main/openspec/changes/asset-image-variants)). Additive, non-breaking — old clients silently ignore the new fields.

### Added

- **`AssetVariant` interface** in `@run402/sdk` (`sdk/src/namespaces/assets.types.ts`). Shape: `{ url, cdn_url, width_px, height_px, format: 'webp' | 'jpeg', sha256 }`. Used by the new `AssetRef.variants` map.
- **Typed image-variant fields on `AssetRef`** — `width_px`, `height_px`, `blurhash`, `variant_spec_version`, `display_url`, `display_immutable_url`, `variants?: { thumb?, medium?, large?, display_jpeg? }`. All optional. Present only for image uploads (jpeg/png/webp/heic/heif ≥320×320) against a v1.49+ gateway. Threaded end-to-end through `ResolvedAssetRef` → `AssetManifestEntry` → `buildAssetRef`, so the same fields appear whether you upload via `r.assets.put(...)` or `r.project(id).apply({ assets: { put: [...] } })`.
- **`AssetRef.thumbUrl`** convenience getter — `variants.thumb.cdn_url ?? displayUrl` for image refs, `undefined` for non-images. Single field for grid thumbnails; TypeScript narrows so a picker that does `<img src={pdfRef.thumbUrl}>` is a compile error.
- **`AssetRef.displayUrl`** convenience getter — `display_url ?? cdn_url` for image refs, `undefined` for non-images. HEIC sources transparently get the JPEG transcode.
- **`AssetRef.imgTagWithSrcSet(opts)`** helper — emits a `<picture>` with a WebP-only `<source>` (three sizes: 320w / 800w / 1920w) and `display_url` as the `<img>` fallback. Throws at call time on (a) missing/empty `opts.sizes` (browsers over-fetch the largest candidate without it), or (b) missing `variants` (non-image / sub-320 / pre-v1.49 ref) — no silent fallback. AVIF deferred from v1 (documented in JSDoc; `<picture>` type-precedence footgun).
- **MCP `assets_put` human output** now surfaces `Dimensions: <w>×<h>`, `Blurhash: <hash>`, `Display URL` (when distinct from `cdn_url` — HEIC only), and a `Variants:` line listing kind + dimensions + format for each present variant.

### Changed

- **`AssetRef.imgTag(alt?)` defaults `<img src>` to `display_url ?? cdn_url`** (was `cdn_url`). Correct rendering for HEIC uploads without HEIC-aware caller code — for non-HEIC images `display_url === cdn_url`, so no behavior change there.
- **`AssetRef.imgTag(alt?)` opportunistically emits `width`/`height` attributes** when both `width_px` and `height_px` are present on the ref. Eliminates Cumulative Layout Shift for image grids. Silently omits both attributes when either dimension is absent — never throws on absence.
- **MCP `assets_put` tool description** updated to mention the new image fields and reference the SDK docs for the full AssetRef shape.

### Out of scope (deliberate carve-out)

- `@run402/functions` type updates — now live in `run402-core/packages/functions/` and publish on their own cadence. The runtime returns the new fields regardless of which `@run402/functions` types are in use.
- AVIF generation or AVIF-aware helpers — deferred at the gateway. When AVIF returns, it must land at all three sizes simultaneously or via a dedicated `imgTagHero()` helper.
- On-demand `?w=N&fmt=webp` resize endpoint and project-configurable variant sizes.

## 2.2.0 — 2026-05-18

Closes the v1.48 unified-apply asset pipeline end-to-end. v2.0.0/v2.0.1 shipped the deploy hero (`r.project(id).apply(spec)`) but left three structural gaps in the asset slice: the normalizer didn't read `spec.assets`, `NodeAssets.uploadDir/syncDir/prepareDir/putMany` never uploaded bytes, and `Assets.put` still called the removed `/storage/v1/uploads*` substrate (404 in production). This release closes all three.

### Added

- **`@run402/functions` `assets` namespace.** `import { assets } from "@run402/functions"` exposes `assets.put(key, source, opts)` for in-function blob uploads. Routes through the new gateway `POST /apply/v1/service-asset-put` (service-key auth) so per-key visibility flips inside the same activation sub-transaction the wallet-auth apply hero uses. Quota enforcement, per-unique-hash storage billing, and immutable URL retention behave identically to deploy-time `r.project(id).apply({ assets: { put: [...] } })`.
- **Wire-shaped `assets` slice in the unified apply spec.** `ReleaseSpec.assets?: AssetSpec` carries `put?: (AssetPutEntry | AssetPutEntryInput)[]`, `delete?: string[]`, and `sync?: { prefix, prune: true, confirm? }`. The SDK input form (`AssetPutEntryInput` with `source: ContentSource`) and the wire form (`AssetPutEntry` with `sha256` + `size_bytes`) can be mixed in the same array.
- **`r.assets.uploadDir(path, opts)` / `syncDir` / `prepareDir` / `putMany`.** Node-only directory ergonomics that walk filesystem, hash, register byte readers, and submit through the single `apply` hero. `entriesFromLocalDir` now returns `AssetPutEntryInput[]` (with `source` retained) instead of pre-hashed wire entries, so the SDK normalizer registers byte readers and bytes flow through `/content/v1/plans`.
- **`DeployResult.assets`** is populated from the plan response's `asset_entries[]`. Carries `list` / `byKey` with the gateway-authoritative `AssetRef` envelope (resolved URLs + SRI + etag + content_digest) plus `totals.bytes_uploaded` / `bytes_reused` (derived from per-entry `status: "upload_pending" | "present" | "satisfied_by_plan"`).
- **`slice_kind` discriminator on observability events.** `content.upload.skipped` / `content.upload.progress` events carry `slice_kind: "release" | "asset" | "mixed"` per SHA; `commit.phase` and `ready` events carry `slice_kinds: ("release" | "asset")[]` summarizing which slice categories the apply's spec carried. Cross-kind CAS dedup (same SHA in `site` + `assets`) escalates the per-SHA value to `"mixed"`.
- **CLI/MCP unified deploy tool now accepts `assets`.** `deploy.apply` (`run402 deploy apply --manifest run402.json`, MCP `deploy` tool) accepts `assets: { put: [{ key, source: { data, encoding? } | { path } }], delete?, sync? }` via the manifest normalizer.
- **Run402 ReleaseSpec JSON schema** (`schemas/release-spec.v1.json`, hosted at `https://run402.com/schemas/release-spec.v1.json`) now describes the `assets` slice with full `$defs/assetPutEntry`, `$defs/assetSync`.

### Changed

- **`r.assets.put` routes through the apply hero.** Single-key upload calls `r.project(id).apply({ assets: { put: [{ key, source: bytes }] } })` and reads the resolved `AssetRef` from `result.assets.byKey[key]`. Behavior matches v2.0.1 from the caller's perspective; the wire path moved to `/apply/v1/plans` + `/content/v1/plans`.
- **CLI `run402 assets put <file>`** delegates to `sdk.assets.put`. The pre-v2.x multipart S3 PUT + resumable session machinery (`~/.run402/uploads/<upload_id>.json`) is gone; resume semantics live at the apply-plan level (24h TTL). The `--concurrency` and `--no-resume` flags are accepted for backward compatibility but ignored.
- **`@run402/functions` runtime helper bundle.** Added `assets` to the export list alongside `db` / `adminDb` / `getUser` / `email` / `ai` / `routedHttp`. No change to the existing exports.

### Removed / deprecated

- **`Assets.initUploadSession` / `getUploadSession` / `completeUploadSession`** throw `LocalError` with an actionable migration message pointing to `r.project(id).apply({ assets: { put: [...] } })` / `r.assets.uploadDir`. Gateway v1.48 dropped the `/storage/v1/uploads*` substrate. The method shapes (and the `BlobUploadInit*` / `BlobUploadStatus*` / `BlobUploadComplete*` types they reference) are kept in the TypeScript surface for source-compat with downstream code that imports them; surface removal is a v3 candidate.

### Gateway changes (shipped to production alongside this release)

- **`POST /apply/v1/service-asset-put`** (service-key auth). In-function blob upload endpoint. Hashes raw body, PutObject to `_cas/<sha[0:2]>/<sha[2:]>`, upserts `internal.content_objects`, calls the shared `applyOneAssetPut` primitive in a short transaction, returns the resolved `AssetRef`. 25 MB inline cap.
- **`applyOneAssetPut`** extracted from `promoteStagedAssetSlice` as the shared per-put primitive. The wallet apply hero and the service-key route both call it; INSERTs into `internal.blobs` / `internal.asset_versions` (skipped when `operationId === null` for service uploads) / `internal.blob_url_refs` are byte-identical between the two paths.
- **`promoteStagedAssetSlice` now inserts `internal.blob_url_refs`** for every immutable put. Without this row the immutable URL form (`pr-<id>.run402.com/_blob/<key-with-sha-suffix>`) returned 404 for assets uploaded via the unified-apply hero; the legacy `/storage/v1/uploads*` cas-promote path always inserted it.

### Migration notes

If you were using v2.0.x and relied on `r.assets.initUploadSession` for low-level resumable uploads, migrate to `r.project(id).apply({ assets: { put: [...] } })` — the apply engine handles retries and large-file streaming through the unified content plan. For single-key uploads, `r.assets.put(projectId, key, source, opts)` is now the recommended surface and routes through the same hero.

If you were running an older gateway (pre-v1.48), this SDK release won't compile against it because the `/storage/v1/uploads*` routes return 404. Upgrade the gateway first.
