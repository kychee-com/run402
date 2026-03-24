## Why

The gateway has 17 unit test files and 7 E2E test suites but no coverage instrumentation — we can't measure what's tested vs what's not. Without metrics, coverage gaps are invisible and regressions go unnoticed. Adding `c8` (which works natively with `node:test`) gives us line/branch/statement percentages and pinpoints untested code.

## What Changes

- Add `c8` as a dev dependency for coverage instrumentation
- Add `npm run test:unit` script that runs all gateway unit tests with coverage
- Add `npm run test:unit:coverage` script that generates HTML + text coverage reports
- Add coverage output directory (`coverage/`) to `.gitignore`
- Add a CI step in the gateway deploy workflow that runs unit tests with coverage and fails on regression (configurable threshold)

## Capabilities

### New Capabilities
- `test-coverage`: Coverage instrumentation for gateway unit tests using c8, with CI integration and configurable thresholds

### Modified Capabilities
_(none — no existing spec-level requirements change)_

## Impact

- **Code**: Root `package.json` (new scripts), `packages/gateway/package.json` (c8 dep + scripts), `.gitignore`
- **CI**: `.github/workflows/deploy-gateway.yml` — new coverage step before deploy
- **Dependencies**: `c8` added as devDependency
- **No runtime impact** — coverage is dev/CI only
