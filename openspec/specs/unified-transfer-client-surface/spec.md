# unified-transfer-client-surface Specification

## Purpose
TBD - created by archiving change unify-transfer-client-surface. Update Purpose after archive.
## Requirements
### Requirement: One initiate method addressed to a wallet, email, OR owned org

The SDK `initiate` method SHALL accept exactly one recipient — `toWallet` XOR `toEmail` XOR `toOrgId` — on the single `InitiateTransferInput`, plus `billingPolicy?`, `message?`, `kysignedRecordId?` (wallet path), and `retainCollaborator?` (email path). It SHALL POST to `POST /projects/v1/:project_id/transfers` with `{ to_wallet }`, `{ to_email }`, or `{ to_org_id }` accordingly. Supplying more than one recipient or no recipient SHALL be rejected before the request is sent. `billingPolicy` and `kysignedRecordId` SHALL be wallet-only; `retainCollaborator` SHALL be email-only. The dedicated `initiateHandoff` method and `InitiateHandoffInput` type SHALL NOT exist.

#### Scenario: Wallet initiate posts to_wallet
- **WHEN** a caller invokes `initiate({ projectId, toWallet: "0xb…" })`
- **THEN** the SDK SHALL POST `{ to_wallet: "0xb…" }` to `/projects/v1/:project_id/transfers`

#### Scenario: Email initiate posts to_email on the same route
- **WHEN** a caller invokes `initiate({ projectId, toEmail: "alice@example.com" })`
- **THEN** the SDK SHALL POST `{ to_email: "alice@example.com" }` to `/projects/v1/:project_id/transfers` (NOT `/handoffs`)

#### Scenario: Owned-org initiate posts to_org_id on the same route
- **WHEN** a caller invokes `initiate({ projectId, toOrgId: "org_…" })`
- **THEN** the SDK SHALL POST `{ to_org_id: "org_…" }` to `/projects/v1/:project_id/transfers`
- **AND** when the response carries `anon_key` and `service_key`, the SDK SHALL persist them with `saveProject` and call `setActiveProject` when the credentials provider supports those methods

#### Scenario: Multiple or no recipients are rejected locally
- **WHEN** a caller supplies more than one of `toWallet`, `toEmail`, and `toOrgId`, or supplies none
- **THEN** the SDK SHALL reject the call without issuing a request

#### Scenario: Recipient-specific fields are rejected locally
- **WHEN** a caller supplies `kysignedRecordId` or `billingPolicy` on an email/org recipient, or `retainCollaborator` on a wallet/org recipient
- **THEN** the SDK SHALL reject the call without issuing a request

### Requirement: Kind-agnostic reads and cancel carry recipient_kind

`listIncoming`, `listOutgoing`, `preview`, and `cancel` SHALL each serve both recipient kinds through the `/agent/v1/transfers/*` endpoints. `TransferSummary` and `ProjectTransferPreview` SHALL carry `recipient_kind: "wallet" | "email"` and an optional `to_email`, with `to_wallet` typed as nullable. A single `listIncoming`/`listOutgoing` call SHALL return the union of wallet- and email-addressed rows for the caller. The handoff-specific `listIncomingHandoffs`, `previewHandoff`, and `cancelHandoff` methods and the `HandoffSummary` / `ProjectHandoffPreview` types SHALL NOT exist. `cancel` SHALL take the transfer id as its single leading positional and the optional reason as a named field of a trailing options object (`cancel(transferId, { reason })`); the positional `cancel(transferId, reason)` form SHALL remain available as a `@deprecated` overload for one major-version window and SHALL behave identically.

#### Scenario: Incoming list returns both kinds with recipient_kind
- **WHEN** the authenticated caller has one wallet-addressed and one email-addressed pending transfer
- **THEN** `listIncoming()` SHALL return both rows, each carrying `recipient_kind`

#### Scenario: Preview of an email transfer uses the unified route
- **WHEN** a caller invokes `preview(transferId)` for an `email`-kind transfer
- **THEN** the SDK SHALL GET `/agent/v1/transfers/:transfer_id` and return a preview whose `recipient_kind` is `"email"`

#### Scenario: Cancel is kind-agnostic
- **WHEN** a caller invokes `cancel(transferId)` for either kind
- **THEN** the SDK SHALL POST `/agent/v1/transfers/:transfer_id/cancel`

#### Scenario: Cancel reason is passed as a named field
- **WHEN** a caller invokes `cancel(transferId, { reason })`
- **THEN** the SDK SHALL POST `/agent/v1/transfers/:transfer_id/cancel` with the reason in the body

#### Scenario: Deprecated positional reason still works
- **WHEN** a caller invokes the deprecated `cancel(transferId, reason)` with a string second argument
- **THEN** the SDK SHALL behave identically to the options-object form and SHALL emit a single stderr deprecation notice for the method in the process

### Requirement: claim is the email completion, the analog of accept

The SDK SHALL expose `claim(transferId, opts?)` where `opts` is `{ organizationId?: string; acceptRetainedCollaborator?: boolean }`, POSTing to `POST /agent/v1/transfers/:transfer_id/claim`. Omitting `organizationId` SHALL claim into a new org. The result SHALL be typed as `{ status: "accepted"; project_id; to_organization_id; created_new_org; retained_collaborator_principal_id: string | null; anon_key: string; service_key: string }`. Symmetric with wallet `accept` (gateway `project-transfer-claim-credentials`), `claim` SHALL persist the returned `anon_key`/`service_key` via `credentials.saveProject` and set the project active via `credentials.setActiveProject`, so the claimant can operate the project immediately. The dedicated `claimHandoff` method SHALL NOT exist.

#### Scenario: claim posts to the unified claim route
- **WHEN** a caller invokes `claim(transferId, { organizationId: "org_…" })`
- **THEN** the SDK SHALL POST `{ org_id: "org_…" }` to `/agent/v1/transfers/:transfer_id/claim`

#### Scenario: claim into a new org omits org_id
- **WHEN** a caller invokes `claim(transferId)` with no `organizationId`
- **THEN** the POST body SHALL NOT contain an `org_id` key

#### Scenario: claim surfaces and persists the new owner's keys
- **WHEN** a `claim` succeeds and the response carries `anon_key` and `service_key`
- **THEN** the SDK SHALL persist them with `saveProject` and call `setActiveProject` (symmetric with `accept`), and a credentials provider without persistence SHALL be unaffected

### Requirement: SDK surfaces the intra-resource completion-mismatch error

When the gateway returns `409 WRONG_COMPLETION_FOR_TRANSFER_KIND` (calling `accept` on an email row or `claim` on a wallet row), the SDK SHALL surface it as a `Run402Error` exposing the gateway `next_actions[]` (which point at the sibling completion on the **same** `transfer_id`). No SDK code, type, or doc SHALL reference the removed `WRONG_TRANSFER_KIND` code.

#### Scenario: Wrong completion surfaces the sibling-completion hint
- **WHEN** `accept(transferId)` is called on an `email`-kind transfer and the gateway returns `409 WRONG_COMPLETION_FOR_TRANSFER_KIND`
- **THEN** the thrown `Run402Error` SHALL expose `nextActions` pointing at `POST /agent/v1/transfers/:transfer_id/claim`

#### Scenario: No stale error code remains
- **WHEN** the SDK source is scanned
- **THEN** there SHALL be no reference to `WRONG_TRANSFER_KIND`

### Requirement: CLI is a thin shim over the unified surface

`run402 transfer init --to <wallet|email>` SHALL auto-detect the recipient kind by `@` and call the unified `initiate` (mapping email to `toEmail`, wallet to `toWallet`). `run402 transfer init --to-org <org_id>` SHALL call `initiate({ toOrgId })` for same-actor owned-org moves. Every `allowanceAuthHeaders` signing path in the transfer command SHALL target `/transfers*` (never `/handoffs*`), matching the endpoint the SDK calls. The obsolete `--handoff` (preview/cancel) and `--handoffs` (list) flags SHALL be removed — `preview`, `cancel`, and `list` are kind-agnostic. `run402 transfer claim` SHALL call the unified `claim` against `/agent/v1/transfers/:id/claim`.

#### Scenario: Email init signs and calls the unified route
- **WHEN** `run402 transfer init --to alice@example.com` runs
- **THEN** the CLI SHALL sign `/projects/v1/:id/transfers` and call `initiate({ toEmail })` — no `/handoffs` path is signed or called

#### Scenario: Owned-org init signs and calls the unified route
- **WHEN** `run402 transfer init --to-org org_…` runs
- **THEN** the CLI SHALL sign `/projects/v1/:id/transfers` and call `initiate({ toOrgId })`

#### Scenario: Recipient-specific CLI flags stay on their rails
- **WHEN** `--kysigned` or `--billing-policy` is passed with `--to <email>` or `--to-org`, or `--retain-collaborator` is passed with `--to <wallet>` or `--to-org`
- **THEN** the CLI SHALL reject the invocation before any network request

#### Scenario: Obsolete kind flags are gone
- **WHEN** `--handoff` or `--handoffs` is passed to any transfer subcommand
- **THEN** the CLI SHALL reject it as an unknown flag

#### Scenario: claim signs the unified claim path
- **WHEN** `run402 transfer claim <id>` runs
- **THEN** the CLI SHALL sign and call `/agent/v1/transfers/<id>/claim`

### Requirement: MCP reaches the full unified surface as thin shims

`initiate_project_transfer` SHALL accept optional `to_wallet`, `to_email`, and `to_org_id` fields (exactly one required) and `claim_project_transfer` SHALL remain the email completion tool. Each handler SHALL be a thin shim over the corresponding SDK method. The MCP wallet tools' existing `/transfers*` behavior SHALL be unchanged.

#### Scenario: MCP can initiate an email transfer
- **WHEN** `initiate_project_transfer` is invoked with `to_email`
- **THEN** the tool SHALL call the SDK `initiate({ toEmail })` and surface the result

#### Scenario: MCP can initiate an owned-org transfer
- **WHEN** `initiate_project_transfer` is invoked with `to_org_id`
- **THEN** the tool SHALL call the SDK `initiate({ toOrgId })` and surface the immediate accepted result

#### Scenario: MCP can claim an email transfer
- **WHEN** `claim_project_transfer` is invoked with a `transfer_id`
- **THEN** the tool SHALL call the SDK `claim(transferId, …)` and surface the result

### Requirement: Surface parity and drift guards hold

The CLI, OpenClaw, and MCP command/tool sets SHALL satisfy `sync.test.ts` after the collapse: the five handoff capabilities SHALL be re-expressed against `/transfers*` endpoints (or removed where folded), `SDK_BY_CAPABILITY` SHALL map only to methods that exist, and the new `claim_project_transfer` tool SHALL be registered. OpenClaw SHALL inherit the unified `transfer` surface via its existing re-export.

#### Scenario: No capability maps to a removed method
- **WHEN** `sync.test.ts` runs
- **THEN** every `SDK_BY_CAPABILITY` entry SHALL resolve to an existing SDK method and no SURFACE row SHALL reference a `/handoffs*` endpoint

#### Scenario: OpenClaw stays at parity
- **WHEN** the OpenClaw `transfer` command set is compared to the CLI
- **THEN** they SHALL be identical

