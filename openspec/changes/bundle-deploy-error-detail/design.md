## Context

The bundle deploy route (`routes/bundle.ts`) has a catch block that converts `BundleError` and `SubdomainError` to HTTP responses with proper status codes and messages. Any other error type (`FunctionError`, `DeploymentError`, raw `Error`) falls through to Express's default error handler, which returns `500 {"error":"Internal server error"}`.

The actual error types that can escape:
- `FunctionError` (from `deployFunction`) — has `statusCode` and `message`
- `DeploymentError` (from `createDeployment`) — has `statusCode` and `message`
- Raw `Error` (e.g., DB connection failure) — has only `message`

## Goals / Non-Goals

**Goals:**
- Every error from `/deploy/v1` includes the actual error message in the response body
- Errors from all deploy phases (migrations, RLS, secrets, functions, files, subdomain) are surfaced

**Non-Goals:**
- Adding a `phase` field to error responses (nice-to-have but not required — the error message itself usually identifies the phase)
- Changing error handling in the individual deploy endpoint (`POST /projects/v1/admin/:id/functions`)
- Changing successful response shapes

## Decisions

### Catch any error with a statusCode property

Rather than adding explicit cases for `FunctionError`, `DeploymentError`, and every future error type, check for a `statusCode` property on the caught error. All service-level errors in the codebase follow this pattern (`BundleError`, `FunctionError`, `DeploymentError`, `SubdomainError`, `HttpError` all have `statusCode`).

```typescript
catch (err: unknown) {
  if (err instanceof Error && 'statusCode' in err) {
    throw new HttpError((err as any).statusCode, err.message);
  }
  throw err;
}
```

**Why over explicit instanceof checks:** Future-proof — any new error type with `statusCode` is automatically handled. No need to update the catch block when adding new deploy phases.

**Why still throw to Express:** `HttpError` is already handled by the `asyncHandler` wrapper, which formats it as `{ error: message }` with the correct status code. No need to duplicate response formatting.

## Risks / Trade-offs

**[Risk] Leaking internal details in error messages** → Mitigation: All service-level error messages are already developer-facing (e.g., "Migration SQL error: column 'foo' already exists"). Raw errors from libraries might leak stack traces — but those already reach Bugsnag and are better surfaced than hidden behind "Internal server error".
