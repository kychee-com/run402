## Why

A Bugsnag error (Mar 24) showed a `POST /auth/v1/token?grant_type=refresh_token` request with `"also_invalid"` as the refresh token reaching Postgres, which rejected it with `invalid input syntax for type uuid`. The gateway has no centralized input validation — UUIDs, wallet addresses, emails, and other user-supplied values flow directly into DB queries or URL construction with only existence checks. This causes DB-level type errors (500) instead of clean 400 responses, wastes round-trips, and obscures real errors in monitoring.

## What Changes

- Add a shared validation utility module with validators for common types: UUID, wallet address (Ethereum), email, slug, pagination integers, and URL
- Add validation to all route handlers that accept user input before it reaches the DB or service layer
- Return consistent 400 responses with clear error messages for malformed input
- Eliminate DB-level type cast errors (`::uuid`, `::int`) caused by unvalidated input

## Capabilities

### New Capabilities
- `input-validation`: Centralized input validation utilities and route-level validation for all gateway endpoints. Covers UUID format, Ethereum wallet address (length + hex), email format, pagination bounds, slug format, and URL format validation.

### Modified Capabilities

_(none — this change adds validation guards without altering API contracts or spec-level behavior)_

## Impact

- **Routes affected:** auth.ts, projects.ts, functions.ts, billing.ts, storage.ts, subdomains.ts, deployments.ts, rest.ts, contact.ts, mailboxes.ts, bundle.ts, admin.ts, faucet.ts
- **Error behavior change:** Several endpoints that currently return 500 (DB type error) will return 400 (validation error) — a backwards-compatible improvement
- **Dependencies:** None — uses built-in validation (regex, `new URL()`), no new libraries
- **Tests:** Existing E2E tests should pass unchanged; new unit tests for the validation module
