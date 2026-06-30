## ADDED Requirements

### Requirement: CLI-authored next actions are typed

The CLI SHALL emit every locally-authored `next_actions` entry as an object with a `type` field and optional structured fields such as `command`, `method`, `path`, `auth`, and `why`.

#### Scenario: Local argument validation fails

- **WHEN** a CLI command rejects invalid or incomplete arguments before calling the SDK/API
- **THEN** the stderr error envelope includes `next_actions` only as typed objects, never bare strings

#### Scenario: Local deploy warning guidance is generated

- **WHEN** the CLI generates fallback guidance for deploy warnings or CI deploy errors
- **THEN** each generated action includes a `type` and any concrete command guidance is placed in `command`

### Requirement: SDK and gateway next actions pass through

The CLI SHALL preserve non-empty `next_actions` received from the SDK/API/gateway instead of replacing them with CLI-authored fallback guidance.

#### Scenario: Gateway error contains structured next actions

- **WHEN** an SDK/API/gateway error already includes one or more `next_actions`
- **THEN** the CLI reports those actions in the stderr envelope without substituting local fallback actions

### Requirement: Public examples use canonical next-action keys

Public agent-facing examples SHALL use `type` as the action discriminator for suggested next actions and SHALL NOT teach an `action` discriminator inside `next_actions[]`.

#### Scenario: Agent reads skill troubleshooting guidance

- **WHEN** an agent reads the Run402 MCP or OpenClaw skill examples
- **THEN** any `next_actions` example uses objects with `type` rather than `action`

### Requirement: Regression tests reject invalid CLI next-action shapes

The test suite SHALL fail if CLI source files add bare-string `next_actions` entries or objects with the invalid `action` key.

#### Scenario: Developer adds invalid next_actions

- **WHEN** a developer adds a bare-string `next_actions` entry or a `next_actions` object whose discriminator is `action` in `cli/lib`
- **THEN** the CLI output contract test fails before the change can ship
