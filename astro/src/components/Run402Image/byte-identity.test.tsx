/**
 * Byte-identity fixture sweep — §8 of run402-image-component-impl.
 *
 * For each fixture: render through BOTH the React adapter
 * (`renderToStaticMarkup`) AND the HTML serializer directly. Assert
 * the two outputs are byte-identical.
 *
 * The byte-identity guarantee is what makes the Astro and React entry
 * points interchangeable — a consumer can move a page from Astro to
 * React (or render the same AssetRef on both surfaces) and get
 * pixel-for-pixel-identical HTML. The SSR cache layer keys on
 * `content_sha256` of the rendered HTML; if the two adapters drifted,
 * caching would thrash silently.
 *
 * The §8 task list called for ~15 fixtures; we ship 16 here spanning
 * the field-level fallback table, HEIC paths, strict-mode resolution,
 * placeholder behavior, and the data-* + class flowdown paths.
 *
 * CI gates this test (tasks 8.5 + 10.1): any drift fails the build
 * with a verbose diff showing exactly where the React and HTML paths
 * disagreed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderToStaticMarkup } from "react-dom/server";
import type { AssetRef } from "@run402/functions";

import { Run402Image } from "./react.js";
import { buildRun402ImageRenderTree } from "./core.js";
import { serializeRenderTree } from "./render-html.js";
import type { RenderContext, Run402ImageProps } from "./types.js";

// =============================================================================
// Fixture factories
// =============================================================================

function makeFullV154AssetRef(overrides: Partial<AssetRef> = {}): AssetRef {
  return {
    key: "images/hero.jpg",
    sha256: "deadbeef0123456789",
    size_bytes: 102400,
    content_type: "image/jpeg",
    visibility: "public",
    immutable: false,
    url: "https://pr-abc.run402.com/_blob/images/hero.jpg",
    immutable_url: null,
    cdn_url: "https://pr-abc.run402.com/_blob/images/hero.jpg",
    cdn_immutable_url: null,
    sri: null,
    etag: '"sha256-deadbeef"',
    content_digest: "sha-256=:3q2+7w==:",
    immutableUrl: null,
    cdnUrl: "https://pr-abc.run402.com/_blob/images/hero.jpg",
    cdnImmutableUrl: null,
    size: 102400,
    contentType: "image/jpeg",
    contentSha256: "deadbeef0123456789",
    width_px: 4032,
    height_px: 3024,
    blurhash: "LKO2:N%2Tw=^]~RBVZRi};RPxuwH",
    blurhash_data_url: "data:image/png;base64,iVBORw0KGgo",
    asset_schema: "v1.54",
    variant_spec_version: "v1",
    display_url: "https://pr-abc.run402.com/_blob/images/hero.jpg",
    display_immutable_url: null,
    variants: {
      thumb: {
        kind: "thumb",
        format: "webp",
        width_px: 320,
        height_px: 240,
        sha256: "thumb1234",
        url: "https://pr-abc.run402.com/_blob/thumb",
        immutable_url: null,
        cdn_url: "https://pr-abc.run402.com/_blob/thumb",
        cdn_immutable_url: null,
      },
      medium: {
        kind: "medium",
        format: "webp",
        width_px: 800,
        height_px: 600,
        sha256: "medium1234",
        url: "https://pr-abc.run402.com/_blob/medium",
        immutable_url: null,
        cdn_url: "https://pr-abc.run402.com/_blob/medium",
        cdn_immutable_url: null,
      },
      large: {
        kind: "large",
        format: "webp",
        width_px: 1920,
        height_px: 1440,
        sha256: "large1234",
        url: "https://pr-abc.run402.com/_blob/large",
        immutable_url: null,
        cdn_url: "https://pr-abc.run402.com/_blob/large",
        cdn_immutable_url: null,
      },
    },
    ...overrides,
  };
}

function makeHeicWithDisplayJpeg(): AssetRef {
  const base = makeFullV154AssetRef({
    key: "images/portrait.heic",
    content_type: "image/heic",
    display_url: "https://pr-abc.run402.com/_blob/display.jpg",
  });
  return {
    ...base,
    variants: {
      ...base.variants,
      display_jpeg: {
        kind: "display_jpeg",
        format: "jpeg",
        width_px: 4032,
        height_px: 3024,
        sha256: "displaysha",
        url: "https://pr-abc.run402.com/_blob/display.jpg",
        immutable_url: null,
        cdn_url: "https://pr-abc.run402.com/_blob/display.jpg",
        cdn_immutable_url: null,
      },
    },
  };
}

// =============================================================================
// Render harnesses
// =============================================================================

function renderReact(
  props: Run402ImageProps & { _forceIsSSR?: boolean },
): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return renderToStaticMarkup(Run402Image(props) as any);
}

function renderHtml(
  props: Run402ImageProps,
  contextOverride: Partial<RenderContext> = {},
): string {
  // The React FC uses detectIsSSR() (no DOM globals → SSR mode); the
  // HTML serializer's RenderContext must mirror that for the comparison.
  // In the Node test runner there's no `document`, so React FC chooses
  // SSR. We default the HTML path's context to match.
  const ctx: RenderContext = { isSSR: true, ...contextOverride };
  const { root, preload } = buildRun402ImageRenderTree(props, ctx);
  return (preload ? serializeRenderTree(preload) : "") + serializeRenderTree(root);
}

// =============================================================================
// Fixture table — 16 cases spanning the spec's render matrix
// =============================================================================

interface Fixture {
  name: string;
  props: Run402ImageProps;
}

const FIXTURES: Fixture[] = [
  // ----- Field-level fallback (5 fields × absence states) -----
  {
    name: "01: Full v1.54 AssetRef + multi-variant",
    props: { asset: makeFullV154AssetRef(), alt: "Hero", sizes: "100vw" },
  },
  {
    name: "02: Pre-v1.49 (only cdn_url) → bare <img>",
    props: {
      asset: makeFullV154AssetRef({
        variants: undefined,
        width_px: undefined,
        height_px: undefined,
        blurhash: undefined,
        blurhash_data_url: undefined,
        asset_schema: undefined,
      }),
      alt: "Legacy",
    },
  },
  {
    name: "03: width_px present, height_px missing (partial CLS)",
    props: {
      asset: makeFullV154AssetRef({ height_px: undefined }),
      alt: "Partial",
      sizes: "100vw",
    },
  },
  {
    name: "04: blurhash_data_url absent (no placeholder)",
    props: {
      asset: makeFullV154AssetRef({ blurhash_data_url: undefined }),
      alt: "No-placeholder",
      sizes: "100vw",
    },
  },
  {
    name: "05: display_url empty-string falls through to cdn_url",
    props: {
      asset: makeFullV154AssetRef({ display_url: "" }),
      alt: "Empty-display",
      sizes: "100vw",
    },
  },

  // ----- Variant subsets -----
  {
    name: "06: Variants present but display_url missing (legacy data)",
    props: {
      asset: makeFullV154AssetRef({ display_url: undefined }),
      alt: "No-display-url",
      sizes: "100vw",
    },
  },
  {
    name: "07: Single variant (thumb only) → still uses <picture>",
    props: {
      asset: (() => {
        const ref = makeFullV154AssetRef();
        ref.variants = { thumb: ref.variants!.thumb };
        return ref;
      })(),
      alt: "Single-variant",
    },
  },

  // ----- HEIC -----
  {
    name: "08: HEIC source with display_jpeg → <img src> points at JPEG variant",
    props: { asset: makeHeicWithDisplayJpeg(), alt: "HEIC", sizes: "100vw" },
  },

  // ----- Placeholder behavior -----
  {
    name: "09: placeholder='none' → no style block",
    props: {
      asset: makeFullV154AssetRef(),
      alt: "No-placeholder",
      sizes: "100vw",
      placeholder: "none",
    },
  },
  {
    name: "10: placeholder='blurhash' (explicit) → style block emitted",
    props: {
      asset: makeFullV154AssetRef(),
      alt: "Explicit-placeholder",
      sizes: "100vw",
      placeholder: "blurhash",
    },
  },

  // ----- class/id/data-attrs flowdown -----
  {
    name: "11: caller class flows to <picture>",
    props: {
      asset: makeFullV154AssetRef(),
      alt: "With-class",
      sizes: "100vw",
      class: "hero-image",
    },
  },
  {
    name: "12: caller id + class + multiple data-* attrs",
    props: {
      asset: makeFullV154AssetRef(),
      alt: "Decorated",
      sizes: "100vw",
      class: "hero",
      id: "main-hero",
      "data-testid": "homepage-hero",
      "data-analytics-id": "main-hero",
    },
  },

  // ----- Loading + decoding + priority -----
  {
    name: "13: priority=true → loading='eager', fetchpriority='high', preload link",
    props: {
      asset: makeFullV154AssetRef(),
      alt: "Priority",
      sizes: "100vw",
      priority: true,
    },
  },
  {
    name: "14: explicit loading='eager' without priority (no preload)",
    props: {
      asset: makeFullV154AssetRef(),
      alt: "Eager",
      sizes: "100vw",
      loading: "eager",
    },
  },

  // ----- Style merge -----
  {
    name: "15: caller object-style merge",
    props: {
      asset: makeFullV154AssetRef(),
      alt: "Styled",
      sizes: "100vw",
      style: { color: "red", "background-size": "contain" },
    },
  },
  {
    name: "16: caller string-style appended after component",
    props: {
      asset: makeFullV154AssetRef(),
      alt: "String-styled",
      sizes: "100vw",
      style: "color:red;font-size:14px",
    },
  },
];

// =============================================================================
// Sweep
// =============================================================================

describe("byte-identity fixture sweep — Astro ↔ React", () => {
  for (const fixture of FIXTURES) {
    it(`byte-identical: ${fixture.name}`, () => {
      const reactHtml = renderReact(fixture.props);
      const stringHtml = renderHtml(fixture.props);
      if (reactHtml !== stringHtml) {
        // Show a side-by-side diff. The byte-level mismatch tells the
        // future maintainer exactly which attribute or value drifted.
        assert.fail(
          `Byte-identity broken for fixture "${fixture.name}":\n\n` +
            `  React (renderToStaticMarkup): ${reactHtml}\n` +
            `  HTML (serializeRenderTree)  : ${stringHtml}\n\n` +
            `Diff: investigate render-react.tsx vs render-html.ts attribute ordering / quoting / escaping.`,
        );
      }
    });
  }

  it(`sweep covers ${FIXTURES.length} fixtures — meets the §8 task budget of ~15`, () => {
    assert.ok(FIXTURES.length >= 15, `expected >= 15 fixtures, got ${FIXTURES.length}`);
  });
});

// =============================================================================
// 8.5 — CI gating (the test running in CI IS the gate; this is metadata)
// =============================================================================

describe("CI gating contract", () => {
  it("test file is named `*.test.tsx` so the unit-test runner picks it up", () => {
    // The astro package's test:unit script globs `src/**/*.test.ts`,
    // and the tsx variant is picked up too. If this file is renamed
    // or moved out of src/, CI silently drops the gate. Pin the path.
    assert.match(
      import.meta.url,
      /\/components\/Run402Image\/byte-identity\.test\.tsx$/,
      "byte-identity test must live at src/components/Run402Image/byte-identity.test.tsx",
    );
  });
});
