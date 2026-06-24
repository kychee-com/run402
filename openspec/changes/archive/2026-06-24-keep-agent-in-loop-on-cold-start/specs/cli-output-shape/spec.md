## ADDED Requirements

### Requirement: Error Envelopes Carry Typed next_actions

CLI stderr error envelopes SHALL be able to carry a `next_actions` array using the canonical platform shape — each entry `{ type, command?, method?, path?, auth?, why? }` where `type` is a known action enum. The enum is the gateway set (`retry | authenticate | submit_payment | renew_tier | check_usage | resume_deploy | edit_request | edit_migration | contact_support`) extended with the bootstrap verbs `create_project` and `initialize_wallet`. The optional `command` field carries the literal CLI invocation for client-side, CLI-resolvable actions.

For any failure on the cold-start bootstrap path — absent or malformed allowance, no active or specified project, or no resolvable tier detected client-side — the envelope SHALL carry a non-empty `next_actions` array naming the exact command that advances the agent. The existing `hint` string MAY remain as a human mirror but SHALL NOT be the only machine-actionable guidance. For failures where no caller action can help, `next_actions` MAY be omitted or empty.

#### Scenario: No active project names provision
- **WHEN** a project-resolving subcommand (e.g. `run402 deploy apply`) fails with `code: "NO_ACTIVE_PROJECT"`
- **THEN** the stderr envelope SHALL contain `next_actions` with an entry `{ type: "create_project", command: "run402 projects provision" }`

#### Scenario: Absent allowance names init
- **WHEN** a subcommand fails because no allowance is configured (or the allowance file is malformed)
- **THEN** the stderr envelope SHALL contain `next_actions` with an entry `{ type: "initialize_wallet", command: "run402 init" }`

#### Scenario: Action type stays within the known enum
- **WHEN** any CLI failure emits a `next_actions[]` entry
- **THEN** each entry's `type` SHALL be a member of the known action enum (gateway set plus `create_project`, `initialize_wallet`)

## MODIFIED Requirements

### Requirement: Long-Running Setup Commands Route Progress To Stderr

CLI subcommands whose primary purpose is long-running interactive setup or scaffolding — specifically `run402 init` and `run402 init astro` — SHALL emit a structured JSON summary on stdout and informational progress lines on stderr. Stdout SHALL remain JSON-parseable end-to-end so scripts piping to `jq` work without filtering; stderr SHALL carry the human-readable narration that lets a person re-running interactively see what's happening (faucet status, files being written, next-step suggestions).

This is distinct from the plain-text carve-out at Requirement "Plain-Text Output Commands Remain Plain Text" (which covers `run402 allowance export` and similar single-value commands whose natural output IS plain text). The setup commands have a structured payload AND informational narration; the narration moves to stderr so the structured payload on stdout stays clean.

The progress-on-stderr split SHALL NOT use the stderr error envelope format (no `status: "error"` sentinel) — progress lines are free-form human text, distinguishable from error envelopes by not starting with `{`.

The success summary SHALL carry next-step guidance as a typed `next_actions[]` array using the same shape and enum as the stderr error envelope (Requirement "Error Envelopes Carry Typed next_actions"). The legacy `next_step` string field SHALL be retained as a back-compat mirror equal to `next_actions[0].command` so existing consumers do not break; `next_actions[]` is the canonical field and `next_step` is derived from it.

#### Scenario: init emits JSON summary on stdout, progress on stderr
- **WHEN** a user runs `run402 init`
- **THEN** stdout SHALL be a JSON object of shape `{ config_dir, wallet, rail, network, balances, tier, projects_saved, next_actions, next_step }`
- **AND** `next_actions` SHALL be a typed action array, and `next_step` SHALL equal `next_actions[0].command`
- **AND** the `wallet` object SHALL carry `local_label`, `server_label`, and `address`, and SHALL NOT carry a `funded` field
- **AND** the `balances` object SHALL match the `run402 status` shape (`on_chain_usd_micros`, `on_chain_token`, `prepaid_credit_usd_micros`, `held_usd_micros`)
- **AND** stdout SHALL NOT contain an `allowance` block or a top-level `balance` field
- **AND** stderr SHALL contain human progress lines including labels such as `Config`, `Allowance`, `Balance`, `Tier`, `Next`
- **AND** stderr SHALL NOT contain a structured error envelope (no JSON object starting with `{ "status": "error"`)

#### Scenario: init astro emits JSON summary on stdout, scaffold narration on stderr
- **WHEN** a user runs `run402 init astro ./my-app`
- **THEN** stdout SHALL be a JSON object of shape `{ dir, files_created, created, next_steps }`
- **AND** stderr SHALL contain `Scaffolded Astro project at <dir>` and `Files created:` and `Next steps:` narration
- **AND** stdout SHALL NOT contain the scaffolded-file list as a text bullet list

#### Scenario: init astro scaffold template does not import retired getUser
- **WHEN** a user runs `run402 init astro ./my-app` and inspects `./my-app/src/pages/[slug].astro`
- **THEN** the scaffolded file SHALL NOT contain `getUser` (the retired bare export from `@run402/functions` v2.x that throws `R402_AUTH_UNKNOWN_EXPORT` at runtime under v3.0+)
- **AND** the scaffolded file SHALL import only the symbols it actually uses from `@run402/functions`
