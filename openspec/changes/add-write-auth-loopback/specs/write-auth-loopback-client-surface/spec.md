## ADDED Requirements

### Requirement: Isomorphic write-auth ceremony seams

`r.operator.writeAuth.requestChallenge({ cliRedirectUri, codeChallenge, state, token? })` SHALL `POST /agent/v1/control-plane/write-auth/challenges` carrying the control-plane session bearer and the loopback redirect, PKCE S256 challenge, and CSRF state, returning the gateway's confirm target and `delivery`. `r.operator.writeAuth.exchangeClaimCode({ code, codeVerifier, state, token? })` SHALL `POST /agent/v1/control-plane/write-auth/cli/token` and return the minted write-auth token payload. Both seams SHALL be isomorphic — no filesystem, loopback, or other Node-only access.

#### Scenario: requestChallenge posts the loopback + PKCE parameters
- **WHEN** a caller invokes `requestChallenge({ cliRedirectUri, codeChallenge, state })`
- **THEN** the client SHALL POST `cli_redirect_uri`, `code_challenge`, and `state` to the write-auth challenges endpoint with the control-plane session bearer attached

#### Scenario: exchangeClaimCode returns the write-auth token payload
- **WHEN** a caller invokes `exchangeClaimCode({ code, codeVerifier, state })` after the loopback redirect
- **THEN** the client SHALL POST `code`, `code_verifier`, and `state` and return the payload containing the write-auth token, its `header` name, and `expires_in`

#### Scenario: Seams carry no Node-only dependency
- **WHEN** the `writeAuth` seams are imported in an isomorphic build
- **THEN** they SHALL NOT import `fs`, `http`, or any Node-only module

### Requirement: Write-auth token cache

A `core/src/write-auth-session.ts` cache SHALL persist the write-auth token at `{base}/write-auth-session.json` with mode `0600`, atomic temp-file-plus-rename writes, and self-healing permissions, mirroring the control-plane-session cache. It SHALL store an absolute `expires_at`, expose `loadLiveWriteAuthSession` returning `null` once expired, and throw a clear fix-it error when the file parses as JSON but the shape is wrong.

#### Scenario: Token round-trips through the cache
- **WHEN** a minted write-auth token is saved and then read back
- **THEN** the read SHALL return the same token, header name, and `expires_at`

#### Scenario: Expired token is not returned as live
- **WHEN** `loadLiveWriteAuthSession` is called and the cached `expires_at` is in the past
- **THEN** it SHALL return `null`

#### Scenario: Cache file is owner-only
- **WHEN** the write-auth cache is written
- **THEN** the file mode SHALL be `0600`

### Requirement: Dual-header injection with control-plane fallback

`NodeCredentialsProvider.getAuth(path)` SHALL return wallet/SIWX headers unchanged when a wallet allowance is present. When no wallet allowance is present and a live control-plane session is cached, it SHALL return `Authorization: Bearer <session>`, and when a live write-auth token is also cached it SHALL additionally return `X-Run402-Write-Auth: Bearer <token>`. The SIWX wallet path SHALL remain byte-for-byte unchanged.

#### Scenario: Wallet path is unchanged
- **WHEN** a wallet allowance is present
- **THEN** `getAuth` SHALL return exactly the allowance/SIWX headers and SHALL NOT attach a control-plane or write-auth header

#### Scenario: Wallet-less write carries both credentials
- **WHEN** no wallet allowance is present and both a live control-plane session and a live write-auth token are cached
- **THEN** `getAuth` SHALL return both `Authorization: Bearer <session>` and `X-Run402-Write-Auth: Bearer <token>`

#### Scenario: Session without a write-auth token carries only the bearer
- **WHEN** no wallet allowance is present, a live control-plane session is cached, but no live write-auth token is cached
- **THEN** `getAuth` SHALL return `Authorization: Bearer <session>` and SHALL NOT attach `X-Run402-Write-Auth`

### Requirement: CLI ceremony mints and caches the write-auth token

`run402 operator write-auth` SHALL run the headless passkey write-intent ceremony — generate PKCE + state, start a 127.0.0.1 loopback server, `requestChallenge`, open the confirm URL, capture the authorization `code` and `state` on the loopback redirect, `exchangeClaimCode`, and persist the token via the cache. It SHALL require a live control-plane session and SHALL fail with guidance to run `operator login --loopback` first when absent. It SHALL emit JSON to stdout on success.

#### Scenario: Successful ceremony caches the token
- **WHEN** `run402 operator write-auth` completes the loopback exchange
- **THEN** the write-auth token SHALL be written to the cache and a JSON success result SHALL be printed

#### Scenario: Missing control-plane session is actionable
- **WHEN** `run402 operator write-auth` runs with no live control-plane session
- **THEN** it SHALL fail with an envelope guiding the user to run `run402 operator login --loopback` first

#### Scenario: State mismatch on the redirect aborts
- **WHEN** the loopback redirect carries a `state` that does not match the value sent to `requestChallenge`
- **THEN** the ceremony SHALL abort without exchanging or caching a token

### Requirement: Wallet-less provision and deploy succeed after the ceremony

After a write-auth token is cached, `run402 provision` and `run402 deploy apply` issued by a wallet-less human SHALL carry the dual header and be authorized by the gateway, with no SIWX wallet present.

#### Scenario: Provision works wallet-less after write-auth
- **WHEN** a wallet-less human with a cached control-plane session and write-auth token runs `run402 provision`
- **THEN** the request SHALL carry both `Authorization` and `X-Run402-Write-Auth` and SHALL NOT return `403 WRITE_AUTH_REQUIRED`

#### Scenario: Deploy works wallet-less after write-auth
- **WHEN** the same human runs `run402 deploy apply`
- **THEN** the apply requests SHALL carry the dual header and proceed

### Requirement: Typed WriteAuthRequiredError

When the gateway returns `403` with envelope code `WRITE_AUTH_REQUIRED`, the SDK SHALL throw a `WriteAuthRequiredError` (a `Run402Error` subclass) carrying the gateway envelope, distinct from `Unauthorized` / `NotAuthorizedError` / `StepUpRequiredError`. Its message SHALL point the caller at `run402 operator write-auth`.

#### Scenario: Missing or expired write-auth token surfaces the typed error
- **WHEN** a wallet-less write is attempted without a live write-auth token and the gateway returns `403 WRITE_AUTH_REQUIRED`
- **THEN** the SDK SHALL throw `WriteAuthRequiredError`, not a generic `Unauthorized`

#### Scenario: The error guides remediation
- **WHEN** a `WriteAuthRequiredError` is surfaced through the CLI
- **THEN** the error output SHALL reference `run402 operator write-auth` as the remediation

### Requirement: Documentation reflects the dual-credential model

The stale `core/control-plane-session.ts` claim that the session is "write-capable … accepted everywhere a SIWX wallet is" SHALL be corrected to state that `provision`/`deploy` additionally require a write-auth token. `cli/llms-cli.txt` and `sdk/llms-sdk.txt` SHALL document the dual-credential wallet-less write path and the `WRITE_AUTH_*` error codes.

#### Scenario: Stale write-capable comment is corrected
- **WHEN** the `control-plane-session.ts` doc comment is read after this change
- **THEN** it SHALL NOT claim SIWX-equivalence for writes and SHALL note the write-auth-token requirement for `provision`/`deploy`

#### Scenario: Dual-credential path is documented
- **WHEN** an agent reads `cli/llms-cli.txt`
- **THEN** it SHALL find the `run402 operator write-auth` ceremony, the wallet-less write path, and the `WRITE_AUTH_REQUIRED` code documented
