# operator-approval-client-surface Specification

## Purpose
TBD - created by archiving change add-write-auth-loopback. Update Purpose after archive.
## Requirements
### Requirement: Surface-aware, deterministic credential resolution

`NodeCredentialsProvider` SHALL accept `{ surface: "cli" | "mcp" | "sdk", authMode?: "auto" | "wallet" | "operator" | "none" }` and SHALL select exactly one credential class per request with no silent fallback between classes. CLI SHALL default to `auto` (wallet allowance, else the live control-plane session). MCP SHALL default to `wallet` only and SHALL NEVER spend the human's cached operator approval. The SIWX wallet path SHALL remain byte-for-byte unchanged.

#### Scenario: MCP never uses the human's cached approval
- **WHEN** the SDK is constructed with `surface: "mcp"` and a wallet-less write is attempted while only an operator session + approval are cached
- **THEN** no `Authorization`/`X-Run402-Write-Auth` from the operator approval SHALL be sent, and the call SHALL surface `OperatorApprovalRequiredError`

#### Scenario: CLI auto-resolution prefers the wallet
- **WHEN** `surface: "cli"`, `authMode: "auto"`, and a wallet allowance is present
- **THEN** `getAuth` SHALL return exactly the wallet/SIWX headers and SHALL NOT attach a control-plane or approval header

#### Scenario: No silent inter-class fallback
- **WHEN** the selected credential class's request fails (e.g. wallet auth rejected)
- **THEN** the SDK SHALL throw a typed error naming the credential class used and SHALL NOT retry the request under a different class

### Requirement: Capability+target-matched dual-header attachment

`getAuth(path, metadata?)` SHALL accept `{ method, capability?, target? }` supplied by the typed SDK method, where `capability` is a gateway `WriteAuthCapability` (`org.project.create` / `project.deploy` / `project.secret.write`) and `target` is `{ org_id }` or `{ project_id }`. When resolution selects the operator-approval class, the control-plane bearer and `X-Run402-Write-Auth: Bearer <token>` SHALL be attached only when a cached approval EXACTLY matches the request's `(capability, target)` (plus origin + cp-session binding). The approval header SHALL NOT be attached blanket, SHALL NOT be governed by a client-side path allowlist, and SHALL NOT be attached when the cached approval's target differs.

#### Scenario: Gated write with a matching approval carries the dual header
- **WHEN** an operator-mode request is made for `capability: "project.deploy"`, `target: { project_id: "prj_x" }`, and a live approval for exactly that `(action, target)` is cached
- **THEN** the request SHALL carry both `Authorization: Bearer <session>` and `X-Run402-Write-Auth: Bearer <token>`

#### Scenario: Gated write with a non-matching approval fails closed
- **WHEN** the request is for `project.deploy` on `prj_x` but only an approval for a different target (or a different action) is cached
- **THEN** the request SHALL carry `Authorization: Bearer <session>` only (no `X-Run402-Write-Auth`), so the gateway returns `WRITE_AUTH_REQUIRED`

#### Scenario: Read carries only the control-plane bearer
- **WHEN** an operator-mode request is made for a method with no write capability
- **THEN** the request SHALL carry `Authorization: Bearer <session>` and SHALL NOT attach `X-Run402-Write-Auth`, even when an approval is cached

### Requirement: Kernel header merge is case-insensitive and credential-family-atomic

The kernel SHALL merge provider headers case-insensitively (an explicit `authorization` SHALL suppress a provider `Authorization`). When a request already sets any auth header (`Authorization`, `SIGN-IN-WITH-X`, or `X-Run402-Write-Auth`, in any casing), the kernel SHALL NOT merge a provider auth header alongside or over it.

#### Scenario: Explicit auth header suppresses provider auth regardless of casing
- **WHEN** a request sets `authorization` (lowercase) and the provider would return `Authorization`
- **THEN** the outgoing request SHALL carry only the request's `authorization` and SHALL NOT carry a duplicate provider `Authorization`

#### Scenario: Request-owned credentials are not co-merged
- **WHEN** a request explicitly sets `Authorization: Bearer <token>` and the provider resolves a different auth class
- **THEN** the kernel SHALL leave the request's credentials intact and SHALL NOT add the provider's auth headers

### Requirement: Isomorphic, action+target-scoped, hardened ceremony seams

`r.operator.approval.requestChallenge({ action, orgId?, projectId?, cliRedirectUri, codeChallenge, state, token? })` SHALL `POST /agent/v1/control-plane/write-auth/challenges` with `{ action, org_id?, project_id?, cli_redirect_uri, code_challenge, state }` and the control-plane session bearer. `r.operator.approval.exchangeClaimCode({ code, codeVerifier, state, token? })` SHALL `POST /agent/v1/control-plane/write-auth/cli/token` with `{ code, code_verifier, state }` (NO `redirect_uri` — it is bound at challenge time) and return the minted payload `{ write_auth_token, token_type, header, session }`. Both seams SHALL be isomorphic (no `fs`/loopback).

#### Scenario: requestChallenge carries the action and target
- **WHEN** `requestChallenge({ action: "project.deploy", projectId: "prj_x", cliRedirectUri, codeChallenge, state })` is invoked
- **THEN** the POST body SHALL include `action: "project.deploy"`, `project_id: "prj_x"`, `cli_redirect_uri`, `code_challenge`, and `state`

#### Scenario: exchangeClaimCode omits redirect_uri
- **WHEN** `exchangeClaimCode({ code, codeVerifier, state })` is invoked
- **THEN** the POST body SHALL contain exactly `code`, `code_verifier`, and `state`, and SHALL NOT contain `redirect_uri`

#### Scenario: Seams carry no Node-only dependency
- **WHEN** the `approval` seams are imported in an isomorphic build
- **THEN** they SHALL NOT import `fs`, `http`, or any Node-only module

### Requirement: Multi-entry approval cache keyed and bound per (origin, cp-session, action, target)

`core/src/write-auth-session.ts` SHALL persist a LIST of approvals at `{base}/write-auth-session.json` (mode `0600`, atomic write, self-healing permissions), each `{ write_auth_token, token_type, header, action, org_id?, project_id?, expires_at, control_plane_session_hash, control_plane_principal_id, api_origin, minted_at }`. Saving an approval SHALL replace any existing entry with the same `(api_origin, control_plane_session_hash, action, target)` key and leave other entries intact. `loadLiveApproval({ apiOrigin, cpSessionHash, capability, target })` SHALL return the entry matching all of origin, cp-session-hash, action, and target, or `null` if none matches or it is expired.

#### Scenario: Distinct (action, target) approvals coexist
- **WHEN** an `org.project.create` approval for org Y and a `project.deploy` approval for project X are both minted under the same control-plane session
- **THEN** both SHALL be retrievable; saving one SHALL NOT evict the other

#### Scenario: A non-matching or cross-origin approval is not returned live
- **WHEN** `loadLiveApproval` is called for `(project.deploy, prj_x)` and the cache holds only an approval for a different target/action, a different `api_origin`, or a different `control_plane_session_hash`
- **THEN** it SHALL return `null`

#### Scenario: Cache file is owner-only
- **WHEN** the approval cache is written
- **THEN** the file mode SHALL be `0600`

### Requirement: Approval is invalidated on every control-plane session lifecycle change

The cached approval SHALL be cleared when the control-plane session changes: `operator logout` SHALL clear it; `operator login` / `operator login --step-up` SHALL clear any prior approval before saving the new control-plane session; and provider load SHALL ignore (and may delete) an approval whose `control_plane_session_hash` does not match the current session.

#### Scenario: Re-login clears the prior approval
- **WHEN** `operator login --loopback` mints a new control-plane session
- **THEN** any previously cached approval SHALL be cleared before the new session is saved

### Requirement: CLI `operator approve`, `operator status`, and TTY-only auto-approve

`run402 operator approve --action <capability> (--org <id> | --project <id>)` SHALL run the headless passkey ceremony scoped to that `(action, target)` (PKCE + state, 127.0.0.1 loopback, `requestChallenge` with the action+target, open the validated `confirm_url`, capture and validate `code`+`state`, `exchangeClaimCode`, persist the bound approval), require a live control-plane session (else fail with guidance to run `operator login --loopback`), and emit JSON. `run402 operator write-auth` SHALL exist as a hidden alias. `run402 operator status` SHALL report operator-login state and each cached approval's `(action, target, expiry)`. When a gated write raises `OperatorApprovalRequiredError` AND `stderr` is a TTY AND surface is CLI, `provision`/`deploy apply` SHALL derive the `(action, target)` from the failing request, offer to run the scoped ceremony, and retry once; in MCP, CI, or non-TTY they SHALL NOT open a browser.

#### Scenario: Scoped ceremony caches a bound approval
- **WHEN** `run402 operator approve --action project.deploy --project prj_x` completes the loopback exchange
- **THEN** an approval bound to `(project.deploy, prj_x, api_origin, cp-session)` SHALL be cached, a JSON success result SHALL be printed, and the token SHALL NOT be printed

#### Scenario: State mismatch aborts before success
- **WHEN** the loopback redirect carries a `state` that does not match the value sent to `requestChallenge`
- **THEN** the ceremony SHALL abort before rendering success and SHALL NOT exchange or cache a token

#### Scenario: Non-interactive deploy does not open a browser
- **WHEN** `run402 deploy apply` needs approval and `stderr` is not a TTY (or `surface` is MCP/CI)
- **THEN** it SHALL NOT open a browser and SHALL surface `OperatorApprovalRequiredError` with the resolved approve command

### Requirement: Wallet-less provision and deploy succeed after approval

After a bound approval is cached, `run402 provision` and `run402 deploy apply` issued by a wallet-less human SHALL carry the dual header on the gated request and be authorized, with no SIWX wallet present.

#### Scenario: Provision works wallet-less after approval
- **WHEN** a wallet-less human with a cached control-plane session and a live bound approval runs `run402 provision`
- **THEN** the create request SHALL carry both `Authorization` and `X-Run402-Write-Auth` and SHALL NOT return `403 WRITE_AUTH_REQUIRED`

### Requirement: Typed OperatorApprovalRequiredError with a resolved next-action

When the gateway returns `403` with envelope code `WRITE_AUTH_REQUIRED`, `WRITE_AUTH_BINDING_MISMATCH`, or `WRITE_AUTH_SESSION_INVALID`, the SDK SHALL throw `OperatorApprovalRequiredError` (a `Run402Error` subclass), distinct from `Unauthorized` / `NotAuthorizedError` / `StepUpRequiredError`, carrying `code`, `principal: "operator"`, the `capability`, the `target` (`{ org_id }` or `{ project_id }`), and `next_actions` whose command is the fully-resolved `run402 operator approve --action <capability> --org <id>|--project <id>` synthesized from the failing request's metadata.

#### Scenario: Missing approval surfaces a fully-resolved command
- **WHEN** a wallet-less `project.deploy` on `prj_x` is attempted without a matching approval and the gateway returns `403 WRITE_AUTH_REQUIRED`
- **THEN** the SDK SHALL throw `OperatorApprovalRequiredError` whose `next_actions[0].command` is `run402 operator approve --action project.deploy --project prj_x`

#### Scenario: Binding mismatch maps to a re-approve action
- **WHEN** the gateway returns `403 WRITE_AUTH_BINDING_MISMATCH` (a cached approval targeted the wrong project/org)
- **THEN** the SDK SHALL throw `OperatorApprovalRequiredError` whose `why` indicates the cached approval is stale/wrong-target and SHALL surface the correctly-targeted approve command

### Requirement: Documentation reflects the operator-approval model

The stale `core/control-plane-session.ts` "write-capable … accepted everywhere a SIWX wallet is" claim SHALL be corrected. `cli/llms-cli.txt` and `sdk/llms-sdk.txt` SHALL document operator approval as the public concept (`operator approve`, `operator status`, the surface/authMode semantics, the wallet-less write path) while noting `X-Run402-Write-Auth` / `WRITE_AUTH_REQUIRED` as transport.

#### Scenario: Public docs speak approval, not write-auth
- **WHEN** an agent reads `cli/llms-cli.txt` after this change
- **THEN** it SHALL find `run402 operator approve`, `operator status`, and the MCP-no-ambient-approval behavior documented, with `WRITE_AUTH_REQUIRED` described as the underlying code

