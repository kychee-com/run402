## ADDED Requirements

### Requirement: Each service file has a colocated unit test
Every `services/*.ts` file currently below 80% line coverage SHALL have a corresponding `services/*.test.ts` file that tests its exported functions.

#### Scenario: New test files are created for uncovered services
- **WHEN** `npm run test:unit` is executed
- **THEN** test files SHALL exist and run for: billing, wallet-tiers, projects, slots, functions, publish, fork, mailbox, admin-wallets

### Requirement: Service tests mock all I/O at module boundaries
Each service test SHALL mock `../db/pool.js` and any external SDK clients (AWS, Stripe) before importing the module under test, following the established `mock.module()` pattern.

#### Scenario: Tests run without network or database access
- **WHEN** `npm run test:unit` is executed in an environment with no database or network
- **THEN** all unit tests SHALL pass (no real I/O performed)

### Requirement: Middleware and route tests for large uncovered files
`middleware/x402.ts` and `routes/admin.ts` SHALL have test files if they are below 80% line coverage.

#### Scenario: x402 middleware has unit tests
- **WHEN** `npm run test:unit:coverage` is executed
- **THEN** `middleware/x402.ts` SHALL have improved line coverage from tests in `middleware/x402.test.ts`

#### Scenario: Admin routes have unit tests
- **WHEN** `npm run test:unit:coverage` is executed
- **THEN** `routes/admin.ts` SHALL have improved line coverage from tests in `routes/admin.test.ts`

### Requirement: Overall line coverage reaches 80%
The combined c8-reported line coverage across all files loaded during `test:unit:coverage` SHALL be at least 80%.

#### Scenario: Coverage check passes
- **WHEN** `npm run test:unit:coverage -- --check-coverage --lines 80` is executed
- **THEN** the command SHALL exit with code 0
