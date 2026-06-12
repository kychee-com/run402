# status-account-balances Specification

## Purpose
TBD - created by archiving change redesign-status-output. Update Purpose after archive.
## Requirements
### Requirement: Status Reports Balances As One Grouped Object

`run402 status` SHALL report all monetary values under a single top-level `balances` object containing `on_chain_usd_micros`, `on_chain_token`, `prepaid_credit_usd_micros`, and `held_usd_micros`. The payload SHALL NOT emit a top-level `wallet_balance_usd_micros` field nor a separate `billing` block; those values move into `balances` (`on_chain_usd_micros` and `prepaid_credit_usd_micros` respectively). `rail` SHALL remain a top-level field.

#### Scenario: Balances are grouped under one object

- **WHEN** a user runs `run402 status` with an active wallet and a organization
- **THEN** stdout SHALL contain a `balances` object with `on_chain_usd_micros`, `on_chain_token`, `prepaid_credit_usd_micros`, and `held_usd_micros`
- **AND** stdout SHALL NOT contain a top-level `wallet_balance_usd_micros` field
- **AND** stdout SHALL NOT contain a top-level `billing` block

#### Scenario: On-chain read failure is a typed null

- **WHEN** a user runs `run402 status` and the on-chain RPC for the active rail is unreachable
- **THEN** `balances.on_chain_usd_micros` SHALL be `null`
- **AND** exit code SHALL be 0

### Requirement: On-Chain Token Tracks The Active Rail

`balances.on_chain_token` SHALL name the token whose balance `balances.on_chain_usd_micros` reports, derived from the active `rail`: `"USDC"` when `rail` is `x402` and `"pathUSD"` when `rail` is `mpp`. `on_chain_usd_micros` SHALL be expressed in 6-decimal USD micros for either token so the unit is comparable across rails.

#### Scenario: x402 rail reports USDC

- **WHEN** a user runs `run402 status` with `rail` `x402`
- **THEN** `balances.on_chain_token` SHALL be `"USDC"`
- **AND** `balances.on_chain_usd_micros` SHALL reflect the wallet's USDC balance on Base in USD micros

#### Scenario: mpp rail reports pathUSD

- **WHEN** a user runs `run402 status` with `rail` `mpp`
- **THEN** `balances.on_chain_token` SHALL be `"pathUSD"`
- **AND** `balances.on_chain_usd_micros` SHALL reflect the wallet's pathUSD balance on Tempo in USD micros

### Requirement: Prepaid Credit Is Rail-Independent

`balances.prepaid_credit_usd_micros` SHALL report the Run402-held billing balance (formerly `billing.available_usd_micros`) independently of the active rail, and SHALL be `null` when no organization exists for the wallet. `balances.held_usd_micros` SHALL report the held portion, defaulting to `0` when a organization exists with nothing held.

#### Scenario: Prepaid credit does not depend on rail

- **WHEN** a user runs `run402 status` under either the `x402` or `mpp` rail with the same organization
- **THEN** `balances.prepaid_credit_usd_micros` SHALL report the same Run402-held balance in both cases

#### Scenario: No organization yields null prepaid credit

- **WHEN** a user runs `run402 status` for a wallet with no organization
- **THEN** `balances.prepaid_credit_usd_micros` SHALL be `null`

### Requirement: Status Omits The Funding Boolean And The Duplicate Wallet Block

`run402 status` SHALL NOT emit a `funded` field nor a standalone `allowance` block in its success payload. Funding state is observable from `balances.on_chain_usd_micros`, and the wallet address is reported once inside the `wallet` object. This removes the duplicate `address` and the stale local-only `funded` boolean.

#### Scenario: Populated status carries no funded or allowance keys

- **WHEN** a user runs `run402 status` with an active wallet
- **THEN** stdout SHALL NOT contain a top-level `funded` field
- **AND** stdout SHALL NOT contain a top-level `allowance` block
- **AND** the wallet address SHALL appear once, inside the `wallet` object

