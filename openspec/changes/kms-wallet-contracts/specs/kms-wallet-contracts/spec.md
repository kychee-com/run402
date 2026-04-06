### Requirement: KMS-backed wallet provisioning

The gateway SHALL provision AWS KMS-managed Ethereum wallets per project, with private keys that never leave KMS, gated by a 30-day prepaid rent check.

#### Scenario: Provision a new wallet (happy path)

- **WHEN** `POST /contracts/v1/wallets` is called with `{ "chain": "base-mainnet" }` and a valid project API key
- **AND** the project's billing account cash balance is at least **1,200,000 USD-micros** ($1.20, equal to 30 days of rent)
- **THEN** the gateway SHALL create an AWS KMS key with spec `ECC_SECG_P256K1` and usage `SIGN_VERIFY`
- **AND** tag the KMS key with `run402:project_id` and `run402:wallet_id`
- **AND** derive the Ethereum address from the KMS public key (keccak256 of the uncompressed point, last 20 bytes)
- **AND** insert a row into `internal.contract_wallets` with `status = 'active'` and `last_rent_debited_on = today`
- **AND** debit the first day's rent immediately (40,000 USD-micros) as a `kms_wallet_rental` ledger entry
- **AND** return `{ id, project_id, chain, address, status: "active", native_balance_wei: "0", native_balance_usd_micros: 0, created_at }`

#### Scenario: Insufficient cash balance at creation

- **WHEN** `POST /contracts/v1/wallets` is called
- **AND** the project's cash balance is less than 1,200,000 USD-micros
- **THEN** the gateway SHALL NOT create the KMS key
- **AND** SHALL return HTTP 402 with `{ "error": "insufficient_balance_for_30_day_prepay", "required_usd_micros": 1200000, "available_usd_micros": <actual> }`

#### Scenario: Soft default of one wallet (CLI/MCP nudge only, no API cap)

- **WHEN** the CLI command `run402 contracts provision-wallet` is invoked and the project already owns one or more active wallets
- **THEN** the CLI SHALL print a confirmation prompt: "This project already has N active wallet(s). Adding another costs $0.04/day each ($1.20/month). Continue? [y/N]"
- **AND** require explicit confirmation before calling the API
- **BUT** the gateway HTTP API itself SHALL NOT cap the number of wallets — projects with sufficient cash balance can create as many wallets as they pay rent for

#### Scenario: Wallet creation is project-scoped

- **WHEN** project A creates a wallet
- **THEN** project B SHALL NOT see it in `GET /contracts/v1/wallets`
- **AND** project B's API key SHALL NOT be able to call `POST /contracts/v1/call` against it

#### Scenario: Unsupported chain

- **WHEN** `POST /contracts/v1/wallets` is called with a chain not in the static chain registry
- **THEN** the gateway SHALL return HTTP 400 with `{ "error": "unsupported_chain", "supported": ["base-mainnet"] }`

#### Scenario: Private key never exported

- **WHEN** any API endpoint or admin operation is called
- **THEN** the gateway SHALL NOT expose, return, or log the KMS key material in any form
- **AND** the codebase SHALL NOT contain any code path that calls `kms:Decrypt` or `kms:GetParametersForImport` on a contract wallet KMS key
- **AND** the gateway IAM role SHALL NOT have `kms:Decrypt` permission scoped to contract wallet KMS keys

### Requirement: Daily wallet rental

The gateway SHALL debit $0.04/day from each project's cash balance for every active wallet, and SHALL suspend wallets when the balance can no longer cover rent.

#### Scenario: Daily rent debit

- **WHEN** the daily rent-billing job runs (once per UTC day, idempotent)
- **AND** a wallet has `status = 'active'` and `last_rent_debited_on < today`
- **AND** the project's cash balance is at least 40,000 USD-micros ($0.04)
- **THEN** the gateway SHALL atomically:
  - debit 40,000 USD-micros from the project's cash balance
  - insert a `kms_wallet_rental` ledger entry with `metadata = { wallet_id, day }`
  - set the wallet's `last_rent_debited_on = today`

#### Scenario: Idempotent daily debit

- **WHEN** the daily rent-billing job runs twice on the same UTC day
- **THEN** the second run SHALL skip any wallet whose `last_rent_debited_on = today`
- **AND** SHALL NOT debit twice
- **AND** SHALL NOT create duplicate ledger entries

#### Scenario: Suspension at zero balance

- **WHEN** the daily rent-billing job processes a wallet
- **AND** the project's cash balance is less than 40,000 USD-micros
- **THEN** the gateway SHALL transition every active wallet on that project to `status = 'suspended'`
- **AND** SHALL set `suspended_at = NOW()` on each suspended wallet
- **AND** SHALL NOT debit any partial amount
- **AND** SHALL NOT take the project's balance below zero

#### Scenario: Suspended wallet rejects writes

- **WHEN** `POST /contracts/v1/call` is called against a wallet with `status = 'suspended'`
- **THEN** the gateway SHALL return HTTP 402 with `{ "error": "wallet_suspended_unpaid_rent", "wallet_id", "suspended_at", "required_top_up_usd_micros": 40000 }`
- **AND** SHALL NOT broadcast any transaction
- **AND** SHALL NOT charge gas

#### Scenario: Suspended wallet allows reads

- **WHEN** `GET /contracts/v1/wallets/:id` is called against a suspended wallet
- **THEN** the gateway SHALL return the wallet metadata with `status: "suspended"`, `suspended_at`, and current native balance
- **AND** `GET /contracts/v1/calls/:id` for past calls on that wallet SHALL continue to work

#### Scenario: Automatic reactivation on top-up

- **WHEN** a project tops up its cash balance to at least 40,000 USD-micros
- **AND** the next daily rent-billing job runs
- **THEN** the gateway SHALL transition all of the project's `suspended` wallets back to `active`
- **AND** clear `suspended_at`
- **AND** debit one day's rent for the current day
- **NOTE:** Reactivation is automatic and free — no admin action, no support ticket. The user simply tops up.

### Requirement: 90-day deletion of permanently suspended wallets

The gateway SHALL permanently delete the KMS key of any wallet that remains suspended for 90 consecutive days, with a funds-rescue path that prefers auto-drain to a recovery address over fund loss.

#### Scenario: Day-90 deletion, dust balance (simple delete)

- **WHEN** the daily rent-billing job runs
- **AND** a wallet has `status = 'suspended'` and `suspended_at < NOW() - INTERVAL '90 days'`
- **AND** the wallet's on-chain native balance is below 1000 wei (dust)
- **THEN** the gateway SHALL call AWS `kms:ScheduleKeyDeletion` with the minimum 7-day window
- **AND** mark the wallet `status = 'deleted'`, `deleted_at = NOW()`
- **AND** clear the `kms_key_id` field on the row (preserve everything else for audit)
- **AND** SHALL NOT delete or modify any historical `contract_calls` rows that reference this wallet

#### Scenario: Day-90 deletion, balance + recovery address (auto-drain rescue)

- **WHEN** the daily rent-billing job processes a 90-day-suspended wallet with on-chain balance > dust
- **AND** `recovery_address` is set on the wallet
- **THEN** the gateway SHALL build, sign (via KMS), and broadcast a drain transaction sending `(balance - estimated_gas_cost)` to the recovery address
- **AND** record the drain as a normal `contract_call` row with `function_name = "<auto_drain_pre_deletion>"`
- **AND** wait for the drain transaction to confirm (or fail) before proceeding to deletion (the deletion is idempotent and will be retried by the daily job until the drain resolves)
- **AND** once the drain is confirmed, schedule key deletion as in the dust scenario above
- **AND** send a notification email to the project's billing email: "Wallet 0x... was auto-drained to recovery address 0x... and deleted after 90 days of suspension. Tx: 0x..."

#### Scenario: Day-90 deletion, balance but no recovery address (warned then deleted)

- **WHEN** the daily rent-billing job processes a 90-day-suspended wallet with on-chain balance > dust
- **AND** `recovery_address` is NOT set
- **THEN** the gateway SHALL still proceed with deletion as in the dust scenario
- **AND** send a final notification email to the project's billing email: "Wallet 0x... has been deleted after 90 days of suspension. The wallet held <balance> ETH at deletion time. Because no recovery address was set, the funds at this address are permanently inaccessible. The on-chain address still exists but no key exists to sign for it."

#### Scenario: Warning emails before day-90

- **WHEN** the daily rent-billing job processes a suspended wallet with on-chain balance > dust
- **AND** `suspended_at` is exactly 60, 75, or 88 days ago (any one of these — fired once each)
- **THEN** the gateway SHALL send a warning email to the project's billing email with subject "URGENT: Your run402 contract wallet will be deleted in N days" (N = 30, 15, or 2)
- **AND** the email body SHALL include: wallet address, current balance in ETH and USD, suspended_at date, deletion date, recovery options (top up cash to reactivate, drain via API, set a recovery address)
- **AND** the gateway SHALL track which warnings have been sent (e.g., `warnings_sent` JSONB column or `last_warning_day` integer) to avoid duplicate warnings

#### Scenario: Reactivation cancels all warnings

- **WHEN** a suspended wallet is reactivated by a top-up
- **THEN** the gateway SHALL clear any pending-warning state
- **AND** if the wallet later suspends again, the warning schedule SHALL restart from the new `suspended_at`

#### Scenario: Deleted wallet rejects all operations

- **WHEN** any `POST /contracts/v1/call` or `POST /contracts/v1/wallets/:id/...` is called against a `deleted` wallet
- **THEN** the gateway SHALL return HTTP 410 (Gone) with `{ "error": "wallet_deleted", "deleted_at" }`
- **AND** SHALL NOT attempt any KMS operation

#### Scenario: Deleted wallet remains visible for audit

- **WHEN** `GET /contracts/v1/wallets/:id` or `GET /contracts/v1/wallets` is called
- **THEN** deleted wallets SHALL still appear in the response with `status: "deleted"`, `deleted_at`, `address` (the on-chain address is permanent), and `kms_key_id: null`
- **AND** historical `GET /contracts/v1/calls/:id` lookups SHALL continue to return full call records for any call ever submitted from a now-deleted wallet

#### Scenario: No free archive

- **WHEN** any user, admin, or automated process attempts to "pause without billing" or "archive" a wallet
- **THEN** there SHALL BE NO API endpoint, CLI command, or admin operation that accomplishes this
- **AND** the only ways a wallet stops accruing rent are: top-up cash never runs out (active), or it transitions to deleted (permanent)
- **NOTE:** This is intentional — AWS KMS bills run402 $1/month/key forever for any KMS key, so a "free archive" would have run402 paying for abandoned wallets indefinitely.

### Requirement: Wallet drain (recover on-chain funds)

The gateway SHALL allow projects to drain a wallet's entire native-token balance to an external address, regardless of suspension status.

#### Scenario: Drain an active wallet

- **WHEN** `POST /contracts/v1/wallets/:id/drain` is called with body `{ destination_address }` and header `X-Confirm-Drain: <wallet_id>`
- **AND** the wallet is `active`
- **AND** the destination address is a valid 0x-prefixed 40-hex-char address
- **THEN** the gateway SHALL fetch the wallet's current native-token balance from RPC
- **AND** estimate gas for a simple value transfer (typically 21000 gas)
- **AND** build a transaction sending `(balance - estimated_gas_cost)` wei to the destination
- **AND** sign via KMS, broadcast, and record the call as a normal `contract_call` row with `function_name = "<drain>"` and a `kms_sign_fee` ledger entry
- **AND** return `{ call_id, tx_hash, drained_wei, destination_address, status: "pending" }`

#### Scenario: Drain a suspended wallet (the safety valve)

- **WHEN** `POST /contracts/v1/wallets/:id/drain` is called against a wallet with `status = 'suspended'`
- **THEN** the gateway SHALL allow the operation regardless of the project's USD cash balance
- **AND** SHALL still record the `kms_sign_fee` ledger entry, even if it pushes the project's cash balance to a negative number internally — the entry is recorded for audit, but suspension blocks future contract calls anyway
- **NOTE:** This is intentional. A project that runs out of cash credit must still be able to recover its on-chain funds. Otherwise the cash-credit suspension becomes a fund-loss vector, which is the worst possible outcome.

#### Scenario: Drain refused if no on-chain balance

- **WHEN** `POST /contracts/v1/wallets/:id/drain` is called
- **AND** the wallet's native-token balance is below 1000 wei (dust) OR below the estimated gas cost
- **THEN** the gateway SHALL return HTTP 409 with `{ "error": "nothing_to_drain", "balance_wei", "estimated_gas_cost_wei" }`
- **AND** SHALL NOT broadcast any transaction

#### Scenario: Drain refused without confirmation header

- **WHEN** `POST /contracts/v1/wallets/:id/drain` is called without `X-Confirm-Drain: <wallet_id>` (or with a wrong value)
- **THEN** the gateway SHALL return HTTP 400 with `{ "error": "drain_confirmation_required", "expected_header": "X-Confirm-Drain: <wallet_id>" }`

#### Scenario: Invalid destination address

- **WHEN** `POST /contracts/v1/wallets/:id/drain` is called with a malformed `destination_address`
- **THEN** the gateway SHALL return HTTP 400 with `{ "error": "invalid_destination_address" }`
- **AND** SHALL NOT broadcast any transaction

#### Scenario: Drain on a deleted wallet

- **WHEN** `POST /contracts/v1/wallets/:id/drain` is called against a `deleted` wallet
- **THEN** the gateway SHALL return HTTP 410 (Gone) — there is no key to sign with

### Requirement: Recovery address

The gateway SHALL allow projects to set an optional recovery address per wallet, to which the 90-day deletion job will auto-drain on-chain balance before scheduling key deletion.

#### Scenario: Set recovery address at creation

- **WHEN** `POST /contracts/v1/wallets` is called with `{ chain, recovery_address }` (recovery address optional)
- **AND** `recovery_address` is a valid 0x-prefixed 40-hex address
- **THEN** the gateway SHALL store it on the new `contract_wallets` row
- **AND** include it in the response

#### Scenario: Set or update recovery address later

- **WHEN** `POST /contracts/v1/wallets/:id/recovery-address` is called with `{ recovery_address }` (or `{ recovery_address: null }` to clear)
- **AND** the wallet is in `active` or `suspended` status (NOT `deleted`)
- **THEN** the gateway SHALL update the `recovery_address` field
- **AND** return the updated wallet
- **NOTE:** This works on suspended wallets so a user who is about to lose a wallet can set a recovery address as a last-minute rescue.

#### Scenario: Recovery address must be different from wallet address

- **WHEN** `POST /contracts/v1/wallets/:id/recovery-address` is called with `recovery_address` equal to the wallet's own address
- **THEN** the gateway SHALL return HTTP 400 with `{ "error": "recovery_address_self_reference" }`

### Requirement: User-initiated wallet deletion

The gateway SHALL allow project owners to explicitly delete a wallet before the 90-day grace period.

#### Scenario: Confirmed delete

- **WHEN** `DELETE /contracts/v1/wallets/:id` is called with header `X-Confirm-Delete: <wallet_id>` (the header value must equal the wallet's ID)
- **AND** the wallet's native-token (ETH) balance is zero or below dust (< 1000 wei)
- **THEN** the gateway SHALL call AWS `kms:ScheduleKeyDeletion` with the minimum 7-day window
- **AND** mark the wallet `status = 'deleted'`, `deleted_at = NOW()`, clear `kms_key_id`
- **AND** return `{ id, status: "deleted", deleted_at, kms_deletion_completes_at }`

#### Scenario: Refuse delete with on-chain balance

- **WHEN** `DELETE /contracts/v1/wallets/:id` is called
- **AND** the wallet's native-token balance is at or above 1000 wei
- **THEN** the gateway SHALL return HTTP 409 with `{ "error": "wallet_has_funds", "address", "native_balance_wei", "instructions": "Drain the wallet on-chain before deleting. The on-chain balance is yours; we cannot recover it after deletion." }`

#### Scenario: Missing confirmation header

- **WHEN** `DELETE /contracts/v1/wallets/:id` is called without `X-Confirm-Delete` matching the wallet ID
- **THEN** the gateway SHALL return HTTP 400 with `{ "error": "delete_confirmation_required", "expected_header": "X-Confirm-Delete: <wallet_id>" }`

### Requirement: Wallet inspection

The gateway SHALL allow projects to read wallet metadata and balance.

#### Scenario: Get wallet by id

- **WHEN** `GET /contracts/v1/wallets/:id` is called with a valid project API key
- **THEN** the gateway SHALL return `{ id, project_id, chain, address, status, native_balance_wei, native_balance_usd_micros, low_balance_threshold_wei, last_rent_debited_on, suspended_at, deleted_at, created_at }`
- **AND** `native_balance_wei` SHALL be fetched live from the chain RPC at request time (skipped for `deleted` wallets — returns the last known value or `null`)
- **AND** `native_balance_usd_micros` SHALL be computed from a recent (≤5 min cached) ETH→USD price read via Chainlink price feed

#### Scenario: List wallets

- **WHEN** `GET /contracts/v1/wallets` is called
- **THEN** the gateway SHALL return all wallets owned by the calling project, with the same shape as single-wallet GET

#### Scenario: Wrong project

- **WHEN** project A's API key calls `GET /contracts/v1/wallets/:id` with a wallet ID owned by project B
- **THEN** the gateway SHALL return HTTP 404 (not 403, to avoid leaking existence)

### Requirement: Generic contract write call

The gateway SHALL allow projects to invoke arbitrary contract write functions from their KMS wallets.

#### Scenario: Submit a write call

- **WHEN** `POST /contracts/v1/call` is called with body `{ wallet_id, contract_address, abi_fragment, function_name, args, value? }`
- **AND** the wallet belongs to the calling project
- **THEN** the gateway SHALL build the transaction using the supplied ABI fragment and args
- **AND** sign it via KMS (the message hash is signed inside KMS; the gateway never sees the private key)
- **AND** broadcast it to the chain's RPC
- **AND** insert a row into `internal.contract_calls` with status `pending` and the tx hash
- **AND** return `{ call_id, tx_hash, status: "pending" }` with HTTP 202

#### Scenario: Insufficient native balance

- **WHEN** the wallet's native balance is less than the estimated gas cost + `value`
- **THEN** the gateway SHALL NOT broadcast the transaction
- **AND** SHALL return HTTP 402 with `{ "error": "insufficient_native_balance", "required_wei", "available_wei" }`

#### Scenario: Idempotency

- **WHEN** `POST /contracts/v1/call` is called with header `Idempotency-Key: <key>`
- **AND** a previous call from the same project used the same key
- **THEN** the gateway SHALL return the existing call record (same `call_id`, same `tx_hash`)
- **AND** SHALL NOT broadcast a second transaction

#### Scenario: Idempotency key collision across projects

- **WHEN** project A and project B both use `Idempotency-Key: foo` for different calls
- **THEN** the gateway SHALL treat them as independent — the unique constraint is `(project_id, idempotency_key)`, not `idempotency_key` alone

#### Scenario: Invalid ABI fragment

- **WHEN** the supplied `abi_fragment` cannot be parsed, or `function_name` is not present in it
- **THEN** the gateway SHALL return HTTP 400 with `{ "error": "invalid_abi" }`
- **AND** SHALL NOT charge gas (no broadcast attempted)

#### Scenario: RPC broadcast failure

- **WHEN** the chain RPC rejects the signed transaction (e.g., nonce too low, gas too low, revert in simulation)
- **THEN** the gateway SHALL insert the call row with status `failed`
- **AND** SHALL return HTTP 502 with `{ call_id, status: "failed", error: <RPC error message> }`
- **AND** the project SHALL NOT be billed for gas (no on-chain consumption)

### Requirement: Generic contract read call

The gateway SHALL allow projects to invoke contract view/pure functions without signing.

#### Scenario: Submit a read call

- **WHEN** `POST /contracts/v1/read` is called with `{ chain, contract_address, abi_fragment, function_name, args }`
- **THEN** the gateway SHALL execute the call via RPC `eth_call`
- **AND** return `{ result: <decoded return value> }`
- **AND** SHALL NOT touch KMS, SHALL NOT bill gas, SHALL NOT write to `contract_calls`

#### Scenario: Read on unsupported chain

- **WHEN** the supplied `chain` is not in the static registry
- **THEN** the gateway SHALL return HTTP 400 with `{ "error": "unsupported_chain" }`

### Requirement: Call status and receipts

The gateway SHALL allow projects to look up call lifecycle state and receipts.

#### Scenario: Get pending call

- **WHEN** `GET /contracts/v1/calls/:id` is called shortly after submission
- **AND** the chain has not yet confirmed the transaction
- **THEN** the gateway SHALL return `{ id, status: "pending", tx_hash, ... }`

#### Scenario: Get confirmed call

- **WHEN** the transaction has been confirmed
- **THEN** the gateway SHALL return `{ id, status: "confirmed", tx_hash, block_number, gas_used_wei, gas_cost_usd_micros, receipt }`
- **AND** the gateway SHALL have written a `contract_call_gas` ledger entry for the project (negative `amount_usd_micros`) at confirmation time

#### Scenario: Get failed call

- **WHEN** the transaction reverted on-chain
- **THEN** the gateway SHALL return `{ id, status: "failed", tx_hash, block_number, gas_used_wei, gas_cost_usd_micros, error, receipt }`
- **AND** the gateway SHALL still write a `contract_call_gas` ledger entry (failed reverts still consume gas)

#### Scenario: Wrong project

- **WHEN** project A calls `GET /contracts/v1/calls/:id` with a call ID owned by project B
- **THEN** the gateway SHALL return HTTP 404

#### Scenario: Status polling

- **WHEN** a call is in `pending` status
- **THEN** the gateway SHALL run a background reconciliation job that polls the chain RPC for the receipt
- **AND** SHALL update the call row to `confirmed` or `failed` within 60 seconds of receipt availability
- **AND** the reconciliation job SHALL be idempotent (safe to run repeatedly, on multiple instances)

### Requirement: Gas accounting and KMS sign fee

Every confirmed or failed contract call SHALL bill the project for two things separately: the at-cost ETH gas cost, and the run402 KMS sign fee markup.

#### Scenario: Gas cost recorded at confirmation (at-cost)

- **WHEN** a call transitions from `pending` to `confirmed` (or `failed`)
- **THEN** the gateway SHALL multiply `gas_used_wei` by `effective_gas_price_wei` to get total wei spent
- **AND** convert to USD-micros using the cached ETH→USD price (≤5 min old, sourced from Chainlink ETH/USD price feed)
- **AND** insert a billing ledger entry with `kind = "contract_call_gas"`, `amount_usd_micros = -<computed>`, and `metadata = { call_id, tx_hash, chain, gas_used_wei, gas_price_wei, eth_usd_price_used }`

#### Scenario: KMS sign fee recorded alongside gas

- **WHEN** a call transitions from `pending` to `confirmed` (or `failed`)
- **THEN** the gateway SHALL ALSO insert a second billing ledger entry with `kind = "kms_sign_fee"`, `amount_usd_micros = -5` (5 USD-micros = $0.000005), and `metadata = { call_id }`
- **AND** both ledger entries SHALL be inserted in the same transaction as the call status update

#### Scenario: Gas is at-cost, sign fee is the only markup

- **WHEN** computing the gas USD-micros amount
- **THEN** the gateway SHALL NOT apply any markup, fee, or rounding-up to gas itself
- **AND** the documented run402 fee on chain gas SHALL be **0%**
- **AND** the run402 markup on contract calls SHALL come exclusively from the `kms_sign_fee` ledger entry ($0.000005/call), which is visible to users on their billing history

### Requirement: Low-balance alerts

The gateway SHALL notify projects when a wallet's native-token balance falls below a configurable threshold.

#### Scenario: Set threshold

- **WHEN** `POST /contracts/v1/wallets/:id/alert` is called with `{ threshold_wei }`
- **THEN** the gateway SHALL update `low_balance_threshold_wei` on the wallet row
- **AND** return `{ id, low_balance_threshold_wei }`

#### Scenario: Threshold default

- **WHEN** a wallet is created without an explicit threshold
- **THEN** the default SHALL be `enough wei for ~100 transactions at 1 gwei × 100k gas` (i.e., `0.00001 ETH × 100 = 0.001 ETH = 10^15 wei` — exact value resolved in design.md)

#### Scenario: Threshold crossed

- **WHEN** the background balance-check job (runs every 10 minutes) detects that a wallet's balance has fallen below its threshold
- **AND** the project's billing account has a verified email address
- **THEN** the gateway SHALL send a low-balance alert email to that address (via the existing email-send service)
- **AND** SHALL set a `last_alert_sent_at` timestamp on the wallet row to suppress further alerts for 24 hours

#### Scenario: No re-alert spam

- **WHEN** a wallet has already been alerted within the last 24 hours
- **THEN** the gateway SHALL NOT send another alert until 24 hours have passed since `last_alert_sent_at`

### Requirement: Chain registry

The gateway SHALL maintain a static configuration of supported chains.

#### Scenario: Initial chain set

- **WHEN** the gateway boots
- **THEN** the chain registry SHALL contain at minimum `base-mainnet` with `{ chain_id: 8453, rpc_url: <from secret>, native_token: "ETH", block_explorer: "https://basescan.org" }`

#### Scenario: Adding a chain

- **WHEN** a new chain is added to the static registry and the gateway is redeployed
- **THEN** new wallets MAY be provisioned on it
- **AND** existing wallets on other chains SHALL be unaffected
- **AND** no database migration SHALL be required

#### Scenario: Chain in use cannot be silently removed

- **WHEN** a chain is removed from the static registry
- **AND** any wallet still references it
- **THEN** the gateway SHALL refuse to boot (fail-fast) with an error naming the orphaned chain

### Requirement: Audit trail

Every contract call SHALL be auditable after the fact.

#### Scenario: Calls table is append-only from the API

- **WHEN** any non-admin API operation is performed
- **THEN** the gateway SHALL NOT delete or modify rows in `internal.contract_calls` (other than the lifecycle fields: `status`, `gas_used_wei`, `gas_cost_usd_micros`, `receipt_json`, `error`, `updated_at`)
- **AND** the original submission fields (`wallet_id`, `contract_address`, `function_name`, `args_json`, `idempotency_key`, `tx_hash`, `created_at`) SHALL be immutable

#### Scenario: Admin can list all calls for a project

- **WHEN** an admin operator queries the admin API for `contract_calls?project_id=...`
- **THEN** they SHALL receive every call ever submitted by that project, including failed and pending ones

### Requirement: MCP, CLI, and OpenClaw surfaces

Every new gateway endpoint SHALL be reachable via the `run402-mcp` MCP server, the `run402` CLI, and the OpenClaw shim layer.

#### Scenario: MCP tools published

- **WHEN** the `run402-mcp` package is installed at the latest version
- **THEN** it SHALL expose the tools `provision_contract_wallet`, `get_contract_wallet`, `list_contract_wallets`, `contract_call`, `contract_read`, `get_contract_call_status`, and `set_low_balance_alert`
- **AND** each tool SHALL be listed in `run402-mcp`'s `--list-tools` output

#### Scenario: CLI subcommands published

- **WHEN** the `run402` CLI is installed at the latest version
- **THEN** `run402 contracts --help` SHALL list at minimum: `provision-wallet`, `get-wallet`, `list-wallets`, `call`, `read`, `status`, `set-alert`
- **AND** each subcommand SHALL be invocable end-to-end against `https://api.run402.com`

#### Scenario: OpenClaw parity

- **WHEN** the `sync.test.ts` test runs in `run402-mcp`
- **THEN** it SHALL pass — meaning every MCP tool has a matching CLI command and a matching OpenClaw shim with consistent argument names

### Requirement: Non-custodial relationship (no fiduciary duty)

The KMS wallet feature is non-custodial. run402 SHALL NOT represent itself as a custodian, escrow, or fiduciary holder of user funds. Marketing copy, terms of service, billing pages, error messages, API responses, and support communications SHALL NOT use language that implies otherwise. The drain endpoint and recovery address are OPTIONAL safety nets provided as a convenience, not guarantees.

#### Scenario: Terms of service explicit disclaimer

- **WHEN** a fresh user reads `https://run402.com/humans/terms.html`
- **THEN** the document SHALL contain a section titled "KMS contract wallets are non-custodial" stating, verbatim or paraphrased, that:
  - run402 provides KMS-backed signing infrastructure, not fund custody
  - the user is solely responsible for managing the on-chain native-token (ETH) balance of their wallets
  - run402 has no obligation to recover, refund, or compensate for funds lost due to wallet suspension or deletion
  - the drain endpoint and recovery address features are OPTIONAL safety nets provided as a convenience, not guarantees
  - if the user does not pay rent, drain the wallet, or set a recovery address before the 90-day suspension grace period ends, on-chain funds at the wallet address become permanently inaccessible to anyone, including run402

#### Scenario: Billing page non-custodial notice

- **WHEN** a fresh user reads `https://run402.com/billing/`
- **THEN** the KMS contract wallet section SHALL include a clearly visible "Non-custodial: you are responsible for your funds" notice
- **AND** the notice SHALL link to the relevant section of the terms of service

#### Scenario: Warning email language (days 60/75/88)

- **WHEN** any of the 60/75/88-day warning emails is sent
- **THEN** the body SHALL contain (verbatim or paraphrased): "run402 does not hold funds on your behalf. If you do not take action (top up cash, drain the wallet, or set a recovery address) before <deletion_date>, the on-chain funds at this address will become permanently inaccessible to anyone, including run402."

#### Scenario: Final fund-loss email language (day 90, no recovery)

- **WHEN** the final fund-loss email is sent (90-day deletion of a wallet with balance > dust and no recovery address)
- **THEN** the body SHALL contain (verbatim or paraphrased): "These funds cannot be recovered by run402, AWS, or any third party. The cryptographic key that controlled this address has been destroyed. run402 is not a custodian and has no obligation to compensate for this loss. You were notified on day 60, day 75, and day 88 of suspension."

#### Scenario: Provisioning response includes non-custodial notice field

- **WHEN** `POST /contracts/v1/wallets` succeeds
- **THEN** the response body SHALL include a top-level field `non_custodial_notice` containing a string equal to (or paraphrased from): "This wallet is non-custodial. You are responsible for funding ETH for gas, paying daily rent in cash credit, and either draining or setting a recovery address before suspension reaches 90 days. run402 will not recover funds from a deleted wallet."
- **AND** this field SHALL be present in the response of every wallet-creating call, regardless of whether the caller is a human, an agent, or a CLI

#### Scenario: Suspension HTTP 402 error includes non-custodial reminder

- **WHEN** any endpoint returns HTTP 402 due to a suspended wallet (e.g., `POST /contracts/v1/call` against a suspended wallet)
- **THEN** the error response body SHALL include a `non_custodial_notice` field reminding the caller that run402 is not holding their funds and that the wallet will be deleted after 90 days of continuous suspension

#### Scenario: Marketing copy audit

- **WHEN** the implementer searches `site/`, `docs/`, `README.md`, and any marketing surface for words that imply custody or guarantee (`safekeep`, `custody`, `escrow`, `safe with us`, `your funds are secure`, `we hold`, `we protect`)
- **THEN** every match SHALL either be removed, rephrased to non-custodial language, or scoped to something that is genuinely under run402 control (e.g., USD cash credit balance, which IS held by run402; KMS keys, which ARE managed by run402)
- **AND** the audit result SHALL be documented in the implementation log

### Requirement: Pricing disclosed on every public pricing surface

The KMS wallet rental and KMS sign fee SHALL appear, with exact values, on **every** run402 surface that mentions pricing today. Adding a new pricing line item requires updating every existing pricing surface — there is no exception, no "we'll do it next sprint", no "the docs will catch up later." If a fresh user can find a pricing list anywhere on the public site or in any public document and the new fees are missing from it, the change is incomplete.

#### Scenario: Marketing site billing page

- **WHEN** a fresh user visits `https://run402.com/billing/`
- **THEN** the page SHALL list, alongside the existing tier prices ($0.10 prototype / $5 hobby / $20 team) and email pack price ($5 for 10,000 emails):
  - `KMS contract wallets: $0.04/day per wallet ($1.20/month), 30 days prepaid required at creation`
  - `Contract calls: chain gas at-cost + $0.000005 per call (KMS sign fee)`
- **AND** the page SHALL explain the suspension and 90-day deletion lifecycle in plain language
- **AND** the page SHALL link to the funds-rescue mechanisms (drain endpoint, recovery address)

#### Scenario: Marketing site landing page

- **WHEN** a fresh user visits `https://run402.com/`
- **AND** the landing page lists or summarizes pricing in any form (tier names, prices, "starting at $X")
- **THEN** if KMS wallets are mentioned at all, the rental and sign fee SHALL be disclosed inline or via a clear link to the billing page

#### Scenario: Marketing site humans pages (terms, faq, etc.)

- **WHEN** a fresh user visits any page under `https://run402.com/humans/` that discusses pricing, fees, or billing (including `terms.html`, `faq.html`, `index.html`)
- **AND** the page enumerates the run402 fee structure
- **THEN** the KMS rental and sign fee SHALL appear in that enumeration

#### Scenario: llms.txt updated

- **WHEN** a fresh user fetches `https://run402.com/llms.txt`
- **THEN** the file SHALL include a section describing KMS wallet pricing (`$0.04/day rental + $0.000005/call sign fee`) alongside the existing tier and email-pack pricing entries
- **AND** the section SHALL include the 30-day prepay creation gate, the suspension model, and the funds-rescue mechanisms in machine-readable form

#### Scenario: llms-cli.txt updated

- **WHEN** a fresh user fetches `https://run402.com/llms-cli.txt`
- **THEN** the file SHALL include a `## run402 contracts` section listing every CLI subcommand with pricing notes inline (e.g., `provision-wallet — creates a KMS wallet ($0.04/day rental, requires $1.20 in cash credit at creation)`)

#### Scenario: llms-full.txt updated

- **WHEN** a fresh user fetches `https://run402.com/llms-full.txt`
- **THEN** the long-form documentation SHALL include the full KMS pricing model and lifecycle as part of its pricing/billing section

#### Scenario: openapi.json updated

- **WHEN** a fresh user fetches `https://run402.com/openapi.json`
- **THEN** every new `/contracts/v1/...` path SHALL be present
- **AND** the description fields for `POST /contracts/v1/wallets` and `POST /contracts/v1/call` SHALL include the pricing in plain text (e.g., `"description": "Provision a KMS-backed Ethereum wallet. Cost: $0.04/day rental ($1.20/month). Requires $1.20 in cash balance at creation. ..."`)

#### Scenario: updates.txt and changelog updated

- **WHEN** the change is shipped
- **THEN** `https://run402.com/updates.txt` SHALL gain an entry describing the new feature **with prices stated**
- **AND** `https://run402.com/humans/changelog.html` SHALL gain an entry describing the new feature **with prices stated**

#### Scenario: AGENTS.md tool table updated

- **WHEN** an agent reads `AGENTS.md` in the run402 repo
- **THEN** the new MCP tools SHALL appear in the tool table (already required by Requirement: MCP, CLI, and OpenClaw surfaces)
- **AND** the description column SHALL note the pricing for tools that incur cost (`provision_contract_wallet`, `contract_call`, `drain_contract_wallet`)

#### Scenario: kysigned spec cross-reference

- **WHEN** the kysigned spec mentions "wallet custody / KMS key management" as a run402 cost line item
- **THEN** that line SHALL be updated (in `docs/products/kysigned/kysigned-spec.md`) to reference the actual price (`$0.04/day per wallet, plus $0.000005 per signature call`) so kysigned's cost model reflects reality
- **NOTE:** This is a cross-document update — the `kms-wallet-contracts` plan owns it because it's introducing the price the kysigned spec needs to cite.

#### Scenario: Pricing appears nowhere else

- **WHEN** the implementer searches the repo for any other pricing-mentioning file (e.g., `docs/ideas.md`, `site/use-cases/**`, `site/agencies/**`, `site/freelance/**`, `site/zh-cn/**` and other localized variants, `README.md`, marketing copy)
- **AND** finds a file that lists run402 fees, even partially
- **THEN** that file SHALL also be updated to include the new KMS pricing
- **NOTE:** The plan's "Ship & Verify" phase MUST include a grep audit step that searches the entire repo for pricing keywords (`$0.10`, `$5`, `$20`, `email pack`, `tier price`, etc.) and verifies every match either contains the new KMS pricing or is irrelevant (e.g., a test fixture). The implementer's checklist is: "if a price is mentioned, all prices are mentioned."

### Requirement: Documentation surfaces

Every new endpoint SHALL be documented in the public docs surfaces.

#### Scenario: llms.txt updated

- **WHEN** a fresh user fetches `https://run402.com/llms.txt`
- **THEN** the response SHALL contain entries for all `/contracts/v1/...` endpoints with method, path, and one-line description

#### Scenario: llms-cli.txt updated

- **WHEN** a fresh user fetches `https://run402.com/llms-cli.txt`
- **THEN** the response SHALL contain a `## run402 contracts` section listing every CLI subcommand with usage and examples

#### Scenario: openapi.json updated

- **WHEN** a fresh user fetches `https://run402.com/openapi.json`
- **THEN** the document SHALL include path entries for `/contracts/v1/wallets`, `/contracts/v1/wallets/{id}`, `/contracts/v1/wallets/{id}/alert`, `/contracts/v1/call`, `/contracts/v1/read`, and `/contracts/v1/calls/{id}`
- **AND** each entry SHALL have request/response schemas matching the gateway's actual behavior

### Requirement: Backward compatibility

This change SHALL NOT modify or break any existing run402 behavior.

#### Scenario: No existing endpoint changed

- **WHEN** the change is deployed
- **THEN** every endpoint outside `/contracts/v1/...` SHALL continue to behave exactly as before
- **AND** the existing E2E test suites (`test:e2e`, `test:bld402-compat`, `test:openclaw`, `test:functions`, `test:ai`, `test:billing`, `test:email`) SHALL continue to pass without modification
