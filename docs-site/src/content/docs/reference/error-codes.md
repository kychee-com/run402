---
title: Error codes (R402_*)
description: Stable R402_* error-envelope codes returned by Run402's Astro/SSR runtime, deploy pipeline, SDK and cache layer, with suggested fixes.
---

Stable error codes returned from Run402 Astro SSR runtime deployments, runtime, SDK, and cache layer. Every code has the same envelope shape:

```json
{
  "ok": false,
  "code": "R402_*",
  "message": "human description",
  "suggestedFix": "concrete action the agent/dev should take",
  "docs": "https://docs.run402.com/<topic>/<page>#<anchor>",
  "file": "src/pages/[slug].astro",
  "line": 14,
  "stage": "snapstart_validate"
}
```

`file`, `line`, `stage`, `activated`, `requestId` are optional and present when applicable.

---

## Build / deploy time

### `R402_ASTRO_BUILD_FAILED`

Astro's own build pipeline threw an unrecovered error. `message` carries the compiler error summary; `file` / `line` when statically determinable.

**Suggested fix:** check the build log for the specific Astro compiler error and address it (typically a syntax error, type error, or missing import in a `.astro` page).

**Docs:** `https://docs.run402.com/astro/errors#build-failed`

---

### `R402_ASTRO_UNSUPPORTED_OUTPUT`

`output: '...'` mode is not supported by the Run402 adapter. v1 supports `'server'`, `'static'`, and (deprecated) `'hybrid'` only.

**Suggested fix:** use `output: 'server'` and opt-in to per-route static prerender via `export const prerender = true;` in any page that should be pre-built.

**Docs:** `https://docs.run402.com/astro/errors#unsupported-output`

---

### `R402_ASTRO_MIDDLEWARE_UNSUPPORTED`

Astro middleware at `src/middleware.ts` is supported by Run402, but a specific middleware pattern hit an implementation snag (typically context-propagation incompatibility). When this code surfaces, the middleware ran but its behavior may diverge from Astro defaults.

**Suggested fix:** move auth-gating logic from `src/middleware.ts` into individual page frontmatter OR API endpoint handlers. Use `Astro.locals.run402.requestId` / cookie reading on the page.

**Docs:** `https://docs.run402.com/astro/errors#middleware-unsupported`

---

### `R402_ASTRO_SERVER_ISLAND_UNSUPPORTED`

Found a `server:defer` or `server:only` directive. Server islands are deferred to v1.5.

**Suggested fix:** use client islands (`client:load`, `client:idle`, `client:visible`) instead, OR move the rendering into the page's frontmatter at SSR time.

**Docs:** `https://docs.run402.com/astro/errors#server-islands-unsupported`

---

### `R402_ASTRO_SESSIONS_UNSUPPORTED`

Found `Astro.session.*` access OR `experimental: { session: ... }` in `astro.config.mjs`. Sessions API deferred to v1.5+.

**Suggested fix:** use signed HTTP-only cookies via `Astro.cookies` OR a custom DB-backed session via `db()` to persist session state.

**Docs:** `https://docs.run402.com/astro/errors#sessions-unsupported`

---

### `R402_ASTRO_DYNAMIC_IMAGE_UNSUPPORTED`

Found `<Image src={expr}>` where `expr` is not statically resolvable (DB-row property access, function call, environment variable, frontmatter value, etc.).

**Suggested fix:** for CMS images, store the full `AssetRef` JSON from `assets.put()` at upload time and render with `<Run402Picture asset={page.hero_asset} />`. For build-time static images, use `<Image src="./hero.jpg">` with a string literal OR `import hero from "../assets/hero.png"; <Image src={hero} />` with a static import binding.

**Docs:** `https://docs.run402.com/astro/images#dynamic-cms-images`

---

### `R402_ASTRO_VERSION_UNSUPPORTED`

Installed `astro` version is outside the Run402 adapter's pinned peer-range.

**Suggested fix:** check `package.json` and pin Astro to `^6.0.0` (or the range documented in `@run402/astro`'s peerDependencies). Run `npm install astro@^6`.

**Docs:** `https://docs.run402.com/astro/errors#version-unsupported`

---

### `R402_BUNDLE_UNRESOLVED_IMPORT`

The deploy bundler couldn't resolve an `import` in a function file.

**Suggested fix:** check the import path is correct; ensure the package is in `package.json`'s `dependencies` (NOT `devDependencies`); run `npm install`.

**Docs:** `https://docs.run402.com/functions/errors#unresolved-import`

---

### `R402_BUNDLE_NATIVE_DEP_UNSUPPORTED`

The function bundle includes a package with native binary components (e.g., `sharp`, `better-sqlite3`, `node-gyp`-built packages). Lambda's Node.js runtime cannot load arbitrary native binaries.

**Suggested fix:** remove the native dependency OR replace with a Run402 primitive — `r.assets.put` for image processing (returns the v1.49 variant ladder + blurhash + display URLs), `r.ai.*` for ML, `r.email.send` for emails, `db()` for SQLite-style storage.

**Docs:** `https://docs.run402.com/functions/errors#native-deps-unsupported`

---

## SnapStart

### `R402_SNAPSTART_INIT_IO`

The SSR-class function did network/database IO at module scope, which SnapStart cannot snapshot consistently. Three places this surfaces:

1. **Deploy-time pre-activation validation** — `waitUntilPublishedVersionActive` failed to confirm a clean snapshot. The deploy still activates (function works without SnapStart's optimization), but the cold-start latency is the legacy ~600ms instead of the SnapStart ~120ms.
2. **Runtime guard in `@run402/functions`** — module-scope IO is intercepted and throws this code during snapshot init.
3. **Build-time static scan** — best-effort heuristic flags top-level `await` on known network primitives as a warning (not failure).

**Suggested fix:** move network/database calls from module scope INSIDE the request handler (Astro frontmatter or APIRoute body). Example:

```ts
// Wrong:
const settings = await db().from('settings').select('*');
export default async () => { /* uses settings */ };

// Right:
let settings: Setting[] | undefined;
export default async () => {
  if (!settings) settings = await db().from('settings').select('*');
  /* uses settings */
};
```

**Docs:** `https://docs.run402.com/functions/errors#snapstart-init-io`

---

## SDK

### `R402_SDK_OUTSIDE_REQUEST_CONTEXT`

An SDK function (`db`, `getUser`, `cache.*`, etc.) was called outside an active request context. Two common causes:

1. **Module scope** — calling an SDK function at the top level of a module file rather than inside a handler.
2. **Background timer / unawaited promise** — `setTimeout(() => db()..., 60000)` scheduled inside a handler, fires AFTER the response was materialized. The runtime context's `active.value` is set to `false` post-response so the timer's SDK call throws.

**Suggested fix:** move the SDK call inside an HTTP request handler. Don't schedule background work that outlives the response — use scheduled functions (`schedule: '0 */6 * * *'`) for periodic tasks instead.

**Docs:** `https://docs.run402.com/sdk/errors#outside-request-context`

---

### `R402_SSR_RUNTIME_ERROR`

The SSR Lambda function threw an uncaught exception during render. The response body contains the structured envelope (without stack trace). The full stack is logged to the request's log stream — retrieve via `run402 logs --request-id <req_xyz>`.

**Suggested fix:**
1. `run402 logs --request-id <req>` to fetch the full stack trace.
2. Fix the exception in the source (typically a null-deref, missing env var, or unhandled rejection).
3. Re-deploy.

**Docs:** `https://docs.run402.com/functions/errors#ssr-runtime-error`

---

## Cache layer

### `R402_CACHE_UNSUPPORTED_VARY`

A response has a `Vary` header referencing something other than `Accept-Language` (which is already encoded in the cache key as `locale`). The response is delivered normally to the client but is NOT cached. The bypass reason is also emitted via `x-run402-cache-reason: unsupported_vary`.

**Suggested fix:** remove the `Vary` header OR restructure the route so different variants live at different paths.

**Docs:** `https://docs.run402.com/cache/errors#unsupported-vary`

---

### `R402_CACHE_AUTH_TAINTED`

Informational diagnostic (NOT an `ok: false` error). The cache layer detected that the render called `getUser()` or a payment primitive and bypassed storage with `x-run402-cache-reason: auth`. This is the expected behavior — auth-dependent renders are uncacheable by design.

**Suggested fix:** none — this is correct behavior. If you want a page to be cacheable, ensure it doesn't call `getUser()` (use `Astro.cookies` directly if you need to check for cookie presence without flipping the taint flag — but consider whether that page should be cached at all).

**Docs:** `https://docs.run402.com/cache/concepts#auth-taint`

---

### `R402_CACHE_INVALIDATION_HOST_REQUIRED`

`cache.invalidate('/path')` (path-string form) was called outside a request context. The path-string form needs the current host from the ALS request context to scope correctly.

**Suggested fix:** use the absolute-URL form: `cache.invalidate(new URL('https://eagles.kychon.com/the-guys'))` OR `cache.invalidate('https://eagles.kychon.com/the-guys')`. Or move the call into a request handler.

**Docs:** `https://docs.run402.com/cache/errors#invalidation-host-required`

---

### `R402_CACHE_INVALIDATION_HOST_FORBIDDEN`

`cache.invalidate(<absolute URL>)` targeted a host that is NOT owned by the caller's authenticated project. Cross-project cache mutation is rejected for tenant isolation.

**Suggested fix:** use a host attached to your project. Run `run402 domains list` to see your project's attached hosts.

**Docs:** `https://docs.run402.com/cache/errors#invalidation-host-forbidden`

---

## Deploy

### `R402_DEPLOY_STAGE_FAILED`

The deploy pipeline failed at a specific stage of the multi-slice apply-v1 state machine. `stage` carries the stage name (`validate`, `stage`, `migrate`, `schema_settling`, `activating`, `snapstart_validate`, etc.).

**Suggested fix:** check the `stage` and the `message`. Common causes:
- `migrate` — SQL migration failed; fix the migration file or use the operator escape hatch.
- `schema_settling` — PostgREST didn't pick up the schema within the budget; usually transient, retry.
- `activating` — atomic activation failed; usually a constraint violation; check the underlying error.
- `snapstart_validate` — see `R402_SNAPSTART_INIT_IO` above.

**Docs:** `https://docs.run402.com/deploy/errors#stage-failed`

---

## Docs URL convention

All `docs` URLs follow the pattern `https://docs.run402.com/<topic>/<page>#<anchor>` where:

- `<topic>` ∈ `astro`, `functions`, `cache`, `deploy`, `cli`, `sdk`, `assets`
- `<page>` is a stable page name within the topic (`errors`, `images`, `concepts`)
- `<anchor>` matches a documented heading within the page

URLs are stable across releases. Anchors are not removed or renamed without a redirect.
