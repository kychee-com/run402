## Context

The `@run402/functions` helper is currently defined as a ~285-line JavaScript heredoc inside `build-layer.sh`. It provides `db` (PostgREST query builder + raw SQL), `getUser` (JWT verification), `email` (mailbox sending), and `ai` (translate/moderate). All exports except `getUser` are pure `fetch()` wrappers — runtime-agnostic. `getUser` depends on `jsonwebtoken` (Node.js only).

A second copy of the helper is inlined by `functions.ts` for local dev execution, creating a maintenance burden (two copies of the same logic).

The Lambda layer also bundles convenience dependencies (stripe, openai, anthropic-sdk, resend, zod, uuid, jsonwebtoken, bcryptjs, cheerio, csv-parse) that users can import directly in their functions.

## Goals / Non-Goals

**Goals:**
- Extract helper code into `packages/functions/` as a proper TypeScript package
- Publish to npm as `@run402/functions` (public)
- Provide full TypeScript type definitions for all exports
- Update `build-layer.sh` to consume the package via npm install
- Simplify local dev to resolve the helper from node_modules instead of inlining
- Zero API changes — existing user function code works unmodified

**Non-Goals:**
- Replacing `jsonwebtoken` with `jose` (deferred to Workers change)
- Moving convenience deps (stripe, openai, etc.) into this package
- Supporting Cloudflare Workers runtime (Phase 2)
- Adding new helpers or APIs beyond what exists today
- Changing the Lambda shim or invocation path

## Decisions

### 1. Package location: `packages/functions/`

Place the package in the monorepo workspace alongside `packages/gateway/` and `packages/shared/`. This allows local development with workspace linking and a single `npm install` at the repo root.

**Alternative considered:** Separate repo (like `run402-mcp`). Rejected because the helper code is tightly coupled to the gateway API surface — changes to REST routes or SQL endpoints often require matching helper changes. Co-locating keeps them in sync.

### 2. TypeScript source with bundled .d.ts

Write the package in TypeScript. Ship both compiled `.js` (ESM) and `.d.ts` type declarations. The package.json `exports` map points to the compiled output.

```
packages/functions/
├── src/
│   ├── index.ts          # re-exports
│   ├── db.ts             # QueryBuilder + db.sql()
│   ├── auth.ts           # getUser()
│   ├── email.ts          # email.send()
│   └── ai.ts             # ai.translate(), ai.moderate()
├── dist/                  # compiled output (gitignored)
├── package.json
└── tsconfig.json
```

**Alternative considered:** Single `index.ts` file. Rejected — separate modules are easier to test and review, and tree-shaking works better with multiple entry points.

### 3. Keep `jsonwebtoken` as a dependency

`getUser()` stays synchronous using `jsonwebtoken`. The package declares `jsonwebtoken` as a regular dependency. This means the package is Node.js-only for now, which is fine since the only runtime target is Lambda (Node 22).

When Workers support is added, `jsonwebtoken` will be swapped for `jose` and `getUser()` will become async — shipped as a semver major bump.

### 4. Configuration via environment variables (unchanged)

The package reads `RUN402_API_BASE`, `RUN402_PROJECT_ID`, `RUN402_SERVICE_KEY`, and `RUN402_JWT_SECRET` from `process.env` at import time, exactly as today. No constructor pattern or init() call.

**Alternative considered:** Explicit initialization (`init({ apiBase, projectId, ... })`). Rejected for this phase — it would change the user-facing API. The env-var pattern is what Lambda and local dev both inject, and it works. A future Workers change could add an optional `init()` alongside the env-var default.

### 5. Lambda layer consumes the package via npm install

`build-layer.sh` changes from a heredoc to:

```bash
# Before: cat > node_modules/@run402/functions/index.js << 'HELPERJS' ...
# After:
npm install @run402/functions@^1.0.0
```

The layer continues to also install convenience deps (stripe, openai, etc.) — those stay in the layer's `package.json`, not in `@run402/functions`.

### 6. Local dev resolves from workspace

The gateway's local function execution (`writeLocalFunction()` in `functions.ts`) currently inlines the helper code into each `.mjs` file. After extraction:

- `packages/functions/` is a workspace member, so `@run402/functions` resolves via node_modules symlink
- Local dev writes user code to `.mjs` files that `import { db } from '@run402/functions'` — the import resolves to the workspace package
- Remove the entire inline helper block from `functions.ts`

### 7. Add to monorepo workspaces

Add `packages/functions` to root `package.json` workspaces array. This enables workspace resolution for local dev and lets CI build/test the package alongside the gateway.

## Risks / Trade-offs

**[Risk] Published package version drifts from layer** → Pin the package version in the layer's `package.json`. The layer build always runs `npm install` fresh, so it picks up the pinned version. Document the version bump + layer republish flow.

**[Risk] Breaking local dev during transition** → Test the workspace resolution path before removing the inline code. The inline removal is the riskiest part — verify `import { db } from '@run402/functions'` resolves correctly in dynamically `import()`ed `.mjs` files written to disk.

**[Risk] npm publish access** → Need npm org access for `@run402` scope. If the scope isn't claimed yet, register it. Alternatively, publish as `run402-functions` (unscoped) if org setup is blocked.

**[Trade-off] Package is Node.js-only for now** → Acceptable. The only consumer is Lambda (Node 22). Document the Node.js requirement in package.json `engines` field. The `jose` migration is a known future step.

**[Trade-off] Convenience deps stay in layer, not package** → Users can't `npm install @run402/functions` and get stripe/openai locally. But bundling those would bloat the package and create version conflicts. Users who want to test locally can install them separately. Document this.

## Migration Plan

1. Create `packages/functions/` with TypeScript source, compile, verify types
2. Add to workspace, verify gateway's local dev resolves the import
3. Publish v1.0.0 to npm
4. Update `build-layer.sh` to `npm install @run402/functions`
5. Rebuild + publish new Lambda layer
6. Update `LAMBDA_LAYER_ARN` in `pod-stack.ts`, redeploy CDK
7. Update `functions.ts` to remove inline helper code
8. Deploy gateway

**Rollback:** Revert `LAMBDA_LAYER_ARN` to previous layer version. Old layer has the inlined helper — instant rollback. Gateway can be reverted independently.
