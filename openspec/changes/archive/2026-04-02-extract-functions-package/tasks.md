## 1. Package Setup

- [x] 1.1 Create `packages/functions/` directory with `package.json` (name: `@run402/functions`, type: module, engines: node >=18), `tsconfig.json`, and source structure (`src/index.ts`, `src/db.ts`, `src/auth.ts`, `src/email.ts`, `src/ai.ts`)
- [x] 1.2 Add `packages/functions` to root `package.json` workspaces array
- [x] 1.3 Add `jsonwebtoken` and `@types/jsonwebtoken` as dependencies

## 2. Core Implementation

- [x] 2.1 Implement `src/db.ts` — `QueryBuilder` class with all filter/mutation methods and thenable `then()`, plus `db.sql()`. Port from `build-layer.sh` heredoc, convert to TypeScript with full type annotations
- [x] 2.2 Implement `src/auth.ts` — `getUser(req)` function using `jsonwebtoken`. Type the return as `{ id: string, role: string, email: string } | null`
- [x] 2.3 Implement `src/email.ts` — `email.send()` with mailbox discovery. Type the options parameter (raw mode vs template mode)
- [x] 2.4 Implement `src/ai.ts` — `ai.translate()` and `ai.moderate()` with typed parameters and return values
- [x] 2.5 Implement `src/index.ts` — re-export all public API: `{ db, getUser, email, ai }`
- [x] 2.6 Add `src/config.ts` — centralize env var reads (`RUN402_API_BASE`, `RUN402_PROJECT_ID`, `RUN402_SERVICE_KEY`, `RUN402_JWT_SECRET`) with defaults

## 3. Build & Types

- [x] 3.1 Configure `tsconfig.json` with declaration output, ESM target, outDir `dist/`
- [x] 3.2 Add build script to `package.json` (`tsc`), verify `dist/` contains `.js` and `.d.ts` files
- [x] 3.3 Configure `package.json` exports map pointing to `dist/index.js` and `dist/index.d.ts`
- [x] 3.4 Verify TypeScript types work: `db.from()` chain, `getUser()` return type, `email.send()` options, `ai.translate()` params all provide correct autocomplete

## 4. Tests

- [x] 4.1 Add unit tests for `QueryBuilder` — verify URL construction, query parameter encoding, method selection (GET/POST/PATCH/DELETE), and thenable behavior
- [x] 4.2 Add unit tests for `getUser` — valid token, missing header, invalid token, wrong project_id, non-Bearer header
- [x] 4.3 Add test script to `package.json`, verify tests pass in CI

## 5. Update Lambda Layer

- [x] 5.1 Update `build-layer.sh` — remove the heredoc block, add `@run402/functions` to the layer's npm install (pin version)
- [x] 5.2 Verify built layer contains `node_modules/@run402/functions/` with compiled JS and types
- [x] 5.3 Verify layer still contains convenience deps (stripe, openai, etc.)

## 6. Update Local Dev

- [x] 6.1 Update `functions.ts` `writeLocalFunction()` — remove inline helper code injection, preserve user import statements (`import { db } from '@run402/functions'`)
- [x] 6.2 Verify local dev function execution resolves `@run402/functions` from workspace
- [x] 6.3 Remove the `createRequire` / `jsonwebtoken` inline hack from local dev path

## 7. Publish & Deploy

- [x] 7.1 Publish `@run402/functions` v1.0.0 to npm (`npm publish --access public`)
- [x] 7.2 Rebuild and publish Lambda layer (`build-layer.sh --publish`)
- [x] 7.3 Update `LAMBDA_LAYER_ARN` in `infra/lib/pod-stack.ts` with new layer ARN
- [x] 7.4 Deploy CDK (`cdk deploy AgentDB-Pod01`)
- [x] 7.5 Deploy gateway (push to main or manual deploy)
- [x] 7.6 Run `test:functions` E2E to verify deployed functions still work
