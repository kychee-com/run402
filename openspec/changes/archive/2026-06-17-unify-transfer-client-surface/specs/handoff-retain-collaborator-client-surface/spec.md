## MODIFIED Requirements

### Requirement: Sender opts into retention at initiate

`InitiateTransferInput` SHALL accept an optional `retainCollaborator?: { role: "developer" } | null` on the **email** recipient path. When set on an email-addressed `initiate` (`toEmail`), the SDK SHALL include `retain_collaborator` in the `POST /projects/v1/:project_id/transfers` body; when omitted, the email request body SHALL be `{ to_email, message? }`. The retain option SHALL ride the unified transfer noun — there is no separate `initiateHandoff` / `InitiateHandoffInput`.

#### Scenario: retain_collaborator is sent when requested
- **WHEN** a caller invokes `initiate({ projectId, toEmail, retainCollaborator: { role: "developer" } })`
- **THEN** the POST body SHALL contain `retain_collaborator: { role: "developer" }`

#### Scenario: Request is unchanged when retention is not requested
- **WHEN** a caller invokes `initiate({ projectId, toEmail })` with no `retainCollaborator`
- **THEN** the POST body SHALL NOT contain a `retain_collaborator` key

### Requirement: Preview surfaces the retention offer as a typed block

`ProjectTransferPreview` SHALL expose a typed `retain_collaborator` field that is either `null` or `{ principal_id, role, sender_label, scope, note, accept_field }` on email-kind transfers, while retaining its forward-compatible index signature. The block is surfaced by the kind-agnostic `preview` — there is no separate `previewHandoff` / `ProjectHandoffPreview`.

#### Scenario: Preview exposes the offer block
- **WHEN** a recipient invokes `preview(transferId)` for an email transfer whose sender requested retention
- **THEN** `preview.retain_collaborator` SHALL be a typed block carrying `sender_label` and `accept_field`

#### Scenario: Preview is null when no retention was offered
- **WHEN** a recipient previews an email transfer with no retention offer
- **THEN** `preview.retain_collaborator` SHALL be `null`

### Requirement: Recipient accepts retention at claim

The unified `claim(transferId, opts?)` options SHALL accept an optional `acceptRetainedCollaborator?: boolean`. When set, the SDK SHALL include `accept_retained_collaborator` in the `POST /agent/v1/transfers/:transfer_id/claim` body; when omitted, the body SHALL be unchanged (full severance). The claim result SHALL expose `retained_collaborator_principal_id: string | null`. There is no separate `claimHandoff` / `ClaimHandoffInput` / `ClaimHandoffResult`.

#### Scenario: Acceptance is sent only when requested
- **WHEN** a caller invokes `claim(id, { acceptRetainedCollaborator: true })`
- **THEN** the POST body SHALL contain `accept_retained_collaborator: true`

#### Scenario: Default claim severs (no acceptance field)
- **WHEN** a caller invokes `claim(id)` or `claim(id, { organizationId })` with no `acceptRetainedCollaborator`
- **THEN** the POST body SHALL NOT contain `accept_retained_collaborator`

#### Scenario: Claim result reports the retained principal
- **WHEN** a claim materializes a retained membership
- **THEN** the claim result's `retained_collaborator_principal_id` SHALL carry the sender's principal id (and SHALL be `null` when none was retained)

### Requirement: CLI flags drive the opt-in on the handoff rail

`run402 transfer init` SHALL accept `--retain-collaborator <role>` on the email recipient path (a `--to <email>`), validating the role against the allowed set and mapping it to the unified `initiate`'s `retainCollaborator`. `run402 transfer claim` SHALL accept a boolean `--accept-retained-collaborator` mapping to the unified `claim`'s `acceptRetainedCollaborator`. Both flags SHALL be registered with `assertKnownFlags`. Retention applies only to the email recipient kind.

#### Scenario: init flag maps to the SDK option
- **WHEN** `run402 transfer init --to alice@example.com --retain-collaborator developer` runs
- **THEN** the CLI SHALL call `initiate` with `toEmail` and `retainCollaborator: { role: "developer" }`

#### Scenario: Invalid retain role is rejected locally
- **WHEN** `--retain-collaborator owner` is passed
- **THEN** the CLI SHALL fail with a `BAD_FLAG` envelope naming the allowed roles, without calling the gateway

#### Scenario: Retain on the wallet rail is rejected
- **WHEN** `--retain-collaborator developer` is combined with a wallet `--to`
- **THEN** the CLI SHALL fail with a `BAD_FLAG` envelope stating retention applies only to email recipients

#### Scenario: claim flag maps to the SDK option
- **WHEN** `run402 transfer claim <id> --accept-retained-collaborator` runs
- **THEN** the CLI SHALL call `claim(id, { acceptRetainedCollaborator: true })`

## REMOVED Requirements

### Requirement: Parity holds and no MCP surface is added

**Reason**: The unify-transfer-client-surface change adds the email recipient kind to MCP (an optional `to_email` on `initiate_project_transfer` plus a new `claim_project_transfer` tool), so the prior "no handoff/retain MCP tool is added" constraint no longer holds — the retain opt-in is now reachable through the unified transfer MCP tools.

**Migration**: Surface parity (CLI / OpenClaw / MCP) and drift guards are now governed by the `unified-transfer-client-surface` capability's "Surface parity and drift guards hold" requirement. The retain opt-in rides the unified transfer MCP tools at parity with the CLI flags.
