# lifecycle-hooks Specification

## Purpose
TBD - created by archiving change on-signup-hook. Update Purpose after archive.
## Requirements
### Requirement: on-* naming convention
Any deployed function whose name starts with `on-` SHALL be treated as a lifecycle hook. Lifecycle hooks are invoked by the gateway in response to platform events, not by HTTP clients. The gateway SHALL never block or reject deployment of a function named `on-*` — it is a convention, not a restriction.

#### Scenario: Deploy a lifecycle hook function
- **WHEN** an agent deploys a function with `{ "name": "on-signup", "code": "..." }`
- **THEN** the function SHALL be deployed normally and be available for both gateway-triggered and HTTP-triggered invocation

#### Scenario: Deploy a non-hook function
- **WHEN** an agent deploys a function with `{ "name": "process-order", "code": "..." }`
- **THEN** the function SHALL be deployed normally with no lifecycle hook behavior

### Requirement: Hook discovery via DB lookup
When a lifecycle event occurs, the gateway SHALL check for a matching hook function by querying `internal.functions` with the project's ID and the hook name (e.g., `on-signup`). If no matching function exists, the gateway SHALL skip the hook silently with no error.

#### Scenario: Hook function exists
- **WHEN** a lifecycle event fires for a project that has a deployed function matching the hook name
- **THEN** the gateway SHALL invoke the function

#### Scenario: Hook function does not exist
- **WHEN** a lifecycle event fires for a project that has no deployed function matching the hook name
- **THEN** the gateway SHALL take no action and produce no error

### Requirement: Fire-and-forget execution
Lifecycle hooks SHALL be invoked asynchronously. The gateway SHALL NOT await the hook's response before returning the result of the triggering operation (e.g., the signup response). The hook's success or failure SHALL NOT affect the triggering operation's response.

#### Scenario: Hook invocation does not delay the triggering response
- **WHEN** a signup triggers the `on-signup` hook
- **THEN** the auth response SHALL be returned immediately, without waiting for the hook function to complete

#### Scenario: Hook function fails
- **WHEN** a lifecycle hook function throws an error or returns a non-200 status
- **THEN** the triggering operation SHALL still have succeeded and the error SHALL be logged to the gateway console

#### Scenario: Hook function times out
- **WHEN** a lifecycle hook function exceeds its configured timeout
- **THEN** the triggering operation SHALL still have succeeded and the timeout SHALL be logged

### Requirement: Trigger header convention
All lifecycle hook invocations SHALL include the header `X-Run402-Trigger` with a value matching the event name (e.g., `signup`). This follows the same pattern as `X-Run402-Trigger: cron` used by scheduled functions.

#### Scenario: Hook receives trigger header
- **WHEN** the gateway invokes a lifecycle hook for the `signup` event
- **THEN** the function SHALL receive a request with header `X-Run402-Trigger: signup`

#### Scenario: HTTP invocation has no trigger header
- **WHEN** a client invokes `POST /functions/v1/on-signup` directly via HTTP
- **THEN** the request SHALL NOT have an `X-Run402-Trigger` header (unless the client sets it manually)

### Requirement: Service-level auth context
Lifecycle hooks SHALL be invoked without a user JWT. The function SHALL use its own `RUN402_SERVICE_KEY` (injected at deploy time) for any database or API operations requiring elevated permissions.

#### Scenario: Hook request has no Authorization header
- **WHEN** the gateway invokes a lifecycle hook
- **THEN** the request SHALL NOT include an `Authorization` header

### Requirement: Hook invocations count against API quota
Each lifecycle hook invocation SHALL be metered as one API call against the project's tier quota, using the same metering logic as scheduled function invocations.

#### Scenario: Hook invocation increments API counter
- **WHEN** a lifecycle hook fires
- **THEN** the project's API call counter SHALL be incremented by 1

#### Scenario: Quota exhausted skips hook
- **WHEN** a project has exceeded its API call quota and a lifecycle event fires
- **THEN** the hook invocation SHALL be skipped and the skip SHALL be logged

### Requirement: Idempotency is the function's responsibility
The gateway makes no idempotency guarantees for lifecycle hooks. Hook functions SHALL be written to handle being invoked more than once for the same event (e.g., due to race conditions). The gateway SHALL document this in developer-facing docs.

#### Scenario: Duplicate invocation
- **WHEN** a lifecycle hook is invoked twice for the same event due to a race condition
- **THEN** the function SHALL handle the duplicate gracefully (e.g., check if work was already done and return early)

