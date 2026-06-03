## MODIFIED Requirements

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
