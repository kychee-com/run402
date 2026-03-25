## Context

The gateway has 13+ route files accepting user input (path params, query strings, request bodies). Input flows into Postgres queries with type casts (`::uuid`, `::int`) or into URL construction with only existence checks. When a malformed value hits the DB, Postgres returns a type error that surfaces as an unhandled 500 — polluting Bugsnag and giving callers no actionable feedback. There is no shared validation utility; each route does ad-hoc checks (or none).

## Goals / Non-Goals

**Goals:**
- Validate all user-supplied values at the route boundary before they reach DB or service layers
- Return 400 with a clear message for malformed input (instead of 500 from DB type errors)
- Provide a small, reusable validation module — no external dependencies
- Cover the most impactful types: UUID, Ethereum address, email, slug, pagination integers, URLs

**Non-Goals:**
- Full request schema validation (e.g. Zod schemas for every endpoint body) — too large, diminishing returns
- Changing API contracts or response shapes for valid inputs
- Validating business logic (e.g. "does this project exist") — that stays in the service layer
- Adding a validation middleware framework — validators are called inline in route handlers

## Decisions

### 1. No new dependencies — use built-in validation

**Choice:** Regex + `new URL()` + simple functions in a single `utils/validate.ts` module.

**Alternatives considered:**
- **Zod**: Powerful but adds a dependency and encourages full-schema validation (non-goal). Overkill for "is this a UUID?"
- **express-validator**: Middleware-based, changes route handler patterns significantly.

**Rationale:** The validators are simple (UUID is a regex, wallet is length + hex check). A dependency adds bundle size and API surface for no real benefit here.

### 2. Inline validation calls in route handlers (not middleware)

**Choice:** Each route handler calls `validateUUID(req.params.id)` etc. at the top, which throws `HttpError(400, ...)` on failure.

**Alternatives considered:**
- Express middleware that validates params before reaching handler
- Decorator/wrapper pattern

**Rationale:** Inline calls are explicit, easy to audit, and match the existing codebase pattern. Middleware would require a schema definition per route — more ceremony than the validators themselves.

### 3. Validators throw HttpError directly

**Choice:** `validateUUID(value, "refresh_token")` throws `HttpError(400, "Invalid refresh_token: must be a valid UUID")` if invalid, returns the value if valid.

**Rationale:** This matches the existing error pattern (asyncHandler catches HttpError and returns it). No new error handling needed. The field name in the message helps callers debug.

### 4. Scope: route-level params and body fields only

Only validate values that would cause DB type errors or are security-sensitive. Skip validating optional fields that have safe defaults (e.g. `limit` already falls back via `|| 50`).

## Risks / Trade-offs

- **[Risk] Over-strict validation rejects valid input** → Mitigate by using spec-compliant patterns (RFC 4122 for UUID, EIP-55 for addresses) and testing against existing E2E suite
- **[Risk] Regex backtracking on adversarial input** → Mitigate by using anchored, non-backtracking patterns; all validators are O(n) or better
- **[Trade-off] Inline calls require touching every route file** → Accepted; gives explicit visibility into what's validated where, and is a one-time cost
