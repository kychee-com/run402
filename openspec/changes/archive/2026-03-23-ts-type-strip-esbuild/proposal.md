## Why

Users naturally write edge functions in TypeScript (e.g., `(req: Request)`), but the deploy pipeline embeds raw code into `.mjs` files with no transpilation. Node.js 22 parses `.mjs` as standard JavaScript, so any type annotation causes a `SyntaxError` at runtime. This silently breaks every TypeScript function deployment.

## What Changes

- Add `esbuild` as a gateway dependency for TypeScript-to-JavaScript transpilation
- Transpile user code in `buildShimCode` before base64-encoding it into the Lambda shim
- Transpile user code in `writeLocalFunction` before embedding it in the local module
- Accept both TypeScript and JavaScript transparently — JS passes through unchanged

## Capabilities

### New Capabilities
- `ts-transpile`: Gateway-side TypeScript transpilation of user function code via esbuild before deployment to Lambda or local execution

### Modified Capabilities
<!-- No existing spec-level behavior changes — this is a new internal capability -->

## Impact

- **Code**: `packages/gateway/src/services/functions.ts` — `buildShimCode()` and `writeLocalFunction()`
- **Dependencies**: New dependency `esbuild` added to `packages/gateway/package.json`
- **Docker**: Gateway image size increases ~9MB (esbuild native binary)
- **APIs**: No API changes — the deploy endpoint accepts code strings as before
- **Behavior**: Functions that previously failed with `SyntaxError` will now work. Pure JS functions are unaffected (esbuild's TS loader is a superset of JS).
