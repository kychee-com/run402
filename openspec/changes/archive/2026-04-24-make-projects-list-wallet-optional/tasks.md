## 1. SDK Implementation

- [x] 1.1 Change the signature of `list` in `sdk/src/namespaces/projects.ts` from `list(wallet: string)` to `list(wallet?: string)`
- [x] 1.2 Add fallback block at the top of `list()`: when `wallet` is undefined, read `this.client.credentials.readAllowance`; throw `Run402Error` with `context: "listing projects"` if the method is missing; throw `Run402Error` with the same context if the method returns `null`; otherwise use `data.address` as the resolved wallet
- [x] 1.3 Ensure the resolved wallet flows through the existing `.toLowerCase()` + `request` path unchanged (no auth, no payment)
- [x] 1.4 Update the JSDoc for `list()` to describe the optional-argument behavior and the two error paths, pointing readers at `allowance.faucet` as the precedent
- [x] 1.5 Confirm `Run402Error` is imported in `projects.ts` (it already is — used by `setupRls`)

## 2. Unit Tests

- [x] 2.1 In `sdk/src/namespaces/projects.test.ts`, extend the existing `projects.list` describe block (or add one if absent) with a test that passes an explicit wallet and asserts the request URL, lowercasing behavior, and `withAuth: false`
- [x] 2.2 Add a test where `readAllowance` is implemented and returns `{ address: "0xAbC..." }`; call `r.projects.list()` with no argument; assert the request URL uses the lowercased address and the result parses correctly
- [x] 2.3 Add a test with a `CredentialsProvider` lacking `readAllowance`; call `r.projects.list()`; assert it throws `Run402Error` with `context === "listing projects"`, the message mentions both "pass an explicit wallet" and "@run402/sdk/node", and no fetch call was made
- [x] 2.4 Add a test where `readAllowance` resolves to `null`; call `r.projects.list()`; assert it throws `Run402Error` with `context === "listing projects"`, the message mentions both "run402 allowance create" and "pass an explicit wallet", and no fetch call was made
- [x] 2.5 Add a test that `sdk.projects.list(other)` still works when the local allowance holds a different address (ops-tooling case) — assert the request targets the explicit wallet and `readAllowance` is not consulted

## 3. Validation

- [x] 3.1 Run `npm run build:sdk` and confirm the SDK compiles with the new signature (TypeScript accepts `wallet?: string` as a narrowing of the prior required type for all existing callers)
- [x] 3.2 Run `node --test --import tsx sdk/src/namespaces/projects.test.ts` and confirm all tests pass
- [x] 3.3 Run `npm test` and confirm the full test suite passes, including `sync.test.ts` (the surface audit is unaffected — no new tool/command added)
- [x] 3.4 Grep for existing `projects.list(` call sites in `src/`, `cli/`, and `openclaw/` and confirm they still compile and behave unchanged (they all pass an explicit wallet today)
