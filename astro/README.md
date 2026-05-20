# @run402/astro

One-line Astro integration for Run402 image variants. Drop `<Image>` into your templates and get the v1.49 WebP variant ladder, HEIC `display_jpeg`, blurhash placeholder, and CDN-served immutable URLs - zero runtime function cost.

## Before you start

Four prerequisites must be true before `astro build` produces working `<picture>` markup. If any of these is missing, the build fails with an actionable error pointing at the exact CLI command to run — but skimming this checklist first saves a round-trip.

### 1. Project ID is set

```sh
# Either env var:
export RUN402_PROJECT_ID="prj_..."

# Or pass via the integration:
# astro.config.mjs → run402({ projectId: 'prj_...' })
```

### 2. Auth path matches your environment

The integration auto-detects which path you're on:

```sh
# Locally — provisions ~/.config/run402/projects.json
run402 login <project-id>

# In CI (GitHub Actions) — workflow needs id-token: write AND a Run402 binding for the repo
run402 ci link github --project <project-id> --repo <owner/repo>
```

GitHub Actions detection is automatic when `GITHUB_ACTIONS=true` is set (which GitHub sets for you). For non-GitHub CI, pass an explicit `credentials` provider via `run402({ credentials: ... })`.

### 3. CI binding has asset_key_scopes for your prefix

CI bindings are closed-by-default for the `spec.assets` slice. Grant the integration's default `astro/` prefix once per binding:

```sh
run402 ci list --project <project-id>                # find the binding id
run402 ci set-asset-scopes <binding-id> 'astro/*'    # grant the prefix
```

If you customized `assetPrefix` in `run402({ assetPrefix: 'my-app/' })`, grant `'my-app/*'` instead. **Local-laptop wallet deploys skip this check; only CI sessions hit it.**

### 4. Image CSS uses `height: auto` (or `aspect-ratio`)

The `<Image>` component emits explicit `width`/`height` HTML attributes from the source's intrinsic dimensions to prevent cumulative layout shift (CLS). Pair this with `height: auto` (or `aspect-ratio: <w>/<h>`) in your CSS, otherwise responsive `width: 100%` rules will stretch images vertically:

```css
/* In your global stylesheet — required for any responsive <Image> usage */
img {
  max-width: 100%;
  height: auto;
}
```

This is the same CLS-prevention contract as Next.js's `<Image>`. v0.1.x doesn't check this at build time; it's docs-only because consumer CSS can be arbitrarily complex.

## Why

Run402 v1.49 pre-encodes 3 WebP variants (320w / 800w / 1920w) + a display-friendly JPEG for HEIC sources + a blurhash placeholder for every image uploaded via the assets slice. Variants serve from CloudFront like any other static URL. This package wires that pipeline into Astro's build: walk your `<Image>` references, upload each unique source, render `<picture>` markup that consumes the variants.

Compared to Next.js's `<Image>` model: Vercel transforms images lazily via Lambda on cache miss. Run402's variants are encoded once at upload time and served as static immutable assets - **no per-request transform cost**.

## Install

```sh
npm install @run402/astro @run402/sdk
```

Astro 5 or 6 (peer dependency, optional declaration so install never blocks).

## Configure

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import { run402 } from '@run402/astro';

export default defineConfig({
  integrations: [run402()],
});
```

Set `RUN402_PROJECT_ID` in your environment (or pass `run402({ projectId: 'prj_...' })`). See the "Before you start" section above for the full credential + binding setup.

For non-GitHub CI (GitLab, CircleCI, etc.), or to wire a custom credential provider, pass `credentials` explicitly:

```js
import { githubActionsCredentials } from '@run402/sdk/node';
// or your own credential factory

export default defineConfig({
  integrations: [run402({
    projectId: 'prj_...',
    credentials: yourCustomCredentialProvider,
  })],
});
```

Locally (no `GITHUB_ACTIONS`), the SDK's `NodeCredentialsProvider` reads `~/.config/run402/projects.json` — same as the rest of the Run402 SDK / CLI tooling.

## Use

```astro
---
import Image from '@run402/astro/Image.astro';
---
<Image src="./images/hero.jpg" alt="Sunset over the Pacific" sizes="100vw" priority />

<Image src="./images/team-photo.heic" alt="Team retreat 2026" sizes="(min-width: 768px) 50vw, 100vw" />
```

`src` is resolved relative to the importing `.astro` file. TypeScript path aliases (`@/*`) also work if you have them in `tsconfig.json`.

**Note on the import shape.** `.astro` components have a single default export, so `import Image from '@run402/astro/Image.astro'` (default-import, subpath) is the only correct form. There is no `import { Image } from '@run402/astro'` named export — anything imported from `@run402/astro` must evaluate cleanly under vanilla Node so it can be loaded from `astro.config.mjs` before Vite is alive, and a top-level re-export of an `.astro` module breaks that boundary.

## Generated HTML

For an image source with v1.49 variants (≥ 320 pixels on both axes), the component emits:

```html
<picture>
  <source type="image/webp"
          srcset="https://cdn.run402.com/.../hero-thumb.webp 320w,
                  https://cdn.run402.com/.../hero-medium.webp 800w,
                  https://cdn.run402.com/.../hero-large.webp 1920w"
          sizes="100vw" />
  <img src="https://cdn.run402.com/.../hero.jpg"
       alt="Sunset over the Pacific"
       width="1600"
       height="1200"
       loading="eager"
       fetchpriority="high"
       style="background-image:url(data:image/png;base64,...);" />
</picture>
```

Width/height attributes prevent cumulative layout shift. The inlined blurhash data URI provides a low-quality image placeholder while the real bytes load.

For HEIC sources, the `<img>` fallback uses the generated `display_jpeg` variant (so non-HEIC-capable browsers - everything before Safari 14 - still render). The original HEIC bytes are preserved in CAS but never served via `<img>`.

For sources smaller than 320 pixels on either axis (logos, icons), the component falls back to a single `<img>` with a build warning.

## Props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `src` | `string` | required | Path relative to the importing file. Leading slashes are rejected. |
| `alt` | `string` | required | Alt text. Escaped for HTML. |
| `sizes` | `string` | `"100vw"` | Passed through to the `<source>` element. |
| `priority` | `boolean` | `false` | Above-the-fold opt-in: emits `loading="eager"` + `fetchpriority="high"`. |
| `loading` | `"lazy" \| "eager"` | `"lazy"` | Ignored when `priority` is set. |
| `width` | `number` | source width | Override width; height auto-recomputed preserving aspect ratio. |
| `height` | `number` | source height | Override height; width auto-recomputed preserving aspect ratio. |
| `class` | `string` | — | Passthrough to `<img>`. |
| `placeholder` | `"blurhash" \| "color" \| "none"` | `"blurhash"` | LQIP strategy. |

## Integration options

```js
run402({
  projectId: 'prj_...',        // overrides RUN402_PROJECT_ID env var
  assetPrefix: 'astro/',       // key prefix for uploaded blobs
  dryRun: false,               // when true, log references but don't upload
  verbose: false,              // print per-image upload events to stderr
})
```

## Build cache

On first build, every unique source is uploaded. Subsequent builds against unchanged sources are essentially free - the cache at `node_modules/.run402/assetMap.json` is keyed by source SHA-256. The cache directory is gitignored on first write (entry appended to project-root `.gitignore`).

Re-deploys with unchanged bytes:
- CAS dedup at the gateway means S3 stores one copy of each unique sha
- The encoder is a no-op for `(project, sha, v1)` tuples already present
- `bytes_reused` reflects the cached set; `bytes_uploaded` reflects new work only

## Dry run

```sh
ASTRO_INTEGRATIONS_LOG=true astro build
```

Or programmatically:

```js
run402({ dryRun: true })
```

Walks the project, lists every `<Image>` reference with its sha256 prefix and file size, estimates upload duration based on the v1.49 encoder semaphore (2 concurrent, ~10s per encode), and exits without uploading.

## Error handling

The integration fails the build (rather than silently falling back) when:

- `<Image src="/absolute">` - leading-slash paths refer to `public/` and bypass the variant pipeline
- Source file does not exist
- Extension is not one of `.jpg / .jpeg / .png / .webp / .avif / .heic / .heif`
- Gateway returns `IMAGE_DECODE_FAILED`, `IMAGE_INPUT_TOO_LARGE`, `IMAGE_ENCODE_TIMEOUT`, `QUOTA_EXCEEDED`
- Encoder queue stays full across 3 retries (`TOO_MANY_ENCODES_QUEUED`)

Each error names the offending file path so the build log points you at the right line.

## What this package does NOT do (v0.1)

- **Dynamic `src` expressions.** Only string literals are extracted. `<Image src={myImage}>` emits a build warning and skips that reference. v0.1 is for build-time-known image references; runtime-dynamic images (CMS-driven) keep using `r.assets.put` server-side.
- **Arbitrary widths.** The variant ladder is the v1.49 fixed set (320 / 800 / 1920). No `?w=437` lazy transforms.
- **Edge content negotiation.** No CloudFront-side variant routing. The `<picture>` element does the negotiation client-side via standard HTML semantics.

## Known limitations

- Astro auto-copies `public/` into `dist/`. The integration filters out any `public/`-located image that's referenced via `<Image>`, but a `public/`-located image NOT referenced via `<Image>` still ships in `dist/` (and via `deployment_files`). If you want all images to go through variants, keep them under `src/images/` not `public/images/`.
- New images added during `astro dev` require a dev server restart. Subsequent builds pick them up automatically.

## License

MIT
