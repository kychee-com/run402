# minimal-site fixture

Smallest possible Astro project that exercises `@run402/astro` end-to-end.

## What this fixture is for

A future integration test (not in v0.1 — would require a full Astro install, a real or stubbed gateway, and a browser to verify the rendered output) would:

1. `npm install` Astro + `@run402/astro` (link to the workspace package)
2. Stand up a stub gateway that responds to `r.assets.put` with synthesized AssetRefs
3. Run `astro build` against this fixture
4. Inspect `dist/index.html` and confirm:
   - `<picture>` element is emitted for the JPEG and HEIC sources
   - `<img>` fallback is emitted for the sub-320 PNG
   - `width`/`height` attributes match the stub AssetRef dimensions
   - `srcset` contains three WebP entries
   - HEIC source's `<img>` `src` points at the `display_jpeg` cdn_url

For v0.1, the unit tests in `packages/astro/src/*.test.ts` cover the same logic at the function level, which is sufficient confidence to publish 0.1.0.

## Structure

```
minimal-site/
├── README.md              # this file
├── astro.config.mjs       # integrations: [run402({ projectId: '...' })]
├── src/
│   ├── pages/
│   │   └── index.astro    # uses <Image> for each fixture image
│   └── images/
│       ├── hero.jpg       # 1600x1200 JPEG (variant happy path)
│       ├── photo.heic     # HEIC source (display_jpeg path)
│       └── icon.png       # 200x200 PNG (sub-320 fallback)
```

Image binaries are intentionally NOT committed — a future integration test would generate them via `scripts/generate-image-fixtures.mjs` (the same script the gateway's `test/fixtures/image-pipeline/` uses).
