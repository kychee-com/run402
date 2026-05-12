## Why

Run402's live integration tests prove the basic CLI and MCP lifecycles, but they do not yet prove that the platform can host and operate a representative full-stack production application. Recent real application usage exposed untested platform paths around combined deploys, large schemas, static route manifests, runtime helpers, auth, storage/CDN, email, secrets, AI text helpers, and release observability.

## What Changes

- Add a product-neutral live full-stack integration suite that exercises Run402 as an application platform, not a specific downstream app.
- Introduce a reusable fixture app under the Run402 repo with static files, deploy routes, database migrations, serverless functions, scheduled function metadata, secrets declarations, auth flows, storage/CDN flows, email, and AI text helper coverage.
- Keep browser/UI product behavior out of the required integration contract; use headless HTTP/API assertions for hosted site, route, asset, function, and runtime verification.
- Preserve the existing CLI and MCP live lifecycle suites as smoke coverage, while adding deeper platform coverage in a separate suite.
- Explicitly exclude downstream SDK/CLI surfaces owned by applications built on Run402.

## Capabilities

### New Capabilities
- `fullstack-integration-coverage`: Defines the required live integration coverage for Run402 full-stack application platform behavior, including deploy composition, runtime helpers, auth, storage/CDN, email, AI text helpers, secrets, scheduled functions, routes, and release observability.

### Modified Capabilities

None.

## Impact

- Adds OpenSpec coverage requirements for live integration testing.
- Affects integration test organization, fixture structure, test scripts, and possibly CI/nightly workflow selection.
- Exercises existing public Run402 APIs and SDK/CLI/MCP surfaces without adding breaking API behavior.
- May require test-only live resources such as temporary projects, users, subdomains, storage objects, secrets, email recipients, and paid testnet payment flows.
