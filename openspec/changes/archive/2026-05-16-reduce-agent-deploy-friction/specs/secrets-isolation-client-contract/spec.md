## ADDED Requirements

### Requirement: CLI Secret Values Can Be Read From Stdin

The CLI SHALL support setting secret values from stdin without requiring a regular temporary file or exposing the value in shell history.

`run402 secrets set <project> <key> --stdin` SHALL read the secret value from stdin until EOF. `--file -` and `/dev/stdin` SHOULD be accepted as aliases when practical. The stdin path SHALL be mutually exclusive with inline positional values and ordinary `--file <path>` values.

The CLI SHALL preserve the write-only secret contract: errors, help text, JSON envelopes, and logs SHALL NOT echo the secret value.

#### Scenario: Stdin flag sets a secret

- **WHEN** a user runs `echo -n "https://example.com" | run402 secrets set prj_123 SITE_URL --stdin`
- **THEN** the CLI SHALL call the secrets set SDK method with the stdin bytes as the secret value
- **AND** the value SHALL NOT appear in stdout, stderr, or structured error metadata

#### Scenario: Dev stdin path is accepted

- **WHEN** a user runs `echo -n "secret" | run402 secrets set prj_123 API_KEY --file /dev/stdin`
- **THEN** the CLI SHALL read from stdin rather than rejecting `/dev/stdin` as `NOT_A_FILE`
- **AND** the command SHALL preserve the same success envelope as ordinary file input

#### Scenario: Conflicting secret value sources fail

- **WHEN** a user supplies both an inline value and `--stdin`
- **THEN** the CLI SHALL fail with a structured `BAD_USAGE` error
- **AND** the error SHALL identify the conflicting value sources without printing the secret value

#### Scenario: Missing stdin value is actionable

- **WHEN** a user supplies `--stdin` without piped input
- **THEN** the CLI SHALL fail with a structured usage error
- **AND** the hint or next actions SHALL mention piping a value, using `--file <path>`, or using an inline value only when shell history exposure is acceptable

