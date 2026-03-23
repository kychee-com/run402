## ADDED Requirements

### Requirement: x402 network selection based on on-chain balance
The `setupPaidFetch()` function SHALL check USDC balance on Base mainnet and Base Sepolia in parallel before creating the x402 client. It SHALL register an x402 policy that filters payment requirements to only networks where the wallet has a non-zero balance.

#### Scenario: Wallet funded on sepolia only (faucet-funded testnet wallet)
- **WHEN** the wallet has 0 USDC on Base mainnet and 250000 micros on Base Sepolia
- **THEN** the x402 policy filters `accepts[]` to only `eip155:84532` (Base Sepolia)
- **AND** the payment is signed and settled on Base Sepolia

#### Scenario: Wallet funded on mainnet only (production wallet)
- **WHEN** the wallet has 500000 micros on Base mainnet and 0 on Base Sepolia
- **THEN** the x402 policy filters `accepts[]` to only `eip155:8453` (Base mainnet)

#### Scenario: Wallet funded on both networks
- **WHEN** the wallet has balance on both Base mainnet and Base Sepolia
- **THEN** the x402 policy keeps both networks in `accepts[]`
- **AND** the default x402 selector picks from the available options

#### Scenario: Endpoint only supports one network
- **WHEN** the server's `accepts[]` contains only `eip155:84532` and the wallet has balance on that network
- **THEN** the payment proceeds on `eip155:84532`

### Requirement: MPP network selection based on on-chain balance
The `setupPaidFetch()` function SHALL check pathUSD balance on Tempo mainnet and Tempo Moderato (testnet) in parallel before creating the mppx client. It SHALL configure mppx with the funded network.

#### Scenario: Wallet funded on Tempo Moderato only
- **WHEN** the wallet has 0 pathUSD on Tempo mainnet and non-zero pathUSD on Tempo Moderato
- **THEN** mppx is configured with the Tempo Moderato chain

#### Scenario: Wallet funded on both Tempo networks
- **WHEN** the wallet has pathUSD on both Tempo mainnet and Tempo Moderato
- **THEN** mppx is configured with both networks available

### Requirement: Fail fast when no network has funds
The `setupPaidFetch()` function SHALL throw an error with an actionable message when no supported network has a non-zero balance, for both x402 and MPP rails.

#### Scenario: x402 wallet with zero balance everywhere
- **WHEN** the wallet has 0 USDC on both Base mainnet and Base Sepolia
- **THEN** `setupPaidFetch()` throws an error containing the balance on each network and guidance to fund the wallet or request the faucet

#### Scenario: MPP wallet with zero balance everywhere
- **WHEN** the wallet has 0 pathUSD on both Tempo mainnet and Tempo Moderato
- **THEN** `setupPaidFetch()` throws an error containing the balance on each network and guidance to fund the wallet

### Requirement: Single setupPaidFetch for all CLI commands
All CLI commands that make paid API calls SHALL use the shared `setupPaidFetch()` from `cli/lib/paid-fetch.mjs`. No command SHALL define its own local payment setup.

#### Scenario: functions deploy uses shared setupPaidFetch
- **WHEN** `cli/lib/functions.mjs` makes a paid API call
- **THEN** it imports and calls `setupPaidFetch()` from `cli/lib/paid-fetch.mjs`
- **AND** no local `setupPaidFetch` function exists in `cli/lib/functions.mjs`

### Requirement: MCP server uses balance-aware network selection
The MCP server's `src/paid-fetch.ts` SHALL apply the same balance-aware network selection logic as the CLI.

#### Scenario: MCP paid fetch selects funded network
- **WHEN** `paidApiRequest()` is called and the wallet has funds only on Base Sepolia
- **THEN** the x402 payment is signed and sent on Base Sepolia
