## Why

The `@run402/functions` helper (db, getUser, email, ai) is currently a 285-line JavaScript heredoc inlined by `build-layer.sh` into the Lambda layer, with a separate inline copy for local dev in `functions.ts`. This means: no TypeScript types for users (zero autocomplete in editors), no standalone tests, no versioning, and the code is locked to the Lambda runtime. Extracting it into a proper npm package delivers immediate DX wins (types, local install, testability) while removing an obstacle for future runtime targets (Cloudflare Workers).

## What Changes

- Extract `@run402/functions` helper code into a new TypeScript package at `packages/functions/`
- Publish to npm as `@run402/functions` (public, scoped)
- Add full TypeScript type definitions for `db.from()` query builder chain, `db.sql()`, `getUser()`, `email.send()`, `ai.translate()`, `ai.moderate()`
- Update `build-layer.sh` to `npm install @run402/functions` instead of inlining the heredoc
- Update local dev function execution in `functions.ts` to resolve from `node_modules` instead of inlining
- Keep `jsonwebtoken` for now (defer `jose` swap to a future Workers-focused change)
- Keep convenience deps (stripe, openai, etc.) in the Lambda layer, not in the package
- No API changes for user function code — `import { db } from '@run402/functions'` continues to work identically

## Capabilities

### New Capabilities
- `functions-package`: The `@run402/functions` npm package — its exports, TypeScript types, configuration via environment variables, and runtime requirements

### Modified Capabilities
- `function-getuser`: No behavioral change, but getUser moves from inlined code to an importable package export. Spec documents the same contract.

## Impact

- **packages/functions-runtime/build-layer.sh** — Remove heredoc, add `npm install @run402/functions` to the layer build
- **packages/gateway/src/services/functions.ts** — Remove local dev inlining logic, resolve helper from node_modules
- **packages/functions/** — New package directory (src, types, package.json, tsconfig)
- **npm** — New public package `@run402/functions`
- **Lambda layer** — Must be republished after this change (new layer version)
- **Existing deployed functions** — Unaffected (pinned to current layer ARN)
