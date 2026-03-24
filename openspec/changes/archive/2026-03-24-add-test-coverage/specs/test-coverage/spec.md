## ADDED Requirements

### Requirement: Unified unit test command
The system SHALL provide a single `npm run test:unit` command in `packages/gateway` that discovers and runs all `*.test.ts` files under `src/`.

#### Scenario: Run all unit tests
- **WHEN** a developer runs `npm run test:unit` from `packages/gateway/`
- **THEN** all files matching `src/**/*.test.ts` SHALL be executed by the Node.js test runner

#### Scenario: New test file automatically included
- **WHEN** a developer adds a new `*.test.ts` file anywhere under `src/`
- **THEN** `npm run test:unit` SHALL discover and run it without any config changes

### Requirement: Coverage report generation
The system SHALL generate coverage reports in text, HTML, and JSON formats when running unit tests with coverage enabled.

#### Scenario: Generate coverage via dedicated script
- **WHEN** a developer runs `npm run test:unit:coverage` from `packages/gateway/`
- **THEN** c8 SHALL instrument all unit tests and produce:
  - A text summary printed to stdout (lines, branches, statements, functions)
  - An HTML report in `coverage/` directory
  - A JSON report in `coverage/` directory

#### Scenario: Coverage excludes test files and node_modules
- **WHEN** coverage is generated
- **THEN** the report SHALL exclude `*.test.ts` files, `node_modules/`, and `dist/` from coverage metrics

### Requirement: Coverage directory ignored by git
The `coverage/` directory SHALL be listed in `.gitignore` so generated reports are never committed.

#### Scenario: Coverage output not tracked
- **WHEN** a developer generates a coverage report
- **THEN** `git status` SHALL NOT show `coverage/` as untracked

### Requirement: CI coverage gate
The CI pipeline SHALL run unit tests with coverage and enforce a minimum threshold.

#### Scenario: CI passes when coverage meets threshold
- **WHEN** the gateway deploy workflow runs and coverage is at or above the configured threshold
- **THEN** the workflow SHALL proceed to the deploy step

#### Scenario: CI fails when coverage drops below threshold
- **WHEN** the gateway deploy workflow runs and coverage drops below the configured threshold
- **THEN** the workflow SHALL fail before the deploy step with a clear error message showing actual vs required coverage

#### Scenario: Threshold is configurable
- **WHEN** a maintainer wants to raise the coverage threshold
- **THEN** the threshold SHALL be configurable in a single location (c8 config or CI workflow) without code changes
