## Why

`POST /deploy/v1` returns `{"error":"Internal server error"}` when a deploy phase fails with a non-BundleError exception. Errors from function deployment (`FunctionError`), site deployment (`DeploymentError`), and unexpected exceptions lose their message and status code, leaving developers unable to debug failures without server-side logs.

## What Changes

- The bundle deploy catch block in `routes/bundle.ts` will handle `FunctionError`, `DeploymentError`, and any other error with a `statusCode` property, propagating their message and status code to the client.
- Unknown errors (no `statusCode`) will return 500 with the error message included instead of the generic "Internal server error".
- No new endpoints, no response shape changes for successful deploys.

## Capabilities

### New Capabilities
- `bundle-deploy-errors`: Error propagation for all deploy phases in the bundle endpoint. Covers mapping of `FunctionError`, `DeploymentError`, and generic errors to HTTP responses with actionable messages.

### Modified Capabilities

_(none — this is a bugfix to error handling, not a behavior change to existing specs)_

## Impact

- **Gateway code**: `packages/gateway/src/routes/bundle.ts` — catch block expanded to handle additional error types.
- **API response**: Error responses from `/deploy/v1` will include the actual error message instead of "Internal server error". This is an improvement, not a breaking change — clients that parse the `error` field will get better messages.
- **No downstream impact**: MCP server, CLI, and deployed functions are not affected.
