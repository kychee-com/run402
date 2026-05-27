# email-mailbox-selection Specification

## Purpose

Defines how the `@run402/sdk`, the MCP tools, and the `run402` CLI select among a project's multiple mailboxes (up to 5, gateway-enforced). Covers the `mailbox` selector (id or slug), the omitted-selector resolution rule, and the removal of `create`'s implicit conflict idempotency. Created by archiving change `email-multi-mailbox-selector` (v2.21.0).

## Requirements

### Requirement: Mailbox selector across SDK, MCP, and CLI
The email surface SHALL let a caller target a specific mailbox on a project that has more than one. The selector SHALL accept either a mailbox id (prefixed `mbx_`) or a mailbox slug. It SHALL be exposed as:

- SDK: a `mailbox` field on `SendEmailOptions` and `ListEmailsOptions`, and an optional trailing selector argument on `get`, `getRaw`, `getMailbox`, `deleteMailbox`, and the `webhooks.*` methods.
- MCP: an optional `mailbox` parameter on `send_email`, `list_emails`, `get_email`, `get_email_raw`, `get_mailbox`, `delete_mailbox`, and the webhook tools.
- CLI: a `--mailbox <slug|id>` flag on `email send`, `list`, `get`, `get-raw`, `reply`, `info`, and the `email webhooks` subcommands.

#### Scenario: Select a mailbox by slug
- **WHEN** a caller sends an email with `mailbox: "sign"` on a project whose mailboxes include `sign@mail.run402.com`
- **THEN** the system SHALL resolve the `sign` mailbox and send from it

#### Scenario: Select a mailbox by id
- **WHEN** a caller passes `mailbox: "mbx_abc123"`
- **THEN** the system SHALL use that mailbox id directly without listing the project's mailboxes, relying on the gateway to reject an id that belongs to a different project (403)

#### Scenario: Unknown slug
- **WHEN** a caller passes `mailbox: "nope"` and no active mailbox on the project has slug `nope`
- **THEN** the system SHALL return an error stating no mailbox with that slug exists in the project, without sending

### Requirement: Omitted-selector resolution
When no selector is provided, the system SHALL resolve the mailbox by listing the project's active mailboxes and applying:

- **0 mailboxes** → an error directing the caller to create one first.
- **exactly 1 mailbox** → use it (and refresh the local keystore convenience cache).
- **2 or more mailboxes** → an ambiguity error that names the available slugs and requires the caller to supply `mailbox`. The system SHALL NOT silently pick one.

The system SHALL NOT use the cached `mailbox_id` to resolve when a selector is omitted and the project has more than one mailbox.

#### Scenario: Single mailbox, no selector
- **WHEN** a caller lists emails with no `mailbox` selector and the project has exactly one mailbox
- **THEN** the system SHALL use that mailbox

#### Scenario: Multiple mailboxes, no selector
- **WHEN** a caller sends an email with no `mailbox` selector and the project has 3 mailboxes (`sign`, `notifications`, `support`)
- **THEN** the system SHALL return an ambiguity error naming `sign, notifications, support` and SHALL NOT send

#### Scenario: No mailbox at all
- **WHEN** a caller invokes any email operation with no selector and the project has no mailboxes
- **THEN** the system SHALL return an error directing the caller to create a mailbox first

### Requirement: Create does not silently recover on conflict
`create_mailbox` SHALL NOT treat an HTTP 409 as "the project already has this mailbox" and SHALL NOT return a different existing mailbox in its place. A 409 from the gateway (`Slug already in use`, `Address is in cooldown period`, or `Project mailbox limit reached (5)`) SHALL be surfaced to the caller as an error.

#### Scenario: Slug collision is surfaced, not masked
- **WHEN** a caller creates a mailbox with a slug already claimed by another project and the gateway returns 409 `Slug already in use`
- **THEN** the system SHALL return that 409 error and SHALL NOT return some other mailbox as if creation succeeded

#### Scenario: At the per-project cap
- **WHEN** a caller creates a mailbox on a project that already has 5 active mailboxes and the gateway returns 409 `Project mailbox limit reached (5)`
- **THEN** the system SHALL return that error
