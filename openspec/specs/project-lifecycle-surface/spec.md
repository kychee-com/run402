## ADDED Requirements

### Requirement: Lifecycle-state signals surfaced on 402

When the gateway returns 402 with lifecycle fields on a control-plane mutating route (deploy, secret rotation, subdomain claim, function upload, publish, contract ops, domain ops, email-domain ops, mailbox ops), the CLI/MCP tool output SHALL extract and display the lifecycle state, the time the project entered it, and the time of the next transition, alongside the existing `renew_url` / `usage` / `hint` fields.

#### Scenario: Past-due 402 on a deploy

- **WHEN** a deploy tool receives `HTTP 402` with body `{ "message": "Project is past_due", "lifecycle_state": "past_due", "entered_state_at": "2026-04-01T00:00:00Z", "next_transition_at": "2026-04-15T00:00:00Z", "renew_url": "https://..." }`
- **THEN** the tool result text includes the HTTP status, the message, a line showing `lifecycle_state: past_due`, the entered-at and next-transition-at timestamps, and a next-step hint directing the agent to renew the tier

#### Scenario: 402 without lifecycle fields

- **WHEN** a tool receives `HTTP 402` with body that only contains `message` and `usage` (no `lifecycle_state`)
- **THEN** output renders the existing usage/renew_url guidance unchanged; no "lifecycle_state" line is emitted

### Requirement: Subdomain reservation 409 produces distinct guidance

When `POST /subdomains/v1` (or equivalent subdomain-claim route) returns `HTTP 409`, tool output SHALL include actionable guidance that the name is currently reserved (e.g., under another wallet's grace window) and suggests waiting for the reservation to lapse or choosing another name, distinct from the 403 not-authorized path.

#### Scenario: Subdomain reserved during grace window

- **WHEN** a subdomain-claim tool receives `HTTP 409` with body `{ "message": "Subdomain reserved", "hint": "Name held for original owner during grace period" }`
- **THEN** the tool result includes the 409 status, the message and hint, and next-step text mentioning the reservation rather than reusing the 403 lease-expired guidance

### Requirement: delete_project tool name and text match the API

The MCP tool that calls `DELETE /projects/v1/:id` SHALL be named `delete_project` (matching the HTTP method) and its description SHALL state that the call triggers an immediate, irreversible cascade purge (drop schema, delete Lambdas, release subdomains, tombstone mailbox, etc.) and SHALL distinguish that explicit purge from the automatic lease-expiry grace state machine. The CLI subcommand SHALL remain `run402 projects delete <id>` and use equivalent wording.

#### Scenario: Successful delete

- **WHEN** the agent invokes `delete_project` on a live project and the API returns 200
- **THEN** the tool returns success text that names the action as a delete/purge, lists the cascade effects, and states that the action is irreversible

#### Scenario: Tool description advertised via MCP list

- **WHEN** an MCP client lists available tools
- **THEN** the description for `delete_project` describes immediate destructive cascade, explicitly contrasts it with the automatic lease-expiry grace path, and does not claim the project enters a reactivatable grace window

### Requirement: SKILL.md runtime sections document the grace state machine

Both `SKILL.md` (MCP) and `openclaw/SKILL.md` SHALL describe the project lifecycle as the four-stage `active → past_due → frozen → dormant → purged` state machine (~104-day grace), note that the end-user data plane continues to serve throughout, and state that owner control-plane mutating endpoints return 402 once the project is past_due. The prior "7-day read-only grace, then archived" wording SHALL be removed.

#### Scenario: Skill lifecycle paragraph

- **WHEN** a reader loads `SKILL.md` or `openclaw/SKILL.md`
- **THEN** the lifecycle section describes the four stages, the ~104-day total window, the data-plane vs control-plane distinction, and that renewing during grace reactivates the project

### Requirement: Lifecycle-state extraction is defensive

`formatApiError` SHALL read `lifecycle_state`, `entered_state_at`, `next_transition_at`, and `scheduled_purge_at` from the response body only when present; missing or null fields MUST NOT produce a line in the output nor throw.

#### Scenario: Partial lifecycle body

- **WHEN** a 402 body contains `lifecycle_state` and `entered_state_at` but omits `next_transition_at`
- **THEN** output lists the present fields and omits the missing one, with no placeholder text such as `undefined` or `null`
