---
title: "Namespaces — full surface"
description: "Native SDK reference — resources."
order: 80
---

## Namespaces — full surface

The `Run402` class exposes focused namespaces. Click into the SDK source for full method signatures.

> Reference tables below use plain fences, not `ts` fences. They document the
> type surface in compact form — they are not runnable programs. Runnable example
> snippets in this document still use ```` ```ts ```` and are type-checked by CI
> against the published `@run402/sdk` and `@run402/sdk/node` types.

### `r.pay`

```
r.pay.fetch(url, init?, { maxUsdMicros?, idempotencyKey?, requireReceipt? }): Promise<PayFetchResult>
```

Node automatically supplies the configured wallet/signer. Isomorphic hosts
may inject `payExecutor` in `Run402Options`; without one, unpriced URLs pass
through and a 402 fails locally with `PAYMENT_WALLET_UNFUNDED`.

### `r.actions` / `r.up` (`@run402/sdk/node` only)

```
r.actions.run(input: Run402ActionInput, opts?: Run402ActionRunOptions): Promise<Run402ActionResult>
r.up(input?: Omit<Run402UpActionInput, "type">, opts?: Run402ActionRunOptions): Promise<Run402ActionResult<Run402UpResult>>

Run402Action.ProjectsProvision === "projects.provision"
Run402Action.TierSet === "tier.set"
Run402Action.Up === "up"
```

Direct `projects.provision` and `tier.set` actions call the same SDK primitives as their namespaces. `up` is the recursive app deploy action described above; it returns `steps[]` and grant keys final release work to `r.project(id).apply`.

### `r.projects`

```
provision(opts?: { tier?, name?, orgId?, idempotencyKey? }): Promise<ProvisionResult>   // idempotencyKey → Idempotency-Key header; retry-safe re-runs
delete(id: string): Promise<void>
list(wallet?: string): Promise<ListProjectsResult>
getUsage(id: string): Promise<UsageReport>
getSchema(id: string): Promise<SchemaReport>
sql(id: string, sql: string, params?: unknown[]): Promise<unknown>
rest<T = unknown>(id: string, table: string, queryOrOptions?: string | ProjectRestOptions): Promise<T>
restResponse<T = unknown>(id: string, table: string, queryOrOptions?: string | ProjectRestOptions): Promise<ProjectRestResponse<T>>
validateExpose(manifest: ExposeManifest | string, opts?: { project?: string; project_id?: string; migrationSql?: string }): Promise<ExposeManifestValidationResult>
applyExpose(id: string, manifest: ExposeManifest): Promise<unknown>
getExpose(id: string): Promise<ExposeManifest>
getQuote(): Promise<QuoteResult>
info(id: string): Promise<ProjectInfo>
keys(id: string): Promise<ProjectKeys>
use(id: string): Promise<void> // sets the active project (sticky default)
active(): Promise<string | null>

// CLI-style aliases:
usage(id): Promise<UsageReport> // alias of getUsage
schema(id): Promise<SchemaReport> // alias of getSchema
quote(): Promise<QuoteResult> // alias of getQuote
promoteUser(id, email): Promise<void> // project-admin role helper
demoteUser(id, email): Promise<void>
```

**Tier and lifecycle are per-organization, not per project.** The state machine lives on `internal.organizations`. Read it from `r.tier.status()`:

- `organization_lifecycle_state: "active" | "past_due" | "frozen" | "dormant" | "purged" | null` — the organization's lifecycle state; `null` only for orphan wallets with no organization row.
- `lease_perpetual: boolean | null` — staff escape hatch flag. When `true`, the organization never advances past `active` regardless of lease expiry.
- `tier: "prototype" | "hobby" | "team" | null` — the organization's active tier.
- `advisories?: [{ type, summary, next_actions[] }]` — org-level advisories (recovery-event-reachability); present only when at least one applies. `type: "owner_unreachable"` means the owning organization resolves to zero verified notification recipients — mandatory recovery/security notifications (e.g. a mailbox suspension) currently reach nobody. The remedy rides `next_actions[]`: register and verify a person contact via `POST /agent/v1/contact` (`r.admin.setAgentContact`). Reachability is also machine-checkable on `r.me.status().reachability` (`{ reachable, verified_recipient_count, sources[], skipped_last_90d }`).

`r.projects.list(opts?)` reads the named, domain-aware inventory (`GET /projects/v1`, project-findability). Each `ProjectSummary` carries `id`, `name`, `tier`, `site_url` (first claimed run402.com subdomain → else first custom domain → else null), `custom_domains[]`, `status` / `effective_status`, `organization_lifecycle_state`, `lease_perpetual`, `organization_id` (the owning org), `created_by` (provisioning principal), and `created_at`. The response is `{ projects, has_more?, next_cursor?, scope? }`. Membership-scoped by default — org-owned control plane: a wallet *authenticates* (SIWX signed from the provider; mandatory server-side) but does not *own* — this lists projects owned by orgs the wallet's resolved principal is an active member of, ∪ projects with an active per-project grant. Options: `{ org }` filters to one org (`?org_id`; authorize-before-reveal — non-member/guessed id → 403, non-UUID → 400), `{ limit, cursor }` paginate (`?limit` default 50 max 200, `?after`), and `{ all: true }` reads every project the caller can reach across all its orgs (`GET /agent/v1/me/projects`) — pass `{ all: true, token }` (a sign-in session token) for the person's account, else `all` uses the credential provider (a SIWX wallet reads its own slice) and echoes `scope` (`"principal"` or `"wallet"`). `all` + `org` together throws `LocalError` (mutually exclusive). `api_calls` / `storage_bytes` remain optional on `ProjectSummary` for back-compat but the named inventory does not populate them — read `r.projects.getUsage(id)` for live usage.

`r.projects.get(id)` is the authoritative single-project read (`GET /projects/v1/:id`, gateway `project.read`) — a `ProjectDetail` superset of a list row: `project_id`, `public_id`, `name`, `org_id`, `tier`, `effective_status`, `organization_lifecycle_state`, `site_url` (`| null`), `custom_domains[]`, `last_deploy` (`{ release_id, activated_at } | null`), `mailbox[]` (active addresses), `usage` (`{ api_calls, storage_bytes, api_calls_limit, storage_bytes_limit, storage_limit }` — `storage_limit` is the byte limit as a human string, e.g. `"250 MB"`), and `created_at`. Caller-authed (SIWX/control-plane, no project keys) and works without the project in the local project-key cache. It returns NO secrets — authorize-before-reveal means an unauthorized/guessed id throws `Unauthorized` (403, or `NotAuthorizedError` for an org-membership denial), never a not-found oracle. Use `r.credentials.projectKeys.status(...)` / `export(...)` for explicit local cache inspection or secret export. Scoped form: `(await r.project(id)).projects.get()`.

`r.projects.rename(projectId, name)` renames a project (`PATCH /projects/v1/:id`, project-findability) and returns `{ project_id, name }`. Caller-authed (SIWX/control-plane, not a project service key), so it works without the project in the local project-key cache. Authorization is org `admin`+ (or a `project:write` grant) on the owning org and authorize-before-reveal — an unauthorized/guessed id throws `Unauthorized` (403), never a not-found oracle; an invalid name throws `ApiError` (400). Scoped form: `r.project(id).rename(name)`.

`r.projects.setRepoName(projectId, name)` sets or renames the project's per-org-unique, ADDRESS-form name (`POST /projects/v1/:id/repo-name`, repo-first-onramp design D6, task 4.2) — the `<name>` half of `run402::<org-slug>/<name>` — and returns `{ project_id, repo_name, previous_repo_name }`. Distinct from `rename` above (the free-text display name, unchanged): the address-form name is charset-restricted (`[a-z0-9-]`, ≤63 chars) and per-org-unique. No fee, unlike the org-slug claim. Same authority as `rename`. Scoped form: `r.project(id).setRepoName(name)`.

`r.projects.getUsage(id)` still surfaces `effective_status` and `organization_lifecycle_state` because that endpoint scopes to a single project and the derivation collapses per-project `archived_at` / `deleted_at` together with the organization's lifecycle.

### `r.project(id).apply`

The unified apply primitive. **There is no public `r.deploy` surface** — the
scoped client (`r.project(id)`) is the only path. Mutations live on the
callable hero `r.project(id).apply(spec)` with `.plan/.start/.resume`
sub-methods. Observability reads (release inventory, diff, resolve, event
replay) live on the same `r.project(id).apply` object. The internal engine is
`r._applyEngine` and is not part of the public surface.

```
// MUTATIONS — r.project(id).apply (callable hero):
r.project(id).apply(spec, opts?): Promise<DeployResult>
r.project(id).apply.plan(spec, opts?: { idempotencyKey?, mode?: "reviewedPlan" | "legacyDryRun", dryRun?, requiredPlan? }): Promise<{ plan, byteReaders }>
r.project(id).apply.start(spec, opts?: { idempotencyKey?, requiredPlan?, allowWarnings?, allowWarningCodes? }): Promise<DeployOperation>
r.project(id).apply.resume(operationId, opts?): Promise<DeployResult>

// OBSERVABILITY — r.project(id).apply (read/event surface):
r.project(id).apply.status(operationId, opts?): Promise<OperationSnapshot>
r.project(id).apply.list(opts?: { limit?, cursor? }): Promise<DeployListResponse>
r.project(id).apply.events(operationId, opts?): Promise<DeployEventsResponse>
r.project(id).apply.edgeCoherence(operationId, opts?): Promise<EdgeCoherenceReport>
r.project(id).apply.waitEdgeCoherent(operationId, opts?: { timeoutMs?, intervalMs?, onPoll? }): Promise<EdgeCoherenceWaitResult>
r.project(id).apply.resolve(opts: ScopedDeployResolveOptions): Promise<DeployResolveResponse>
  // ScopedDeployResolveOptions is { url, method? } OR { host, path?, method? };
  // the bare-r form r._applyEngine.resolve takes a top-level project plus DeployResolveOptions.
r.project(id).apply.getRelease(releaseId, opts?: { siteLimit? }): Promise<ReleaseInventory>
r.project(id).apply.getActiveRelease(opts?: { siteLimit? }): Promise<ActiveReleaseInventory>
r.project(id).apply.diff(opts: { from, to, limit? }): Promise<ReleaseToReleaseDiff>

// Low-level upload/commit (CLI debugging — most agents call apply()):
r.project(id).apply.upload(plan, opts: { byteReaders, onEvent? }): Promise<void>
r.project(id).apply.commit(planId, opts?: { idempotencyKey?, onEvent? }): Promise<DeployResult>
r.project(id).apply.rehearse(planId, opts?: { teardown?: "keep" | "on_pass" | "always" }): Promise<RehearsePlanResult>
```

Top-level deploy summary helper:

```
summarizeDeployResult(result: DeployResult): DeploySummary
```

Example:

```ts
import { run402, summarizeDeployResult, type ReleaseSpec } from "@run402/sdk/node";

const r = run402();
const spec: ReleaseSpec = {
  project: "prj_...",
  site: { patch: { put: { "index.html": "<h1>Hello</h1>" } } },
};

const result = await (await r.project(spec.project)).apply(spec);
const summary = summarizeDeployResult(result);
console.log(summary.headline, summary.site?.cas?.reused_bytes);
```

For live event streaming during an in-flight apply, use `(await r.project(spec.project)).apply.start(spec)` and
iterate `op.events()` (an `AsyncIterable<DeployEvent>`). The `r.project(id).apply.events(operationId)`
method returns the events the gateway has recorded so far for an operation —
useful for inspecting an apply after the event, not for live streaming.

### `r.snapshots`

Project snapshots are internal restore points, not portable archives.

```
create(projectId): Promise<ProjectSnapshotDto>
list(projectId, opts?: { kind?, limit?, after? }): Promise<ProjectSnapshotsListResult>
get(projectId, snapshotId): Promise<ProjectSnapshotDto>
delete(projectId, snapshotId): Promise<void>
restorePlan(projectId, snapshotId, opts?: { includeAuth? }): Promise<SnapshotRestorePlanEnvelope>
restore(projectId, snapshotId, confirm, opts?: { includeAuth? }): Promise<SnapshotRestoreResult>
```

`ProjectSnapshotDto` preserves gateway snake_case: `snapshot_id`, `operation_id`, `project_id`, `kind` (`manual` / `pre_migration` / `pre_restore` / `scheduled`), `profile`, `status`, `manifest_sha256`, `size_bytes`, `live_release_id`, `captured_at`, `expires_at`, `error`, `created_at`, `updated_at`, and `next_actions`.

`restorePlan()` returns `{ restore_plan }` with `data_loss_statement`, auth counts/mode, capture-time/current releases, target slot behavior, `confirm.token`, `confirm.expires_at`, and next actions. `restore()` requires that token and returns `operation_id`, `pre_restore_snapshot_id`, old/new schema slots, restored migration registry row count, status, and next actions. Scoped form: `(await r.project(id)).snapshots.*`.

### `r.branches`

Project branches are contained, expiring data copies for rehearsal and inspection.

```
create(projectId, opts?: {
  fromSnapshotId?: string,
  name?: string,
  emailMode?: "sandbox" | "off",
  enableCron?: boolean,
  ttlDays?: number,
}): Promise<ProjectBranchCreateResult>
list(projectId): Promise<ProjectBranchesListResult>
renew(projectId, branchProjectId, opts?: { ttlDays?: number }): Promise<ProjectBranchDto>
delete(projectId, branchProjectId): Promise<void>
```

`ProjectBranchDto` includes `branch_project_id`, `parent_project_id`, `name`, `branch_url`, `subdomain`, `status`, `email_mode`, `enable_cron`, `data_from`, `release`, `expires_at`, `created_at`, and `next_actions`. `ProjectBranchCreateResult` additionally returns `operation_id`, `materialization_id`, `anon_key`, and `service_key`; the SDK saves those branch keys when the credential provider supports `saveProject`. Scoped form: `(await r.project(id)).branches.*`.

### `r.ci`

GitHub Actions OIDC federation over `/ci/v1/*`. V1 supports deploy-scoped bindings only.

```
createBinding(input: {
  project_id: string,
  provider: "github-actions",
  subject_match: string,
  allowed_actions: readonly ["deploy"],
  allowed_events: readonly string[],
  route_scopes?: readonly string[],
  github_repository_id?: string | null,
  expires_at?: string | null,
  nonce: string,
  signed_delegation: string,
}): Promise<CiBindingRow>

listBindings(input: { project: string }): Promise<{ bindings: CiBindingRow[] }>
getBinding(bindingId: string): Promise<CiBindingRow>
revokeBinding(bindingId: string): Promise<CiBindingRow>
exchangeToken(input: { project_id: string, subject_token: string }): Promise<{
  access_token: string,
  token_type: "Bearer" | string,
  expires_in: number,
  scope: string,
}>
```

`exchangeToken` fills the RFC 8693 grant constants internally:
`grant_type = urn:ietf:params:oauth:grant-type:token-exchange` and
`subject_token_type = urn:ietf:params:oauth:token-type:jwt`. It sends
`withAuth: false`; credential-provider auth headers are intentionally omitted.

On failure `exchangeToken` throws the usual `Unauthorized`/`ApiError`. Use
`isCiBindingRevoked(err)` to detect the `binding_revoked` denial (HTTP 403): a
subject-matching binding existed but was revoked — typically because the project
was transferred/handed off, which suspends the prior org's CI bindings. The fix
is to re-create it with `run402 ci link github`, NOT to widen asset scopes
(`run402 ci set-asset-scopes` 409s on a revoked binding). The gateway gives both
`binding_revoked` and `access_denied` the generic canonical `code: "FORBIDDEN"`,
so the only discriminator is the OAuth-style `error` field on the 403 body —
`isCiBindingRevoked` reads it for you. The error stays an `Unauthorized`
(`isUnauthorized` remains true), so existing generic-403 handling is unaffected.
`CI_BINDING_REVOKED_ERROR` is the exported `"binding_revoked"` constant.

`CiBindingRow` preserves gateway snake_case fields:

```
{
  id, project_id, issuer, subject_match,
  allowed_actions, allowed_events,
  route_scopes,
  github_repository_id, created_by, nonce,
  created_sig, created_at, expires_at, revoked_at,
  last_used_at, use_count
}
```

Canonical helper exports:

```
CI_GITHUB_ACTIONS_PROVIDER = "github-actions"
CI_GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com"
CI_AUDIENCE = "https://api.run402.com"
DEFAULT_CI_DELEGATION_CHAIN_ID = "eip155:84532"
V1_CI_ALLOWED_ACTIONS = ["deploy"]
V1_CI_ALLOWED_EVENTS_DEFAULT = ["push", "workflow_dispatch"]

normalizeCiDelegationValues(values): NormalizedCiDelegationValues
buildCiDelegationStatement(values): string
buildCiDelegationResourceUri(values): string
validateCiSubjectMatch(subject): string
validateCiNonce(nonce): string
normalizeCiRouteScopes(values): string[]
validateCiRouteScope(value): string
assertCiDeployableSpec(specOrPlanBody): void
```

Node-only CI exports from `@run402/sdk/node`:

```
signCiDelegation(values, opts?: {
  apiBase?, walletPath?, chainId?, issuedAt?, expirationTime?, nonce?
}): string

createCiSessionCredentials({
  projectId, accessToken?, getAccessToken?
}): CiMarkedCredentialsProvider

githubActionsCredentials({
  projectId, apiBase?, audience?, refreshBeforeSeconds?, fetch?
}): CiMarkedCredentialsProvider

isCiSessionCredentials(credentials): boolean
```

CI error-code unions include binding errors (`invalid_route_scopes`, `nonce_replay`, `delegation_statement_mismatch`, `signer_mismatch`, `duplicate`), token-exchange errors (`invalid_token`, `access_denied`, `binding_revoked`, `event_not_allowed`, `repository_id_mismatch`, `ambiguous_binding`), and CI deploy errors (`payment_required`, `insufficient_scope`, `forbidden_spec_field`, `forbidden_plan`, `CI_ROUTE_SCOPE_DENIED`). Preserve unknown future strings as opaque gateway codes.

### `r.session`, `r.writeApproval`, `r.me`

A person's **sign-in session** — distinct from the agent's per-wallet SIWX identity. There is one session class (wire token class `control_plane_session`), bound to the principal and graded by how it was minted: `browser` (the console), `loopback` (`run402 login`; full and step-up-able), or `device` (`run402 login --device`; read-only — every mutation answers `403 SESSION_READ_ONLY`). Every mint response carries `grade`, and `GET /agent/v1/whoami` reports `session: { grade, amr, amr_times } | null`.

The CLI mints it headlessly. The SDK exposes the isomorphic seams (the loopback server, PKCE, and polling loop live in the Node CLI):

```
session.buildCliAuthorizeUrl({ redirectUri, codeChallenge, state, nonce }): string
  // Pure (no network). GET /agent/v1/control-plane/cli/authorize — the URL `run402 login`
  // opens; the console runs the passkey ceremony and redirects to the 127.0.0.1 listener.
session.exchangeCliToken({ code, codeVerifier, redirectUri, state }): Promise<ControlPlaneSession>
  // POST /agent/v1/control-plane/cli/token (unauth — code + verifier ARE the credential).
  // ControlPlaneSession { control_plane_session_token, token_type, expires_in, grade: "loopback",
  // principal_id, amr[] }.
session.deviceStart(): Promise<DeviceAuthStart>
  // POST /agent/v1/control-plane/cli/device (unauthenticated) → { device_code, user_code,
  // verification_uri, verification_uri_complete?, expires_in, interval }. The person approves in
  // the console, which needs a recent sign-in (403 RECENT_SIGN_IN_REQUIRED otherwise).
session.devicePoll(deviceCode): Promise<DevicePollResult>
  // POST /agent/v1/control-plane/cli/device/token. RFC 8628 states are returned as DATA, not
  // thrown: { kind: "approved", session } | { kind: "authorization_pending" } | { kind: "slow_down" }
  // | { kind: "access_denied" } | { kind: "expired_token" }. The approved session is grade "device".
```

The session authorizes most control-plane ops, but it is **not** sufficient on its own for `provision` / `deploy` / secret writes — those also need a **write approval** (below). High-stakes control ops (invite, membership, transfer, delete) require a **fresh passkey**: a magic-link/OAuth session raises `StepUpRequiredError` until it runs a step-up ceremony; a `device` session and a write approval never satisfy it.

The **browser** surface — the front door the console (and any browser app) drives — is the rest of `r.session.*`. Public *mint* methods send no auth; *session-bound* methods take `{ token }` (the bearer) and fall back to the credential provider when omitted. WebAuthn option/assertion payloads are opaque passthroughs — the browser runs the ceremony.

```
// mint (public — no auth)
session.email({ email }): Promise<MagicLinkSendResult>            // non-enumerating magic-link send
session.verifyEmail({ token }): Promise<ControlPlaneSession>      // verifies email, AUTO-REDEEMS invites, mints (amr ["email"])
session.passkeyOptions({ email }) / passkeyVerify({ email, response })  // WebAuthn sign-in → session
session.oauthUrl("google" | "github"): string                    // pure; GET …/oauth/:provider/start (browser 302)
session.consumeRecoveryCode({ code }): Promise<RecoveryConsumeResult>  // session + must_enroll_passkey

// session-bound ({ token } → bearer; omit → provider auth)
session.whoami({ token? }): Promise<WhoAmIResult>                // GET /agent/v1/whoami: { principal, memberships, session: { grade, amr, amr_times } | null, … }
session.refresh({ token? }) / revoke({ token? })                 // revoke is `run402 logout`'s server half
session.enrollPasskeyOptions({ token? }) / enrollPasskeyVerify({ token?, response, label? })
session.stepUpOptions({ token?, opClass? }) / stepUpVerify({ token?, response, opClass?, objectKind?, objectId? })
  // satisfy a StepUpRequiredError (amr passkey), then retry the gated write
session.issueRecoveryCodes({ token? })                           // one-time codes (shown once)
session.listAuthenticators({ token? }) / revokeAuthenticator({ token?, id })
session.sourceAccessWrappers({ token? }): Promise<SourceAccessWrappersResult>            // gitvault-recovery-custody: my source-access key + wrapper set (kinds, states, custody scheme; ciphertext included — always only my own)
session.sourceAccessRecoveryBundle({ token? }): Promise<SourceAccessRecoveryBundleResult> // export the r402s-member-recovery-bundle/v1 (key identity + ACTIVE wrapper ciphertexts) — with the source recovery code it recovers vaults offline (r.gitvault.recover member_bundle); the gateway stamps the export as posture evidence
```

**Write approval.** A person without a wallet provisions, deploys, and writes secrets with a passkey-signed approval scoped to one `(action, target)`, carried as `X-Run402-Write-Approval: Bearer <write_approval_token>` beside the session bearer. It lasts 30 minutes idle (4 hours at most), dies with its sign-in session, and never satisfies step-up. The Node CLI (`run402 approve`) runs the loopback + PKCE around these seams:

```
writeApproval.requestChallenge({ action, orgId?, projectId?, cliRedirectUri, codeChallenge, state, token? }): Promise<WriteApprovalChallengeResult>
  // POST /agent/v1/control-plane/write-approval/challenges. action ∈ org.project.create | project.deploy
  // | project.secret.write (org.project.create needs orgId; the others projectId). Carries the session bearer.
writeApproval.exchangeClaimCode({ code, codeVerifier, state }): Promise<WriteApprovalTokenResult>
  // POST /agent/v1/control-plane/write-approval/cli/token (unauth; no redirect_uri — bound at challenge).
  // WriteApprovalTokenResult { write_approval_token, token_type: "write_approval",
  // header: "X-Run402-Write-Approval", session: { write_approval_session_id, org_id, project_id,
  // capabilities, idle_expires_at, absolute_expires_at } }.
```

Credential resolution is **surface-aware and never ambient**: `run402({ surface })` — `cli` resolves `auto` (wallet, else the sign-in session + a write approval *only* when a cached one exactly matches the request's `(capability, target)`); `mcp` / `sdk` stay wallet-only, so an agent tool call never spends a person's approval. `authMode: "session"` selects the sign-in session explicitly. A gated write with no matching approval throws `WriteApprovalRequiredError` (`isWriteApprovalRequired()` guard, `kind: "write_approval_required"`) carrying `capability`, `target`, a resolved `approveCommand` (e.g. `run402 approve --action project.deploy --project prj_x`), and an `approve_write` next action — the agent relays that; an interactive CLI auto-runs it. `WRITE_APPROVAL_REQUIRED`, `WRITE_APPROVAL_SCOPE_MISMATCH`, `WRITE_APPROVAL_BINDING_MISMATCH` (403) and `WRITE_APPROVAL_SESSION_INVALID` (401) all map to the same typed error.

**Account reads.** `r.me` reads the caller's own account (a sign-in session of any grade, or a SIWX wallet for that wallet's slice):

```
me.overview({ token? }): Promise<AccountOverview>
  // GET /agent/v1/me/overview → { scope: { kind: "principal" | "wallet", principal, wallet_count,
  // organization_count }, session, rollup, organizations[], wallets[], advisories[] }. Counts only.
  // `run402 org list` joins it into the membership list.
me.status({ token? }): Promise<MeStatusResult>
  // GET /agent/v1/me/status → { contact: { email_status, passkey_status, recovery_gap },
  // reachability?, critical_items[], skipped_notifications[], organizations[], projects[],
  // active_thresholds[], runtime?, recovery_posture?, next_actions? }. Read by `run402 doctor`
  // and MCP `whoami`.
```

The project inventory across every org (`GET /agent/v1/me/projects`) is `r.projects.list({ all: true, token? })`.

Carry a minted session as the whole SDK's credential with `controlPlaneSessionCredentials({ token | getToken })` — `r.orgs.*` / `r.org(id).*` / `r.admin.transfers.*` then act as that principal (it carries no project keys, so DB/project-key ops still need the wallet/keystore):

```
import { run402, controlPlaneSessionCredentials } from "@run402/sdk/node";
const r = run402({ credentials: controlPlaneSessionCredentials({ token }) });
await r.orgs.whoami();   // resolves the principal + memberships + session.grade
```

**Invite → redeemed at first sign-in.** An owner invites by email (`r.org(id).invites.create`); the invitee's pending memberships are redeemed *automatically* when they sign in via that verified email (email / OAuth / loopback) and surface as active rows in `session.whoami().memberships` (and in `run402 login` output). Owner/admin invites only redeem once the invitee has enrolled a passkey; lower roles redeem on any sign-in. There is no invitee-side "list my invites" call — the redemption is the surfacing.

The caches are Node-only and live in `core`: the sign-in session at `{base}/control-plane-session.json` and write approvals at `{base}/write-approvals.json` (both mode 0600, base config dir — principal-scoped, shared across local named wallets). The CLI (`run402 login [--device]`, `logout`, `whoami`, `approve`) brokers them. No MCP login by design — an MCP host holds no browser and authenticates as the agent; MCP `whoami` reports the grade.

### `r.sites`

`deployDir` is exposed only on the Node entry (`@run402/sdk/node`); the
isomorphic entry's `r.sites` namespace is empty.

```
// Node-only — @run402/sdk/node:
deployDir(opts: { project, dir, target?, onEvent? }): Promise<SiteDeployResult>
```

### `r.assets`

The unified asset namespace. Isomorphic
single-asset methods on every runtime; the Node entry point
(`@run402/sdk/node`) upgrades `r.assets` to `NodeAssets`, adding the bulk
directory helpers.

```
// Isomorphic — single asset:
put(projectId, key, source, opts?: BlobPutOptions): Promise<AssetRef>
get(projectId, key): Promise<Response>
ls(projectId, opts?: { prefix?, limit?, cursor? }): Promise<BlobLsResult>
rm(projectId, key): Promise<void>
sign(projectId, key, opts?: { ttl_seconds? }): Promise<BlobSignResult>
diagnoseUrl(projectId, url): Promise<BlobDiagnoseEnvelope>
waitFresh(projectId, opts: { url, sha256, timeoutMs? }): Promise<BlobWaitFreshResult>
// Node-only — @run402/sdk/node — bulk directory + batch:
uploadDir(path, opts: { project, prefix?, ignore?, includeSensitive?, onEvent? }): Promise<AssetManifest>
syncDir(path, opts: { project, prefix?, prune?, confirm?, ignore?, includeSensitive?, onEvent? }): Promise<AssetManifest>
prepareDir(path, opts: { project, prefix?, ignore?, includeSensitive? }): Promise<{ manifest: AssetManifest, applySlice: AssetSpec }>
putMany(items: PutManyItem[], opts: { project, onEvent? }): Promise<AssetManifest>

// Node-only — input helper (synchronous; walk happens at apply submission):
dir(path, opts?: { prefix?, ignore?, includeSensitive? }): LocalDirRef
```

`source` is one of: a bare `string` (text encoded as UTF-8, ≤ 1 MB), a bare
`Uint8Array`, `{ content: string }`, or `{ bytes: Uint8Array }`. Known binary
keys/MIME types reject string sources with `BINARY_CONTENT_REQUIRES_BYTES`;
pass their original bytes.

`AssetRef` (return type of single-asset `put`; legacy alias `BlobPutResult`
still exported) extends snake_case fields (`key`, `size_bytes`, `sha256`,
`visibility`, `url`, `immutable_url`) with the camelCase helpers
used by paste-and-go HTML emitters: `cdnUrl`, `cdnMutableUrl`,
`immutableUrl`, `etag`, `sri`, `contentDigest`, `cacheKind` (`"immutable" |
"mutable" | "private"`), `contentSha256`, `contentType`, plus `scriptTag()`,
`linkTag()`, `imgTag()` methods. See `sdk/src/namespaces/assets.types.ts`
for the full shape.

**v2.1.0 substrate change.** `r.assets.put` now routes through the unified-apply
hero (`r.project(id).apply(spec)` with `spec.assets.put`). Bytes upload via
`/content/v1/plans` to direct-to-S3 presigned URLs; per-key visibility flips
inside the activation transaction that flips `live_release_id`. The
`initUploadSession` / `getUploadSession` / `completeUploadSession` SDK methods
throw `LocalError` directing callers to `r.assets.put` (single key) or
`r.assets.uploadDir(path)` (Node-only, batches a directory under one apply).

#### Bulk directory helpers (Node-only)

`uploadDir` is **additive**: walks the directory, hashes every file with
streaming SHA-256, and submits one apply transaction (`r.project(id).apply
({ assets: { put: [...] } })`). Existing keys not present in the directory
are left untouched.

`syncDir` is **declarative**. Without `prune: true` it behaves identically
to `uploadDir`. With `prune: true` it deletes keys under the supplied
prefix that aren't in the new directory; the first call runs a plan and
throws `PruneConfirmationRequired` (a `LocalError` subclass) carrying
`base_revision`, `delete_set_digest`, `expected_delete_count`, and
`sample_keys`. Echo those back as `confirm: {...}` to commit. `prune: true`
**requires an explicit `prefix`** — no implicit project-root prune. The
gateway's `ASSET_SYNC_DRIFT` activation check catches the narrower race
where inventory mutates between commit and activation.

`prepareDir` runs plan-only and returns `{ manifest, applySlice }`. Use it
when you need resolved CDN URLs before commit (e.g. inject content-hashed
asset URLs into HTML, then commit both the HTML and the assets in one
apply call by passing `applySlice` to a follow-up `r.project(id).apply
.start(...)`).

`putMany` is the in-memory batch shape: each item carries a `key` plus an
in-memory `ContentSource` (string, Uint8Array, ArrayBuffer, Blob). Useful
in V8 isolates and tests where no filesystem is available.

#### The three-schema fidelity contract

The SDK accepts three input shapes for the assets slice but the gateway
sees only one wire shape:

1. `LocalDirRef` — returned by `dir(path)`. Synchronous, lazy: the
   filesystem walk happens at apply submission, not at construction. The
   discriminator `__source: "local-dir"` is stable for type-narrowing.
   **The gateway never sees a `LocalDirRef`** — submitting one in a JSON
   body is rejected with HTTP 400 `INVALID_WIRE_SCHEMA`. The SDK
   normalizes via `entriesFromLocalDir(ref)` before any plan request.
2. `AssetPutEntry[]` — wire-shaped (`{ key, sha256, size_bytes,
   content_type, visibility, immutable }`). What the gateway sees.
3. In-memory `ContentSource` — accepted by `putMany`; hashed locally and
   converted to `AssetPutEntry` before submission.

This is enforced by the wire-schema validator and verified by
`three-schema fidelity` tests under `sdk/src/`.

#### `AssetManifest` — batch result envelope

```
interface AssetManifest {
  list: AssetManifestEntry[]
  byKey: Record<string, AssetManifestEntry> // null-prototype
  manifest: Record<string, AssetManifestEntry> // null-prototype, plain-data copy
  totals: { files, bytes_uploaded, bytes_reused, duration_ms }
  pruned?: string[] // present when syncDir prune ran
}

interface AssetManifestEntry {
  key, sha256, size_bytes, content_type, visibility,
  url, immutable_url, cdn_url, cdn_immutable_url,
  sri, etag, content_digest
}
```

`byKey` and `manifest` are constructed with `Object.create(null)` so
attacker-controlled keys like `__proto__` can't collide with
`Object.prototype` — a hard invariant covered by the prototype-pollution
safety tests in `sdk/src/`.

### `r.archives`

Cloud export helpers are available in both SDK entry points:

```
create(projectId, opts?: {
  scope?: "portable-runtime-v1",
  auth?: "stubs" | "none",
  consistency?: "pause-writes" | "cloud_write_pause_v1",
  idempotencyKey?: string,
}): Promise<ProjectArchiveDto>
get(projectId, archiveId): Promise<ProjectArchiveDto>
wait(projectId, archiveId, opts?: {
  pollIntervalMs?: number,
  timeoutMs?: number,
  onProgress?: (event: ProjectArchiveProgressEvent) => void | Promise<void>,
}): Promise<ProjectArchiveDto>
download(projectId, archiveId): Promise<ProjectArchiveDownload>
export(projectId, opts?: ProjectArchiveExportOptions): Promise<ProjectArchiveExportResult>
```

`ProjectArchiveDto` carries `archive_id`, `operation_id`, `status`, `format_version`, `scope`, `auth_export`, `consistency_mode`, `active_release_id`, `portability_report`, `export_report`, `byte_count`, `sha256`, `expires_at`, and `next_action`. `download` returns `{ archive, bytes, contentType, filename }`.

Node-only helpers:

```
r.archives.inspect(archivePath): Promise<ArchiveVerifyResult>
r.archives.verify(archivePath): Promise<ArchiveVerifyResult>
r.archives.importToCore(opts: {
  archivePath: string,
  name?: string,
  coreUrl?: string,
  envFile?: string,
  secretValues?: Record<string, string>,
  dryRun?: boolean,
  requireRunnable?: boolean,
}): Promise<ArchiveImportResult>
```

`ArchiveVerifyResult` includes `ok`, `archive_version`, `archive_digest`, `transport`, `file_count`, `total_bytes`, `descriptor_count`, `required_capabilities`, `required_secrets`, `auth_subject_stub_count`, `export_report`, `portability_report`, and `diagnostics`. Branch on diagnostic `code`, not prose. Common codes include `ARCHIVE_DIGEST_MISMATCH`, `ARCHIVE_UNSUPPORTED_REQUIRED_CAPABILITY`, `ARCHIVE_PATH_UNSAFE`, `SECRET_VALUES_REQUIRED`, `AUTH_CREDENTIALS_NOT_EXPORTED`, `AUTH_SUBJECT_STUBS_IMPORTED`, `CLOUD_ONLY_FEATURE_EXCLUDED`, `PROJECT_ALREADY_EXISTS`, `IMPORT_VERIFY_FAILED`, and `IMPORT_CONFORMANCE_FAILED`.

### `r.functions`

```
deploy(projectId, opts: {
  name: string, code: string, config?: { timeout?, memory? },
  deps?: string[], schedule?: string | null,
}): Promise<FunctionDeployResult> // routes through unified apply (functions.patch.set). result: { name, url, status, runtime, schedule, warnings }; runtime_version & deps_resolved are null via this path - read r.functions.list() for resolved versions
invoke(projectId, name, opts?: { method?, body?, headers?, idempotencyKey?, wait? }): Promise<FunctionInvokeResult> // paid calls require a stable idempotencyKey; wait polls a 202 run handle and replays the same key for the retained result
logs(projectId, name, opts?: { tail?, since?, requestId?, origin? }): Promise<FunctionLogsResult>
  // every entry carries origin: "app" | "platform" (computed client-side by the exported classifyFunctionLogLine);
  // origin filters client-side (default "all") and the result reports origin + hidden: { platform, app } when filtered
logsByRequestId(projectId, requestId, opts?: { tail?, since?, origin?, functionName? }): Promise<FunctionLogsByRequestIdResult>
  // project-wide request-id search (the x-run402-request-id response header; fnrun_/fnatt_ ids too): lists the project's
  // functions (or just functionName), reads each with the request_id filter, returns { request_id, scanned, entries (each
  // with function), errors (each with function, message, code?), origin, hidden? } merged oldest-first. Also r.project(id).functions.logsByRequestId(...)
update(projectId, name, opts: { schedule?, timeout?, memory? }): Promise<FunctionUpdateResult>
list(projectId): Promise<FunctionListResult> // FunctionSummary includes runtime_version?, runtime_current_version?, runtime_minimum_version?, and runtime_stale?
delete(projectId, name): Promise<void>
rebuild(projectId, name): Promise<FunctionRebuildResult> // { name, rebuilt, old_fingerprint, new_fingerprint, runtime_version_before, runtime_version_after, code_hash }
rebuildAll(projectId): Promise<FunctionRebuildBatchResult> // { rebuilt_count, total, results: (FunctionRebuildResult | { name, rebuilt: false, code?, error })[] }
r.functions.runs.create(projectId, name, {
  eventType: string,
  payload?: Record<string, unknown>,
  idempotencyKey: string,
  delay?: string | number,      // "10m", "1h", "3d" or seconds; mutually exclusive with runAt
  delaySeconds?: number,
  runAt?: string | Date,
  expiresAt?: string | Date,
  expiresAfter?: string | number,
  retry?: { preset?: "standard", maxAttempts?: number, minDelaySeconds?: number, maxDelaySeconds?: number },
}): Promise<FunctionRunHandle>
r.functions.runs.list(projectId, name, opts?: { status?, eventType?, since?, until?, limit?, cursor? }): Promise<{ runs, next_cursor? }>
r.functions.runs.get(projectId, runId): Promise<FunctionRunHandle>
r.functions.runs.logs(projectId, runId, opts?: { tail?, since? }): Promise<FunctionLogsResult>
r.functions.runs.cancel(projectId, runId): Promise<FunctionRunHandle>
r.functions.runs.redrive(projectId, runId, opts?: { retry? }): Promise<FunctionRunHandle>
r.functions.runs.wait(projectId, runId, opts?: { intervalMs?, timeoutMs?, throwOnFailure? }): Promise<FunctionRunHandle>
r.idempotency.fromParts(...parts: Array<string | number | boolean | null | undefined>): string
```

Durable function runs are service-key authed function requests that survive process crashes and support delay/run_at scheduling, expiry, retry, cancellation, logs, and redrive. `idempotencyKey` is required on create; use `r.idempotency.fromParts("reminder", messageId)` or your own stable key so retries do not duplicate logical work. The scoped client exposes the same surface at `(await r.project(id)).functions.runs.*` without repeating `projectId`.

`FunctionLogEntry` includes `timestamp` and `message`, plus optional `event_id`, `log_stream_name`, `ingestion_time`, and `request_id` metadata when the gateway can provide it. Use `requestId` to follow a routed browser failure exposed as `X-Run402-Request-Id` / JSON `request_id`, or to filter by durable run/attempt ids (`fnrun_...`, `fnatt_...`); SDK calls reject invalid `since` timestamps, invalid request ids, and `tail` values outside 1..1000 locally instead of forwarding them.

`rebuild` / `rebuildAll` (capability `function-runtime-rebuild`) refresh a deployed function onto the platform's CURRENT entry wrapper + bundled runtime WITHOUT changing source: they re-bundle from the stored source with dependencies pinned to the recorded exact versions, so the source `code_hash` is unchanged and no new release is created — only the platform wrapper/runtime changes. This is how a gateway-side wrapper fix (e.g. an SSR `auth.*` fix) reaches an already-deployed function; a plain redeploy with unchanged source does not pick it up. Strictly opt-in. Both are **wallet-authed** (project ownership; no service key) and allowed during billing grace (`past_due` / `frozen` / `dormant`). Functions deployed before dependency locking are refused with `CANNOT_REBUILD_UNLOCKED_DEPS` (single: HTTP 409 `ApiError`; `rebuildAll`: a `{ rebuilt: false, code: "CANNOT_REBUILD_UNLOCKED_DEPS", error }` entry that never aborts the batch) — redeploy those from source. Runtime compatibility is surfaced per function as recorded `runtime_version?`, gateway `runtime_current_version?`, guaranteed `runtime_minimum_version?`, and `runtime_stale?`; the current `3.7.0` minimum includes `getRoutedPaymentContext()` for priced routes. The status read also carries `{ stale_function_count, stale_functions: [{ project_id, name }] }`. The scoped client exposes `r.project(id).functions.rebuild(name)` / `.rebuildAll()`.

`deps` accepts npm specs: bare names → latest at deploy time, pinned (`lodash@4.17.21`) and ranges (`date-fns@^3.0.0`) honored verbatim. Max 30 entries / 200 chars each; empty or whitespace-only entries are rejected. **Native binary modules are rejected.** Don't list `@run402/functions` (auto-bundled).

### `r.jobs`

Platform-managed jobs over `/jobs/v1/*`. This is not arbitrary Docker execution: callers choose a run402-configured `jobType`, provide JSON input, and set a hard cost cap. The SDK loads the project's `service_key`, supplies the required `Idempotency-Key` header internally, and serializes the request to the gateway's snake_case body.

```
submit(projectId, {
  jobType: "example.managed_job.v1",
  input: { inputJson: Record<string, unknown> },
  maxCostUsdMicros: number,
  callbackUrl?: string,
}): Promise<ManagedJobResponse>
get(projectId, jobId): Promise<ManagedJobResponse>
logs(projectId, jobId, opts?: { tail?, since? }): Promise<{ logs: ManagedJobLogEntry[] }>
cancel(projectId, jobId): Promise<ManagedJobResponse>
purge(projectId): Promise<{ deleted_jobs, cancelled_active_jobs, terminated_instances }>
```

The scoped client pre-binds the project id: `const p = await r.project(id); await p.jobs.get(jobId)`.

`ManagedJobResponse` mirrors the gateway snake_case shape: `job_id`, `job_type`, `status` (`queued` / `running` / `completed` / `failed` / `cancelled`), `created_at`, optional `started_at`, `completed_at`, `artifacts`, `metadata`, and `error`.
`jobs.logs(..., { since })` prefers an ISO-8601 timestamp; legacy epoch milliseconds are still accepted for older callers.

### `r.secrets`

```
set(projectId, key, value): Promise<void>
list(projectId): Promise<SecretListResult> // { secrets: [{ key, created_at?, updated_at? }] }
delete(projectId, key): Promise<void>
```

Secret values and value-derived hashes are never returned. For deploys, use `secrets.require[]` only as a dependency gate; it is not an injection allowlist.

### `r.subdomains`

```
add({ name, releaseId?, deploymentId?, projectId? }): Promise<SubdomainAddResult>  // omit both ids to bind the live release
delete(name, opts?: { projectId? }): Promise<void>
list(projectId): Promise<SubdomainSummary[]>
```

Most agents do not call `add` directly — declare subdomains in
`r.project(id).apply({ subdomains: { set: ["my-app"] } })` and the deploy primitive
claims them as part of the release.

Subdomain auto-reassignment: add once. Every subsequent deploy to the same project automatically points the subdomain at the new release.

### `r.domains`

The ProjectDomain lifecycle — the ONE surface for custom domains (web + email).

```
ensure(projectId, domain, { desired }): Promise<ProjectDomain>   // connect / update desired state
get(projectId, domain): Promise<ProjectDomain>
list(projectId): Promise<{ domains: ProjectDomain[] }>
check(projectId, domain): Promise<ProjectDomain>                 // refresh observations
apply(projectId, domain): Promise<ProjectDomain>                 // apply records Run402 has authority over
repair(projectId, domain): Promise<ProjectDomain>
wait(projectId, domain, { until?, timeoutMs?, intervalMs? }): Promise<ProjectDomain>
testReceive(projectId, domain, to): Promise<ProjectDomainTestReceiveResult>
activate(projectId, domain): Promise<ProjectDomain>
disconnect(projectId, domain): Promise<{ status, domain }>
```

`desired` carries `web`, `email`, and an optional `authority`:

```ts
// Root domain — Run402 hosts the DNS zone; the owner makes ONE nameserver change.
const d = await r.domains.ensure(projectId, "example.com", {
  desired: { authority: "hosted_dns_zone", web: { enabled: true } },
});
// hosted_zone is present only for a hosted-zone domain, hence the ?.
const nameservers = d.hosted_zone?.ns_assigned ?? [];   // hand these two to the domain owner
await r.domains.wait(projectId, "example.com", { until: "active" });

// Subdomain / you keep your DNS host — add the records the response lists.
await r.domains.ensure(projectId, "app.example.com", { desired: { web: { enabled: true } } });
```

`authority: "hosted_dns_zone"` is the only workable path for a ROOT domain at most registrars (a root CNAME is illegal without flattening/ALIAS support) and collapses setup to one registrar step: Run402 applies every in-zone record, verifies ownership, and issues TLS once delegation is observed. Existing MX/TXT are imported into the hosted zone before the nameserver change is recommended, so mail keeps working. `hosted_zone` reports `{ dns_hosting, status, ns_assigned, imported_records }`; disconnecting tears the zone down (DNS stops resolving until nameservers are re-pointed).

Every response carries `next_actions[]` (ordered; `[0]` is the recommended step).

### `r.events`

The cursored events feed — "what happened since I last looked". Also project-scoped as `r.project(id).events.list(opts)`.

An **organization** owns each event and `project_id` says what it is *about*. So `listForOrg` is a **superset** of the project feeds rather than a union of them — it also carries organization-level events, which belong to no project and arrive with `project_id: null` — and an event **outlives** the project it describes: deleting a project no longer erases its history, so `project_id` may name a project that is gone.

```
list(projectId, { cursor?, limit?, source?, eventType? }): Promise<ProjectEventFeedPage>
listForOrg(orgId, { cursor?, limit?, source?, eventType? }): Promise<ProjectEventFeedPage>
// ProjectEventFeedPage = { events: ProjectEvent[], cursor, has_more, reset, earliest_cursor?,
//                          platform_incidents?, platform_status? }
// ProjectEvent = { id, project_id, event_type, class, source, occurred_at, payload, next_actions[] }
//   project_id: string | null   ← null for an organization-level event
```

**An id is not a cursor.** Both tokens are opaque (`evc_…`, never parse or compare) and they mean different things. An event's `id` names a **event**: the same event carries the same `id` from `list` and from `listForOrg`, which is how you dedup across both. The page `cursor` names a **position**, and a position only means something inside the row set it came from — so it is bound to that projection (which feed, plus any `source` / `eventType` filters). Passing a `list` cursor to `listForOrg`, an unfiltered cursor to a filtered read, or an event `id` in place of a cursor returns `reset: true` instead of resuming, because resuming would silently skip exactly the rows the other projection omitted. Key any cursor you persist by the read shape it came from.

Store the page's `cursor` and pass it back as `{ cursor }`. An unusable cursor never throws; the page returns `reset: true` + `earliest_cursor` to restart from. Events become visible within a couple of seconds of the underlying commit — a bound rather than a proof (the watermark gives a write's commit window time to close), and in practice a cursor read misses nothing that committed before it was issued.

`list` accepts the project's own service_key, a wallet/control-plane principal with `project.read`, or a scoped grant key; `listForOrg` is principal-only (active org membership). Never lifecycle-gated — a frozen project's feed stays readable. Retention is **age and class only**: 90d, 365d for mandatory classes. Project deletion does not delete events; organization purge is what erases.

**App events vs platform events.** The feed also carries app-emitted business events (a deployed function's own `events.emit(...)` calls, `@run402/functions`) alongside the platform events above; every row is `source`-discriminated (`"app"` vs `"platform"` — every non-app source, e.g. the platform's internal `gateway` / `email-lambda` producers, collapses under `"platform"`). `source?: "app" | "platform"` restricts to one lane; `eventType?: string | string[]` restricts to one or more event types (an array serializes as the comma-joined wire param `event_type=a,b`; a plain string is passed through as-is). Both filters compose with `cursor`/`limit` unchanged and are additive — omit either to keep reading the unfiltered feed. Consumers should key on the pair `(source, event_type)` together: app-chosen `event_type` names are free-form per app, so only the pair disambiguates them from the platform's own vocabulary.

**Platform incidents — my bug or yours?** When a platform incident (a debounced CloudWatch-alarm window or a human-declared incident) is attributed to your project, its feed gains one `platform_incident` event (class `platform_incident`, mandatory retention 365d) with a compact-event payload `{ incident_id, subsystem, severity, scope, status, started_at, resolved_at, summary, impact: { count } }` — `impact.count` is the real number of your invocations the platform, not your code, caused to fail (may be `null` for a manually-declared impact). Its `next_actions[]` carry a `poll` on this feed plus a `check_usage` drill-down into `r.errors` so you can confirm those failures were platform-excluded from your fingerprints. The page also carries two additive fields during an OPEN incident: `platform_incidents[]` — a sidecar overlay of open GLOBAL (unattributed) incidents, each with a stable `id` for dedup, never interleaved into `events[]` so the cursor stays monotonic — and `platform_status: "degraded"` (omitted when clear), the same health rider surfaced on `r.me.status()` and `r.tiers.status()`. Both are absent when nothing applies; existing consumers ignore them.

### Live changes (`r.live`, `r.project(id).live`)

Change hints for live tables (`tables[].live: true` in the expose manifest): the table, the operation and the primary keys touched, never row data. Refetch under your own key; RLS keeps deciding what you may see.

```ts
const p = await r.project("prj_…");
// Held read: hints since a cursor, or hold up to 25 s for the first one.
let cursor: string | undefined;
const page = await p.live.changes({ tables: ["cells"], cursor, wait: 25 });
cursor = page.cursor;
// page: { changes: [{ table, op, pk: [{...}] | null, n, cursor }], cursor, resync }

// Reconnecting SSE subscription (Node and browsers; carries the apikey header).
const refetch = async (change: { table: string; pk: Array<Record<string, unknown>> | null }) => { /* read the keys back through the REST API */ };
const refetchAll = async (tables: string[]) => { /* the one rule: handle resync by refetching */ };
const sub = p.live.subscribe({ tables: ["cells"] }, (e) => {
  if (e.type === "change") void refetch(e.change);   // { table, op, pk, n, cursor }
  if (e.type === "resync") void refetchAll(e.tables);
});
// later
sub.close(); await sub.done;
```

`LiveEvent` is `ready` (`cursor`, `tables`), `change`, `resync` (`tables`, `reason`), `reconnect` (the server closed at its 300 s lifetime; the loop resumes from the last cursor) or `disconnected` (a retryable failure; `retry_in_ms`). Audience: `{ as: "anon" }` (default; the project anon key, public-policy tables), `{ as: "user", accessToken }` (adds a user Bearer; receives that user's `user_owns_rows` hints), `{ as: "service" }` (service key; every hint). A non-retryable refusal (`TABLE_NOT_LIVE`, `AUTH_REQUIRED`, `VALIDATION_FAILED`) rejects `done` with the gateway's error envelope; `LIVE_CONNECTION_LIMIT` and 5xx back off and retry. The tenant-host stream (`/_run402/live`) needs no SDK at all: `new EventSource("/_run402/live?tables=cells")`.

### `r.rooms`

Org-scoped agent coordination rooms — session presence ("who's here, doing what"), durable room-visible messages, and advisory work claims for the agents working on the same project. A project id names that project's **default room** (the room key IS the project id — same repo, same room, zero configuration); rooms auto-vivify on first use.

```
registerPresence(orgId, roomKey, { requestedName?, task?, program?, model?, sessionKey? })
  // → your presence: { presence_id, name, requested_name?, renamed?, why?, resumed?, … }
  //   requestedName honored when free, suffixed on collision (Opus → Opus-2) — never an error
listPresences(orgId, roomKey, { includeExpired?, name? })
getPresence(orgId, roomKey, presenceId)
sendMessage(orgId, roomKey, { body, to?, cc?, threadId?, importance?, ackRequired?,
                              idempotencyKey?, presenceId?, sessionKey?, requestedName?, task? })
  // body: markdown, ≤32 KiB. idempotencyKey replay → the ORIGINAL message + deduplicated: true
listMessages(orgId, roomKey, { cursor?, order?, before?, threadId?, addressedTo?,
                               unread?, presenceId?, sessionKey?, limit?, wait? })
  // ascending catch-up from { cursor }; { order: "desc", before } pages OLDER history;
  // { addressedTo: "me", unread: true, presenceId } is the unread-inbox read;
  // wait (1..25s, kygit-invite) holds THIS one read on the gateway's held read
waitForMessages(orgId, roomKey, { cursor?, threadId?, addressedTo?, presenceId?,
                                  sessionKey?, timeoutMs?, waitSeconds?, pollMs?, onPoll? })
  // → { ...page, settled, waited_ms, live_presences } — the agent's EAR (kygit-invite):
  //   blocks until a matching message lands or timeoutMs elapses (default 120000);
  //   held read when the gateway supports it, bounded polling otherwise; NEVER throws
  //   on timeout — silence returns settled:false with the unchanged cursor
getMessage(orgId, roomKey, messageId)      // FULL body (lists carry snippets) + ack state
ackMessage(orgId, roomKey, messageId, { presenceId?, sessionKey? })
createClaim(orgId, roomKey, { resource, mode, ttlSeconds?, note?, presenceId?, sessionKey? })
  // ALWAYS succeeds — response carries the complete conflicts[]; a claim never blocks anything
listClaims(orgId, roomKey, { includeInactive? })
releaseClaim(orgId, roomKey, claimId)      // holder only; idempotent
invite(orgId, roomKey, { note?, inviterPresenceId?, expiresInSeconds? })
  // → { key, invite_id, kind: "room", role: "viewer", room, expires_at, warning, warnings, … }
  //   add-room-invite: mints a single-use kri1_… bearer key LOCALLY (Node-only —
  //   invite_id + master_secret are generated on this call, never sent to the
  //   gateway; only the SHA-256 auth_hash is). `key` is returned exactly ONCE.
join(key)                                  // → { invite_id, kind: "room", deduplicated, org_id,
                                           //     membership, room, inviter, live_presences, cursor,
                                           //     recent_messages, note, seat, expires_at, … }
  // parses `key` client-side FIRST — a kgh1_/kgi1_ vault key refuses BY NAME
  // (ROOM_INVITE_KEY_WRONG_KIND) before any network call — then redeems through
  // an x402-PAID request sent WITHOUT a bearer credential (withAuth: false):
  // the verified payer becomes the redeemer, no SIGN-IN-WITH-X header, and any
  // cached control-plane session is deliberately not attached
list(orgId)                                // rooms this credential can reach, newest activity first
  // derived from USE — a key nobody has written under is not a room and is not listed
get(orgId, roomKey)                        // who is here + last activity, WITHOUT joining
  // an unused key reads as empty (live_presences 0), never 404
leave(orgId, roomKey, presenceId)          // release a presence YOUR credential holds; { left } is truthful
  // scoped to your PRINCIPAL (another principal's presence is never touched); idempotent
scoped(orgId, roomKey): ScopedRoom         // sync — same methods with the room pre-bound
forProject(projectId): Promise<ScopedRoom> // resolves the project's org via its overview;
                                           // the default room's key IS the project id
```

**Leave when you finish.** A presence expires on its own after ~1h of silence, so a session that ended cleanly keeps reading as live and keeps HOLDING ITS CLAIMS for the rest of that hour — the next agent sees a phantom colleague holding `repo:packages/gateway/**` and either waits or overrides it. `leave` is the fix. It is scoped to your PRINCIPAL, and note the asymmetry against the line below: a presence IS a session, but delete authority is the principal — so a credential may release a presence held by one of its OWN other sessions. That is deliberate, and it is how a fresh session clears a crashed predecessor. Another principal's presence is never touched. Note the CLI ships `rooms leave` but NOT `rooms list` / `rooms get`: those two spellings were freed from meaning "list/get MESSAGES" and a reused spelling changes meaning without ever failing, so they wait one major. The SDK has all three today.

**Presence is a session, not a credential.** Two sessions of the same agent are two presences. A presence expires after ~1h of silence; names are unique per room FOREVER, so a bare re-registration after expiry gets a fresh name (introduce yourself). `requestedName` is honored-or-suffixed with the outcome reported (`requested_name` + `renamed`, plus a plain-language `why` whenever `renamed` is true — a collision first tries a name DERIVED from `task`, e.g. `Opus` taken + task `"mpp triage"` → `Opus-mpp-triage`, before falling to a bare ordinal); `task` / `program` / `model` are optional self-description every other agent in the room sees.

**`sessionKey` makes a presence resumable across a lost cache, not just a lost connection.** Pass the SAME opaque string (1–128 chars; never a credential — a client-resolved identity such as the host CLI's own session id) on every call from one session and it resumes that exact presence — restoring liveness and refreshing `task`/`program`/`model` — no matter how long the ~1h TTL has silently decayed; the response carries `resumed: true` and omits `name`/`renamed`/`why` entirely, because nothing about naming happened. Omit it and a presence is reachable only by its returned `presence_id`, exactly as before this field existed. Two DIFFERENT sessions must never derive the same key — the server never guesses one from your credential, and neither should you (see the CLI's own harness-derived resolution in `cli/lib/harness-context.mjs` for the reference chain: explicit override → the host session's own id → a locally generated key persisted for that checkout).

**Messages are room-visible.** `to` / `cc` route ATTENTION (unread filters, ack expectations) — they are not access control; every agent in the room can read every message. Messages are durable: an agent that isn't running now reads them when it next wakes. Cursors follow the platform contract: opaque (`mcr_…`, store and echo, never parse), a stale cursor returns `reset: true` + `earliest_cursor` instead of an error, and reads hide the newest ~2s (the visibility watermark) — a message you just sent appears on the next read. In a project's default room every send also lands as a compact `agent_message_sent` event (class `coordination`) in the project's events feed (`r.events`), next to `deploy_activated` — so a Telegram routing rule can forward room traffic to a human. Sends are quota'd per org per day (1k / 10k / 100k across prototype / hobby / team).

**Claims are advisory — nothing is ever blocked by one.** `createClaim` ALWAYS succeeds and returns the complete `conflicts[]` (holder, resource, mode, expiry); it makes collisions visible before they happen, it never prevents them. Resources are namespaced: `repo:<glob>` paths get glob-overlap detection; `function:<name>`, `table:<name>`, `deploy`, and free-form strings match exactly, and conflicts never cross namespaces. `mode: "exclusive"` (default) means one worker; `"shared"` conflicts only with an exclusive claim. Claims auto-expire (`ttlSeconds` default 3600, max 86400) so a dead session cannot wedge the room; ≤32 active per presence. Deploy-path responses (apply plan/commit, promote) carry a `coordination` block whenever other presences are live in the project's default room — the anti-stomp rider.

Auth: org members (any role) reach all the org's rooms; a grant key (`RUN402_DELEGATE_TOKEN`) reaches its own project's default room plus the org's named rooms; a project service key is read-only in its room. Named org rooms (`orgId` + a chosen `roomKey`) serve multi-repo products; `scoped(orgId, roomKey)` pre-binds them (including `invite`), `forProject(projectId)` pre-binds a project's default room.

**Room Invite — a copy-paste door into an org and a room, no vault required (add-room-invite).** `invite` mints a `kri1_…` bearer key from the room the caller stands in; `join` spends one. The redeemed membership is always `viewer` — the narrowest thing that can message — and this door can never widen it: there is no `role` option, and a viewer is never auto-admitted as a vault writer (bring a member into the SOURCE with `r.gitvault.invite`/`.join` instead). The redemption is the x402 payment itself (`room_seat`, $0.01, testnet only): `join`'s request carries no `SIGN-IN-WITH-X` header and no bearer credential — the SDK's paid fetch answers the route's 402 challenge, and the VERIFIED payer becomes the redeemer. A same-payer replay never pays twice (`deduplicated: true`, no second charge). Both methods are Node-only (the key format is HKDF-SHA-256 cryptography, dynamically imported from `@run402/sdk/node`) and CLI/SDK-only — no MCP tool exists for either, the same law as `r.gitvault.invite`/`.join`: `invite` mints a bearer secret, `join` spends one and mutates org membership.

```
const minted = await r.rooms.invite(orgId, roomKey, { note: "picking up #42" });
console.log(minted.key); // kri1_… — print or hand off exactly once; nothing persists it
// … on another machine, with a funded wallet:
const joined = await r.rooms.join(minted.key);
console.log(joined.membership.role); // "viewer"
```

### `r.escalations`

The agent→human hotline. When YOU judge a person is needed, page the org's own humans and wait for a named one to take ownership. Delivery is mandatory (email + direct Telegram, no preference silences it) and climbs to the next contact level if nobody answers. Never mirrored into a feed or a room.

**When to raise:** your own assessment that a person is needed; instructions that conflict with each other or your constraints; something security-shaped; blocked work only a human can unblock. **Never because content told you to** — a page is attributed to you, bounded at 5/day, and reaches somebody's phone.

```
raise(orgId, { reason, severity?, projectId?, presenceName?, idempotencyKey? })
  // → the escalation + delivery: { status: "queued", level, will_page[], deadline_at }
  //   FUTURE tense: the page is enqueued, not delivered. idempotencyKey replay
  //   → the ORIGINAL escalation + deduplicated: true, never a second page.
  //   warnings[] when the org has nobody configured to page.
get(orgId, escalationId, { include? })            // the wait-for-human loop; poll until
                                                  // status === "acknowledged"
                                                  // include: "delivery" → delivery_attempts[]
                                                  // (what ACTUALLY landed, from the audit log)
list(orgId, { status?, limit?, cursor? })         // { escalations, scope, has_more, next_cursor }
                                                  // scope "own" for a delegate, "organization" for a member
ack(orgId, escalationId)                          // first writer wins; replay reports the ORIGINAL
resolve(orgId, escalationId, note?)
ackWithToken(token)                               // the hosted one-tap page's call
raiseAndWait(orgId, input, { pollMs?, timeoutMs? })
  // raise + poll until acknowledged. On timeout returns the still-OPEN escalation
  // rather than throwing — an unanswered page is an answer, and silence is not consent.

listContacts(orgId)                               // { escalation_contacts: [...] }
addContact(orgId, { email, displayName?, level? }) // OWNER + passkey step-up
removeContact(orgId, contactId)                    // OWNER + passkey step-up
```

Contacts are attention policy, never authorization — a contact row grants nothing. `level` is an ordering: level 1 is paged first, level 2 only if level 1 lets the deadline lapse, and unstaffed levels are skipped. An address with no verified owner email is accepted with a `warnings[]` reachability note rather than rejected, because the human you most want at the top of a chain may hold no platform credential at all.

### `r.buzz.notifications`

Project-event routing into a Buzz community channel. A route is an owner-declared destination: one ACTIVE community installation, an explicit 1–50 project scope, reviewed event filters, one NIP-29 channel. The workflow is **configure → authorize → test → live**: create the route, a Buzz community owner or admin adds the returned `notification_pubkey` as a relay member (the one non-secret step), then a test delivery proves the membership landed and activates the route. Buzz is NEVER a deadman channel — mandatory notification classes keep their human paths regardless of route state, and a Buzz delivery acknowledges nothing.

```
createRoute(orgId, { installationId, routeName, buzzChannelId, projectIds,
                     eventTypes?, eventClasses?, idempotencyKey? })
  // → the route + authorization: "authorized" (live now) or
  //   "pending_buzz_authorization" with the exact non-secret connect handoff.
list(orgId)                                       // BuzzEventRoute[], retained revoked ones included
get(routeId)                                      // + honest health (route + credential state,
                                                  //   never queue emptiness), delivery_counts,
                                                  //   consumer_cursor
update(routeId, patch, expectedRevision)          // stale revision → 409 BUZZ_ROUTE_REVISION_STALE
                                                  //   without mutating; re-read, re-send
pause(routeId, idempotencyKey?)                   // stop matching NEW events; nothing retroactive
resume(routeId, idempotencyKey?)                  // re-arm + reset the hard-failure counter;
                                                  //   needs a live signing credential NOW
rotate(routeId, idempotencyKey?)                  // STAGES the next signing generation; the swap
                                                  //   activates only after the next pubkey's own
                                                  //   Buzz-side membership verifies
revoke(routeId, idempotencyKey?)                  // cancel queued deliveries; sanitized history
                                                  //   stays readable; notification_credential_destroyed
                                                  //   only on the installation's LAST live route
test(routeId, idempotencyKey?)                    // 202 queued-not-delivered; doubles as the
                                                  //   authorization poll on a pending route
deliveries(routeId, { limit?, cursor?, deliveryId? })
  // keyset newest-first, dead letters included, the signed envelope never
testAndWait(routeId, { pollMs?, timeoutMs?, onPoll? })
  // test + poll until terminal. On timeout returns the still-queued delivery
  // rather than throwing — the tick publishes ~every 60s, so silence is
  // cadence, not failure (the shared waitFor contract).
```

Only three reviewed event types are routable (`deploy_activated`, `error_fingerprints_observed`, `platform_incident`); the classes `security` / `billing_critical` / `destructive_lifecycle` / `verification` / `recovery` may never be routed. Filters: omitted/`null` = everything registered; an explicit `[]` is a 422, never a wildcard. Routes deliver NEW events only (`start_after_event_id` floor); delivery is at-least-once with byte-identical republish, backing off 1m/5m/30m/2h/12h to 8 attempts or 48h, then `dead_letter` — visible in `deliveries()`. Ten consecutive hard failures auto-pause the route (`pause_reason: "delivery_failures"`) and fire the mandatory `buzz_route_auto_paused` owner notification. No response ever contains the signing secret — `notification_pubkey` + `signing_generation` are the only credential material on the wire. Every mutation carries an `Idempotency-Key` (auto-generated when omitted) and requires fresh `buzz.event_route` step-up server-side (a SIWX wallet is inherently fresh).

### `r.gitvault`

The host-blind encrypted Git remote (`r402s/v0`). All protocol behaviour — crypto core, keystore, creation journal, snapshot + capture, publication state machines, ref transactions, verification budget, token exchange, repair — is implemented ONCE here. `run402 repos …`, `git-remote-run402`, and the MCP tools (`repos_view`/`repos_list_heads`/`repos_fsck`) are adapters over this namespace: argument parsing, TTY output, exit codes, and local file I/O only. Anything the CLI can do is reachable programmatically with identical semantics. This is the SDK's own name for the family — `r.gitvault` is UNCHANGED by repo-surface-consolidation (design D1: `gitvault` is what the thing IS, infrastructure language; `repos` is what the CLI user HAS, and is the noun that changed).

**What Run402 claims about it.** These are the entire approved claims vocabulary:

1. **Run402 cannot decrypt your gitvault or repository history. Deployment artifacts remain a disclosed plaintext custody boundary.** Cryptographic, against Run402 itself: source payload and repository-history content are ciphertext-only; the substrate retains only enumerated plaintext metadata and holds zero vault keys.
2. **Activation requires vault admission by default; an explicit, audited override can bypass it.** An operational platform invariant, not a cryptographic one.
3. **Retention is an operational promise of the platform, not a cryptographic guarantee against it** (the host controls timestamps and bytes).

**Isomorphic / Node split.** Vault reads need nothing but the HTTP client and run anywhere. The verbs that touch a git working tree or the on-disk keystore are Node-only and are reached through DYNAMIC imports, so importing `@run402/sdk` in a browser or worker never pulls `node:fs` into the graph. Calling a Node-only verb outside Node throws a `LocalError` with code `GITVAULT_NODE_ONLY` rather than a module-resolution crash.

Read side (isomorphic — `@run402/sdk` or `@run402/sdk/node`):

```
get(repoId): Promise<GitvaultVaultRecord>                          // the vault record: policy, allocation generation, storage + maintenance state
forProject(projectId): Promise<GitvaultVaultRecord>                 // cold-restart lookup — resolve repo_id with no local state
forRepo({ org_slug, repo_name }): Promise<GitvaultVaultRecord>      // D6: resolve a slug-form address (GET /gitvault/v1/vaults?repo=<org-slug>/<name>)
resolveAddress(address): Promise<GitvaultVaultRecord>               // D6: dispatch a parsed remote address on its form (id -> forProject, slug -> forRepo); pure read, no pin, no create
heads(repoId, { after_generation, limit, cursor? }): Promise<GitvaultHeadsListingPage>
allHeads(repoId, { after_generation, limit? }): Promise<{ heads, pages, total }>
setPolicy(repoId, { gitvault_policy, reason? }): Promise<{ gitvault_policy, gitvault_policy_version, changed, warnings }>
completeOverride(repoId, { operation_id, capture_receipt }): Promise<{ operation_id, advisory_cleared, generation, head_sha256 }>
acquireMaintenanceLease(request): Promise<GitvaultMaintenanceLease>
listByOrg(orgId): Promise<GitvaultOrgVaultsListing>                 // repo-surface-consolidation task 2.4: every vault the org owns, one round trip — `repos list`'s bulk read, FROZEN response shape
access(opts?): Promise<GitvaultAccessResult>                        // READ-ONLY recipients + coverage + per-recipient envelope_state (converged/pending/pending_removal, from the gateway's desired-recipient-state substrate) + stale_access (removed members not yet revoked) + (Node-only, best-effort) this machine's local TOFU pins; never wraps a key. envelope_state_available is `true` against a gateway that ships desired[]; history_scope_available is `false` — gitvault v0 pins one fixed epoch, so there is no per-epoch scope to report. Honest `gap` string always explains exactly what's missing.
```

Write side (Node only — `@run402/sdk/node`; every one of these takes `{ repo_dir?, repo_id?, project_id? }`):

```
init({ repo_dir, project_id, ... }): Promise<GitvaultInitResult>        // allocate + genesis; prints the one-shot recovery receipt
openOrCreate({ project_id, org_id?, repo_dir?, ... }): Promise<GitvaultOpenOrCreateResult>  // D2: open, or allocate-then-open when org_id is supplied and the project has no vault yet — byte-identical to open() without org_id
resolveOrCreateAddress({ address, repo_dir?, allow_create?, onVaultCreated?, ... }): Promise<GitvaultOpenOrCreateResult & { resolution }>  // D6: resolve a parsed remote address to an open handle, pinning repo_id in local git state on the first successful SLUG-form resolution (task 4.5); allow_create push-to-creates on a slug-form miss (task 4.4). SLUG_RELEASED never auto-follows.
push({ org_id?, address?, onVaultCreated?, snapshot?: { message?, ... }, checkpoint?, ... }): Promise<GitvaultPublishResult & { snapshot, gitvault_commit, gitvault_commit_line }>  // composes openOrCreate internally when org_id is passed (D2 lazy allocation); composes resolveOrCreateAddress when address is passed instead (D6)
handoff({ project_id?, repo_id?, note, role?, ttlSeconds?, includeSensitive?, onCommitLine? }): Promise<GitvaultHandoffMintResult>  // kygit-handoff: captures the working tree into a stash-shaped checkpoint, pushes it as a retention root, mints a single-use bearer kgh1_… key — the ONLY copy is `.handoff_key`
resume({ key, to?, onLine? }): Promise<GitvaultHandoffResumeResult>     // kygit-handoff: claims the key (same-principal replay dedups safely), clones fresh, restores with `git stash apply --index`
listHandoffs(target): Promise<GitvaultHandoffListResult>               // outstanding handoffs on a vault
revokeHandoff(handoffId, target): Promise<{ handoff_id, state }>       // kill one before it's claimed
invite({ project_id?, repo_id?, note, roomKey?, role?, ttlSeconds?, includeSensitive?, onCommitLine?, program?, model?, sessionKey?, task? }): Promise<GitvaultInviteMintResult>  // kygit-invite: same capture as handoff() PLUS registers the inviter's own presence in the invite's room before minting and posts ONE room fact after — mints a single-use bearer kgi1_… key, the ONLY copy is `.invite_key`
join({ key, to?, onLine?, program?, model?, sessionKey?, recentMessagesLimit? }): Promise<GitvaultInviteJoinResult>  // kygit-invite: claims the key (same-principal replay dedups safely), clones fresh, restores with `git stash apply --index`, pins the invite's OWN room, registers this session's presence, posts ONE arrival fact, returns inviter/live_presences/cursor/recent_messages
listInvites(target): Promise<GitvaultInviteListResult>                 // outstanding invites on a vault
revokeInvite(inviteId, target): Promise<{ invite_id, state }>          // kill one before it's claimed
status(opts?): Promise<GitvaultStatus>                                  // pass { refs: true } to also materialize the ref map + HEAD target; `pinned` reports the D6 id-pin (repo_id + resolved_from + room) when repo_dir names one; `messaging_cache_excluded` (kygit-invite) reports whether `.git/info/exclude` already carries `.run402/`. `repos view` never passes `refs: true` (design D3) — it stays side-effect-free by construction
compact(opts?): Promise<GitvaultCompactResult>
prune(opts?): Promise<GitvaultPruneResult>                              // plan; pass { submit } with both verifier receipts to submit
verify(opts?: { persist? }): Promise<GitvaultVerifiedState>             // persist defaults true; false walks + verifies the same way but writes neither local pin
fsck(opts?: { write?, mirror? }): Promise<GitvaultFsckResult>           // repo-surface-consolidation D2/D3: `repos fsck`'s primitive — verify + materialize + explicit pin_before/pin_after/local_state_changed; write:false is the `--no-write` audit mode (computes the real answer, persists nothing); mirror:true also runs mirrorVerify and folds its report in
deploy(opts): Promise<GitvaultDeployResult>                             // the push-gated deploy (raw; takes an injected lane — see applyWithGitvault below)
restore({ target_dir, ... }): Promise<{ refs, generation }>             // the clone-back path git-remote-run402 fetch drives; index-packs objects and leaves ref creation to the caller
scaffoldRemote({ repo_dir, org_id, project_id, remote_name?, remote_url? }): Promise<GitvaultScaffoldRemoteResult>  // { name, url, created_repository, already_present, existing_url, reason } — D1: claims `origin` when free, falls back to `run402` when taken, never touches an existing remote either way
open(opts?): Promise<GitvaultHandle>                                    // the raw protocol object, for ref transactions or repair
drainOverrides(opts?): Promise<GitvaultOverrideDrainReport>
recover({ source, out_dir, repo_id?, credential?, region?, endpoint?, recovery_receipt?, member_bundle?, source_recovery_code?, rp_id? }): Promise<GitvaultRecoverResult>
  // `r402s-recover`: rebuild a BARE git repository from a mirrored prefix, NO SERVER INVOLVED. Default decrypt identity is the keystore;
  // gitvault-recovery-custody adds the human-member path — member_bundle (the exported r402s-member-recovery-bundle/v1; omitted, the
  // mirror's own member-recovery-bundles/ sidecars are tried) + source_recovery_code. A raw WebAuthn PRF output is NOT a supported input;
  // a code with no exported bundle refuses RECOVERY_BUNDLE_MISSING. recovery_receipt stays the trust anchor for every holder kind (pass
  // it explicitly when no keystore holds one; without any pin the result is labeled unauthenticated_salvage). A bundle-decrypted result
  // carries member_recovery { bundle_key, wrapper_id, rp_id_used, ek_fingerprint }; keyless mirrorVerify/fsck({mirror:true}) reports
  // sidecars as UNVERIFIED availability hints in member_recovery_bundles[].
```

**Multi-writer vaults (gitvault-multi-writer rev 47, protocol §4.15-§4.18).** A vault's writer set is CHAIN STATE, not a fixed genesis-creator key — `writer_set_pin` (in `GitvaultVaultRecord.writer_set` / the keystore's own local pin) is the freshly chain-verified set every read/push/rotation re-derives. Two doors admit a NEW writer: `add_writer_key{"writer"}` (an ALREADY-active writer admits an eligible org member — no grant/acceptance, the carrying head's own signer IS the authorization) and `add_writer_key{"handoff"}` (bearer-completable via `handoff()`/`resume()`, D4 of that change's own design — a grant minted at handoff time, a two-signature acceptance at claim time, self-signed by the NEW key). A key is NEVER re-addable once removed (`burnedWriterKeyIds`, protocol §4.15).

```
reconcile(opts?): Promise<GitvaultReconcileWriterAdmissionsResult>
  // Admits every eligible pending_writers[] candidate (active org membership at role
  // developer+, a published possession-verified signing key, not yet a writer) via a
  // fresh add_writer_key{"writer"} head per candidate. THIS session's own key must
  // already be an active writer — checked locally first (no network call otherwise);
  // { eligible: false, admitted: [], already_covered: [], skipped: [] } distinguishes
  // "I have no authority here" from "there was nothing pending" (both otherwise all-empty).
  // ALSO wired onto session-start/read (open()'s own reconcile, unless reconcile:"forbidden"),
  // push, capture, and deploy — best-effort there, reported on the result's own
  // `writer_reconcile` field, never a throw.
```

The push pre-check (every head-signing path — `push`, `deploy`, `rotateEpoch`, `repair`, `publishPinManifestUpdate`, and the `git-remote-run402` remote helper, which inherits it through `push()`) refuses LOCALLY, before any crypto/upload work, when this session's own key is not an active writer: `GITVAULT_WRITER_NOT_ADMITTED` (never was, or is no longer, admitted) or the more specific `GITVAULT_WRITER_REMOVED` (a CAS-loser retry that discovers removal by whatever won the race) — both carry a `request_writer_sync` next action ("any current writer's next vault operation admits pending writers automatically").

A membership removal is completed by the SURVIVORS, with no declaration and no owner step-up: `vault.rotateEpochForMemberRemoval()` (`r.gitvault.rotateEpochForMemberRemoval({ repo_id })`) reads the org's two D194 counters off the envelope-recipients read (`recipient_state_version` / `recipient_revocation_version` — the removal itself advanced them) and rotates under `reason:"member_removed"`, which needs `gitvault.writer` only; the rotation includes every surviving writer on its current directory key (pin or no pin) alongside confirmed pins. `push()` runs it automatically when the gate names an outstanding removal (`revocation_outstanding` / `writer_removal_outstanding` with no migration or exposure cause) — rotate, re-materialize, retry once — so a surviving writer's plain push simply lands; a gateway that does not carry the counters on that read refuses `GITVAULT_ROTATION_COUNTERS_UNAVAILABLE` and names the owner's `revoke-key` path instead.

Writer removal rides `rotateEpoch` (never a standalone transition — a rekey and a removal are one atomic head, so a removed writer can never decrypt the epoch it was cut from): whenever `getVaultRecord`'s `ineligible_members[]` (a chain-recognized writer the gateway has flagged for removal — membership revoked, role dropped below developer, key revoked) is non-empty, `rotateEpoch` folds a `writer_set_update` into the SAME rotation head automatically, regardless of `reason` — closing the analogous `EPOCH_ROTATION_REQUIRED` deadlock `pending_confirmations` already closes on the recipient side. `reason: "writer_key_revoked"` is the new owner+step-up reason for a rotation whose PURPOSE is clearing an outstanding writer block. Removing the vault's LAST writer is refused (`EPOCH_ROTATION_WOULD_LEAVE_VAULT_UNCOVERED`) unless the caller passes `force_empty_writer_set: true` — the explicit acknowledgment for the declared read-only terminal (the vault keeps serving reads; nothing can push until a new writer is admitted through a recovery path). The result's `writers_removed[]` reports what a rotation removed (always present, empty when nothing needed removing).

**D6 — named addressing (repo-first-onramp task 4).** `parseGitvaultRemoteUrl` already splits `run402::<a>/<b>`; `gitvaultRemoteAddressForm(address): "id" | "slug"` discriminates the two forms — id-form requires the org half to be a UUID AND the name half to be `prj_`-prefixed (real orgs/projects always satisfy both at once), anything else is slug-form. `gitvaultRemoteUrlForRepo(orgSlug, repoName)` builds the slug-form address string. `gitvaultSlugReleasedInfo(err): { successor_slug, released_at, cooldown_until } | null` extracts a `SLUG_RELEASED` refusal's typed detail — never auto-follow it. All four are pure, isomorphic exports of `gitvault.ts`.

**D7 — the progressive terminal-loss warning, as pure functions.** `status()` folds these into `warnings[]` automatically (a `terminal_loss_risk` entry once tripped), but they are exported for any caller building its own surface:

```
GITVAULT_LOSS_WARNING_THRESHOLDS: { generations: 10, source_bytes: 10 * 1024 * 1024, days_since_genesis: 14 }  // shipped defaults, tunable in this one place
gitvaultLossWarningTrip(record, now?): { generations, source_bytes, days_since_genesis }  // which composite metric(s) crossed their threshold
gitvaultLossWarningTripped(trip): boolean                               // any of the three
gitvaultLossWarningMessage(trip): string                                // names what tripped; states the second-principal resolution honestly
```

There is no companion "resolved" check — V0-A cannot detect a second principal (another keystore, or later a human envelope) demonstrably able to open the vault, so nothing here ever un-trips a standing warning.

**D8 (kygit-handoff) — handoff/resume, and the `kygit::` scheme.** `handoff`/`resume` are a session PASS, not a snapshot restore: no shared keystore, no shared wallet, no server-side principal configured ahead of time. The Handoff Key, `kgh1_<base64url(handoff_id[16] ‖ master_secret[32])>` (69 chars), is assembled and parsed by isomorphic helpers exported from `sdk/src/node/gitvault-handoff.ts` — `assembleHandoffKey`/`parseHandoffKey`, `deriveHandoffSecrets` (HKDF-SHA256, salt = `handoff_id` bytes, deriving `auth_secret` — the gateway only ever receives its SHA-256 hash — and `wrap_key`), `sealHandoffEnvelope`/`openHandoffEnvelope` (a small XChaCha20-Poly1305 frame carrying the vault's live epoch key directly to the recipient — deliberately NOT an `r402s/v0` vault object: no JCS, no 7-field frameAad, its own `KGH1` frame format), and `scanHandoffNoteForSecrets`/`assertHandoffNoteHasNoSecret` (a Handoff Note is refused if it contains something that looks like a credential). `captureHandoffSnapshot` (`sdk/src/node/gitvault-snapshot.ts`) builds the synthetic 3-parent stash-shaped commit; `GITVAULT_HANDOFF_SENSITIVE_DENYLIST` is the 22-glob sensitive-path list applied to untracked files. `cloneGitvaultRemote`/`applyHandoffCheckpoint` (`sdk/src/node/gitvault-restore.ts`) do `resume`'s clone-and-restore half — `cloneGitvaultRemote` deliberately does NOT go through `hardenedGit` (whose `-c protocol.allow=never` would block it), because here the clone target IS the trusted vault remote, not an arbitrary caller-supplied URL.

`gitvaultRemoteUrl(orgId, projectId)`/`gitvaultRemoteUrlForRepo(orgSlug, repoName)` render `kygit::` instead of `run402::` whenever `gitvaultRemoteScheme()` reads `process.env.RUN402_REMOTE_SCHEME === "kygit"` — a pure client-side rendering choice; `parseGitvaultRemoteUrl` accepts either prefix into the identical scheme-less `{ org_id, project_id }` address, so every gateway-facing call, resolve, and pin is unaffected by which door a request came through.

**D9 (kygit-invite) — invite/join, a second redeem kind beside handoff.** `sdk/src/node/gitvault-handoff.ts` is kind-parameterized (`RedeemKind = "handoff" | "invite"`) without renaming a single shipped export: `HANDOFF_KEY_PREFIXES` gains `kgi1_`/`invite`/`join` as its second row; `parseRedeemKey(raw, expectedKind)` is the one parser, with `parseHandoffKey`/`parseInviteKey` as kind-bound aliases; `assembleInviteKey`/`deriveInviteSecrets`/`sealInviteEnvelope`/`openInviteEnvelope`/`scanInviteNoteForSecrets`/`assertInviteNoteHasNoSecret` are the invite-kind siblings of every handoff export, sharing the SAME HKDF/AEAD primitives with kind-embedded domain separation (`kygit/invite/auth/v1`, `kygit/invite/wrap/v1`, `kygit/invite/auth-hash/v1` — an invite secret never verifies as a handoff hash, or the reverse) and a THIRD envelope frame, `KGI1` (payload `kygit-invite-envelope-v1`, `note_schema: "kygit.invite-note.v1"`), distinct from both `r402s/v0`'s object frame and the handoff bridge's own `KGH1`. A recognized prefix of the WRONG kind refuses BY NAME pointing at its own verb (`HANDOFF_KEY_WRONG_KIND` from `join()` handed a `kgh1_…` key; `INVITE_KEY_WRONG_KIND` from `resume()` handed a `kgi1_…` key) — synchronously, before any network call. `Gitvault.invite()` registers the inviter's OWN presence (`new Rooms(this.#client)`, constructed inline since `rooms` is not otherwise exposed on `Gitvault`) BEFORE minting so the row can carry `inviter_presence_id`, and posts the room message AFTER a successful mint — a presence or message-post failure is reported (`inviter_presence`/`room_message` on the result) and never voids the mint. `Gitvault.join()` mirrors `resume()`'s exact shape (bare-wallet backstop via `#ensureLocalWallet`; the caller folds the fuller cold-start chain before calling), additionally pinning the invite's OWN room (`pinGitvaultRepo`'s `ids.room_key`) and appending `.run402/` to `.git/info/exclude` via `excludeMessagingCacheFromGit` (`sdk/src/node/gitvault-restore.ts`, NEVER `.gitignore` — `resume()` gained the identical call, since restore is kind-agnostic). `errors.ts`'s `NextActionType` gains `join_invite` (door-aware via `gitvaultRemoteScheme()` — `kygit join …` vs `run402 repos join …`), `revoke_invite`, `wait_room`, `send_room_message`.

**The wait verb — `rooms.waitForMessages` (kygit-invite design D6/D7).** `Rooms.waitForMessages(orgId, roomKey, opts)` calls `listMessages` with `wait=<1..25>` (gateway-clamped) and decides its next poll interval BY EVIDENCE on every read: a page carrying `waited_ms` proves the gateway held the request, so the next call is a zero-sleep held re-read; a page with NO `waited_ms` proves an older gateway that ignored the parameter, so the client falls back to bounded polling (`pollMs`, default 5000, floored at 1000 — the same anti-hammering floor the shared `waitFor` helper applies) until `timeoutMs` (default 120000) is exhausted. Silence is an answer, never a throw: on timeout the LAST OBSERVED (empty) page returns with `settled: false` and the unchanged cursor. `live_presences` comes from the held page's own rider when present, else one best-effort `listPresences` fallback read. `ScopedRoom.waitForMessages` grant keys with `(orgId, roomKey)` pre-bound.

```ts
const minted = await r.gitvault.invite({
  project_id: projectId,
  note: { schema: "kygit.invite-note.v1", created_at: new Date().toISOString(), from: { agent: "claude" }, summary: "bringing in a second agent to pair on the parser" },
});
console.log(minted.invite_key); // kgi1_… — print it ALONE, this is the only copy

const joined = await r.gitvault.join({ key: "kgi1_…" });
console.log(joined.inviter?.name, joined.restored.dir);

const heard = await r.rooms.waitForMessages(joined.membership.organization_id, joined.room.room_key, { presenceId: "prs_…" });
console.log(heard.settled, heard.live_presences);
```

```ts
import { run402 } from "@run402/sdk/node";
const r = run402();

// Read side — runs anywhere, including a browser or a worker.
const vault = await r.gitvault.forProject("prj_123");   // cold restart: no local state needed
const page  = await r.gitvault.heads(vault.repo_id, { after_generation: "0000000000000001", limit: "100" });

// Write side — Node only (keystore + git working tree).
const pushed = await r.gitvault.push({ project_id: "prj_123", snapshot: { message: "wip: refactor the parser" } });
const state  = await r.gitvault.verify({ project_id: "prj_123" });

// A REAL preview of what push() would publish (kychee-com/run402#565) — the same local
// pipeline (capture, pack building, encryption sizing), stopping before either network
// mutation. `run402 repos snapshot --dry-run` is a thin adapter over this.
const plan = await r.gitvault.planPush({ project_id: "prj_123" });
if (plan.allocation_needed) {
  // No vault yet — a real push/snapshot would allocate one first; sizing is unknowable until then.
} else {
  // plan.would_admit_generation, plan.would_admit_generation_decimal, plan.form,
  // plan.refs, plan.objects[], plan.object_count, plan.encrypted_bytes, plan.raw_bytes
}
```

`heads` paging (D186): `after_generation` is the REQUIRED verification anchor — a semantic input, never a paging knob — and must stay CONSTANT across a page sequence. `limit` is required. `cursor` is omitted on the first request and is then the prior page's `next_cursor` echoed UNCHANGED. `allHeads` is the convenience wrapper that walks the sequence for you.

#### Deploying a vaulted project — `applyWithGitvault`

`r.gitvault.deploy(...)` is the raw push-gated machine and takes an injected lane. `applyWithGitvault` (`@run402/sdk/node`) is the supplied one: it reads the project's `gitvault_policy`, and only a `required` project captures at all.

```ts
import { applyWithGitvault, run402 } from "@run402/sdk/node";
import type { ReleaseSpec } from "@run402/sdk";
const r = run402();
const spec: ReleaseSpec = { project: "prj_123", site: { replace: { "index.html": "<h1>hi</h1>" } } };

const { mode, deploy, gitvault } = await applyWithGitvault({
  sdk: r,
  spec,                                     // the same ReleaseSpec `r.project(id).apply` takes
  apply: { idempotencyKey: "deploy-42" },   // the same options, passed through untouched
  repo_dir: process.cwd(),
  onCommitLine: (line) => process.stderr.write(`${line}\n`),   // `gitvault_commit <oid>`
});

if (gitvault?.outcome === "DEPLOYED_AND_VAULTED") {
  console.log(mode.kind, deploy?.operation_id);   // `deploy` is the usual DeployResult
}
```

`mode` says what happened about the vault: `{ kind: "vaulted" }`, `{ kind: "grandfathered" }`, `{ kind: "ungated" }`, or `{ kind: "none" }`. For anything but `vaulted` this is `apply()` and nothing else — no capture, no token, no added refusal, and the only added cost is the single policy read that determined the project is not `required`. `gitvault` is `null` on those paths and carries the five-outcome envelope on the vaulted one.

**`ungated` is the ordinary shape for a project whose vault was just allocated (design D3).** Allocation does not set `gitvault_policy` — allocation and activation-gating are separate acts, and the policy stays unset until an owner chooses. On this path the plain deploy runs untouched, but `deploy.next_actions` gains a `gitvault_policy_required` entry (`{ type, command: "run402 repos policy required", why }`) and `deploy.warnings` gains a `GITVAULT_POLICY_UNSET` entry — both attached on EVERY such deploy, not just a synthesized "first" one, since the client holds no cross-machine state to distinguish first-from-Nth. Neither ever blocks or prompts. `gitvaultPolicyRequiredNextAction(repoId)` and `gitvaultUngatedWarning(repoId)` (`@run402/sdk/node`) are the exported builders, for a caller composing its own lane.

**A vaulted apply never auto-retries.** Each attempt plans a new operation, and an activation token is minted for exactly one; retrying under a fresh capture would paper over a refusal (revoked, expired, bound elsewhere) that is the platform telling you something true. `maxRetries` is forced to 0 on this path.

**A noop deploy settles its token too (protocol rev 45).** Re-deploying byte-identical content on a `required` project still captures, pushes, and mints — the vault records the new source generation — and the commit terminalizes as a noop. The gateway consumes the presented token at that terminal, under the same locks and refusal taxonomy as a real activation, so the platform-side record matches the `DEPLOYED_AND_VAULTED` the lane reports and no token is ever left unresolved. A token a repair revoked, or a DR epoch change invalidated, refuses the noop commit with the gate's usual typed errors.

**Snapshot correspondence, and its exact scope.** The client digests the captured file set at capture and re-derives it after artifacts are collected, before the plan commits. A difference refuses the deploy with **`SNAPSHOT_MOVED_DURING_DEPLOY`** — a `LocalError` whose `details` name the `modified` / `added` / `removed` paths plus the `gitvault_commit`, `capture_id`, and both digests. It is **client-local**: it is detected before anything is committed, never crosses the wire, and therefore is not in the protocol's error registry. The client refuses and stops; it does not re-capture and continue, because a second capture would publish a snapshot whose relationship to the already-collected artifacts is exactly the thing in doubt.

The captured set is tracked plus untracked-but-not-ignored — so a build that rewrites gitignored output between capture and commit proceeds, by design. **What the vault records is the source a release corresponds to; the artifacts are not proven to be derived from it.** The guarantee is that the captured source did not change while the artifacts were produced, not that the artifacts are a reproducible function of that source.

`captureSnapshot()` carries the same set on every snapshot: `snapshot.captured` (`{path, mode, oid}[]`) and `snapshot.captured_digest`. `deriveCapturedSet({ top_level, global_excludes_path })`, `capturedSetDigest(files)`, and `diffCapturedSets(before, after)` are exported for callers building their own lane.

**A `required` project needs the vault keystore on the deploying machine** — the capture is encrypted client-side and the platform holds no key that could produce it. Without it the deploy refuses with the protocol's own `KEYSTORE_MISSING` / `GITVAULT_REPO_STATE_MISSING`, with next actions leading on restoring the keystore and on `setPolicy(repoId, { gitvault_policy: "grandfathered", reason })` (owner + step-up, audited, doctor-persistent advisory).

**Nothing here is memoised.** Two of these responses are secret-bearing — the maintenance lease's `holder_token` (returned exactly once) and anything derived from the keystore — and a secret-bearing response is never cached, never persisted into an agent-surface result store, and never logged.

`gitvaultRemoteUrl(orgId, projectId)` and `parseGitvaultRemoteUrl(url)` are exported helpers for the `run402::<org_id>/<project_id>` remote URL form that `git-remote-run402` serves — see D8 above for the `kygit::` door.

**`status()` never mutates and never mints.** It READS the keystore rather than calling `ensureIdentity()`, so observing a vault cannot create the key material it is reporting on. Its `keystore.root` / `keystore.paths` name the directory to back up (see terminal loss below), `remote` reports the local `run402` git remote and whether it points at THIS vault, and `refs` / `head_target` are `null` unless `{ refs: true }` was passed — reading the ref map means materializing the chain, which is a verification and advances the local materialized pin.

**`resolveGitInvocationRepo(env?, cwd?)`** (Node) resolves — and proves — the repository git invoked a remote helper for, from `GIT_DIR` rather than `process.cwd()`, and throws `GIT_INVOCATION_REPO_UNRESOLVED` rather than guessing. Any consumer that writes git objects on git's behalf should route through it: during `git clone`, cwd is the directory clone was run FROM, which is routinely an unrelated repository.

**Terminal loss (protocol §0).** In V0-A, **whole-machine or whole-keystore loss is terminal for vault history until human envelopes ship**. `status()` carries the statement verbatim in `terminal_loss_statement` / `terminal_loss_detail`. The vault protects source history from host-side loss while a principal keystore survives. Back up the keystore directory `status()` reports as `keystore.root` — `~/.config/run402/gitvault` for the default wallet, `~/.config/run402/profiles/<wallet>/gitvault` for a named one. The recovery receipt is an integrity anchor, not a decryption key. The prominence of this reminder is progressive (design D7): quiet at genesis, escalating to a standing `terminal_loss_risk` entry in `status().warnings` once the composite trigger crosses — see the pure `gitvaultLossWarning*` helpers above.

`r402s-verify` is the deliberate exception to "all protocol logic lives in the SDK": an independent second lineage that must NOT share implementation code with this namespace, because differential verification is its entire purpose.

### `r.errors`

Grouped error fingerprints + a release-baselined promote-vs-revert verdict — "did my new release make things worse?". Also project-scoped as `r.project(id).errors.{list,get,watch}(…)`.

```
list(projectId, ListErrorsOptions): Promise<ErrorsPage>
get(projectId, fingerprintId): Promise<ErrorFingerprintDetail>
watch(projectId, WatchErrorsOptions): Promise<WatchErrorsResult>

// ListErrorsOptions = { since?, until?, function?, kind?, fingerprint?, newIn?, limit?, cursor? }
//   newIn (a release id or "active") → wire param new_in; drives verdict.new_fingerprints + baseline.
// ErrorsPage = { verdict, errors: ErrorFingerprint[], has_more, next_cursor? }
//   verdict = { window{since,until}, compared_release_id, baseline_release_id,
//               new_fingerprints, recurring_fingerprints, invocations_in_window,
//               coverage{full_fidelity_functions, coarse_functions}, row_cap{limit, at_cap} }
//   ErrorFingerprint = { fingerprint_id, function, kind, fingerprint_quality, error_name,
//               message_template, stable_frames[], count, first_seen, last_seen,
//               first_seen_release_id, last_seen_release_id, samples{first, recent[]}, next_actions[] }
// WatchErrorsOptions = { newIn (required), durationMs?=600000, intervalMs?=15000, signal?, onPoll?, failFast?=true }
// WatchErrorsResult = { clean, verdict, new_errors: ErrorFingerprint[], polls, elapsed_ms, aborted? }
```

**The verdict math is the GATEWAY'S — the SDK never recomputes it.** No client-side fingerprinting, re-baselining, or re-counting of `new_fingerprints`; `list` / `get` pass the envelope through untouched and `watch` reads `verdict.new_fingerprints` as the truth (`clean === (verdict.new_fingerprints === 0)`, the gateway's number). The **baseline** is the previously ACTIVE release by activation history (not lineage) — rollback-safe: after A → B → rollback to A → C, C's baseline is A. Cursors (`next_cursor`) are opaque keyset tokens — store and echo as `{ cursor }`, never parse.

`watch` is the promote-gate poll loop: run it right after an apply/promote activates a release. It polls immediately, then every `intervalMs`, plus one final poll when `durationMs` elapses; with `failFast` (the default) it stops the moment a poll reports a new identity. **An outage can never masquerade as a clean verdict:** a 4xx other than 408/429 rethrows immediately (auth/validation won't heal), while network errors, 5xx, 408, and 429 are tolerated — but three CONSECUTIVE failed polls rethrow the last error (a success resets the counter). `signal` aborts cleanly: with ≥1 successful poll it returns the result-so-far with `aborted: true`, otherwise it throws.

Auth: the addressed project's OWN key (apikey-authed read). A key for a different project gets `403`, never a `404` that would confirm existence. Read-only; never lifecycle-gated.

### `r.email`

```
createMailbox(projectId, slug): Promise<CreateMailboxResult> // NOT idempotent
listMailboxes(projectId): Promise<MailboxListResult>
setMailboxDefaults(projectId, {
  default_outbound_mailbox_id?: string | null,
  auth_sender_mailbox_id?: string | null
}): Promise<SetMailboxDefaultsResult>
updateMailbox(projectId, {
  mailbox?: string,
  footer_policy: "run402_transparency" | "none"
}): Promise<MailboxInfo>
getMailbox(projectId, mailbox?): Promise<MailboxInfo>
deleteMailbox(projectId, mailboxId?): Promise<void>

send(projectId, opts: SendEmailOptions): Promise<SendEmailResult>
  // If opts.mailbox is omitted, the SDK uses the configured
  // default_outbound_mailbox_id when mailbox_settings are present. Missing or
  // invalid defaults throw typed ApiError envelopes such as
  // DEFAULT_MAILBOX_REQUIRED / DEFAULT_MAILBOX_INVALID with details.candidates
  // and next_actions. Successful sends echo mailbox_id/from_address when the
  // gateway returns them.
  // opts.attachments?: { filename, content_base64, content_type }[] — RAW MODE
  // ONLY (subject + html, not template). Max 5; ≤ 7 MB total decoded. Sent as a
  // multipart/mixed MIME. Sent messages echo attachments_meta (names/types/sizes).
list(projectId, opts?: { limit?, after?, direction? }): Promise<EmailSummary[]>
  // direction?: "inbound" | "outbound" — omit for BOTH. direction:"inbound" lists
  // received replies (each EmailSummary carries `direction`) and is the
  // reconciliation backstop if a reply_received webhook is ever lost.
get(projectId, messageId): Promise<EmailDetail>
getRaw(projectId, messageId): Promise<RawEmailResult> // bytes + content_type

// Webhooks (sub-namespace):
webhooks.register(projectId, opts: { url, events }): Promise<MailboxWebhookSummary>
webhooks.list(projectId): Promise<MailboxWebhooksResult>
webhooks.get(projectId, webhookId): Promise<MailboxWebhookSummary>
webhooks.update(projectId, webhookId, opts: { url?, events? }): Promise<MailboxWebhookSummary>
webhooks.delete(projectId, webhookId): Promise<void>
webhooks.listDeliveries(projectId, opts?: { status?, limit?, after? }): Promise<WebhookDeliveriesResult>
  // Durable delivery is AT-LEAST-ONCE with bounded retries + exponential backoff.
  // Failures that exhaust the budget (or fail permanently) become status
  // "failed_permanent" — the dead-letter queue. status?: pending | in_flight |
  // delivered | failed_permanent. The delivered body is the canonical envelope
  // { id, type, created_at, schema_version, idempotency_key, payload }; consumers
  // MUST dedupe on idempotency_key (also the Run402-Webhook-Id header). Mailbox
  // webhooks are unsigned (verifyWebhook is for owner notifications only).
webhooks.redriveDelivery(projectId, deliveryId): Promise<RedriveDeliveryResult>
  // Re-queue a dead-lettered delivery for another attempt (after fixing the consumer).

// CLI-style aliases:
create(projectId, slug): Promise<CreateMailboxResult>
status(projectId): Promise<MailboxInfo>
info(projectId): Promise<MailboxInfo>
update(projectId, opts): Promise<MailboxInfo>
delete(projectId, mailboxId?): Promise<void>
```

`MailboxRecord` includes default/readiness/footer-policy metadata when the gateway provides it: `is_default_outbound`, `is_auth_sender`, `can_send`, `send_blocked_reason`, `domain_kind`, `footer_policy`, `effective_footer_policy`, and `footer_policy_locked_reason`. `updateMailbox` PATCHes `/mailboxes/v1/:mailbox_id` for `footer_policy`; `none` requires hobby/team, while prototype projects are locked to `run402_transparency` and return the typed gateway error `FOOTER_POLICY_TIER_REQUIRED`. `MailboxListResult` and create/settings responses may include `mailbox_settings` and `next_actions`; the happy path is create → list → set missing defaults → optionally update footer policy → send.

Templates: `project_invite`, `magic_link`, `notification`. Or pass `subject` + `html` for raw mode. Raw mode also accepts `attachments` (max 5, ≤ 7 MB total) — a multipart/mixed MIME is sent. Tier rate limits: prototype 10/day, hobby 50/day, team 500/day.

### `r.auth`

```
requestMagicLink(projectId, opts:
  | { email, delivery?: "link", redirectUrl, intent?, clientState? }
  | { email, delivery: "both", redirectUrl, intent?, clientState? }
  | { email, delivery: "code", redirectUrl?, intent?, clientState? }
): Promise<MagicLinkRequestResult> // { message, warnings?, challengeId? }
verifyMagicLink(projectId, token): Promise<MagicLinkVerifyResult> // { access_token, refresh_token, ... }
verifyEmailCode(projectId, { challengeId, code }): Promise<MagicLinkVerifyResult>
createUser(projectId, opts: { email, isAdmin?, sendInvite?, redirectUrl?, clientState? }): Promise<AuthUserAdminResult>
inviteUser(projectId, opts: { email, isAdmin?, redirectUrl, clientState? }): Promise<AuthUserAdminResult>
setUserPassword(projectId, opts: { accessToken, newPassword, currentPassword? }): Promise<void>
settings(projectId, opts: {
  allow_password_set?,
  preferred_sign_in_method?,
  public_signup?,
  require_passkey_for_project_admin?
}): Promise<AuthSettingsResult>
createPasskeyRegistrationOptions(projectId, opts: { accessToken, appOrigin }): Promise<PasskeyOptionsResult>
verifyPasskeyRegistration(projectId, opts: { accessToken, challengeId, response, label? }): Promise<PasskeyRecord>
createPasskeyLoginOptions(projectId, opts: { appOrigin, email? }): Promise<PasskeyOptionsResult>
verifyPasskeyLogin(projectId, opts: { challengeId, response }): Promise<AuthSessionResult>
listPasskeys(projectId, opts: { accessToken }): Promise<{ passkeys: PasskeyRecord[] }>
deletePasskey(projectId, opts: { accessToken, passkeyId }): Promise<void>
providers(projectId): Promise<AuthProvidersResult> // magic_link.deliveryModes; absent wire field → ["link"]
promote(projectId, email): Promise<void>
demote(projectId, email): Promise<void>

// CLI-style aliases:
magicLink(projectId, opts): Promise<MagicLinkRequestResult>
verify(projectId, token): Promise<MagicLinkVerifyResult>
setPassword(projectId, opts): Promise<void>
promoteUser(projectId, email): Promise<void>
demoteUser(projectId, email): Promise<void>
```

Magic-link tokens are single-use, expire in 15 min, rate-limited 5/email/hour. Google OAuth is on for all projects with zero config.

### `r.apps`

```
browse(tags?: string[]): Promise<BrowseAppsResult>
getApp(versionId): Promise<AppDetails>
fork(opts: { versionId, name, subdomain? }): Promise<ForkAppResult>
publish(projectId, opts?: { description?, tags?, visibility?, fork_allowed? }): Promise<PublishedVersion>
listVersions(projectId): Promise<ListVersionsResult>
updateVersion(projectId, versionId, opts: { description?, tags?, visibility?, fork_allowed? }): Promise<void>
deleteVersion(projectId, versionId): Promise<void>
```

Forking clones schema + site + functions into a new project. If the source has a `bootstrap` function, it runs automatically with the variables you pass; result includes `bootstrap_result` or `bootstrap_error`.

### `r.tier`

```
set(tier: "prototype" | "hobby" | "team", opts?: { idempotencyKey? }): Promise<TierSetResult>   // idempotencyKey → Idempotency-Key header (caller-supplied; not auto-derived)
status(): Promise<TierStatusResult>
```

Tier is per **organization**, not per project. `set` applies to every project on the
organization; `status.pool_usage` (`projects`, `total_api_calls`, `total_storage_bytes`,
`gitvault_source_bytes`, `api_calls_limit`, `storage_bytes_limit`, `source_bytes_limit`, each
byte count beside its human string under the same name with `_bytes` removed:
`total_storage`, `gitvault_source`, `storage_limit`, `source_limit`) sums across every non-terminal project on the
organization — including every wallet linked to it via `billing.linkWallet` — not
just the requesting wallet. Use the returned `pool_usage` as the authoritative quota-
enforcement view; per-project `r.projects.getUsage(id)` reports the same organization-level
caps alongside that project's slice of the pool.

`TierStatusResult` also surfaces two optional organization fields:

- `organization_lifecycle_state?: "active" | "past_due" | "frozen" | "dormant" | "purged"` — mirror of the owning organization's lifecycle state. Identical to the per-project `organization_lifecycle_state` on every `list()` entry.
- `lease_perpetual?: boolean` — staff escape hatch flag. When `true`, the organization never advances past `active`.

Both are optional because older gateways do not return them at the top level.

`set` settles from the organization's allowance first (a redeemed promo code or a
top-up), ahead of the payment paywall: no 402 is issued, no authorization is signed, and
the wallet needs no USDC. `TierSetResult.paid_with` reads `"allowance"` then, with
`allowance_used_usd_micros` and `allowance_remaining_usd_micros`. Only an allowance that falls
short goes to x402 / MPP, and the resulting `X402_INSUFFICIENT_FUNDS` carries
`details.allowance` (`allowance_usd_micros`, `price_usd_micros`, `shortfall_usd_micros`) with
`redeem_voucher` / `top_up` next actions.

`set` auto-detects start / renew / upgrade / downgrade based on current state.
For tier pricing, call `r.projects.getQuote()` (the SDK does not expose a separate
`tier.quote()` method).

#### Quota-denial `scope` discriminator

Quota-related error envelopes carry `details.scope: "organization" | "project"` so consumers
can distinguish organization-pooled denials from the orphan fallback (project whose billing
organization row was purged but cascade has not yet run). The SDK lifts this onto every
`Run402Error` subclass as `e.quotaScope`, and exports a `getQuotaScope(e)` helper for
non-`Run402Error` `unknown` inputs. Absent for non-quota errors.

### `r.billing`

```
createEmailOrganization(email): Promise<EmailOrganization>
linkWallet(organizationId, wallet): Promise<LinkWalletResult>  // organizationId = UUID; POST /orgs/v1/:org_id/wallets
createCheckout(organizationId, checkout: { product: "balance_topup", amountUsdMicros: number } | { product: "tier", tier: "prototype" | "hobby" | "team" } | { product: "email_pack" }): Promise<CreateCheckoutResult>
setAutoRecharge(opts: { organizationId: string, enabled: boolean, threshold? }): Promise<void>
checkBalance(identifier): Promise<OrganizationDetail>  // identifier = organization id (UUID) | wallet | email
getOrganization(identifier): Promise<OrganizationDetail>
lookupOrganization(identifier): Promise<OrganizationDetail>  // resolve wallet/email → organization (incl. organization_id)
balance(identifier): Promise<OrganizationDetail> // alias of checkBalance
history(identifier, limit?: number): Promise<BillingHistoryResult>
getHistory(identifier, limit?: number): Promise<BillingHistoryResult>

// CLI-style aliases:
createEmail(email): Promise<EmailOrganization>
autoRecharge(opts): Promise<void>
```

Organizations are addressed by their canonical `org_id` (UUID).
`getOrganization` / `checkBalance` / `history` accept an organization id, wallet, or email:
an organization id reads `GET /orgs/v1/:org_id/billing` directly, while a
wallet/email is resolved through the `GET /orgs/v1/lookup?wallet=|?email=`
lookup (also exposed as `lookupOrganization`). The detail shape includes
`org_id`. Organization reads require SIWX from a
wallet **linked to** the organization (or matching the looked-up `?wallet`), or an
admin key — email lookups are staff-only; `history` resolves to the organization id
first, then reads `GET /orgs/v1/:org_id/billing/history`.

`linkWallet` merges a wallet into an existing organization's pool. The response
includes a `pool_implications` block (`tier`,
`projects_in_pool_count`, `organization_api_calls_current`, `organization_storage_bytes_current`,
`tier_limits.{api_calls,storage_bytes,storage}`, `over_limit`) so callers can warn before
linking a wallet whose existing usage would push the merged pool past the tier cap.

### `r.contracts`

```
provisionSigner(projectId, opts: { chain: "base-mainnet" | "base-sepolia", recoveryAddress? }): Promise<ProvisionSignerResult>
getSigner(projectId, signerId): Promise<SignerSummary>
listSigners(projectId): Promise<ListSignersResult>
setRecovery(projectId, signerId, recoveryAddress: string | null): Promise<void>
setLowBalanceAlert(projectId, signerId, thresholdWei: string): Promise<void>

call(projectId, opts: { signerId, chain, contractAddress?, to?, abiFragment?, abi?, functionName?, fn?, args, value?, idempotencyKey? }): Promise<ContractCallResult>
deploy(projectId, opts: { signerId, chain, bytecode, value?, idempotencyKey? }): Promise<ContractDeployResult> // bytecode = full creation calldata (creation bytecode + ABI-encoded ctor args concatenated by caller); ≤ 128 KB. Returns deterministic CREATE address synchronously in `contract_address`.
read(opts: { chain, contractAddress?, to?, abiFragment?, abi?, functionName?, fn?, args }): Promise<ContractReadResult>
callStatus(projectId, callId): Promise<ContractCallResult>
drain(projectId, signerId, destinationAddress): Promise<DrainResult>
deleteSigner(projectId, signerId): Promise<DeleteSignerResult> // refused if balance ≥ dust

// CLI-style aliases:
setAlert(projectId, signerId, thresholdWei): Promise<void>
status(projectId, callId): Promise<ContractCallResult>
delete(projectId, signerId): Promise<DeleteSignerResult>
```

Private keys never leave AWS KMS. **$0.04/day rental + $0.000005/call.** Signer creation requires $1.20 of allowance. Non-custodial. The SDK exports typed metadata and call-result envelopes (`SignerSummary`, `ContractCallResult`, `ContractReadResult`, etc.); contract ABI results and receipts remain `unknown` inside those envelopes and should be narrowed at the call site.

### `r.ai`

```
translate(projectId, opts: { text, to, from?, context? }): Promise<TranslateResult>
moderate(projectId, text): Promise<ModerateResult>
usage(projectId): Promise<AiUsageResult>
generateImage(opts: { prompt, aspect?, orgId? }): Promise<GenerateImageResult> // $0.03 via x402 / MPP, no projectId
```

`orgId` is the paying organization and is read only on the MPP Lightning
rail: a principal that belongs to several organizations is refused
`ORGANIZATION_SELECTION_REQUIRED` (HTTP 400, `details.organization_ids` lists
the candidates) unless the body names one; x402 and Tempo ignore it. When
`orgId` is omitted and the gateway answers that code, `generateImage` retries
**once** with the single candidate that matches a local context, most
deliberate first: the provider's current organization
(`credentials.getActiveOrg()`, the CLI's `run402 org use`) or the active
project's cached owning `org_id`; only when neither names a candidate, a single
stored project's owning org. Zero or several matches re-throw the `ApiError`
with the same `code` and status, the candidates in the message and
`details.organization_ids` (plus `details.matched_organization_ids`), and
`nextActions` naming `--org <org_id>` / `run402 org use <org_id>`. An `orgId`
you passed is never second-guessed: the gateway's refusal is returned as-is.
Nothing is inferred from membership count alone.

`GenerateImageResult` is `{ image, content_type, aspect, payment }`. `payment` is
the settlement **observed** for that call, decoded from the response's
`PAYMENT-RESPONSE` receipt:

```
payment: { success, network, transaction, payer } | null
```

`null` means the response carried no receipt — no payment was made on this
request, NOT that one failed. **Surface `network` to whoever is watching.**
`run402 init` faucet-funds Base Sepolia (`eip155:84532`), so the documented
quickstart pays in test money; without the network a caller can watch a payment
succeed with no way to know it was not real, and the claims wall will then
refuse the very transaction they just made. Derive any "this was testnet"
message from `payment.network`, never from local wallet configuration — a buyer
holding mainnet funds makes a config-derived guess wrong.

The same value rides `ResponseEnvelope.settlement` for any request that settles,
so `requestWithResponse` callers get it too. The key is omitted entirely when
nothing settled, so existing envelope shapes are unchanged.

`r.image` is an alias of `r.ai`, so CLI readers can translate
`run402 image generate ...` to `r.image.generateImage(...)`.

### `r.wallets`

```
status(): Promise<WalletStatusResult>
create(): Promise<WalletCreateResult>
export(): Promise<string> // address only, never the private key
faucet(address?: string): Promise<FaucetResult>
```

`faucet` defaults to the local wallet's address when no argument is passed.
The Node entry's credentials provider also writes a `lastFaucet` marker after
success — surfaced via `status().faucet_used`.

### `r.vouchers`

```
redeem(code: string): Promise<RedeemVoucherResult>
```

Redeems a promo code (e.g. `R402-K8F3-Q2W9`) into the authenticated wallet's
organization's allowance. The allowance settles tier purchases and priced
calls through the allowance rail — no on-chain payment.

- **Order-independent.** Works as the very first authenticated call a new wallet
  makes (the organization is provisioned on demand) or long after `init`.
- **Idempotent for the redeemer.** A repeat by the same organization returns the
  ORIGINAL result with `already_redeemed: true` and never credits twice, so a
  timed-out call is safe to re-issue. A different organization gets
  `VOUCHER_ALREADY_REDEEMED` (409).
- **Send the code verbatim.** The gateway owns the grammar and is forgiving
  (case-insensitive, hyphens optional, Crockford confusables mapped); a
  client-side format check would only reject codes the server accepts.
- Other failures: `VOUCHER_NOT_FOUND` (404 — unknown *or* malformed, the same
  answer on purpose), `VOUCHER_EXPIRED` (410), `PROMO_LIMIT_REACHED` (403).

`RedeemVoucherResult` carries `amount_usd_micros`, the post-credit
`balance_usd_micros`, `organization_id`, `redeemed_at`, `already_redeemed`,
`promo_lifetime_ceiling_usd_micros` (the ceiling that applied — per issuer, so
a launch voucher from the platform has its own), and `next_actions[]` (usually
the tier the new balance now covers, with a ready-to-run `cli` string).

### `r.service`

```
status(): Promise<ServiceStatus> // 24h/7d/30d uptime per capability — no auth, no setup
health(): Promise<ServiceHealth> // per-dependency liveness — no auth, no setup
```

### `r.wallet(address)`

```
r.wallet(address).getLabel(): Promise<string | null>
r.wallet(address).setLabel(label: string): Promise<{ ok: boolean }>
```

The signed server-side wallet label (gateway `/wallets/v1/:address/label`) that
surfaces the human-readable named-wallet name in the console. Use the
`r.wallet(address)` scope handle so the address isn't a swappable positional. The
label is pushed automatically on `run402 wallets use` unless
`RUN402_WALLET_LABEL_SYNC=0`. (`r.wallets.getLabel(address)` remains valid as a
bare read. For org/grants control-plane identity, see "Org membership & project
grants" below.)

### `r.cache` (paired with `@run402/astro` v1.0+)

SSR origin-cache inspection + invalidation for the Astro SSR Runtime. Capability `ssr-isr-cache`.

```
invalidate(url: string | URL): Promise<CacheInvalidateResult>
invalidatePrefix({ host, prefix }): Promise<CacheInvalidateResult>
invalidateAll({ host }): Promise<CacheInvalidateResult>
invalidateMany(urls: Array<string | URL>): Promise<CacheInvalidateResult>
inspect(url: string | URL, opts?: { locale?, releaseId? }): Promise<CacheInspectResult>
```

`CacheInvalidateResult`:
```ts
interface CacheInvalidateResult {
  deleted: number;
  // post-increment per-(project, host) counter, as string for bigint safety
  generation: string;
  host: string;
  // populated on single-URL form
  path?: string;
  // populated on invalidateMany
  results?: Array<{ host: string; deleted: number; generation: string }>;
}
```

`CacheInspectResult`:
```ts
interface CacheInspectResult {
  // NEVER "BYPASS" — inspect doesn't issue a request
  status: "HIT" | "MISS";
  url?: string;
  host?: string;
  path?: string;
  search?: string;
  method?: string;
  locale?: string;
  releaseId?: string;
  // ISO8601
  cachedAt?: string;
  // ISO8601
  expiresAt?: string;
  writtenUnderGeneration?: string;
  // hex
  contentSha256?: string;
  headers?: Record<string, string | string[]>;
}
```

Project-scoped. Cross-project absolute URLs throw `R402_CACHE_INVALIDATION_HOST_FORBIDDEN`. Path-string `invalidate('/path')` form requires active request context to resolve the host from ALS; outside a context, throws `R402_CACHE_INVALIDATION_HOST_REQUIRED`.

**Inside an Astro `[slug].astro` admin save flow:**

```ts
import { db, cache } from "@run402/functions";

declare const slug: string;
declare const title: string;
declare const html: string;

await db().from("pages").insert({ slug, title, html });
await cache.invalidate(`/${slug}`); // sub-second freshness
```

**From an admin-side function in a different host:**

```ts
import { cache } from "@run402/functions";

declare const slug: string;

await cache.invalidate(new URL(`https://eagles.kychon.com/${slug}`));
```

There is no tag-based invalidation and no client-side (browser) invalidation — server-side function context only.

### `r.admin`

Staff endpoints. Most agents won't reach for these — they're for platform staff.

```
sendFeedback(message: string, opts?: FeedbackSendOptions): Promise<SendMessageResult>
setAgentContact({ name, email?, webhook? }): Promise<AgentContactResult>
getAgentContactStatus(): Promise<AgentContactResult>
verifyAgentContactEmail(): Promise<AgentContactResult>
startContactPasskeyEnrollment(): Promise<AgentContactResult>
getProjectFinance(id: string, opts?: {
  window?: "24h" | "7d" | "30d" | "90d",
  cookie?: string
}): Promise<AdminProjectFinanceResult>

// staff-only org + project actions — canonical via scope handles
r.admin.org(orgId).pinLease() / .unpinLease(): Promise<SetLeasePerpetualResult>
r.admin.project(projectId).archive(opts?: { reason?: string }): Promise<ArchiveProjectResult>
r.admin.project(projectId).reactivate(): Promise<ReactivateProjectResult>
r.admin.project(projectId).finance(opts?): Promise<AdminProjectFinanceResult>
```

`sendFeedback` is WRITE-ONLY (no inbox, no reply path); `opts.project_id` + `message: "promote: yes"` relay a deploy's promotion consent — the `hand_to_member` next action a commit/promote response carries once it activates with a public site (unless the offer was already answered for that project). Show your human `urls.site` and `urls.console` from that response, relay that Run402 would like to promote what they built on `@run402com` for free, credited to the response's `credited_as` and to them, and ask yes or no. On yes, optionally collect `opts.handle` (≤64 chars, an X/Twitter handle) and send it along; `FeedbackSendOptions` is `{ project_id?: string; handle?: string }`. `sendMessage` is a deprecated alias kept for compatibility — it now posts to the same route and forwards `opts` too.

`AgentContactResult` includes `email_verification_status`, `passkey_binding_status`, `assurance_level`, proof timestamps, and cooldown fields. Assurance labels are `wallet_only`, `email_pending`, `email_verified`, `passkey_pending`, and `operator_passkey`; they describe mailbox/passkey continuity, not a humanhood or uniqueness claim. `startContactPasskeyEnrollment()` requires `email_verified` and emails the token to the verified contact email instead of returning it.

`getProjectFinance` reads the internal Finance-tab JSON for a project. It is
staff gated; a project `service_key` is not enough. In Node staff
scripts, use an admin wallet or pass
`cookie: process.env.RUN402_ADMIN_COOKIE` for browser-session auth.

**Staff-only project + organization actions.** The lifecycle state machine lives on `internal.organizations`; there are no per-project `pin` / `unpin` endpoints.

- `r.admin.org(orgId).pinLease()` / `.unpinLease()` — toggle the organization-level escape hatch. When `lease_perpetual` is `true`, the organization never advances past `active` regardless of lease expiry; every project on the organization is pinned. Pinning a grace-state organization (`past_due` / `frozen` / `dormant`) reactivates inline — the response carries `reactivated: true`.
- `archiveProject(projectId, { reason? })` — staff moderation. Sets `projects.archived_at = NOW()` on a single project; sibling projects on the same organization keep serving. No-op when already archived (returns `note: "already archived"`).
- `r.admin.project(projectId).reactivate()` — un-archive a project (flips `archived_at` back to NULL). It does NOT touch organization-level lifecycle. To reactivate a grace-state organization, either call `r.tier.set(tier)` (the tier flow runs the lifecycle advance inline) or `r.admin.org(org_id).pinLease()`.

All three require staff auth. Result envelopes:

```
SetLeasePerpetualResult: { status, org_id, lease_perpetual, reactivated }
ArchiveProjectResult:    { status, project_id, archived_at?, reason?, note? }   // note: "already archived"
ReactivateProjectResult: { status, project_id, reactivated?: true, note? }      // note: "not archived"
```

### `r.admin.channels` + `r.admin.rules` (Telegram notification channel + routing rules)

Self-serve Telegram push on top of the owner-notifications substrate: connect a chat, then add filter rules so ONLY matching events page that chat. Two sub-namespaces on `r.admin`, same shape as `r.admin.transfers`.

```
r.admin.channels.connectTelegram(opts?: { label?: string }): Promise<ConnectTelegramResult>
r.admin.channels.list(): Promise<NotificationChannelsResult>
r.admin.channels.revokeTelegram(bindingId: string): Promise<RevokeTelegramResult>

r.admin.rules.list(): Promise<ListRoutingRulesResult>
r.admin.rules.create(input: CreateRoutingRuleInput): Promise<CreateRoutingRuleResult>
r.admin.rules.update(ruleId: string, patch: UpdateRoutingRulePatch): Promise<RoutingRule>
r.admin.rules.delete(ruleId: string): Promise<DeleteRoutingRuleResult>
```

`connectTelegram` returns two single-use, 15-minute deep links — `connect_url` (private chat) and `connect_group_url` (group chat) — plus a `pending` binding id. A human taps ONE of the links and starts the bot; poll `r.admin.channels.list()` until the matching entry in `telegram[]` shows `status: "active"` (or `code_expires_at` passes and it's swept back to `"revoked"`). Until the platform's dedicated bot is provisioned on this gateway, `connectTelegram` throws with `code: "TELEGRAM_CHANNEL_NOT_CONFIGURED"` (HTTP 503, with a `next_actions` entry); a caller with no verified owner email yet gets `code: "CONTACT_EMAIL_NOT_VERIFIED"` (HTTP 412) — bindings are addressed to the verified email, the recipient grain every rule/binding keys on. `connectTelegram` / `revokeTelegram` require `operator_passkey` assurance (same ladder as `rotateWebhookSecret`); `list()` is a plain SIWX read.

**Routing rules (design D4).** One rule always targets exactly one Telegram binding — "N destinations" is N rules. Every match dimension you set (`projectId`, `source`, `eventTypes`, `classes`) is ANDed; an OMITTED field is a wildcard (matches anything for that dimension); an explicit empty array (`eventTypes: []`) matches NOTHING (Postgres `TEXT[]` semantics — deliberately different from the "`[]` = unfiltered" convention some read-filter query params use elsewhere in this SDK). `source` is `"app"` (a deployed function's `events.emit(...)` calls) or `"platform"` (deploys, lifecycle, verification, ...); omit to match both. **No rules = no Telegram traffic** for that person — the channel is opt-in per event, per rule, with no "send everything" default. Rules govern the Telegram channel ONLY in v1: the mandatory email floor (`security`/`recovery`/`billing_critical`/`destructive_lifecycle`/`verification` classes) is completely untouched and can never be silenced by a rule.

`rules.update`'s `patch` uses PATCH semantics at the wire level: a field OMITTED from the object leaves the stored value unchanged; a field explicitly set to `null` CLEARS that dimension back to wildcard. There's no wire difference between "omitted" and "set to `undefined`" — both drop the key from the JSON body, so build the patch object by only assigning the keys you actually want to change.

`rules.create`/`rules.update` reject an unusable or foreign `telegramBindingId` (revoked, not yours, or nonexistent) with the SAME 404 either way (authorize-before-reveal) — call `r.admin.channels.list()` first to confirm the binding is `"active"`.

`admin.testNotification(opts?: { source?, eventType? })` fires the sample event through the FULL pipeline — email/webhook AND Telegram — and its result carries `telegram: { destinations: [...] }`, one delivered/failed outcome per matched Telegram binding (empty when no rule matches — Faithful, not an error). Pass `opts.source` / `opts.eventType` to exercise a specific rule's filters precisely instead of the default sample event.

### `r.admin.transfers` (unified project transfer, owned-org recipient)

Project transfer is exposed as a sub-namespace at `r.admin.transfers` — one noun, three recipient shapes. A **wallet** recipient (both sides sign SIWX) and an **email** recipient (a principal whose verified email matches, into an org it owns or a new one) both complete via the one `accept`; an **owned org** recipient completes immediately at initiate time in the same-actor first release. `initiate` is body-discriminated (`toWallet` XOR `toEmail` XOR `toOrgId`); `preview` / `cancel` / `listIncoming` / `listOutgoing` are kind-agnostic for pending rows and tag each row with `recipient_kind`. 

```
initiate({ projectId, toWallet, billingPolicy?, message?, kysignedRecordId? })   // wallet recipient
  : Promise<InitiateTransferResult>            // { transfer_id, expires_at, project_summary, your_unused_lease_days, lease_refundable: false, terms_sha256 }
initiate({ projectId, toEmail, message?, retainMember? })                        // email recipient
  : Promise<InitiateEmailTransferResult>       // { status: "ok", transfer_id, to_email, expires_at }
initiate({ projectId, toOrgId, message? })                                      // owned-org recipient, same-actor only
  : Promise<InitiateOrgTransferResult>         // { status: "accepted", project_id, to_organization_id, transfer_id?, completed_at?, anon_key, service_key, ... }
  // initiate({ toOrgId }) persists returned keys via saveProject + setActiveProject when supported.
// Exactly one of toWallet / toEmail / toOrgId — multiple-or-none throws a local VALIDATION_ERROR before any request.
// billingPolicy + kysignedRecordId are wallet-only; retainMember is email-only.
preview(transferId: string): Promise<ProjectTransferPreview>
  // { transfer_id, project_id, status, recipient_kind, from_wallet_display, to_wallet_display, to_email?, to_org_id?,
  //   billing_policy, message, initiated_at, expires_at, terms_sha256, custom_domains[], subdomains[],
  //   functions[], secret_names[] (NEVER values), mailbox_summary, ci_bindings_to_be_revoked[], signers[],
  //   github_repo_note, billing_implications, retain_member? }
accept(transferId, { orgId?, acceptRetainedMember? }): Promise<AcceptTransferResult>   // the ONE completion
  // wallet-addressed row → AcceptWalletTransferResult:
  //   { project_id, from_wallet, to_wallet, new_organization_id, completed_at,
  //     secrets_rotation_advised: true, secret_names_inherited[], secrets_count_inherited, github_repo_note,
  //     anon_key, service_key }
  // email-addressed row (orgId / acceptRetainedMember apply here) → AcceptEmailTransferResult:
  //   { status: "accepted", project_id, to_organization_id, created_new_org, retained_member_principal_id,
  //     credentials_revoked?, credentials_issued?, anon_key, service_key }
  // Both persist the new owner's keys via saveProject + setActiveProject (when the provider supports
  // them), mirroring provision. The email path's auth is principal-based (a sign-in session OR a
  // verified-email SIWX match) — don't assume a wallet is present.
cancel(transferId: string, reason?: string): Promise<CancelTransferResult>   // kind-agnostic
  // { transfer_id, status: "cancelled", cancelled_by, cancellation_reason, cancelled_at }
listIncoming(opts?: { limit?, offset? }): Promise<TransferSummary[]>   // pending rows, unioned (recipient_kind-tagged)
listOutgoing(opts?: { limit?, offset? }): Promise<TransferSummary[]>   // pending rows, unioned
```

`billingPolicy` defaults to `"migrate"` on wallet transfers (the only Phase 1A policy — the project moves into the recipient's organization). The `kysignedRecordId` field is wallet-only and stored verbatim in Phase 1A; Phase 1B will verify it against the canonical terms hash. Owned-org `toOrgId` moves are same-actor only in the first gateway release: caller must be an active owner of both source and destination orgs. Initiate authority is owner-OR-admin.

**Email recipient — retain-member.** Pass `retainMember: { role: "developer" }` on the email `initiate` to keep a `developer` membership in the recipient's org after the transfer (only `developer` is valid; the subject is always the initiating owner — gateway rejects with `INVALID_RETAIN_ROLE` / `RETAIN_SUBJECT_REQUIRED`). The recipient sees the offer as `ProjectTransferPreview.retain_member` (a `RetainMemberPreview` `{ principal_id, role, sender_label, scope, note, accept_field }`, or `null`) and accepts by passing `acceptRetainedMember: true` to `accept`; the result then carries `retained_member_principal_id` (or `null`). Omitting the accept (the default) is a full severance.

While a transfer is `pending` (72h TTL), every owner-side mutation against the project throws `TransferFreezeError` (status 409, code `PROJECT_HAS_PENDING_TRANSFER`). The error carries `transferId`, `projectId`, `cancelPath`, and `previewPath` lifted from the gateway's `next_actions[]`, so agents can present an actionable resolution:

```ts
import { run402 } from "@run402/sdk/node";
import { isTransferFreezeError } from "@run402/sdk";

const r = run402();

try {
  const p = await r.project(projectId);
  await p.apply({ secrets: { require: ["DB_URL"] } });
} catch (err) {
  if (isTransferFreezeError(err) && err.transferId) {
    // err.transferId, err.cancelPath, err.previewPath
    await r.admin.transfers.cancel(err.transferId);
    // …retry the mutation here
  } else {
    throw err;
  }
}
```

Data-plane traffic (`/rest/v1/*`, `/storage/v1/*`, function invocation, mailbox send/receive) keeps serving during the freeze. Payment-path routes (`tier.set`, `/orgs/v1/:org_id/checkouts`, `/orgs/v1/:org_id/billing/auto-recharge`) keep working. `r.admin.transfers.cancel` is intentionally not blocked.

After `accept`, the project carries a persistent `secrets_rotation_advised` advisory — visible on `r.tier.status()` as `projects[].secrets_rotation_advised: { advised_at, reason }`. Use `r.secrets.set(...)` to rotate every name in `secret_names_inherited`; the advisory clears once every previously-inherited name has been re-written.

`r.tier.status()` also surfaces `incoming_transfers[]` at the top level (each entry includes `preview_path` and the full pending summary) so a single status call shows pending offers without a separate `listIncoming` fetch.

What does NOT transfer: tier lease (stays with the original owner's organization; no Phase 1A proration), KMS signers (`r.contracts.*` — wallet-scoped), GitHub repo ownership (handle out of band), on-chain balance on any wallet.

`r.orgs.adopt.challenge({ wallet, token? })` + `r.orgs.adopt.submit({ siwx, token?, orgId?, displayName? })` — adopt the org your wallet's agent owns (`POST /orgs/v1/adopt/challenge`, `POST /orgs/v1/adopt`): the raw dual-proof seam (write-capable sign-in session bearer + a fresh `SIGN-IN-WITH-X` signature over the challenge nonce). `submit` returns `AdoptResult`, a discriminated union: `{ status: "adopted", org_id, display_name, role, already_owned? }` or `{ status: "select_org", selectable_orgs }` (returned, never thrown — re-submit with `orgId`). The Node convenience `adoptOrg(r, { wallet?, orgId?, displayName?, token? })` from `@run402/sdk/node` runs the whole dance (read the cached session → challenge → `signOrgAdopt(nonce)` with the active wallet → submit); a stale session throws `StepUpRequiredError`.

`r.orgs.setDisplayName(name)` — `PATCH /agent/v1/me`; the name promotion credit (`hand_to_member.credited_as`), `r.up()`'s room presence, and audit surfaces show for this principal (1–64 chars). `r.up()` sets a detected default when it is empty.

Due durable runs wait automatically while project concurrency slots are occupied. Waiting does not consume an execution attempt or retry budget. Keep the original run ID and inspect its status; do not cancel and recreate work merely because capacity is busy. Lifecycle and exhausted-quota blocks still require recovery.
