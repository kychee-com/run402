## MODIFIED Requirements

### Requirement: getUser available in both Lambda and local dev modes
The `getUser` implementation SHALL exist in the `@run402/functions` npm package at `packages/functions/`. Both Lambda and local dev modes SHALL resolve `getUser` from this package — there SHALL be no separate inlined copy.

1. Lambda: the Lambda layer installs `@run402/functions` via npm, making `getUser` available at runtime
2. Local dev: the monorepo workspace links `packages/functions/`, making `getUser` available via standard module resolution

Both modes SHALL behave identically.

#### Scenario: Lambda mode
- **WHEN** a function deployed to Lambda calls `getUser(req)`
- **THEN** it SHALL work using the `@run402/functions` package installed in the Lambda layer and the `RUN402_JWT_SECRET` env var

#### Scenario: Local dev mode
- **WHEN** a function running in local dev mode calls `getUser(req)`
- **THEN** it SHALL work using the `@run402/functions` package resolved from the monorepo workspace and the `RUN402_JWT_SECRET` env var

### Requirement: getUser uses jsonwebtoken for verification
The `getUser` function SHALL use the `jsonwebtoken` package to verify the token signature, check expiry, and extract claims. The `jsonwebtoken` package SHALL be declared as a dependency of `@run402/functions` in its `package.json`.

#### Scenario: Token signature verification
- **WHEN** a function calls `getUser(req)` with a JWT signed by a different secret
- **THEN** it SHALL return `null` (signature mismatch)
