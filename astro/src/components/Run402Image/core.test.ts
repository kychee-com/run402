/**
 * Unit tests for `<Run402Image>` shared core (`core.ts`).
 *
 * Covers §3 (core unit tests) of `openspec/changes/run402-image-component-impl/tasks.md`:
 *
 *   3.1  Happy path
 *   3.2  Validation error scenarios (8 R402_* codes)
 *   3.3  Field-level fallback (5 fields × absence states)
 *   3.4  HEIC scenarios (4 variations)
 *   3.5  Strict-mode scenarios (schema-filter × asset_schema × strict flag)
 *   3.6  Placeholder behavior (3 values × has-or-not blurhash_data_url)
 *   3.7  Style merge (object/string × overlap × shorthand pitfall)
 *   3.8  Preload emission (priority + SSR × multi-vs-single-variant × hook)
 *   3.9  data-* pass-through + reserved-key collision
 *   3.10 `data-run402-image="1"` placement on outermost element
 *   3.11 class/className normalization
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { AssetRef } from "@run402/functions";

import { buildRun402ImageRenderTree } from "./core.js";
import {
  Run402ImageError,
  type DegradationEntry,
  type ImgAttrs,
  type PictureAttrs,
  type RenderContext,
  type RenderTreeNode,
  type Run402ImageProps,
} from "./types.js";

// =============================================================================
// Fixtures
// =============================================================================

/**
 * A fully-populated v1.54 AssetRef (the "everything works" case). Tests
 * use this as the base and override specific fields to exercise degradation
 * paths.
 */
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
    blurhash_data_url: "data:image/png;base64,iVBORw0KGgo...",
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

function makeContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return { isSSR: false, ...overrides };
}

function build(
  props: Partial<Run402ImageProps>,
  context: Partial<RenderContext> = {},
): ReturnType<typeof buildRun402ImageRenderTree> {
  const fullProps: Run402ImageProps = {
    asset: makeFullAssetRef(),
    alt: "Hero image",
    sizes: "100vw",
    ...props,
  };
  return buildRun402ImageRenderTree(fullProps, makeContext(context));
}

function expectThrows(
  thunk: () => unknown,
  code: string,
): Run402ImageError {
  let caught: unknown;
  try {
    thunk();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Run402ImageError, `expected Run402ImageError, got ${String(caught)}`);
  const err = caught as Run402ImageError;
  assert.equal(err.code, code, `expected code=${code}, got code=${err.code}`);
  return err;
}

function imgAttrs(node: RenderTreeNode): ImgAttrs {
  if (node.kind === "img") return node.attrs;
  if (node.kind === "picture") {
    const img = node.children.find((c) => c.kind === "img");
    assert.ok(img, "picture has no img child");
    return (img as { kind: "img"; attrs: ImgAttrs }).attrs;
  }
  throw new Error(`expected img or picture, got ${node.kind}`);
}

function pictureAttrs(node: RenderTreeNode): PictureAttrs {
  assert.equal(node.kind, "picture");
  return (node as { kind: "picture"; attrs: PictureAttrs }).attrs;
}

// =============================================================================
// 3.1 — Happy path
// =============================================================================

describe("happy path — full v1.54 AssetRef", () => {
  it("emits a <picture> wrapping <source srcset> + <img> fallback", () => {
    const { root } = build({});
    assert.equal(root.kind, "picture");
    assert.ok(root.kind === "picture");
    const source = root.children.find((c) => c.kind === "source");
    const img = root.children.find((c) => c.kind === "img");
    assert.ok(source && img);
  });

  it("variants are ordered ascending by width_px (320 → 800 → 1920)", () => {
    const { root } = build({});
    assert.equal(root.kind, "picture");
    if (root.kind !== "picture") return;
    const source = root.children.find((c) => c.kind === "source")!;
    assert.equal(source.kind, "source");
    if (source.kind !== "source") return;
    const widths = source.attrs.srcset
      .split(", ")
      .map((s) => parseInt(s.split(" ")[1]!, 10));
    assert.deepEqual(widths, [320, 800, 1920]);
  });

  it("emits `data-run402-image=\"1\"` on the outermost element (picture)", () => {
    const { root } = build({});
    const attrs = pictureAttrs(root);
    assert.equal(attrs["data-run402-image"], "1");
  });

  it("placeholder style block includes all three required properties", () => {
    const { root } = build({});
    const attrs = imgAttrs(root);
    assert.ok(attrs.style);
    assert.match(attrs.style ?? "", /background-image:\s*url\(data:image\/png/);
    assert.match(attrs.style ?? "", /background-size:\s*cover/);
    assert.match(attrs.style ?? "", /background-position:\s*center/);
  });
});

// =============================================================================
// 3.2 — Validation error scenarios
// =============================================================================

describe("validation — R402_ASTRO_IMAGE_ASSET_MISSING", () => {
  it("throws on null asset", () => {
    expectThrows(
      () => build({ asset: null as unknown as AssetRef }),
      "R402_ASTRO_IMAGE_ASSET_MISSING",
    );
  });
  it("throws on undefined asset", () => {
    expectThrows(
      () => build({ asset: undefined as unknown as AssetRef }),
      "R402_ASTRO_IMAGE_ASSET_MISSING",
    );
  });
  it("carries a suggested-fix referencing r.assets.fromRef", () => {
    const err = expectThrows(
      () => build({ asset: null as unknown as AssetRef }),
      "R402_ASTRO_IMAGE_ASSET_MISSING",
    );
    assert.match(err.suggestedFix ?? "", /r\.assets\.fromRef/);
  });
});

describe("validation — R402_ASTRO_IMAGE_ASSET_STRING_URL", () => {
  it("throws on plain string URL", () => {
    expectThrows(
      () => build({ asset: "https://example.com/hero.jpg" as unknown as AssetRef }),
      "R402_ASTRO_IMAGE_ASSET_STRING_URL",
    );
  });
  it("error message names the offending URL", () => {
    const err = expectThrows(
      () => build({ asset: "https://example.com/hero.jpg" as unknown as AssetRef }),
      "R402_ASTRO_IMAGE_ASSET_STRING_URL",
    );
    assert.match(err.message, /https:\/\/example\.com\/hero\.jpg/);
  });
});

describe("validation — R402_ASTRO_IMAGE_ASSET_WRONG_SHAPE", () => {
  it("throws on object lacking cdn_url", () => {
    const broken = { key: "x" } as unknown as AssetRef;
    expectThrows(() => build({ asset: broken }), "R402_ASTRO_IMAGE_ASSET_WRONG_SHAPE");
  });
  it("throws on cdn_url === empty string", () => {
    expectThrows(
      () => build({ asset: makeFullAssetRef({ cdn_url: "" }) }),
      "R402_ASTRO_IMAGE_ASSET_WRONG_SHAPE",
    );
  });
});

describe("validation — R402_ASTRO_IMAGE_NON_IMAGE_ASSET", () => {
  it("throws on application/pdf content_type", () => {
    expectThrows(
      () => build({ asset: makeFullAssetRef({ content_type: "application/pdf" }) }),
      "R402_ASTRO_IMAGE_NON_IMAGE_ASSET",
    );
  });
  it("accepts MISSING content_type (per field-level fallback table)", () => {
    // content_type undefined → component assumes image, no throw.
    const ref = makeFullAssetRef();
    delete (ref as { content_type?: string }).content_type;
    const { root } = build({ asset: ref });
    assert.ok(root);
  });
});

describe("validation — R402_ASTRO_IMAGE_ALT_REQUIRED", () => {
  it("throws when alt is missing (JS consumer bypass)", () => {
    expectThrows(
      () => build({ alt: undefined as unknown as string }),
      "R402_ASTRO_IMAGE_ALT_REQUIRED",
    );
  });
  it("accepts alt=\"\" (decorative per HTML5 §4.7.4.4)", () => {
    const { root } = build({ alt: "" });
    assert.equal(imgAttrs(root).alt, "");
  });
});

describe("validation — R402_ASTRO_IMAGE_CONFLICTING_CLASS_PROPS", () => {
  it("throws when both class and className are set", () => {
    expectThrows(
      () => build({ class: "hero", className: "card" }),
      "R402_ASTRO_IMAGE_CONFLICTING_CLASS_PROPS",
    );
  });
  it("accepts only class", () => {
    const { root } = build({ class: "hero" });
    assert.equal(pictureAttrs(root).class, "hero");
  });
  it("accepts only className (normalized to class)", () => {
    const { root } = build({ className: "card" });
    assert.equal(pictureAttrs(root).class, "card");
  });
});

describe("validation — R402_ASTRO_IMAGE_CONFLICTING_LOADING_PROPS", () => {
  it("throws when priority=true AND loading=lazy", () => {
    expectThrows(
      () => build({ priority: true, loading: "lazy" }),
      "R402_ASTRO_IMAGE_CONFLICTING_LOADING_PROPS",
    );
  });
  it("accepts priority=true alone (→ loading='eager')", () => {
    const { root } = build({ priority: true });
    assert.equal(imgAttrs(root).loading, "eager");
    assert.equal(imgAttrs(root).fetchpriority, "high");
  });
});

describe("validation — R402_ASTRO_IMAGE_RESERVED_DATA_ATTR", () => {
  it("throws when caller passes data-run402-image", () => {
    expectThrows(
      () =>
        build({
          // @ts-expect-error — DataAttributes excludes this key; runtime guard
          "data-run402-image": "custom",
        }),
      "R402_ASTRO_IMAGE_RESERVED_DATA_ATTR",
    );
  });
});

// =============================================================================
// 3.4 — HEIC scenarios
// =============================================================================

describe("HEIC — correctness floor (R402_ASTRO_IMAGE_HEIC_NO_TRANSCODE)", () => {
  it("throws for image/heic without display_jpeg variant", () => {
    const ref = makeFullAssetRef({ content_type: "image/heic" });
    expectThrows(() => build({ asset: ref }), "R402_ASTRO_IMAGE_HEIC_NO_TRANSCODE");
  });
  it("throws for image/heif without display_jpeg variant", () => {
    const ref = makeFullAssetRef({ content_type: "image/heif" });
    expectThrows(() => build({ asset: ref }), "R402_ASTRO_IMAGE_HEIC_NO_TRANSCODE");
  });
  it("renders correctly for image/heic WITH display_jpeg variant", () => {
    const ref = makeFullAssetRef({
      content_type: "image/heic",
      display_url: "https://pr-abc.run402.com/_blob/display.jpg",
      variants: {
        ...makeFullAssetRef().variants,
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
    });
    const { root } = build({ asset: ref });
    // For HEIC: <img src> points at display_url (the JPEG variant).
    const attrs = imgAttrs(root);
    assert.equal(attrs.src, "https://pr-abc.run402.com/_blob/display.jpg");
  });
  it("HEIC + display_jpeg bypasses HEIC floor even under strict-mode (different orderings)", () => {
    const ref = makeFullAssetRef({
      content_type: "image/heic",
      asset_schema: "v1.54",
      variants: {
        ...makeFullAssetRef().variants,
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
    });
    const { root } = build({ asset: ref, strict: true });
    assert.ok(root);
  });
});

// =============================================================================
// 3.11 — sizes required for multi-variant
// =============================================================================

describe("R402_ASTRO_IMAGE_SIZES_REQUIRED", () => {
  it("throws when AssetRef has multiple variants and sizes is omitted", () => {
    expectThrows(
      () => build({ sizes: undefined }),
      "R402_ASTRO_IMAGE_SIZES_REQUIRED",
    );
  });
  it("does NOT throw when AssetRef has zero variants (bare img path)", () => {
    const ref = makeFullAssetRef({ variants: undefined });
    const { root } = build({ asset: ref, sizes: undefined });
    assert.equal(root.kind, "img");
  });
});

// =============================================================================
// 3.3 — Field-level fallback rules
// =============================================================================

describe("field-level fallback — variants absent → bare <img>", () => {
  it("AssetRef with only cdn_url renders as bare <img>", () => {
    const ref = makeFullAssetRef({
      variants: undefined,
      width_px: undefined,
      height_px: undefined,
      blurhash: undefined,
      blurhash_data_url: undefined,
    });
    const { root } = build({ asset: ref, sizes: undefined });
    assert.equal(root.kind, "img");
    const attrs = imgAttrs(root);
    assert.equal(attrs.src, ref.cdn_url);
    assert.equal(attrs.width, undefined);
    assert.equal(attrs.height, undefined);
    assert.equal(attrs.style, undefined);
    assert.equal(attrs["data-run402-image"], "1");
  });
});

describe("field-level fallback — width_px present but height_px missing", () => {
  it("emits width= but no height=", () => {
    const ref = makeFullAssetRef({ height_px: undefined });
    const { root } = build({ asset: ref });
    const attrs = imgAttrs(root);
    assert.equal(attrs.width, 4032);
    assert.equal(attrs.height, undefined);
  });
});

describe("field-level fallback — display_url empty-string falls through to cdn_url", () => {
  it("empty-string display_url → use cdn_url (NOT `??`, explicit empty check)", () => {
    const ref = makeFullAssetRef({ display_url: "" });
    const { root } = build({ asset: ref });
    const attrs = imgAttrs(root);
    assert.equal(attrs.src, ref.cdn_url);
  });
});

// =============================================================================
// 3.5 — Strict mode
// =============================================================================

describe("strict mode — binary form", () => {
  it("strict=true on a fully-populated AssetRef → no throw", () => {
    const { root } = build({ strict: true });
    assert.ok(root);
  });
  it("strict=true + missing variants → STRICT_DEGRADED (subcode NO_VARIANTS)", () => {
    const ref = makeFullAssetRef({ variants: undefined });
    const err = expectThrows(
      () => build({ asset: ref, sizes: undefined, strict: true }),
      "R402_ASTRO_IMAGE_STRICT_DEGRADED",
    );
    assert.equal(err.subcode, "NO_VARIANTS");
  });
  it("strict=true + missing width_px → STRICT_DEGRADED (subcode NO_INTRINSICS)", () => {
    const ref = makeFullAssetRef({ width_px: undefined });
    const err = expectThrows(
      () => build({ asset: ref, strict: true }),
      "R402_ASTRO_IMAGE_STRICT_DEGRADED",
    );
    assert.equal(err.subcode, "NO_INTRINSICS");
  });
});

describe("strict mode — placeholder gating (NO_PLACEHOLDER subcode)", () => {
  it("strict=true + placeholder=\"auto\" + missing blurhash_data_url → no throw (auto doesn't trip strict)", () => {
    const ref = makeFullAssetRef({ blurhash_data_url: undefined });
    const { root } = build({ asset: ref, strict: true });
    assert.ok(root);
  });
  it("strict=true + placeholder=\"blurhash\" + missing blurhash_data_url → STRICT_DEGRADED (NO_PLACEHOLDER)", () => {
    const ref = makeFullAssetRef({ blurhash_data_url: undefined });
    const err = expectThrows(
      () => build({ asset: ref, strict: true, placeholder: "blurhash" }),
      "R402_ASTRO_IMAGE_STRICT_DEGRADED",
    );
    assert.equal(err.subcode, "NO_PLACEHOLDER");
  });
});

describe("strict mode — schema-filtered form", () => {
  it("strict={onSchema:'>=v1.49'} + AssetRef has no asset_schema → bypasses strict", () => {
    const ref = makeFullAssetRef({
      asset_schema: undefined,
      variants: undefined,
    });
    const { root } = build({ asset: ref, sizes: undefined, strict: { onSchema: ">=v1.49" } });
    assert.equal(root.kind, "img");
  });
  it("strict={onSchema:'>=v1.49'} + asset_schema=v1.49 + missing variants → STRICT_DEGRADED", () => {
    const ref = makeFullAssetRef({
      asset_schema: "v1.49",
      variants: undefined,
    });
    expectThrows(
      () => build({ asset: ref, sizes: undefined, strict: { onSchema: ">=v1.49" } }),
      "R402_ASTRO_IMAGE_STRICT_DEGRADED",
    );
  });
  it("strict={onSchema:'>=v1.54'} + asset_schema=v1.49 → bypasses (schema below predicate)", () => {
    const ref = makeFullAssetRef({
      asset_schema: "v1.49",
      variants: undefined,
    });
    const { root } = build({ asset: ref, sizes: undefined, strict: { onSchema: ">=v1.54" } });
    assert.equal(root.kind, "img");
  });
  it("strict={onSchema:'any'} acts like strict=true", () => {
    const ref = makeFullAssetRef({
      asset_schema: "v1.49",
      variants: undefined,
    });
    expectThrows(
      () => build({ asset: ref, sizes: undefined, strict: { onSchema: "any" } }),
      "R402_ASTRO_IMAGE_STRICT_DEGRADED",
    );
  });
});

describe("strict mode — project default + per-call override", () => {
  it("project default strict=true is applied when per-call is unset", () => {
    const ref = makeFullAssetRef({ variants: undefined });
    expectThrows(
      () =>
        build(
          { asset: ref, sizes: undefined },
          { imageDefaults: { strict: true } },
        ),
      "R402_ASTRO_IMAGE_STRICT_DEGRADED",
    );
  });
  it("per-call strict=false overrides project default strict=true", () => {
    const ref = makeFullAssetRef({ variants: undefined });
    const { root } = build(
      { asset: ref, sizes: undefined, strict: false },
      { imageDefaults: { strict: true } },
    );
    assert.equal(root.kind, "img");
  });
});

// =============================================================================
// 3.6 — Placeholder behavior
// =============================================================================

describe("placeholder behavior", () => {
  it("placeholder=\"auto\" (default) + blurhash_data_url present → renders style block", () => {
    const { root } = build({});
    const attrs = imgAttrs(root);
    assert.match(attrs.style ?? "", /background-image/);
  });
  it("placeholder=\"auto\" + blurhash_data_url ABSENT → no style block", () => {
    const ref = makeFullAssetRef({ blurhash_data_url: undefined });
    const { root } = build({ asset: ref });
    const attrs = imgAttrs(root);
    assert.equal(attrs.style, undefined);
  });
  it("placeholder=\"none\" + blurhash_data_url present → no style block", () => {
    const { root } = build({ placeholder: "none" });
    const attrs = imgAttrs(root);
    assert.equal(attrs.style, undefined);
  });
  it("placeholder=\"blurhash\" + blurhash_data_url present → renders style block", () => {
    const { root } = build({ placeholder: "blurhash" });
    const attrs = imgAttrs(root);
    assert.match(attrs.style ?? "", /background-image/);
  });
});

// =============================================================================
// 3.7 — Style merge
// =============================================================================

describe("style merge — object form", () => {
  it("caller object merges with placeholder; caller wins on overlap", () => {
    const { root } = build({
      style: { color: "red", "background-size": "contain" },
    });
    const attrs = imgAttrs(root);
    assert.match(attrs.style ?? "", /color:\s*red/);
    // Caller's background-size overrides the component's `cover`.
    assert.match(attrs.style ?? "", /background-size:\s*contain/);
    assert.doesNotMatch(attrs.style ?? "", /background-size:\s*cover/);
    // background-position not overridden → component value preserved.
    assert.match(attrs.style ?? "", /background-position:\s*center/);
  });
  it("camelCase JS keys (React form) normalize to kebab-case CSS keys", () => {
    const { root } = build({
      style: { backgroundColor: "blue" },
    });
    const attrs = imgAttrs(root);
    assert.match(attrs.style ?? "", /background-color:\s*blue/);
  });
});

describe("style merge — string form", () => {
  it("caller string appended AFTER component string", () => {
    const { root } = build({
      style: "color: red; background-size: contain",
    });
    const attrs = imgAttrs(root);
    const style = attrs.style ?? "";
    // Component's `background-size:cover` (no spaces, React-style) appears
    // first, then the caller's verbatim string.
    const componentIdx = style.indexOf("background-size:cover");
    const callerIdx = style.indexOf("background-size: contain");
    assert.ok(componentIdx >= 0 && callerIdx > componentIdx);
  });
  it("background shorthand wipes the placeholder (documented pitfall)", () => {
    const { root } = build({ style: "background: blue" });
    const attrs = imgAttrs(root);
    // Component's longhand is still emitted (we don't strip), then caller's
    // shorthand. At render time the browser applies the cascade.
    const style = attrs.style ?? "";
    assert.match(style, /background-image:\s*url/);
    assert.ok(style.endsWith("background: blue"));
  });
});

// =============================================================================
// 3.8 — Preload emission
// =============================================================================

describe("preload — priority + SSR", () => {
  it("priority=true + isSSR=true + multi-variant → emits multi-variant preload link", () => {
    const result = build({ priority: true }, { isSSR: true });
    assert.ok(result.preload);
    assert.equal(result.preload?.kind, "link");
    if (result.preload?.kind !== "link") return;
    assert.equal(result.preload.attrs.rel, "preload");
    assert.equal(result.preload.attrs.as, "image");
    assert.match(result.preload.attrs.imagesrcset ?? "", /1920w/);
  });
  it("priority=true + isSSR=true + single-variant (no variants) → emits href form", () => {
    const ref = makeFullAssetRef({ variants: undefined });
    const result = build({ asset: ref, sizes: undefined, priority: true }, { isSSR: true });
    assert.ok(result.preload);
    assert.equal(result.preload?.kind, "link");
    if (result.preload?.kind !== "link") return;
    assert.ok(typeof result.preload.attrs.href === "string");
    assert.equal(result.preload.attrs.imagesrcset, undefined);
  });
  it("priority=true + isSSR=FALSE (client-only React) → NO preload emission", () => {
    const result = build({ priority: true }, { isSSR: false });
    assert.equal(result.preload, undefined);
  });
  it("priority=false → NO preload emission even under SSR", () => {
    const result = build({ priority: false }, { isSSR: true });
    assert.equal(result.preload, undefined);
  });
  it("registerPreload hook is called when exposed; no adjacent <link> emitted", () => {
    const calls: unknown[] = [];
    const result = build(
      { priority: true },
      { isSSR: true, registerPreload: (link) => calls.push(link) },
    );
    assert.equal(calls.length, 1);
    assert.equal(result.preload, undefined);
  });
});

// =============================================================================
// 3.9 — data-* pass-through
// =============================================================================

describe("data-* pass-through", () => {
  it("arbitrary data-* attrs flow to outermost element (picture)", () => {
    const { root } = build({
      "data-testid": "hero-image",
      "data-analytics-id": "homepage-hero",
    });
    const attrs = pictureAttrs(root);
    assert.deepEqual(attrs.dataAttrs, {
      "data-testid": "hero-image",
      "data-analytics-id": "homepage-hero",
    });
  });
  it("arbitrary data-* attrs flow to <img> when no <picture>", () => {
    const ref = makeFullAssetRef({ variants: undefined });
    const { root } = build({
      asset: ref,
      sizes: undefined,
      "data-testid": "hero",
    });
    const attrs = imgAttrs(root);
    assert.deepEqual(attrs.dataAttrs, { "data-testid": "hero" });
  });
});

// =============================================================================
// 3.10 — data-run402-image="1" placement
// =============================================================================

describe("data-run402-image marker placement", () => {
  it("placed on <picture> when variants present", () => {
    const { root } = build({});
    assert.equal(pictureAttrs(root)["data-run402-image"], "1");
  });
  it("placed on <img> when no variants (bare img path)", () => {
    const ref = makeFullAssetRef({ variants: undefined });
    const { root } = build({ asset: ref, sizes: undefined });
    assert.equal(imgAttrs(root)["data-run402-image"], "1");
  });
});

// =============================================================================
// 3.7 — Default-mode degradation recording
// =============================================================================

describe("recordDegradation — default-mode lenient path", () => {
  it("calls recordDegradation when the asset is missing optional fields", () => {
    const calls: DegradationEntry[] = [];
    const ref = makeFullAssetRef({
      variants: undefined,
      width_px: undefined,
      blurhash_data_url: undefined,
    });
    build(
      { asset: ref, sizes: undefined, placeholder: "blurhash" },
      { recordDegradation: (e) => calls.push(e) },
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0]!.missingFields.sort(),
      ["blurhash_data_url", "variants", "width_px"].sort(),
    );
  });
  it("does NOT record degradation for a fully-populated AssetRef", () => {
    const calls: DegradationEntry[] = [];
    build({}, { recordDegradation: (e) => calls.push(e) });
    assert.equal(calls.length, 0);
  });
  it("schema-filter suppresses warnings for legacy assets", () => {
    const calls: DegradationEntry[] = [];
    const ref = makeFullAssetRef({
      asset_schema: undefined,
      variants: undefined,
      width_px: undefined,
    });
    build(
      { asset: ref, sizes: undefined },
      {
        imageDefaults: { strict: { onSchema: ">=v1.49" } },
        recordDegradation: (e) => calls.push(e),
      },
    );
    // Per spec: legacy assets (no asset_schema) under a schema-filtered
    // project default get NO degradation warnings.
    assert.equal(calls.length, 0);
  });
});

// =============================================================================
// 2.20+2.21+2.22 — Default attribute coverage
// =============================================================================

describe("attribute defaults", () => {
  it("loading defaults to 'lazy'", () => {
    const { root } = build({});
    assert.equal(imgAttrs(root).loading, "lazy");
  });
  it("decoding defaults to 'async'", () => {
    const { root } = build({});
    assert.equal(imgAttrs(root).decoding, "async");
  });
  it("priority=true flips loading to 'eager' AND sets fetchpriority='high'", () => {
    const { root } = build({ priority: true });
    const a = imgAttrs(root);
    assert.equal(a.loading, "eager");
    assert.equal(a.fetchpriority, "high");
  });
  it("width prop overrides AssetRef.width_px", () => {
    const { root } = build({ width: 1000 });
    assert.equal(imgAttrs(root).width, 1000);
  });
});
