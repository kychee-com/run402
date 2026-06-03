# wallet-named-identity Specification

## Purpose
TBD - created by archiving change named-wallet-profiles. Update Purpose after archive.
## Requirements
### Requirement: A Wallet Has A Single Synced Name

The local profile/folder name, the `--wallet` selector, and the server-side display label SHALL be one and the same name for a given wallet. The name SHALL be set only at `run402 wallets new <name>` and changed only at `run402 wallets rename <old> <new>`; both SHALL attempt to push the resulting name to the server-side wallet label. There SHALL be no command that sets a server-side label independently of the local folder name.

#### Scenario: Creating a wallet sets folder and pushes label

- **WHEN** a user runs `run402 wallets new kychon`
- **THEN** the local profile directory SHALL be `profiles/kychon/`
- **AND** the CLI SHALL attempt to set the server-side label for that wallet's address to `kychon`

#### Scenario: Rename updates both folder and label

- **WHEN** a user runs `run402 wallets rename kychon kychon-prod`
- **THEN** the local profile directory SHALL become `profiles/kychon-prod/`
- **AND** the CLI SHALL attempt to update the server-side label to `kychon-prod`

#### Scenario: No standalone label command exists

- **WHEN** a user inspects the `run402 wallets` command set
- **THEN** there SHALL be no subcommand that sets the server label without also being the folder name

### Requirement: Display Falls Back To The Local Name When The Server Label Is Unavailable

When rendering a wallet's name, every surface SHALL prefer the locally-known name and SHALL remain fully functional when the server-side label is absent or the server is unreachable. Drift between the local name and the server label (for example, a rename performed while offline) SHALL be surfaced as a reconcilable notice through `wallets list` / `wallets current`, never as a command failure.

#### Scenario: Offline rendering uses the local name

- **WHEN** the server is unreachable and a user runs `run402 status`
- **THEN** the CLI SHALL display the wallet's local name without error

#### Scenario: Drift is surfaced as a reconcilable notice

- **WHEN** the local name and the cached server label differ
- **THEN** `run402 wallets current` SHALL indicate the drift and the action that reconciles it
- **AND** SHALL NOT exit non-zero solely because of the drift

### Requirement: Setting The Server Label Requires Proof Of Wallet Control And Stores Only Metadata

A server-side label write SHALL be authenticated by the wallet's allowance signature (EIP-191 / SIWX), proving control of the key. The label SHALL be display metadata only and SHALL NOT affect key custody. Private keys SHALL never be transmitted off the local machine by any part of this feature.

#### Scenario: Label write is signed by the wallet

- **WHEN** the CLI pushes a label for a wallet
- **THEN** the request SHALL carry the allowance signature headers for that wallet's address

#### Scenario: Keys never leave the machine

- **WHEN** any wallet name, label, or selection operation runs
- **THEN** no private key material SHALL be sent to the server

### Requirement: The Active Wallet Name Is Surfaced In CLI Output

`run402 status` SHALL display a wallet header containing the wallet's name, short address, and rail. Machine-readable output of wallet-touching commands SHALL include a `wallet` object with at least `{ local_label, server_label, address }`, consistent with the CLI output contract (no top-level `status` wrapper). `local_label` is the local profile/`--wallet` selector name and SHALL always be present; `server_label` is the server-side display label (the `/wallets/v1/:address/label` value) and SHALL be `null` when it is unknown or the server is unreachable. The two fields carry the same synced value in the normal case; the distinct keys convey local-selector versus server-display rather than implying two different names.

#### Scenario: Status header names the wallet

- **WHEN** a user runs `run402 status` with wallet `kychon` active
- **THEN** the human-readable output SHALL include a header naming `kychon` and its short address

#### Scenario: Machine output carries the wallet object

- **WHEN** a user runs `run402 status` and parses stdout JSON
- **THEN** the payload SHALL include a `wallet` object with `local_label`, `server_label`, and `address`
- **AND** `local_label` SHALL be non-null and `server_label` SHALL be the cached server label or `null`
- **AND** the payload SHALL NOT introduce a top-level `status` wrapper

### Requirement: The Active Wallet Name Is Surfaced Through The SDK

The SDK SHALL expose an identity read (for example `r.whoami()`) returning at least `{ local_label, server_label, address, activeProject }` for the resolved wallet. `local_label` is the resolved local profile/selector name; `server_label` is the server-side display label, or `null` when unknown/offline. The Node credential provider SHALL expose the resolved profile name so SDK consumers can display which wallet is in use. The internal credential-provider identity shape and on-disk `meta.json` keys MAY retain their existing `name`/`label` field names; only the public `whoami` result is renamed.

#### Scenario: whoami returns the resolved identity

- **WHEN** an SDK consumer calls the identity read for wallet `kychon`
- **THEN** the result SHALL include `local_label: "kychon"`, the wallet `address`, the server `server_label` (or null), and the active project id (or null)

### Requirement: The Active Wallet Name Is Surfaced In MCP Tool Output

The MCP server SHALL resolve its active wallet from `RUN402_WALLET` in its environment. Responses from wallet-touching MCP tools SHALL name the active wallet so the model can tell which wallet it is operating on, and the `status` tool SHALL surface the active wallet name prominently.

#### Scenario: MCP tool output names the active wallet

- **WHEN** the MCP server is configured with `RUN402_WALLET=kychon` and a wallet-touching tool runs
- **THEN** the tool response SHALL identify the active wallet as `kychon`

