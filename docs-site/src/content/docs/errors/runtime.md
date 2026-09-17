---
title: runtime errors
description: Owned codes and recovery guidance.
---

[Error contracts and compatibility index](/errors/). Follow the actual response's message, field details and next actions. Never infer retry safety from the code name alone.

<h2 id="R402_ASTRO_ADAPTER_MANIFEST_">R402_ASTRO_ADAPTER_MANIFEST_</h2>

Owner: `public:cli/lib/deploy-v2.mjs`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_ADAPTER_MANIFEST_MISSING">R402_ASTRO_ADAPTER_MANIFEST_MISSING</h2>

Owner: `public:astro/src/release-slice.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_ADAPTER_MANIFEST_VERSION_UNSUPPORTED">R402_ASTRO_ADAPTER_MANIFEST_VERSION_UNSUPPORTED</h2>

Owner: `public:astro/src/release-slice.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_BUILD_FAILED">R402_ASTRO_BUILD_FAILED</h2>

Owner: `public:astro/src/ssr-adapter.ts`, `gateway:packages/gateway/src/utils/error-envelope.ts`.

Astro's own build pipeline threw an unrecovered error. `message` carries the compiler error summary; `file` / `line` when statically determinable.

**Suggested fix:** check the build log for the specific Astro compiler error and address it (typically a syntax error, type error, or missing import in a `.astro` page).


<h2 id="R402_ASTRO_DYNAMIC_IMAGE_UNSUPPORTED">R402_ASTRO_DYNAMIC_IMAGE_UNSUPPORTED</h2>

Owner: `public:astro/src/ssr-detectors.ts`, `gateway:packages/gateway/src/utils/error-envelope.ts`.

Found `<Image src={expr}>` where `expr` is not statically resolvable (DB-row property access, function call, environment variable, frontmatter value, etc.).

**Suggested fix:** for CMS images, store the full `AssetRef` JSON from `assets.put()` at upload time and render with `<Run402Picture asset={page.hero_asset} />`. For build-time static images, use `<Image src="./hero.jpg">` with a string literal OR `import hero from "../assets/hero.png"; <Image src={hero} />` with a static import binding.


<h2 id="R402_ASTRO_IMAGE_ALT_REQUIRED">R402_ASTRO_IMAGE_ALT_REQUIRED</h2>

Owner: `public:astro/src/components/Run402Image/core.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_IMAGE_ASSET_MISSING">R402_ASTRO_IMAGE_ASSET_MISSING</h2>

Owner: `public:astro/src/components/Run402Image/core.ts`, `public:astro/src/components/Run402Image/types.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_IMAGE_ASSET_STRING_URL">R402_ASTRO_IMAGE_ASSET_STRING_URL</h2>

Owner: `public:astro/src/components/Run402Image/core.ts`, `public:astro/src/components/Run402Image/types.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_IMAGE_ASSET_WRONG_SHAPE">R402_ASTRO_IMAGE_ASSET_WRONG_SHAPE</h2>

Owner: `public:astro/src/components/Run402Image/core.ts`, `public:astro/src/components/Run402Image/types.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_IMAGE_CONFLICTING_CLASS_PROPS">R402_ASTRO_IMAGE_CONFLICTING_CLASS_PROPS</h2>

Owner: `public:astro/src/components/Run402Image/core.ts`, `public:astro/src/components/Run402Image/types.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_IMAGE_CONFLICTING_LOADING_PROPS">R402_ASTRO_IMAGE_CONFLICTING_LOADING_PROPS</h2>

Owner: `public:astro/src/components/Run402Image/core.ts`, `public:astro/src/components/Run402Image/types.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_IMAGE_HEIC_NO_TRANSCODE">R402_ASTRO_IMAGE_HEIC_NO_TRANSCODE</h2>

Owner: `public:astro/src/components/Run402Image/core.ts`, `public:astro/src/components/Run402Image/types.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_IMAGE_NON_IMAGE_ASSET">R402_ASTRO_IMAGE_NON_IMAGE_ASSET</h2>

Owner: `public:astro/src/components/Run402Image/core.ts`, `public:astro/src/components/Run402Image/types.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_IMAGE_RESERVED_DATA_ATTR">R402_ASTRO_IMAGE_RESERVED_DATA_ATTR</h2>

Owner: `public:astro/src/components/Run402Image/core.ts`, `public:astro/src/components/Run402Image/types.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_IMAGE_SIZES_REQUIRED">R402_ASTRO_IMAGE_SIZES_REQUIRED</h2>

Owner: `public:astro/src/components/Run402Image/core.ts`, `public:astro/src/components/Run402Image/types.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_IMAGE_STRICT_DEGRADED">R402_ASTRO_IMAGE_STRICT_DEGRADED</h2>

Owner: `public:astro/src/components/Run402Image/core.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_IMAGE_WRONG_ENTRY_POINT">R402_ASTRO_IMAGE_WRONG_ENTRY_POINT</h2>

Owner: `public:astro/src/components/Run402Image/types.ts`, `public:astro/src/components/Run402Image.astro`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_MIDDLEWARE_UNSUPPORTED">R402_ASTRO_MIDDLEWARE_UNSUPPORTED</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

An unsupported middleware pattern was detected. Inspect the diagnostic and use the supported request-context middleware or page/endpoint auth helpers. This code alone does not prove the middleware ran successfully.

<h2 id="R402_ASTRO_SDK_VERSION_TOO_OLD">R402_ASTRO_SDK_VERSION_TOO_OLD</h2>

Owner: `public:astro/src/release-slice.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_ASTRO_SERVER_ISLAND_UNSUPPORTED">R402_ASTRO_SERVER_ISLAND_UNSUPPORTED</h2>

Owner: `public:astro/src/ssr-detectors.ts`, `gateway:packages/gateway/src/utils/error-envelope.ts`.

Found a `server:defer` or `server:only` directive. Server islands are unsupported.

**Suggested fix:** use client islands (`client:load`, `client:idle`, `client:visible`) instead, OR move the rendering into the page's frontmatter at SSR time.


<h2 id="R402_ASTRO_SESSIONS_UNSUPPORTED">R402_ASTRO_SESSIONS_UNSUPPORTED</h2>

Owner: `public:astro/src/ssr-detectors.ts`, `gateway:packages/gateway/src/utils/error-envelope.ts`.

The installed adapter rejects Astro Sessions API usage. Remove that configuration and use the supported hosted authentication/session helpers for app login. Application-owned session systems require their own cookie, CSRF, expiry and revocation design; a plain cookie is not an equivalent replacement.

<h2 id="R402_ASTRO_UNSUPPORTED_OUTPUT">R402_ASTRO_UNSUPPORTED_OUTPUT</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The requested output mode is unsupported by the installed adapter. Use the supported `server` preset and per-route `export const prerender = true` for build-time pages. Consult the installed package peer range before upgrading Astro.

<h2 id="R402_ASTRO_VERSION_UNSUPPORTED">R402_ASTRO_VERSION_UNSUPPORTED</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The installed Astro version is outside the adapter peer range. Check the installed `@run402/astro` package; this source revision supports Astro `>=6 <8`. Install a version inside that range and rebuild.

<h2 id="R402_BACKFILL_CHECKPOINT_CONFLICT">R402_BACKFILL_CHECKPOINT_CONFLICT</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_BACKFILL_HEIC_TRANSCODE_FAILED">R402_BACKFILL_HEIC_TRANSCODE_FAILED</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_BUNDLE_NATIVE_DEP_UNSUPPORTED">R402_BUNDLE_NATIVE_DEP_UNSUPPORTED</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The function bundler rejected a native binary dependency. Replace it with a supported dependency or application runtime helper. Use the CLI asset workflow for operating uploads; application-side image, database, AI and email calls belong in their supported runtime APIs.

<h2 id="R402_BUNDLE_UNRESOLVED_IMPORT">R402_BUNDLE_UNRESOLVED_IMPORT</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The deploy bundler couldn't resolve an `import` in a function file.

**Suggested fix:** check the import path is correct; ensure the package is in `package.json`'s `dependencies` (NOT `devDependencies`); run `npm install`.


<h2 id="R402_CACHE_AUTH_TAINTED">R402_CACHE_AUTH_TAINTED</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

An auth-dependent render bypassed public cache storage. This is expected isolation behavior. Keep personalized responses uncacheable; do not bypass auth helpers or read cookies directly merely to avoid cache taint.

<h2 id="R402_CACHE_INVALIDATION_HOST_FORBIDDEN">R402_CACHE_INVALIDATION_HOST_FORBIDDEN</h2>

Owner: `public:sdk/src/namespaces/cache.ts`, `public:cli/lib/cache.mjs`, `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/cache.ts`.

`cache.invalidate(<absolute URL>)` targeted a host that is NOT owned by the caller's authenticated project. Cross-project cache mutation is rejected for tenant isolation.

**Suggested fix:** use a host attached to your project. Run `run402 domains list` to see your project's attached hosts.


<h2 id="R402_CACHE_INVALIDATION_HOST_REQUIRED">R402_CACHE_INVALIDATION_HOST_REQUIRED</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/cache.ts`.

`cache.invalidate('/path')` (path-string form) was called outside a request context. The path-string form needs the current host from the ALS request context to scope correctly.

**Suggested fix:** use the absolute-URL form: `cache.invalidate(new URL('https://eagles.kychon.com/the-guys'))` OR `cache.invalidate('https://eagles.kychon.com/the-guys')`. Or move the call into a request handler.


<h2 id="R402_CACHE_UNSUPPORTED_VARY">R402_CACHE_UNSUPPORTED_VARY</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

The cache cannot safely partition this response by its requested Vary dimensions, so it bypasses storage. Preserve the response’s correctness and privacy. Use supported cache-key dimensions or separate public paths only when that preserves the application semantics; do not delete Vary merely to force caching.

<h2 id="R402_DB_QUERY_ERROR">R402_DB_QUERY_ERROR</h2>

Owner: `core:packages/functions/src/db.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_DB_SQL_ERROR">R402_DB_SQL_ERROR</h2>

Owner: `core:packages/functions/src/db.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_DB_SQL_RESULT_SHAPE">R402_DB_SQL_RESULT_SHAPE</h2>

Owner: `core:packages/functions/src/db.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_DEPLOY_STAGE_FAILED">R402_DEPLOY_STAGE_FAILED</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

Inspect the reported stage, operation identity, field diagnostics and next actions. Resolve the failing input or dependency, then follow the returned resume/retry action only when permitted. An ambiguous activation result requires inspection; promotion does not reverse migrations.

<h2 id="R402_DOCTOR_AUTH_SESSION_MINT_CAPABILITY_MISSING">R402_DOCTOR_AUTH_SESSION_MINT_CAPABILITY_MISSING</h2>

Owner: `public:sdk/src/node/source-scan.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_FUNCTION_RUN_INVALID_INPUT">R402_FUNCTION_RUN_INVALID_INPUT</h2>

Owner: `core:packages/functions/src/function-runs.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_FUNCTION_RUN_MISSING_CONTEXT">R402_FUNCTION_RUN_MISSING_CONTEXT</h2>

Owner: `core:packages/functions/src/function-runs.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_PAYMENT_FULFILLMENT_CONTEXT_EXPIRED">R402_PAYMENT_FULFILLMENT_CONTEXT_EXPIRED</h2>

Owner: `core:packages/functions/src/payment.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_PAYMENT_FULFILLMENT_DIRECTIVE_INVALID">R402_PAYMENT_FULFILLMENT_DIRECTIVE_INVALID</h2>

Owner: `core:packages/functions/src/payment.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_PAYMENT_FULFILLMENT_OUTSIDE_ROUTED_REQUEST">R402_PAYMENT_FULFILLMENT_OUTSIDE_ROUTED_REQUEST</h2>

Owner: `core:packages/functions/src/payment.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_PAYMENT_FULFILLMENT_RECEIPT_NOT_ENABLED">R402_PAYMENT_FULFILLMENT_RECEIPT_NOT_ENABLED</h2>

Owner: `core:packages/functions/src/payment.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_PAYMENT_FULFILLMENT_UNSETTLED">R402_PAYMENT_FULFILLMENT_UNSETTLED</h2>

Owner: `core:packages/functions/src/payment.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_PROTECTED_REF_NAMESPACE">R402_PROTECTED_REF_NAMESPACE</h2>

Owner: `public:cli/lib/remote-helper-session.mjs`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="R402_SDK_OUTSIDE_REQUEST_CONTEXT">R402_SDK_OUTSIDE_REQUEST_CONTEXT</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`, `core:packages/functions/src/runtime-context.ts`.

A request-scoped runtime helper was called during module initialization or after its request ended. Move the awaited call into a request handler. Use a declared scheduled trigger and durable function run for work that must outlive a response; do not rely on an unawaited timer.

<h2 id="R402_SNAPSTART_INIT_IO">R402_SNAPSTART_INIT_IO</h2>

Owner: `gateway:packages/gateway/src/utils/error-envelope.ts`.

Move network and database work from module initialization into the request handler. Inspect the deployment report for whether activation occurred and whether a resume is available. This diagnostic alone does not establish activation, snapshot success or a latency guarantee.

<h2 id="R402_SSR_RUNTIME_ERROR">R402_SSR_RUNTIME_ERROR</h2>

Owner: `public:astro/src/runtime/server.ts`, `gateway:packages/gateway/src/utils/error-envelope.ts`.

The SSR render failed. Use `run402 logs --request-id <actual-request-id> --project <project-id>` and inspect the available application logs. Fix the reported source or configuration issue and redeploy. Public diagnostics omit private stack information; exact log detail depends on the runtime and its redaction policy.

<h2 id="RUN402_ASTRO_LEADING_SLASH_SRC">RUN402_ASTRO_LEADING_SLASH_SRC</h2>

Owner: `public:astro/src/errors.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="RUN402_ASTRO_MISSING_ASSET_REF">RUN402_ASTRO_MISSING_ASSET_REF</h2>

Owner: `public:astro/src/errors.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="RUN402_ASTRO_MISSING_PROJECT_ID">RUN402_ASTRO_MISSING_PROJECT_ID</h2>

Owner: `public:astro/src/errors.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="RUN402_ASTRO_SOURCE_NOT_FOUND">RUN402_ASTRO_SOURCE_NOT_FOUND</h2>

Owner: `public:astro/src/errors.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.

<h2 id="RUN402_ASTRO_UNSUPPORTED_EXTENSION">RUN402_ASTRO_UNSUPPORTED_EXTENSION</h2>

Owner: `public:astro/src/errors.ts`.

The adapter or runtime reported this diagnostic. Inspect its message, source location and suggested fix; check the installed package version and supported features. Correct the named input or request-context usage before rebuilding or deploying.
