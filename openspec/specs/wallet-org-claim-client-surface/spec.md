# wallet-org-claim-client-surface Specification

## Purpose
The client surface for claiming a wallet-`agent`-owned org into a human's console identity (an ownership transfer): the challenge → sign → dual-proof submit choreography, the reusable-nonce `select_org` round-trip, `STEP_UP_REQUIRED` handling, the control-plane-session-only bearer, and the isomorphic seam (`r.operator.claimWalletOrg.challenge`/`.submit`) + Node convenience (`claimWalletOrg` / `signWalletOrgClaim`) split. CLI + SDK only. Wraps gateway v1.82 `first-class-orgs`.
## Requirements
### Requirement: Request a claim challenge

`r.operator.claimWalletOrg.challenge({ wallet })` SHALL `POST /agent/v1/operator/claim-wallet-org/challenge` and return `{ nonce }`. The method is isomorphic (no Node-only APIs).

#### Scenario: Challenge returns a single-use nonce
- **WHEN** a caller invokes `r.operator.claimWalletOrg.challenge({ wallet })`
- **THEN** the client SHALL POST `{ wallet }` and return the server-issued `{ nonce }`

### Requirement: Submit a claim with both proofs on one request

`r.operator.claimWalletOrg.submit({ token, siwx, orgId?, displayName? })` SHALL `POST /agent/v1/operator/claim-wallet-org` carrying `Authorization: Bearer <token>` (the control-plane session) AND `SIGN-IN-WITH-X: <siwx>` (the wallet proof) on the same request, with body `{ org_id?, display_name? }`. The method is isomorphic.

#### Scenario: Dual proofs ride one request
- **WHEN** a caller invokes `submit({ token, siwx })`
- **THEN** the request SHALL include both the `Authorization: Bearer` header and the `SIGN-IN-WITH-X` header

#### Scenario: First submit may omit the org id
- **WHEN** a caller submits without `orgId`
- **THEN** the request body SHALL NOT contain `org_id`

### Requirement: select_org is a discriminated, non-thrown result that reuses the same proof

The submit result SHALL be the discriminated union `{ status: "claimed", org_id, ... } | { status: "select_org", selectable_orgs: { org_id, display_name, tier }[] }`. A `select_org` result SHALL NOT be thrown as an error. Because the challenge nonce binds to `(human, wallet, action)` and not to an org, re-submitting with a chosen `orgId` SHALL reuse the same `token` and the same `siwx` — no re-challenge and no re-sign.

#### Scenario: select_org is returned, not thrown
- **WHEN** a multi-org wallet's claim returns `select_org`
- **THEN** `submit` SHALL return `{ status: "select_org", selectable_orgs }` without throwing

#### Scenario: Re-submit reuses the live nonce and signature
- **WHEN** the caller re-submits after a `select_org` with a chosen `orgId`
- **THEN** the client SHALL reuse the same `token` and `siwx` and add `org_id` to the body, issuing no new challenge and no new signature

### Requirement: Node convenience runs the full claim dance

The Node entry SHALL provide a convenience that orchestrates the claim: pull the control-plane session from cache, request a challenge, sign the nonce with the local allowance, submit both proofs, and return the discriminated result. The SIWX signature SHALL be built via the allowance SIWX-header path with `domain` = the API base host, `nonce` = the challenge nonce, a fresh `issuedAt`, and an `expirationTime` within the freshness window; it SHALL NOT construct or require a canonical statement string. The convenience SHALL NOT attempt the WebAuthn step-up itself.

#### Scenario: Signs the challenge nonce with the local allowance
- **WHEN** the Node convenience runs the dance
- **THEN** it SHALL produce a `SIGN-IN-WITH-X` proof over the challenge `nonce` with `domain` = the API host, signed by the active wallet's allowance

#### Scenario: Step-up is not driven from the SDK
- **WHEN** the gateway responds `STEP_UP_REQUIRED`
- **THEN** the Node convenience SHALL surface that error and SHALL NOT attempt a WebAuthn ceremony

### Requirement: Claim uses the write-capable control-plane session only

The Node convenience SHALL source the bearer from the control-plane session cache (loopback-PKCE), not the read-only device-flow operator session. When no control-plane session is cached, it SHALL fail with guidance to run the loopback login.

#### Scenario: Missing control-plane session yields guidance
- **WHEN** the convenience runs with no control-plane session cached
- **THEN** it SHALL fail with a message directing the user to `run402 operator login --loopback`

#### Scenario: The read-only operator session is not used as the claim bearer
- **WHEN** only a device-flow operator session is present
- **THEN** the convenience SHALL NOT use it as the claim bearer

### Requirement: STEP_UP_REQUIRED is recognizable and actionable

A `STEP_UP_REQUIRED` response (HTTP 403, `details.op_class = "org.claim_wallet"`) SHALL surface as a recognizable error preserving the gateway `details`. The CLI SHALL direct the user to `run402 operator login --step-up` and allow re-running, since the challenge nonce remains live. The client SHALL behave correctly whether the gateway gates the challenge endpoint or only the claim.

#### Scenario: Step-up surfaces with remediation
- **WHEN** the claim returns `STEP_UP_REQUIRED`
- **THEN** the client SHALL surface the error with the gateway `details`, and the CLI SHALL point the user at `run402 operator login --step-up`

#### Scenario: Re-run after step-up reuses the live nonce
- **WHEN** the user steps up and re-runs the claim
- **THEN** the flow SHALL be able to reuse the still-live nonce rather than forcing a new challenge

### Requirement: CLI claim flow

`run402 operator claim-wallet-org [--org <id>] [--name <label>]` SHALL run challenge → sign → submit; on `select_org` it SHALL print the `selectable_orgs` (org_id, display_name, tier) and instruct re-running with `--org`; on success it SHALL emit JSON. Per the CLI output contract (`cli-output-shape`), stdout SHALL NOT carry a top-level `status` field — the gateway's `claimed`/`select_org` discriminator is surfaced as an explicit `claimed` boolean (`claimed: true` on success; `claimed: false` with `selectable_orgs` on the multi-org round). The command SHALL be registered in the `sync.test.ts` `SURFACE` (operator namespace), kept at CLI/OpenClaw parity, and documented in `cli/llms-cli.txt`.

#### Scenario: Multi-org selection guidance
- **WHEN** the claim returns `select_org`
- **THEN** the CLI SHALL print `{ claimed: false, selectable_orgs, hint }` and instruct the user to re-run with `--org <id>`

#### Scenario: Successful claim emits JSON without a status envelope
- **WHEN** the claim succeeds
- **THEN** the CLI SHALL print the claimed org as JSON with an explicit `claimed: true` and no top-level `status` field

