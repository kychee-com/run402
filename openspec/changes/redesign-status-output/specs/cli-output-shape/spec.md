## MODIFIED Requirements

### Requirement: Local-State Inspection Uses Typed Nullable Payload Fields

CLI subcommands that report on local configuration state (allowance, wallet, keystore) SHALL represent absent state through typed nullable payload fields, never through a top-level `status` value.

When the inspected resource is absent, the payload SHALL contain the resource's field set to `null` and a `hint` string giving the next actionable command. When the inspected resource is present, the payload SHALL contain the resource's field set to a non-null object. Exit code SHALL be 0 in both absent and present cases — absence is an informational read, not a command failure.

The `hint` field SHALL use the same name as the existing stderr error envelope's `hint` so agents see consistent guidance-field naming across success and error channels.

#### Scenario: Status with no wallet reports null wallet and hint

- **WHEN** a user runs `run402 status` and no allowance file exists
- **THEN** stdout SHALL contain a JSON object with `wallet: null` and `hint: "Run: run402 init"` (or equivalent next-step guidance)
- **AND** stdout SHALL NOT contain an `allowance` block
- **AND** exit code SHALL be 0
- **AND** stdout SHALL NOT contain a top-level `status` field

#### Scenario: Allowance status with no wallet reports null wallet and hint

- **WHEN** a user runs `run402 allowance status` and no wallet has been created
- **THEN** stdout SHALL contain a JSON object with `wallet: null` and `hint: "Run: run402 allowance create"` (or equivalent next-step guidance)
- **AND** exit code SHALL be 0
- **AND** stdout SHALL NOT contain a top-level `status` field

#### Scenario: Allowance status with a wallet reports the wallet object

- **WHEN** a user runs `run402 allowance status` and a wallet exists
- **THEN** stdout SHALL contain a JSON object with `wallet: { ... }` populated by wallet fields
- **AND** stdout SHALL NOT contain a top-level `status` field

### Requirement: Long-Running Setup Commands Route Progress To Stderr

CLI subcommands whose primary purpose is long-running interactive setup or scaffolding — specifically `run402 init` and `run402 init astro` — SHALL emit a structured JSON summary on stdout and informational progress lines on stderr. Stdout SHALL remain JSON-parseable end-to-end so scripts piping to `jq` work without filtering; stderr SHALL carry the human-readable narration that lets a person re-running interactively see what's happening (faucet status, files being written, next-step suggestions).

This is distinct from the plain-text carve-out at Requirement "Plain-Text Output Commands Remain Plain Text" (which covers `run402 allowance export` and similar single-value commands whose natural output IS plain text). The setup commands have a structured payload AND informational narration; the narration moves to stderr so the structured payload on stdout stays clean.

The progress-on-stderr split SHALL NOT use the stderr error envelope format (no `status: "error"` sentinel) — progress lines are free-form human text, distinguishable from error envelopes by not starting with `{`.

#### Scenario: init emits JSON summary on stdout, progress on stderr

- **WHEN** a user runs `run402 init`
- **THEN** stdout SHALL be a JSON object of shape `{ config_dir, wallet, rail, network, balances, tier, projects_saved, next_step }`
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
