/**
 * Unit tests for the React adapter (`react.tsx` + `render-react.tsx`).
 *
 * Covers §5 of the impl change plus an early sliver of §8 byte-identity:
 * each test renders the React FC via `renderToStaticMarkup` AND the
 * shared core's RenderTreeNode via the HTML serializer, then asserts
 * the two output strings are byte-identical.
 *
 * The byte-identity guarantee is the contract that makes the Astro and
 * React adapters interchangeable. If a regression breaks it, this test
 * file fails BEFORE the comprehensive §8 fixture sweep runs — cheap
 * early signal during development.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderToStaticMarkup } from "react-dom/server";
import type { AssetRef } from "@run402/functions";

import { Run402Image } from "./react.js";
import { buildRun402ImageRenderTree } from "./core.js";
import { serializeRenderTree } from "./render-html.js";
import {
  Run402ImageError,
  type Run402ImageProps,
  type RenderContext,
} from "./types.js";

// =============================================================================
// Fixtures (subset of core.test.ts — focused on rendering, not validation)
// =============================================================================

function makeFullAssetRef(overrides: Partial<AssetRef> = {}): AssetRef {
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

/** Render via React's renderToStaticMarkup. Strips React-only artifacts
 *  if any (none expected with the static-markup renderer; this is
 *  defensive). */
function renderReactToHtml(
  props: Run402ImageProps & { _forceIsSSR?: boolean },
): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return renderToStaticMarkup(Run402Image(props) as any);
}

/** Render via the shared core + HTML serializer (the Astro path's
 *  string-emitting equivalent). */
function renderHtmlPath(
  props: Run402ImageProps,
  context: Partial<RenderContext> = {},
): string {
  const fullContext: RenderContext = { isSSR: false, ...context };
  const { root, preload } = buildRun402ImageRenderTree(props, fullContext);
  return (preload ? serializeRenderTree(preload) : "") + serializeRenderTree(root);
}

// =============================================================================
// 5.1-5.6 — Smoke tests
// =============================================================================

describe("React adapter — basic rendering", () => {
  it("returns a React element for a fully-populated AssetRef", () => {
    const html = renderReactToHtml({
      asset: makeFullAssetRef(),
      alt: "Hero",
      sizes: "100vw",
    });
    assert.match(html, /<picture/);
    assert.match(html, /<source/);
    assert.match(html, /<img/);
  });

  it("renders bare <img> for AssetRef without variants", () => {
    const ref = makeFullAssetRef({ variants: undefined });
    const html = renderReactToHtml({ asset: ref, alt: "Hero" });
    assert.doesNotMatch(html, /<picture/);
    assert.match(html, /<img/);
  });

  it("emits data-run402-image=\"1\" on the outermost element", () => {
    const html = renderReactToHtml({
      asset: makeFullAssetRef(),
      alt: "Hero",
      sizes: "100vw",
    });
    // `<picture data-run402-image="1" ...>`
    assert.match(html, /<picture[^>]+data-run402-image="1"/);
  });
});

// =============================================================================
// 5.7 — Wrong-entry-point runtime guard
// =============================================================================

describe("React adapter — wrong-entry-point guard", () => {
  it("R402_ASTRO_IMAGE_ASSET_MISSING propagates through React.createElement (not the wrong-entry-point guard)", () => {
    // The runtime entry-point guard is impossible to test "for real"
    // without mocking React; this test instead verifies that
    // validation errors from the shared core PROPAGATE THROUGH the
    // React FC (not silently swallowed).
    let caught: unknown;
    try {
      renderReactToHtml({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        asset: null as any,
        alt: "x",
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Run402ImageError);
    assert.equal(
      (caught as Run402ImageError).code,
      "R402_ASTRO_IMAGE_ASSET_MISSING",
    );
  });
});

// =============================================================================
// 8.1-8.5 (early sliver) — Byte-identity Astro ↔ React
// =============================================================================

describe("byte-identity — React renderToStaticMarkup vs HTML serializer", () => {
  const FIXTURES: Array<{
    name: string;
    props: Run402ImageProps & { _forceIsSSR?: boolean };
    contextForHtml: Partial<RenderContext>;
  }> = [
    {
      name: "full v1.54 AssetRef + sizes",
      props: { asset: makeFullAssetRef(), alt: "Hero", sizes: "100vw" },
      contextForHtml: { isSSR: false },
    },
    {
      name: "bare AssetRef (no variants) — bare <img> path",
      props: {
        asset: makeFullAssetRef({
          variants: undefined,
          width_px: undefined,
          height_px: undefined,
          blurhash_data_url: undefined,
        }),
        alt: "Bare",
      },
      contextForHtml: { isSSR: false },
    },
    {
      name: "AssetRef with caller class",
      props: {
        asset: makeFullAssetRef(),
        alt: "Hero",
        sizes: "100vw",
        class: "hero-image",
      },
      contextForHtml: { isSSR: false },
    },
    {
      name: "AssetRef with data-testid pass-through",
      props: {
        asset: makeFullAssetRef(),
        alt: "Hero",
        sizes: "100vw",
        "data-testid": "homepage-hero",
      },
      contextForHtml: { isSSR: false },
    },
    {
      name: "priority=false + isSSR=true (no preload — but React FC runs in jsdom-less env so isSSR auto-detected)",
      props: {
        asset: makeFullAssetRef(),
        alt: "Hero",
        sizes: "100vw",
        priority: false,
      },
      contextForHtml: { isSSR: true },
    },
  ];

  for (const fixture of FIXTURES) {
    it(`byte-identical: ${fixture.name}`, () => {
      const reactHtml = renderReactToHtml(fixture.props);
      const stringHtml = renderHtmlPath(fixture.props, fixture.contextForHtml);
      if (reactHtml !== stringHtml) {
        // Verbose diff for debugging — the test name above identifies the
        // fixture; the assertion message points at the byte-level diff.
        assert.fail(
          `byte-identity broken between React and HTML adapters for "${fixture.name}":\n` +
            `  React HTML : ${reactHtml}\n` +
            `  HTML path  : ${stringHtml}`,
        );
      }
    });
  }
});
