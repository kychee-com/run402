## MODIFIED Requirements

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
