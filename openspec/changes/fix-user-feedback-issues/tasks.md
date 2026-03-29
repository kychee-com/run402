## 1. CORS Content-Range (Issue #4)

- [x] 1.1 Add `Content-Range` to `Access-Control-Expose-Headers` in `packages/gateway/src/server.ts:132`

## 2. JWT Email Claim (Issue #5)

- [x] 2.1 Add `email: user.email` to `jwt.sign()` in password login flow (`packages/gateway/src/routes/auth.ts`)
- [x] 2.2 Add `email: user.email` to `jwt.sign()` in OAuth login flow (`packages/gateway/src/routes/auth.ts`)
- [x] 2.3 Add `email: user.email` to `jwt.sign()` in token refresh flow (`packages/gateway/src/routes/auth.ts`)

## 3. getUser() Email Return (Issue #5)

- [x] 3.1 Update `getUser()` in local dev inline helper (`packages/gateway/src/services/functions.ts`) to return `{ id, role, email }`
- [x] 3.2 Update `getUser()` in Lambda layer helper (`packages/functions-runtime/build-layer.sh`) to return `{ id, role, email }`
- [x] 3.3 Update `function-getuser` spec (`openspec/specs/function-getuser/spec.md`) to reflect email in return value

## 4. SQL Filter Fix (Issue #6)

- [x] 4.1 Change regex in `packages/gateway/src/routes/admin.ts:160` from `/\bSET\s+(search_path|role)\b/i` to `/\bSET\s+search_path\b/i`
- [x] 4.2 Change same regex in `packages/gateway/src/services/bundle.ts`

## 5. Tests

- [x] 5.1 Update `getUser()` assertions in `test/functions-e2e.ts` to expect `email` field
- [x] 5.2 Run `npm run lint` and `npx tsc --noEmit -p packages/gateway`
- [ ] 5.3 Run `npm run test:functions` to verify getUser changes (requires live server + Lambda layer rebuild)
