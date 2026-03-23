## ADDED Requirements

### Requirement: MCP server provides a setupPaidFetch function
The MCP server SHALL provide a `setupPaidFetch()` function in `src/paid-fetch.ts` that reads the local allowance file, branches on `rail` (x402 or mpp), and returns a wrapped fetch function that automatically intercepts 402 responses, signs payment, and retries the request.

#### Scenario: x402 rail with funded allowance
- **WHEN** `setupPaidFetch()` is called and the allowance file exists with `rail: "x402"` (or no rail, defaulting to x402)
- **THEN** the function SHALL return a fetch wrapper that uses `@x402/fetch`'s `wrapFetchWithPayment` with viem accounts registered for Base mainnet (eip155:8453) and Base Sepolia (eip155:84532)

#### Scenario: mpp rail with funded allowance
- **WHEN** `setupPaidFetch()` is called and the allowance file exists with `rail: "mpp"`
- **THEN** the function SHALL return a fetch wrapper that uses `mppx.fetch` with Tempo method configured from the allowance private key

#### Scenario: No allowance file
- **WHEN** `setupPaidFetch()` is called and no allowance file exists
- **THEN** the function SHALL return `null` (not throw, not call process.exit)

#### Scenario: Payment library import fails
- **WHEN** `setupPaidFetch()` is called but `@x402/fetch`, `viem`, or `mppx` cannot be imported
- **THEN** the function SHALL return `null` (graceful degradation)

### Requirement: MCP server provides a paidApiRequest helper
The MCP server SHALL provide a `paidApiRequest()` function that wraps `apiRequest` from core. When a paid fetch is available, it SHALL use the paid fetch so that 402 responses are handled transparently. When no paid fetch is available, it SHALL fall back to the bare `apiRequest`.

#### Scenario: Paid fetch available and server returns 402
- **WHEN** `paidApiRequest()` is called, a paid fetch is available, and the server returns 402
- **THEN** the paid fetch interceptor SHALL automatically sign payment and retry, returning the successful response to the caller (never exposing `is402: true`)

#### Scenario: Paid fetch available and server returns non-402
- **WHEN** `paidApiRequest()` is called, a paid fetch is available, and the server returns a non-402 response
- **THEN** the response SHALL pass through unchanged (same as bare `apiRequest`)

#### Scenario: No paid fetch available and server returns 402
- **WHEN** `paidApiRequest()` is called, no paid fetch is available, and the server returns 402
- **THEN** the response SHALL be `{ ok: false, is402: true, status: 402, body: ... }` (same as current behavior)

### Requirement: Paid fetch initialization is lazy and cached
The paid fetch wrapper SHALL be initialized on first use of `paidApiRequest()` and cached for the lifetime of the process. Dynamic imports of viem, @x402/fetch, @x402/evm, and mppx SHALL only happen once.

#### Scenario: Multiple paidApiRequest calls
- **WHEN** `paidApiRequest()` is called multiple times across different tool invocations
- **THEN** `setupPaidFetch()` SHALL be called only once, and the cached result SHALL be reused

### Requirement: set_tier tool uses paid fetch
The `set_tier` MCP tool SHALL use `paidApiRequest` instead of bare `apiRequest` for the POST to `/tiers/v1/{tier}`. On successful payment, it SHALL return the tier subscription result directly.

#### Scenario: set_tier with funded allowance pays automatically
- **WHEN** `set_tier` is called with a funded allowance and the server returns 402
- **THEN** payment SHALL be executed automatically and the tool SHALL return the tier subscription success response

#### Scenario: set_tier without allowance falls back to informational 402
- **WHEN** `set_tier` is called without an allowance and the server returns 402
- **THEN** the tool SHALL return the existing "Payment Required" informational text

### Requirement: generate_image tool uses paid fetch
The `generate_image` MCP tool SHALL use `paidApiRequest` instead of bare `apiRequest` for the POST to `/generate-image/v1`.

#### Scenario: generate_image with funded allowance pays automatically
- **WHEN** `generate_image` is called with a funded allowance and the server returns 402
- **THEN** payment SHALL be executed automatically and the tool SHALL return the generated image

#### Scenario: generate_image without allowance falls back to informational 402
- **WHEN** `generate_image` is called without an allowance and the server returns 402
- **THEN** the tool SHALL return the existing "Payment Required" informational text

### Requirement: deploy_function tool uses paid fetch
The `deploy_function` MCP tool SHALL use `paidApiRequest` instead of bare `apiRequest` for the POST to `/projects/v1/admin/{id}/functions`.

#### Scenario: deploy_function with funded allowance pays automatically
- **WHEN** `deploy_function` is called with a funded allowance and the server returns 402
- **THEN** payment SHALL be executed automatically and the tool SHALL return the deployment success response

#### Scenario: deploy_function without allowance falls back to informational 402
- **WHEN** `deploy_function` is called without an allowance and the server returns 402
- **THEN** the tool SHALL return the existing "Payment Required" informational text

### Requirement: invoke_function tool uses paid fetch
The `invoke_function` MCP tool SHALL use `paidApiRequest` instead of bare `apiRequest` for the POST/GET to `/functions/v1/{name}`.

#### Scenario: invoke_function with funded allowance pays automatically
- **WHEN** `invoke_function` is called with a funded allowance and the server returns 402
- **THEN** payment SHALL be executed automatically and the tool SHALL return the function response

#### Scenario: invoke_function without allowance falls back to informational 402
- **WHEN** `invoke_function` is called without an allowance and the server returns 402
- **THEN** the tool SHALL return the existing "Payment Required" informational text

### Requirement: provision tool uses paid fetch
The `provision` MCP tool SHALL use `paidApiRequest` instead of bare `apiRequest` for the POST to `/projects/v1`. Currently, 402 is treated as a generic error via `formatApiError`.

#### Scenario: provision with funded allowance pays automatically
- **WHEN** `provision` is called with a funded allowance and the server returns 402
- **THEN** payment SHALL be executed automatically and the tool SHALL return the provisioned project credentials

#### Scenario: provision without allowance returns informational 402
- **WHEN** `provision` is called without an allowance and the server returns 402
- **THEN** the tool SHALL return a "Payment Required" informational response (not `isError: true`)

### Requirement: bundle_deploy tool uses paid fetch
The `bundle_deploy` MCP tool SHALL use `paidApiRequest` instead of bare `apiRequest` for the POST to `/deploy/v1`. Currently, 402 is treated as a generic error via `formatApiError`.

#### Scenario: bundle_deploy with funded allowance pays automatically
- **WHEN** `bundle_deploy` is called with a funded allowance and the server returns 402
- **THEN** payment SHALL be executed automatically and the tool SHALL return the deployment success response

#### Scenario: bundle_deploy without allowance returns informational 402
- **WHEN** `bundle_deploy` is called without an allowance and the server returns 402
- **THEN** the tool SHALL return a "Payment Required" informational response (not `isError: true`)
