## ADDED Requirements

### Requirement: Sender opts into retention at initiate

`InitiateHandoffInput` SHALL accept an optional `retainCollaborator?: { role: "developer" } | null`. When set, `initiateHandoff` SHALL include `retain_collaborator` in the request body; when omitted, the request body SHALL be byte-for-byte identical to today's (`{ to_email, message? }`).

#### Scenario: retain_collaborator is sent when requested
- **WHEN** a caller invokes `initiateHandoff({ projectId, toEmail, retainCollaborator: { role: "developer" } })`
- **THEN** the POST body SHALL contain `retain_collaborator: { role: "developer" }`

#### Scenario: Request is unchanged when retention is not requested
- **WHEN** a caller invokes `initiateHandoff({ projectId, toEmail })` with no `retainCollaborator`
- **THEN** the POST body SHALL NOT contain a `retain_collaborator` key

### Requirement: Preview surfaces the retention offer as a typed block

`ProjectHandoffPreview` SHALL expose a typed `retain_collaborator` field that is either `null` or `{ principal_id, role, sender_label, scope, note, accept_field }`, while retaining its forward-compatible index signature.

#### Scenario: Preview exposes the offer block
- **WHEN** a recipient previews a handoff whose sender requested retention
- **THEN** `preview.retain_collaborator` SHALL be a typed block carrying `sender_label` and `accept_field`

#### Scenario: Preview is null when no retention was offered
- **WHEN** a recipient previews a handoff with no retention offer
- **THEN** `preview.retain_collaborator` SHALL be `null`

### Requirement: Recipient accepts retention at claim

`ClaimHandoffInput` SHALL accept an optional `acceptRetainedCollaborator?: boolean`. When set, `claimHandoff` SHALL include `accept_retained_collaborator` in the request body; when omitted, the body SHALL be unchanged (full severance). `ClaimHandoffResult` SHALL expose `retained_collaborator_principal_id: string | null`.

#### Scenario: Acceptance is sent only when requested
- **WHEN** a caller invokes `claimHandoff(id, { acceptRetainedCollaborator: true })`
- **THEN** the POST body SHALL contain `accept_retained_collaborator: true`

#### Scenario: Default claim severs (no acceptance field)
- **WHEN** a caller invokes `claimHandoff(id)` or `claimHandoff(id, { organizationId })` with no `acceptRetainedCollaborator`
- **THEN** the POST body SHALL NOT contain `accept_retained_collaborator`

#### Scenario: Claim result reports the retained principal
- **WHEN** a claim materializes a retained membership
- **THEN** `ClaimHandoffResult.retained_collaborator_principal_id` SHALL carry the sender's principal id (and SHALL be `null` when none was retained)

### Requirement: CLI flags drive the opt-in on the handoff rail

`run402 transfer init` SHALL accept `--retain-collaborator <role>` on the email/handoff rail, validating the role against the allowed set and mapping it to `retainCollaborator`. `run402 transfer claim` SHALL accept a boolean `--accept-retained-collaborator` mapping to `acceptRetainedCollaborator`. Both flags SHALL be registered with `assertKnownFlags`.

#### Scenario: init flag maps to the SDK option
- **WHEN** `run402 transfer init --to alice@example.com --retain-collaborator developer` runs
- **THEN** the CLI SHALL call `initiateHandoff` with `retainCollaborator: { role: "developer" }`

#### Scenario: Invalid retain role is rejected locally
- **WHEN** `--retain-collaborator owner` is passed
- **THEN** the CLI SHALL fail with a `BAD_FLAG` envelope naming the allowed roles, without calling the gateway

#### Scenario: Retain on the wallet rail is rejected
- **WHEN** `--retain-collaborator developer` is combined with a wallet `--to`
- **THEN** the CLI SHALL fail with a `BAD_FLAG` envelope stating retention applies only to email handoffs

#### Scenario: claim flag maps to the SDK option
- **WHEN** `run402 transfer claim <id> --accept-retained-collaborator` runs
- **THEN** the CLI SHALL call `claimHandoff(id, { acceptRetainedCollaborator: true })`

### Requirement: Parity holds and no MCP surface is added

OpenClaw SHALL inherit the new flags via the existing `transfer` re-export, and no handoff MCP tool SHALL be added (handoff is not exposed via MCP today). `sync.test.ts` CLI/OpenClaw parity SHALL continue to pass.

#### Scenario: OpenClaw inherits the flags
- **WHEN** the OpenClaw `transfer` command set is compared to the CLI
- **THEN** they SHALL remain identical, including the new flags

#### Scenario: No handoff MCP tool is introduced
- **WHEN** the MCP tool set is scanned after this change
- **THEN** there SHALL be no new handoff/retain MCP tool
