## Context

The gateway's `buildShimCode()` and `writeLocalFunction()` embed user code verbatim into `.mjs` files. Users increasingly write TypeScript (type annotations, interfaces), which causes `SyntaxError` at runtime because Node.js treats `.mjs` as strict JavaScript.

The transpilation must happen gateway-side at deploy time — Lambda's `nodejs22.x` runtime is sealed (no custom Node flags), and client-side transpilation would burden every API consumer.

## Goals / Non-Goals

**Goals:**
- TypeScript function code deploys and runs without errors
- JavaScript function code continues to work identically (no regressions)
- Single transpilation point in the gateway, before code is embedded in the shim

**Non-Goals:**
- Type checking — esbuild deliberately does not type-check (same as `tsc --noCheck`). Users rely on their editor for that.
- JSX/TSX support — edge functions are API handlers, not React components
- Bundling or dependency resolution — that's the Lambda layer's job
- Source maps — edge functions are small single-file handlers; stack traces are readable without them

## Decisions

### 1. Use esbuild `transform()`, not `build()`

`transform()` operates on a string in memory — no filesystem, no temp files, no bundling. It takes the user's code string and returns transpiled JavaScript. This fits perfectly: we already have code as a string and need a string back.

**Alternative considered:** `build()` with `stdin` — unnecessary complexity, designed for multi-file bundling.

### 2. Transpile unconditionally (no TS detection heuristic)

Always run `esbuild.transform(code, { loader: "ts" })` regardless of whether the code looks like TypeScript. esbuild's TS loader is a strict superset of JavaScript — valid JS passes through unchanged (no semantic changes, no performance concern at <1ms per transform).

**Alternative considered:** Regex-based TS detection — fragile, edge cases (e.g., `: string` in a comment), unnecessary complexity when the no-op path is free.

### 3. Transpile before embedding, not at runtime

Strip types at deploy time in the gateway, producing clean JS that goes into the shim. This means:
- Lambda receives valid JavaScript — no runtime surprises
- Cold starts are unaffected (no transpilation at import time)
- The stored `source` column keeps the original TypeScript for publish/fork

**Alternative considered:** `NODE_OPTIONS=--experimental-strip-types` at Lambda runtime — depends on Lambda honoring the flag, adds cold-start overhead on every invocation, doesn't support enums.

### 4. Insert transpilation at two points

- `buildShimCode()`: before `Buffer.from(userCode).toString("base64")` — covers Lambda path
- `writeLocalFunction()`: before stripping the `@run402/functions` import — covers local dev path

Both call the same helper function to keep behavior identical.

## Risks / Trade-offs

- **[esbuild version drift]** → Pin to a specific major version. esbuild is stable and follows semver. Minimal risk.
- **[Docker image size +~9MB]** → Acceptable for a gateway container. The esbuild binary is self-contained with no transitive deps.
- **[User writes unsupported TS syntax]** → esbuild supports all practical TypeScript. The only unsupported features are `const enum` (across files) and legacy `namespace` merging — both are rare in single-file edge functions. esbuild returns clear error messages for unsupported syntax.
- **[Deploy latency increase]** → Negligible. esbuild transforms small files in <1ms.
