## Why

Three user-reported blocking issues are preventing standard usage patterns: counting rows via Content-Range headers is invisible to browsers, `getUser()` lacks the email field that every auth-aware function needs, and `UPDATE ... SET role = 'admin'` is blocked by a false-positive in the SQL safety filter. All three have workarounds that are either inefficient, insecure, or surprising.

## What Changes

- **Expose `Content-Range` in CORS headers** so browser clients can read row counts from PostgREST HEAD/GET responses (issue #4)
- **Add `email` to JWT claims and `getUser()` return value** so edge functions can identify users without a DB round-trip or trusting client-supplied data (issue #5) — **BREAKING** for the existing `function-getuser` spec which explicitly excludes email
- **Remove `role` from the SQL blocklist** so `UPDATE ... SET role = 'admin'` works via `db.sql()` (issue #6). The `search_path` pre-set and transaction wrapping are the real security boundary; the regex was defense-in-depth that produces false positives on a very common column name.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `function-getuser`: `getUser()` SHALL return `{ id, role, email }` instead of `{ id, role }`. The JWT SHALL include the `email` claim. The spec requirement "SHALL NOT include app-level fields like email" is reversed — email is now considered core identity.

## Impact

- **Gateway** (`packages/gateway/src/server.ts`): CORS expose list gains `Content-Range`
- **Gateway** (`packages/gateway/src/routes/auth.ts`): JWT `sign()` calls (3 places) add `email` claim
- **Gateway** (`packages/gateway/src/routes/admin.ts`): SQL blocklist regex drops `role` from the `SET` pattern
- **Gateway** (`packages/gateway/src/services/bundle.ts`): Same regex fix for bundle deploy validation
- **Gateway** (`packages/gateway/src/services/functions.ts`): `getUser()` inline helper returns `email`
- **Lambda layer** (`packages/functions-runtime/build-layer.sh`): `getUser()` helper returns `email`
- **Spec** (`openspec/specs/function-getuser/spec.md`): Updated requirements
- **Tests**: `test/functions-e2e.ts` assertions updated for new `getUser()` shape
