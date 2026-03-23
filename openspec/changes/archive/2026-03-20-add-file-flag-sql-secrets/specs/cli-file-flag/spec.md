## ADDED Requirements

### Requirement: projects sql accepts --file flag
The `projects sql` command SHALL accept an optional `--file <path>` flag. When provided, the SQL statement SHALL be read from the specified file path instead of the positional `"<query>"` argument. The file SHALL be read as UTF-8 text. When both `--file` and a positional query are provided, `--file` SHALL take precedence.

#### Scenario: SQL read from file
- **WHEN** user runs `run402 projects sql <id> --file setup.sql`
- **THEN** the command reads `setup.sql` from disk and sends its contents as the SQL query

#### Scenario: File flag takes precedence over inline arg
- **WHEN** user runs `run402 projects sql <id> "SELECT 1" --file setup.sql`
- **THEN** the command uses the contents of `setup.sql`, ignoring the inline query

#### Scenario: Inline query still works without --file
- **WHEN** user runs `run402 projects sql <id> "SELECT 1"`
- **THEN** the command uses the inline query as before (backward compatible)

#### Scenario: Missing file path
- **WHEN** user runs `run402 projects sql <id> --file` with no path argument
- **THEN** the `--file` flag is ignored and the command falls through to requiring a query

### Requirement: secrets set accepts --file flag
The `secrets set` command SHALL accept an optional `--file <path>` flag. When provided, the secret value SHALL be read from the specified file path instead of the positional `<value>` argument. The file SHALL be read as UTF-8 text. When both `--file` and a positional value are provided, `--file` SHALL take precedence.

#### Scenario: Secret value read from file
- **WHEN** user runs `run402 secrets set <id> API_KEY --file key.pem`
- **THEN** the command reads `key.pem` from disk and uses its contents as the secret value

#### Scenario: File flag takes precedence over inline value
- **WHEN** user runs `run402 secrets set <id> API_KEY some-value --file key.pem`
- **THEN** the command uses the contents of `key.pem`, ignoring the inline value

#### Scenario: Inline value still works without --file
- **WHEN** user runs `run402 secrets set <id> API_KEY some-value`
- **THEN** the command uses the inline value as before (backward compatible)

### Requirement: Help text documents --file flag
The help text for both `projects sql` and `secrets set` SHALL document the `--file` option.

#### Scenario: projects sql help shows --file
- **WHEN** user runs `run402 projects --help`
- **THEN** the `sql` subcommand line includes `[--file <path>]`

#### Scenario: secrets set help shows --file
- **WHEN** user runs `run402 secrets --help`
- **THEN** the `set` subcommand line includes `[--file <path>]`

### Requirement: llms-cli.txt documents --file flags
The `llms-cli.txt` documentation SHALL include the `--file` option for both `projects sql` and `secrets set`.

#### Scenario: Updated docs
- **WHEN** an LLM reads `llms-cli.txt`
- **THEN** the `projects sql` and `secrets set` entries show `[--file <path>]` as an option
