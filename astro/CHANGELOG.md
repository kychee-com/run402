# Changelog

All notable changes to `@run402/astro`.

## 2.0.0 (paired with `@run402/functions` v3.0 + gateway v1.60/v1.61 — `auth-aware-ssr`)

### Added

- **Hosted-auth chrome components** at `@run402/astro/components`:
  - `<SignIn />` — anonymous-only email/password form posting to
    `/auth/sign-in`. Carries no client-side JS; the platform mints the
    cookie + 303-redirects on success.
  - `<SignUp />` — mirror of `<SignIn />`, posts to `/auth/sign-up`.
  - `<UserButton />` — signed-in chrome rendering the user's email
    alongside a POST sign-out form. Embeds the platform's double-submit
    CSRF token derived from `auth.csrfToken()`.
  - `<SignedIn>…</SignedIn>` / `<SignedOut>…</SignedOut>` — conditional
    render gates. SSR-only: read the actor from `await auth.user()`.
    Calling either from a prerendered page throws
    `R402_AUTH_PRERENDERED`.

- Per-component `./components/SignIn.astro` etc. subpath exports for
  consumers who want direct file imports.

### Changed

- **BREAKING** — `peerDependencies["@run402/functions"]` bumped to
  `^3.0.0`. The component implementations import `auth.user()` /
  `auth.csrfToken()` from the new SDK namespace.

- Description + keywords updated to surface the auth-aware-SSR
  capability alongside the image-optimization story.

## Unreleased

### Added

- `<SignIn methods={["magic_link"]} />` now supports
  `emailDelivery="link" | "code" | "both"`. When the prop is omitted, managed
  SSR checks provider discovery and chooses both only when advertised,
  otherwise falling back to link. Both mode keeps the opaque challenge handle
  in the originating page, presents one labelled six-digit input
  (`inputmode="numeric"`, `autocomplete="one-time-code"`), and retains the
  emailed link as fallback. Normal form submission remains the no-JS baseline;
  enhancement avoids navigating away and replaces a resend handle only after
  an accepted response. Password-only output remains byte-identical. This is
  an additive minor component release.

### Changed

- **Astro 7 compatibility.** `peerDependencies.astro` now accepts `>=6 <8`, and the workspace dev dependency moved to `astro ^7.0.0` so the `@run402/astro` package tests and build exercise the latest supported Astro major. Astro 6 remains supported; Astro 5 remains outside the supported peer range because the SSR adapter requires `astro/app/entrypoint`. This compatibility update does **not** adopt Astro 7-only route caching, advanced routing through `src/fetch.ts`, or any new Run402 cache/route semantics.

### Fixed

- **`<Run402Image>`'s Astro and React entries wrote different `style` attributes, and the React one could render differently.** React only takes object styles, so the React entry turned the merged style string into an object and React printed it again. That dropped spaces inside declarations, so `color: red` became `color:red`. A repeated property kept its first position with its last value, and the HTML entry kept both declarations. That reordering could put a caller's `background-size` in front of the caller's own later `background` shorthand, which then reset it. Custom properties were mangled, so `--brand-color` printed as `-BrandColor`. Both entries now write one canonical form, for string and object `style` alike:
  - each property appears once, at the position of its winning declaration, which leaves the rendered result unchanged;
  - a normal declaration does not displace an earlier `!important` one;
  - declarations are written `name:value`, trimmed, and joined by one `;`;
  - property names are lowercased, except custom properties;
  - empty values are dropped.

  Object keys accept vendor prefixes (`WebkitLineClamp`, `msTransform`) and custom properties. The bytes in a `style` attribute can change, but what the browser renders does not, except in the React entry, where the reordering bug is fixed.

- **`<Run402Image priority>` emitted two image preloads under React 19 SSR, and its preload dropped `crossorigin` / `referrerpolicy`.** React 19's server renderer preloads every non-lazy `<img>` outside `<picture>` on its own and does not dedupe that against a rendered `<link rel="preload">` element, so a bare AssetRef (no `variants`) rendered through `@run402/astro/react` carried two preloads for the same URL. On React 19 the React entry now hands its preload to `ReactDOM.preload()` instead of rendering a `<link>`: React keys it like its automatic image preload, so exactly one `<link>` is written, hoisted into the document head (or the preamble of a fragment render). React 18, which has neither `ReactDOM.preload()` nor the automatic preload, still gets the `<link>` element. Separately, on both entry points and for both the bare `<img>` and the `<picture>` path, the preload now carries the image's `crossorigin` and `referrerpolicy`: a browser only reuses a preload made in the same CORS mode, so a CORS-mode image was fetched twice and reported as an unused preload. The `registerPreload` hook's `PreloadAttrs` gains the same two fields. The preload `<link>`'s attribute order now follows `ReactDOM.preload()` (`rel`, `href`, `as`, `crossorigin`, `type`, `fetchpriority`, `referrerpolicy`, `imagesrcset`, `imagesizes`), and the anonymous CORS mode is written `crossorigin=""`, the equivalent HTML value React uses, so the Astro and React outputs stay identical apart from attribute-name case.

- **`<Run402Image>` merged a string `style` into the blurhash placeholder style without a `;`.** With a placeholder and `style="color:red;font-size:14px"`, the `<img>` got `…;background-position:centercolor:red;font-size:14px`, one invalid declaration, so the browser dropped both the placeholder's `background-position` (the blurhash tiled from the top-left) and the caller's first property. The merge now joins the two with exactly one `;`, and trims leading and trailing `;` and whitespace from the caller string, so an empty or `;`-only `style` adds nothing. Object-form `style` was not affected. Both the Astro and React entries share the fix, and their output stays byte-identical.

- **`<Run402Image>` from `@run402/astro/react` logged React "Invalid DOM property" warnings.** The React renderer passed HTML attribute names (`class`, `srcset`, `fetchpriority`, `crossorigin`, `referrerpolicy`, `imagesrcset`, `imagesizes`) to `createElement`, so every render warned in dev and in consumers' tests. It now passes React's DOM prop names (`className`, `srcSet`, `fetchPriority`, `crossOrigin`, `referrerPolicy`, `imageSrcSet`, `imageSizes`). React 19's SSR writes `srcSet`, `fetchPriority`, `referrerPolicy`, `imageSrcSet` and `imageSizes` in camelCase, so React output now differs from the Astro path only in the case of those attribute names, which HTML treats as equivalent. The byte-identity suites compare attribute names case-insensitively; values, order, quoting and escaping still have to match exactly.

- **`dist/run402/adapter.json` left out SSR routes on Astro 6/7.** The adapter built `routes[]` from the `routes` param of `astro:build:done`, which Astro 5 deprecated and Astro 6+ no longer passes, so it fell back to `pages[]`, which lists only prerendered pages. An all-SSR app got `"routes": []`, and a hybrid app's on-demand routes were missing. The adapter now collects RouteData in the `astro:routes:resolved` hook: on-demand routes are recorded as `prerender: false`, and each prerendered page from `pages[]` gets the resolved route that produced it (its `pattern` and whether it is a `page` or an `endpoint`). Prerendered endpoints such as `/rss.xml`, which Astro 7 leaves out of `pages[]`, are added from their resolved route. Astro-internal routes (`/_image`, server islands) and redirects are excluded. The older `routes`/`pages[]` fallbacks still apply when the hook does not fire. The only reader of `routes[]` is `buildAstroReleaseSlice`'s `cacheClass` option (`run402 deploy --dir` does not pass it), which maps prerendered entries into explicit `site.public_paths`.

- **`buildAstroReleaseSlice(dist, { cacheClass })` left every CSS/JS and `public/` file unreachable.** The option switches `site.public_paths` to explicit mode, where only declared paths are public, but it declared only the prerendered HTML. So `/_astro/*` stylesheets and scripts, favicons, and everything else in the client dir returned 404. The explicit map now declares every file the deploy uploads from `dist/run402/client/` at the paths implicit mode would give it (`/<file>`, plus `/<dir>/` for an `index.html`), using the SDK's own `fileSetFromDir` walk so no declared path names a skipped file. Only prerendered pages carry `cacheClass`; the gateway infers every other class, prerendered endpoints such as `/rss.xml` included (previously mapped to the nonexistent asset `rss.xml/index.html`). A prerendered route whose asset is not in the client dir is no longer declared, which used to fail the deploy with a missing-asset error. `run402 deploy --dir` and the default (no `cacheClass`) slice were not affected.

- **Two Astro-core inputs still made the SSR bundle differ between builds of the same commit.** The SSR adapter now handles both in `astro:build:done`, whenever Astro emitted a server entry: (1) it sorts the `assets` list in Astro's serialized server manifest, which Astro collects with an unsorted async glob, so its order was a race (the runtime turns it into a Set, so order carries no meaning); the rewrite is scoped to the manifest's `"inlinedScripts"` → `"assets"` field pair, is whitespace-tolerant, and only reorders string elements; (2) it warns when `ASTRO_KEY` is unset, because Astro then mints a random encryption key per build and the `ssr` function is redeployed on every deploy. The README documents generating a key with `npx astro create-key` and setting it as a CI secret. Builds from different checkout paths still differ, because Astro's compiler bakes absolute source paths into the server bundle.

- **The SSR function's `code_hash` changed on every build, so every deploy redeployed the `ssr` Lambda even when no source changed.** Two non-deterministic inputs reached the SSR server bundle through `virtual:run402-assetmap`: the asset manifest's `generated_at` was the wall clock (`new Date()`), and the default-export `Map` (plus the `<Image src>` props the plugin rewrites into `.astro` sources) was keyed by absolute filesystem paths, so two checkouts of the same commit bundled different bytes. `generated_at` is now deterministic — `SOURCE_DATE_EPOCH` when set, otherwise `1970-01-01T00:00:00.000Z` — so the bundled manifest and the on-disk `_assets-manifest.json` always match; asset-map keys and rewritten `src` props are project-root-relative paths; and entries are sorted so upload completion order cannot leak in. Rebuilding the same commit, from any checkout path, now yields a byte-identical SSR bundle and `_assets-manifest.json`. Consumers that read `generated_at` as a build time should set `SOURCE_DATE_EPOCH` (for example to the commit time, `git log -1 --format=%ct`).

- **Npm-installed SSR adapter failed `astro build` with `Entry module "@run402/astro/runtime/server" cannot be external`.** The adapter now passes Astro an absolute installed `runtime/server.js` file path for `serverEntrypoint` instead of the package subpath string. Workspace/source builds masked this; consuming the published package exposed it.

- **Too-loose Astro peer floor caused a cryptic build failure on Astro 5.** `peerDependencies.astro` was `>=5 <7`, but the SSR runtime (`src/runtime/server.ts`) does `await import("astro/app/entrypoint")` — a specifier Astro 5 does not export (Astro 5.18.2 ships only `./app` and `./app/node`; `./app/entrypoint` first appears in Astro 6). A consumer on Astro 5 using the default `export default run402()` preset (or `createRun402Adapter()`) therefore aborted during `astro build`'s "Building server entrypoints" step with the opaque `[commonjs--resolver] Missing "./app/entrypoint" specifier in "astro" package` — the `try/catch` in `getAstroApp()` does not help because Vite resolves the specifier at bundle time, before the runtime guard runs. Raised the peer floor to Astro 6 and now declare `>=6 <8`, so the supported window matches the SSR adapter requirement and the Astro 7 compatibility validation. The build-time image integration (`run402Image()` / the named `run402` alias, used without the SSR adapter) never bundles `runtime/server.ts` and may run on Astro 5, but Astro 5 is no longer in the supported peer range.

- **`createRun402Adapter` incompatible with Astro 6** ([#403](https://github.com/kychee-com/run402/issues/403)). `astro build` on Astro 6.x previously aborted with `NoAdapterInstalled` even when the adapter was wired up, and printed a deprecation warning about `entrypointResolution: "explicit"` plus an `[ERROR] [config] adapter does not currently support sharp` line. Root cause was a mix of stale Astro-5-era adapter API usage: the adapter omitted `entrypointResolution` (defaulting to deprecated `"explicit"`), declared the legacy `exports: ["handler", "default"]` array, did not declare `sharpImageService` support, and the `run402()` preset pushed the adapter into `integrations[]` instead of the `adapter:` field — leaving `config.adapter` empty so Astro 6's check `!config.adapter && buildOutput === 'server'` threw `NoAdapterInstalled`. Fix:
  - Adapter now declares `entrypointResolution: "auto"` (Astro 6 recommended path) and drops the deprecated `exports` array — `runtime/server.ts` already exports `handler` + `default` directly.
  - Adapter declares `sharpImageService: "stable"` in `supportedAstroFeatures`.
  - Adapter no longer forces `adapterFeatures.buildOutput: "server"` — Astro derives the build shape from `output` + per-page `prerender`.
  - `run402()` preset returns `{ adapter: createRun402Adapter(...) }` on the top-level config (where Astro 6 looks for it) instead of pushing it into `integrations[]`.
  - `runtime/server.ts` migrated from the Astro-5 `manifest.mjs` + `new App(manifest)` pattern to Astro 6's `createApp()` from `astro/app/entrypoint` — Vite no longer fails to resolve `./manifest.mjs` because the virtual entrypoint module bakes the manifest in.
  - `astro:build:done` no longer uses `new URL("./...", pathnameString)` (invalid base) for the client dir — uses `path.join(buildOutputDir, "...")` against the resolved filesystem path instead.
  Devdep bumped to `astro ^7.0.0` so package validation exercises the latest supported Astro major; **the SSR adapter portion requires Astro 6+ at runtime** (`runtime/server.ts` imports `astro/app/entrypoint`), so the peer dep range is `>=6 <8` (see the dedicated entries above). The image-only `run402Image()` integration may still run on Astro 5 but is no longer inside the supported peer range. Users on the integrations-array pattern should migrate to `adapter: createRun402Adapter()`:

  ```ts
  // Before (Astro 5, broken on Astro 6):
  import { defineConfig } from "astro/config";
  import { createRun402Adapter } from "@run402/astro";
  export default defineConfig({
    integrations: [createRun402Adapter()],
  });

  // After (Astro 6):
  import { defineConfig } from "astro/config";
  import { createRun402Adapter } from "@run402/astro";
  export default defineConfig({
    adapter: createRun402Adapter(),
  });

  // Or, with the preset (handles the above for you):
  import run402 from "@run402/astro";
  export default run402();
  ```
- **Stale `dist/_assets-manifest.json` entries missing v1.54 AssetRef fields.** The build cache at `node_modules/.run402/assetMap.json` stores AssetRefs verbatim by source SHA; when the gateway started emitting `blurhash_data_url` + `asset_schema` (v1.54), existing caches kept returning pre-v1.54 AssetRefs on hit, silently producing manifests that looked correct (legacy fields populated) but lacked the v1.54 additions. Bumped `CACHE_SCHEMA_VERSION` from `1` to `2` so existing caches invalidate on first run after upgrade. Reproducer: `rm -f node_modules/.run402/assetMap.json && npm run build` then `jq '.assets[<key>] | {blurhash_data_url, asset_schema}' dist/_assets-manifest.json` populates both fields.

### Changed

- **`AssetRef` widened to mirror the current SDK shape.** Adds the v1.50 metadata + EXIF fields (`metadata`, `image_format`, `image_info`, `image_exif`, `image_exif_policy`) and v1.54 shape-contract fields (`blurhash_data_url`, `asset_schema`) the runtime already passed through. Plus the supporting `AssetMetadata` + `ExifPolicy` exports. Strictly additive — pre-existing consumers continue to type-check unchanged, but `as any` casts at field-access sites can now be removed.

### Internal

- New cache.ts header documents the AssetRef-field-add → cache-version-bump discipline that prevents future occurrences of this bug; `cache.test.ts` gains a v1 → v2 migration regression test and a v1.54-field roundtrip guard.

## 1.0.0-alpha.1 — unreleased

The agent-DX-locked default-export preset (Finding 5 in the design-review consultation). One-line `astro.config.mjs`:

```ts
import run402 from "@run402/astro";
export default run402();
```

returns a complete `AstroUserConfig` composing the image integration AND the SSR adapter. `output: 'server'` by default. Toggle either off via `images: false` / `ssr: false`. Compose alongside other integrations via `integrations: [...]`.

### Added

- **`run402` default export** — `(options?: Run402PresetOptions) => AstroUserConfig`. The agent-facing one-liner.
- **`run402Image`** — named export of just the image integration (the v0.2.x default behavior, renamed for clarity). Returns `AstroIntegration` for use in custom Astro configs.
- **`run402` named export aliased to `run402Image`** — v0.2.x users who wrote `import { run402 } from '@run402/astro'; integrations: [run402()]` continue to work unchanged.
- **`Run402PresetOptions`** type — extends `Run402AstroOptions` (the v0.2.x image options) with `output`, `integrations`, `site`, `images`, `ssr` controls for the preset.

### Migration from v0.2.x / v0.3.0-alpha

- **No code change required** if you used `import { run402 } from '@run402/astro'` — the named export `run402` is aliased to `run402Image` and still returns an `AstroIntegration`.
- **Recommended migration:** switch to the default export preset for one-line config:
  ```ts
  // Old (still works):
  import { run402 } from "@run402/astro";
  export default defineConfig({ integrations: [run402()] });

  // New (recommended):
  import run402 from "@run402/astro";
  export default run402();
  ```

## 0.3.0-alpha.1 — superseded by 1.0.0-alpha.1

Capability `astro-ssr-runtime` ([openspec change in run402-private](https://github.com/kychee-com/run402-private/tree/main/openspec/changes/astro-ssr-runtime)). Adds the SSR adapter primitives alongside the existing v0.2.x image integration. Additive — `integrations: [run402()]` users see zero breaking changes.

### Added

- **`createRun402Adapter(options?)` — Astro adapter factory.** New named export from `@run402/astro` (and via subpath `@run402/astro/ssr-adapter`). Returns an `AstroIntegration` that:
  - Registers itself as the deploy adapter via `setAdapter({ serverEntrypoint: '@run402/astro/runtime/server', ... })` in `astro:config:done`.
  - Configures the server build to land at `dist/run402/server/entry.mjs` (consumed by `run402 deploy`'s multi-slice ReleaseSpec emitter).
  - Runs build-time detectors for unsupported Astro features (dynamic `<Image>`, server islands, sessions API) at `astro:build:setup` and hard-fails with structured `R402_ASTRO_*` errors.
  - Emits `dist/run402/adapter.json` at `astro:build:done` — manifest the Run402 CLI reads to assemble the ReleaseSpec.
- **`detectDynamicImage`, `detectServerIslands`, `detectSessionsApi`** — build-time detector helpers, also exported from `@run402/astro/ssr-detectors`. Allow static-import `<Image src={hero}>` (where `hero` is an imported asset) while rejecting runtime `<Image src={page.heroUrl}>` (DB-sourced, function-call, env-var). Throw `Run402AstroDetectorError` with `code`, `message`, `suggestedFix`, `docs`, `file`, `line`.
- **`@run402/astro/runtime/server` — SSR Lambda entry shim.** The `serverEntrypoint` Astro's build wires to via `setAdapter`. Wraps `App.render(request)` in `runWithContext` (dynamically imported from optional peer dep `@run402/functions` — falls back to a no-op ALS scope when absent). Materializes the response body inside the ALS scope, flips `context.active.value = false` post-materialization, returns the user response alongside a `__r402_ssr_metadata` envelope (`{ cacheBypassTainted, runtimeError? }`) that the gateway reads to drive the ISR cache layer.
- **`<Run402Picture asset={AssetRef}>` component.** New subpath: `@run402/astro/components/Run402Picture.astro`. Renders a `<picture>` from a runtime-stored AssetRef (the typical Kychon CMS pattern: admin uploads via `assets.put()`, stores the returned AssetRef JSON in a DB column, page frontmatter fetches the row and passes `page.hero_asset` to the component). Emits WebP srcset (320w/800w/1920w) when variants are present; falls back to a safe single `<img>` from `display_url` / `cdn_url` / `variants.display_jpeg.cdn_url` (HEIC sources). Validates URL schemes against `javascript:` / `data:` / other unsafe schemes; emits runtime warning + drops the URL on detection. `priority` prop sets `fetchpriority="high"` + `loading="eager"` + `decoding="sync"`. `blurhash` data-attribute emitted when present (decoder ships in `@run402/astro/blurhash` for client-side hydration).
- **Optional peer dep `@run402/functions`** — required only when using `runtime/server` (the SSR adapter path); image-integration users don't need it.

### Subpath exports

- `@run402/astro/ssr-adapter` — `createRun402Adapter`, `Run402AdapterManifest`, `CreateRun402AdapterOptions`
- `@run402/astro/ssr-detectors` — `detectDynamicImage`, `detectServerIslands`, `detectSessionsApi`, `Run402AstroDetectorError`, `DetectorError`
- `@run402/astro/runtime/server` — `default` (the Lambda handler), `handler` (named alias)
- `@run402/astro/components/Run402Picture.astro` — the runtime picture component
- (unchanged) `.`, `./Image.astro`, `./manifest`, `./build-manifest`, `./blurhash`

### Roadmap

v1.0 will collapse this into a single default-exported `run402(options?): AstroUserConfig` factory so the agent-facing config is one line:

```ts
// astro.config.mjs (v1.0+)
import run402 from '@run402/astro';
export default run402();
```

v0.3.x ships the building blocks so adopters can start using SSR while the preset shape settles.

### Out of scope (deferred)

- v1.0 default-export preset shape (collapsing adapter + integration into one factory)
- Lambda response streaming through ECS Express (deferred to v1.5 — see `astro-ssr-runtime/specs/ssr-isr-cache/spec.md`)
- SWR via background revalidate (deferred to v1.5 — needs proper worker capture path)
- Runtime `/_image` endpoint (deferred — use the `<Run402Picture asset>` recipe for CMS images)

## 0.2.4 — 2026-05-19

(see git history for prior versions)
