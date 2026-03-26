## ADDED Requirements

### Requirement: RUN402_ALLOWANCE_PATH env var overrides default allowance path
When the `RUN402_ALLOWANCE_PATH` environment variable is set, `getAllowancePath()` SHALL return its value directly, bypassing both `RUN402_CONFIG_DIR`-based resolution and legacy `wallet.json` migration.

#### Scenario: Env var set to absolute path
- **WHEN** `RUN402_ALLOWANCE_PATH` is set to `/custom/path/allowance.json`
- **THEN** `getAllowancePath()` returns `/custom/path/allowance.json`

#### Scenario: Env var not set, falls back to default
- **WHEN** `RUN402_ALLOWANCE_PATH` is not set
- **THEN** `getAllowancePath()` returns `{configDir}/allowance.json` with legacy migration (existing behavior)

#### Scenario: Env var set, legacy migration skipped
- **WHEN** `RUN402_ALLOWANCE_PATH` is set to `/custom/path/allowance.json`
- **AND** `{configDir}/wallet.json` exists
- **THEN** `getAllowancePath()` returns `/custom/path/allowance.json` and does NOT rename `wallet.json`

### Requirement: saveAllowance respects custom path
When `RUN402_ALLOWANCE_PATH` is set, `saveAllowance()` (called without an explicit path argument) SHALL write to the custom path, creating parent directories as needed.

#### Scenario: Save to custom path
- **WHEN** `RUN402_ALLOWANCE_PATH` is set to `/custom/dir/my-wallet.json`
- **AND** `saveAllowance(data)` is called without a path argument
- **THEN** the allowance file is written to `/custom/dir/my-wallet.json` with mode 0600

### Requirement: Documentation lists RUN402_ALLOWANCE_PATH
The env var table in README and CLAUDE.md SHALL include `RUN402_ALLOWANCE_PATH` with its default (none — falls back to `{configDir}/allowance.json`) and purpose.

#### Scenario: Env var documented
- **WHEN** a user reads the README or CLAUDE.md environment variables table
- **THEN** `RUN402_ALLOWANCE_PATH` is listed with description and default behavior
