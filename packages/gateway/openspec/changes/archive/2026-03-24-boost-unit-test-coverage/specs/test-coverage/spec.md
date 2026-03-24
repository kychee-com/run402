## MODIFIED Requirements

### Requirement: CI coverage gate
The CI pipeline SHALL run unit tests with coverage and enforce a minimum threshold of 75% lines.

#### Scenario: CI passes when coverage meets threshold
- **WHEN** the gateway deploy workflow runs and coverage is at or above 75% lines
- **THEN** the workflow SHALL proceed to the deploy step

#### Scenario: CI fails when coverage drops below threshold
- **WHEN** the gateway deploy workflow runs and coverage drops below 75% lines
- **THEN** the workflow SHALL fail before the deploy step with a clear error message showing actual vs required coverage

#### Scenario: Threshold is configurable
- **WHEN** a maintainer wants to raise the coverage threshold
- **THEN** the threshold SHALL be configurable in a single location (c8 config or CI workflow) without code changes
