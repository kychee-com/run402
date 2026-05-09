## ADDED Requirements

### Requirement: Interface-Parity SDK Types Are Exported

Any SDK method added or widened so CLI and MCP no longer need direct Run402 gateway calls SHALL expose its public option and result types from both `@run402/sdk` and `@run402/sdk/node`.

#### Scenario: Blob upload session types are exported
- **WHEN** low-level blob upload session methods are added for resumable CLI upload support
- **THEN** their input, part, status, and completion result types SHALL be importable from `@run402/sdk`
- **AND** the same types SHALL be importable from `@run402/sdk/node`

#### Scenario: Generic billing identifier types are exported
- **WHEN** SDK billing reads accept either wallet or email identifiers
- **THEN** the identifier, balance, history, and option/result types SHALL be importable from package entrypoints

#### Scenario: Interface refactor uses public package paths
- **WHEN** CLI, MCP, docs, or tests refer to new SDK types
- **THEN** they SHALL import from `@run402/sdk`, `@run402/sdk/node`, or existing local SDK build entrypoints
- **AND** they SHALL NOT import from deep namespace source paths
