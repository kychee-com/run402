## 1. Dependencies

- [x] 1.1 Add `esbuild` to `packages/gateway/package.json` dependencies and install

## 2. Core Implementation

- [x] 2.1 Create a `transpileTS` helper function in `packages/gateway/src/services/functions.ts` that calls `esbuild.transform(code, { loader: "ts" })` and returns the transpiled JS, or throws a `FunctionError(400)` with the esbuild error message on failure
- [x] 2.2 Call `transpileTS` in `buildShimCode()` before base64-encoding user code
- [x] 2.3 Call `transpileTS` in `writeLocalFunction()` before stripping the `@run402/functions` import and embedding user code

## 3. Verification

- [x] 3.1 Run `npx tsc --noEmit -p packages/gateway` to confirm no type errors
- [x] 3.2 Run `npm run lint` to confirm no lint issues
- [x] 3.3 Test locally: deploy a TypeScript function (with type annotations) and verify it executes without `SyntaxError`
- [x] 3.4 Test locally: deploy a plain JavaScript function and verify it still works identically
