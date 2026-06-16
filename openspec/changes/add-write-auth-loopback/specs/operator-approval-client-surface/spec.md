## ADDED Requirements

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

### Requirement: Capability-driven dual-header attachment

`getAuth(path, metadata?)` SHALL accept `{ method, mutates?, capability? }` supplied by the typed SDK method. When resolution selects the operator-approval class, the control-plane bearer and `X-Run402-Write-Auth` SHALL be attached only for requests whose metadata marks a mutating/gated capability. The approval header SHALL NOT be attached blanket to every control-plane request, and SHALL NOT be governed by a client-side path allowlist.

#### Scenario: Gated write carries the dual header
- **WHEN** an operator-mode request is made for a method marked `mutates: true` (e.g. provision/deploy) with a live approval cached
- **THEN** the request SHALL carry both `Authorization: Bearer <session>` and `X-Run402-Write-Auth: Bearer <token>`

#### Scenario: Read carries only the control-plane bearer
- **WHEN** an operator-mode request is made for a non-mutating method (no `mutates`/gated `capability`)
- **THEN** the request SHALL carry `Authorization: Bearer <session>` and SHALL NOT attach `X-Run402-Write-Auth`, even when an approval is cached

### Requirement: Kernel header merge is case-insensitive and credential-family-atomic

The kernel SHALL merge provider headers case-insensitively (an explicit `authorization` SHALL suppress a provider `Authorization`). When a request already sets any auth header (`Authorization`, `SIGN-IN-WITH-X`, or `X-Run402-Write-Auth`, in any casing), the kernel SHALL NOT merge a provider auth header alongside or over it.

#### Scenario: Explicit auth header suppresses provider auth regardless of casing
- **WHEN** a request sets `authorization` (lowercase) and the provider would return `Authorization`
- **THEN** the outgoing request SHALL carry only the request's `authorization` and SHALL NOT carry a duplicate provider `Authorization`

#### Scenario: Request-owned credentials are not co-merged
- **WHEN** a request explicitly sets `Authorization: Bearer <token>` and the provider resolves a different auth class
- **THEN** the kernel SHALL leave the request's credentials intact and SHALL NOT add the provider's auth headers

### Requirement: Isomorphic, hardened operator-approval ceremony seams

`r.operator.approval.requestChallenge({ cliRedirectUri, codeChallenge, state, token? })` SHALL `POST /agent/v1/control-plane/write-auth/challenges` carrying the control-plane session bearer, the loopback redirect, the PKCE S256 challenge, and CSRF state. `r.operator.approval.exchangeClaimCode({ code, codeVerifier, redirectUri, state, token? })` SHALL `POST /agent/v1/control-plane/write-auth/cli/token` including `redirect_uri`, and return the minted approval token payload. Both seams SHALL be isomorphic (no `fs`/loopback).

#### Scenario: exchangeClaimCode includes the redirect_uri
- **WHEN** `exchangeClaimCode({ code, codeVerifier, redirectUri, state })` is invoked
- **THEN** the POST body SHALL include `redirect_uri` in addition to `code`, `code_verifier`, and `state`

#### Scenario: Seams carry no Node-only dependency
- **WHEN** the `approval` seams are imported in an isomorphic build
- **THEN** they SHALL NOT import `fs`, `http`, or any Node-only module

### Requirement: Approval token cache bound to session, origin, and target

`core/src/write-auth-session.ts` SHALL persist the approval at `{base}/write-auth-session.json` (mode `0600`, atomic write, self-healing permissions, absolute `expires_at`) and SHALL store binding fields: `control_plane_session_hash`, `control_plane_principal_id`, `api_origin`, `scopes`, optional `org_id`/`project_id`, and `minted_at`. `loadLiveApproval(...)` SHALL return `null` on cp-session-hash mismatch, principal mismatch, api-origin mismatch, scope/target mismatch, or expiry.

#### Scenario: A stale or cross-origin approval is not returned live
- **WHEN** `loadLiveApproval` is called and the cached `control_plane_session_hash` or `api_origin` does not match the current control-plane session / API base
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

`run402 operator approve` SHALL run the headless passkey approval ceremony (PKCE + state, 127.0.0.1 loopback, `requestChallenge`, open the validated `confirm_url`, capture and validate `code`+`state`, `exchangeClaimCode`, persist + bind the approval), require a live control-plane session (else fail with guidance to run `operator login --loopback`), and emit JSON. `run402 operator write-auth` SHALL exist as a hidden alias. `run402 operator status` SHALL report operator-login state, approval state + expiry, scopes, and org/project target. When approval is missing AND `stderr` is a TTY, `provision`/`deploy apply` SHALL offer to run the ceremony and retry once; in MCP, CI, or non-TTY they SHALL NOT open a browser.

#### Scenario: Successful ceremony caches a bound approval
- **WHEN** `run402 operator approve` completes the loopback exchange
- **THEN** the approval SHALL be written to the cache with its session/origin binding and a JSON success result SHALL be printed, and the token SHALL NOT be printed

#### Scenario: State mismatch aborts before success
- **WHEN** the loopback redirect carries a `state` that does not match the value sent to `requestChallenge`
- **THEN** the ceremony SHALL abort before rendering success and SHALL NOT exchange or cache a token

#### Scenario: Non-interactive deploy does not open a browser
- **WHEN** `run402 deploy apply` needs approval and `stderr` is not a TTY (or `surface` is MCP/CI)
- **THEN** it SHALL NOT open a browser and SHALL surface `OperatorApprovalRequiredError`

### Requirement: Wallet-less provision and deploy succeed after approval

After a bound approval is cached, `run402 provision` and `run402 deploy apply` issued by a wallet-less human SHALL carry the dual header on the gated request and be authorized, with no SIWX wallet present.

#### Scenario: Provision works wallet-less after approval
- **WHEN** a wallet-less human with a cached control-plane session and a live bound approval runs `run402 provision`
- **THEN** the create request SHALL carry both `Authorization` and `X-Run402-Write-Auth` and SHALL NOT return `403 WRITE_AUTH_REQUIRED`

### Requirement: Typed OperatorApprovalRequiredError with structured remediation

When the gateway returns `403` with envelope code `WRITE_AUTH_REQUIRED`, the SDK SHALL throw `OperatorApprovalRequiredError` (a `Run402Error` subclass), distinct from `Unauthorized` / `NotAuthorizedError` / `StepUpRequiredError`, carrying `code: "WRITE_AUTH_REQUIRED"`, `principal: "operator"`, the `capability`, and `next_actions` referencing `run402 operator approve`.

#### Scenario: Missing approval surfaces the typed error with next_actions
- **WHEN** a wallet-less gated write is attempted without a live approval and the gateway returns `403 WRITE_AUTH_REQUIRED`
- **THEN** the SDK SHALL throw `OperatorApprovalRequiredError` whose `next_actions` reference `run402 operator approve`

### Requirement: Documentation reflects the operator-approval model

The stale `core/control-plane-session.ts` "write-capable … accepted everywhere a SIWX wallet is" claim SHALL be corrected. `cli/llms-cli.txt` and `sdk/llms-sdk.txt` SHALL document operator approval as the public concept (`operator approve`, `operator status`, the surface/authMode semantics, the wallet-less write path) while noting `X-Run402-Write-Auth` / `WRITE_AUTH_REQUIRED` as transport.

#### Scenario: Public docs speak approval, not write-auth
- **WHEN** an agent reads `cli/llms-cli.txt` after this change
- **THEN** it SHALL find `run402 operator approve`, `operator status`, and the MCP-no-ambient-approval behavior documented, with `WRITE_AUTH_REQUIRED` described as the underlying code
