## ADDED Requirements

### Requirement: Init tool creates allowance if none exists
The `init` MCP tool SHALL create a new agent allowance (private key + derived Ethereum address) and save it to `allowance.json` when no allowance file exists. The allowance SHALL be saved with `funded: false` and the specified rail (defaulting to `x402`).

#### Scenario: No existing allowance
- **WHEN** `init` is called and no `allowance.json` exists
- **THEN** a new allowance is created with a random private key, the derived address, `created` timestamp, `funded: false`, and `rail` set to the requested rail
- **THEN** the allowance is saved to `~/.config/run402/allowance.json` with mode 0600

#### Scenario: Allowance already exists
- **WHEN** `init` is called and `allowance.json` already exists
- **THEN** the existing allowance is used without modification (unless rail switching applies)

### Requirement: Init tool requests faucet when unfunded
The `init` tool SHALL request faucet funding when the allowance is not yet funded. For `x402` rail, it SHALL call `POST /faucet/v1`. For `mpp` rail, it SHALL call the Tempo RPC `tempo_fundAddress` method.

#### Scenario: Unfunded x402 allowance
- **WHEN** `init` is called with an unfunded allowance on `x402` rail
- **THEN** the tool calls `POST /faucet/v1` with the allowance address
- **THEN** on success, the allowance is updated with `funded: true` and `lastFaucet` timestamp

#### Scenario: Unfunded mpp allowance
- **WHEN** `init` is called with an unfunded allowance on `mpp` rail
- **THEN** the tool calls the Tempo RPC faucet with `tempo_fundAddress`
- **THEN** on success, the allowance is updated with `funded: true` and `lastFaucet` timestamp

#### Scenario: Already funded allowance
- **WHEN** `init` is called with a funded allowance
- **THEN** the faucet step is skipped

#### Scenario: Faucet request fails
- **WHEN** the faucet API returns an error
- **THEN** the tool continues (non-fatal) and reports the faucet error in the summary

### Requirement: Init tool checks tier status
The `init` tool SHALL check the current tier subscription via `GET /tiers/v1/status` using allowance auth headers. The tier info SHALL be included in the summary.

#### Scenario: Active tier exists
- **WHEN** the tier API returns an active tier
- **THEN** the summary includes the tier name and expiry date

#### Scenario: No active tier
- **WHEN** the tier API returns no tier or the call fails
- **THEN** the summary reports no active tier and suggests subscribing

### Requirement: Init tool reports project count
The `init` tool SHALL read the local keystore and report the number of projects.

#### Scenario: Projects exist in keystore
- **WHEN** the keystore contains projects
- **THEN** the summary reports the project count

#### Scenario: Empty keystore
- **WHEN** the keystore is empty or missing
- **THEN** the summary reports 0 projects

### Requirement: Init tool supports rail parameter
The `init` tool SHALL accept an optional `rail` parameter with values `"x402"` (default) or `"mpp"`. If the stored allowance has a different rail, the tool SHALL update it.

#### Scenario: Switch from x402 to mpp
- **WHEN** `init` is called with `rail: "mpp"` and the stored allowance has `rail: "x402"`
- **THEN** the allowance `rail` field is updated to `"mpp"` and saved

#### Scenario: Default rail
- **WHEN** `init` is called without a `rail` parameter
- **THEN** the rail defaults to `"x402"`

### Requirement: Init tool returns markdown summary
The `init` tool SHALL return a single markdown text response with a table summarizing: config directory, allowance address, network, rail, balance/faucet status, tier status, project count, and a next-step suggestion.

#### Scenario: Full summary returned
- **WHEN** `init` completes all steps
- **THEN** the response contains `{ content: [{type: "text", text: <markdown>}] }` with all status fields

### Requirement: Init tool is idempotent
The `init` tool SHALL be safe to call multiple times. Repeated calls SHALL not create duplicate allowances, re-request already-funded faucets, or corrupt state.

#### Scenario: Second call after successful init
- **WHEN** `init` is called after a previous successful `init`
- **THEN** existing allowance is reused, faucet is skipped (already funded), tier and projects are re-checked, and a fresh summary is returned

### Requirement: Sync test updated
The SURFACE entry for `init` in `sync.test.ts` SHALL have `mcp: "init"` instead of `mcp: null`.

#### Scenario: Sync test passes
- **WHEN** `npm run test:sync` is executed
- **THEN** the `init` capability passes with MCP tool name `"init"`
