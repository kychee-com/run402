## Context

The gateway (`packages/gateway`) has 17 unit test files using Node.js built-in `node:test` with `--experimental-test-module-mocks`. Tests are run individually via named npm scripts (e.g., `test:siwx`, `test:subdomains`). There is no unified "run all unit tests" command and no coverage instrumentation.

E2E tests in `test/` run against a live API and are out of scope for coverage instrumentation (they test the system as a black box).

## Goals / Non-Goals

**Goals:**
- Measure line, branch, and statement coverage for gateway unit tests
- Provide a single `npm run test:unit` command that runs all unit tests
- Generate human-readable coverage reports (text summary + HTML)
- Add a CI gate that fails the build if coverage drops below a configurable threshold
- Make it easy to identify untested code paths

**Non-Goals:**
- Achieving any specific coverage target (the first run establishes the baseline)
- Adding coverage to E2E/integration tests (they hit a live server, not instrumented code)
- Adding new unit tests (separate effort — this change just adds the measurement)
- Coverage for `packages/functions-runtime`, `packages/shared`, or `infra/`

## Decisions

### Use `c8` for coverage instrumentation
**Rationale:** `c8` uses V8's built-in coverage (no source transformation), works natively with `node:test`, and requires zero config for basic usage. Alternatives like `istanbul`/`nyc` require instrumentation plugins that don't integrate well with the built-in test runner. `c8` is the standard choice for `node:test` projects.

### Single `test:unit` script that globs all `*.test.ts` files
**Rationale:** Currently each test file has its own npm script. A single glob-based command (`node --test 'src/**/*.test.ts'`) ensures new test files are automatically included without updating `package.json`. Individual scripts remain for running specific tests during development.

### Coverage threshold as a CI warning initially, hard gate later
**Rationale:** We don't know the current baseline. The first CI run will establish it. Start with a low threshold (e.g., 50% lines) and ratchet up once we see the actual numbers. Prevents the change from immediately breaking CI.

### HTML + text + JSON reports
**Rationale:** Text for quick CI log review, HTML for detailed local exploration, JSON for potential future tooling (badge generation, trend tracking).

## Risks / Trade-offs

- **[Risk] Coverage overhead slows CI** → c8/V8 coverage adds ~10-15% overhead; unit tests currently run in seconds, so impact is negligible.
- **[Risk] Threshold too aggressive breaks unrelated PRs** → Start with a low threshold; document how to update it.
- **[Trade-off] c8 doesn't support `--experimental-test-module-mocks` coverage of mocked modules** → Mocked modules won't show in coverage, but that's correct — we want to measure coverage of the code under test, not the mocks.
