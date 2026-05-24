/**
 * Type-system contract tests for the `<Run402Image>` foundations.
 *
 * Most of the work in §1 of the impl change is type-level — the tests here
 * mostly verify the runtime behavior of `Run402ImageError` (the one
 * non-type-only export from `types.ts`) + assert via type-only `expect`
 * patterns that the type contract holds. TypeScript compile failures in
 * THIS file are the primary signal that the type contract regressed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Run402ImageError,
  type DataAttributes,
  type DegradationEntry,
  type ImageDefaults,
  type ImgAttrs,
  type LinkAttrs,
  type PictureAttrs,
  type PreloadAttrs,
  type RenderContext,
  type RenderTreeNode,
  type Run402ImageProps,
  type SourceAttrs,
} from "./types.js";

// =============================================================================
// Run402ImageError — runtime behavior
// =============================================================================

describe("Run402ImageError", () => {
  it("extends Error and carries the canonical fields", () => {
    const err = new Run402ImageError({
      code: "R402_ASTRO_IMAGE_ASSET_MISSING",
      message: "asset prop is required",
      suggestedFix: "Pass <Run402Image asset={...} alt=\"\" />",
      docs: "https://run402.com/errors/r402-astro-image-asset-missing",
    });
    assert.ok(err instanceof Error);
    assert.ok(err instanceof Run402ImageError);
    assert.equal(err.name, "Run402ImageError");
    assert.equal(err.code, "R402_ASTRO_IMAGE_ASSET_MISSING");
    assert.equal(err.message, "asset prop is required");
    assert.equal(err.suggestedFix, 'Pass <Run402Image asset={...} alt="" />');
    assert.equal(err.docs, "https://run402.com/errors/r402-astro-image-asset-missing");
    assert.equal(err.subcode, undefined);
    assert.equal(err.fix, undefined);
  });

  it("preserves subcode + fix for strict-mode errors", () => {
    const err = new Run402ImageError({
      code: "R402_ASTRO_IMAGE_STRICT_DEGRADED",
      message: "asset missing required v1.49 fields under strict mode",
      subcode: "NO_INTRINSICS",
      fix: { missingFields: ["width_px", "height_px"] },
    });
    assert.equal(err.subcode, "NO_INTRINSICS");
    assert.deepEqual(err.fix, { missingFields: ["width_px", "height_px"] });
  });

  it("omits optional fields when not provided (no `undefined` properties)", () => {
    // Defensive — log shippers like Bugsnag enumerate enumerable keys,
    // and shipping `subcode: undefined` produces spurious bug reports.
    const err = new Run402ImageError({
      code: "R402_ASTRO_IMAGE_ASSET_STRING_URL",
      message: "Pass a typed AssetRef, not a URL string",
    });
    // `in` returns true for explicitly-`undefined` properties; this assert
    // catches if we ever drop the `if (input.X !== undefined)` guards.
    assert.equal("suggestedFix" in err, false);
    assert.equal("docs" in err, false);
    assert.equal("subcode" in err, false);
    assert.equal("fix" in err, false);
  });

  it("stack trace is preserved through the Error subclass", () => {
    const err = new Run402ImageError({
      code: "R402_ASTRO_IMAGE_SIZES_REQUIRED",
      message: "sizes prop required when AssetRef has variants",
    });
    assert.ok(typeof err.stack === "string");
    assert.match(err.stack ?? "", /Run402ImageError/);
  });
});

// =============================================================================
// Type-level contract assertions
// =============================================================================
//
// These assertions don't run any code (the `void` casts are stripped at
// runtime). They exist so TypeScript catches changes to the type contract:
// adding/removing required fields, retyping field shapes, etc.

describe("Run402ImageProps — type contract", () => {
  it("accepts the minimal-required shape (asset + alt)", () => {
    // The test passes by compiling. A type-level error here means the
    // minimal contract regressed.
    const _minimal: Run402ImageProps = {
      asset: {} as Run402ImageProps["asset"],
      alt: "",
    };
    void _minimal;
    assert.ok(true);
  });

  it("accepts the full shape with all optional props set", () => {
    const _full: Run402ImageProps = {
      asset: {} as Run402ImageProps["asset"],
      alt: "test",
      sizes: "100vw",
      priority: true,
      loading: "lazy",
      decoding: "async",
      width: 1920,
      height: 1080,
      placeholder: "auto",
      fetchpriority: "high",
      strict: { onSchema: ">=v1.49" },
      class: "hero",
      className: "hero", // Should fail at runtime (CONFLICTING) but type-OK
      style: { color: "red" },
      id: "main-hero",
      crossorigin: "anonymous",
      referrerpolicy: "no-referrer",
      "data-testid": "hero-image",
      "data-analytics-id": "homepage-hero",
    };
    void _full;
    assert.ok(true);
  });

  it("accepts `placeholder: \"auto\" | \"blurhash\" | \"none\"`", () => {
    const a: Run402ImageProps["placeholder"] = "auto";
    const b: Run402ImageProps["placeholder"] = "blurhash";
    const c: Run402ImageProps["placeholder"] = "none";
    const d: Run402ImageProps["placeholder"] = undefined;
    void [a, b, c, d];
    assert.ok(true);
  });

  it("accepts both binary and schema-filtered strict-mode shapes", () => {
    const binary: Run402ImageProps["strict"] = true;
    const filteredV149: Run402ImageProps["strict"] = { onSchema: ">=v1.49" };
    const filteredV150: Run402ImageProps["strict"] = { onSchema: ">=v1.50" };
    const filteredV154: Run402ImageProps["strict"] = { onSchema: ">=v1.54" };
    const filteredAny: Run402ImageProps["strict"] = { onSchema: "any" };
    void [binary, filteredV149, filteredV150, filteredV154, filteredAny];
    assert.ok(true);
  });

  it("style accepts both string and object form", () => {
    const stringForm: Run402ImageProps["style"] = "background-color: red;";
    const objectForm: Run402ImageProps["style"] = { backgroundColor: "red" };
    void [stringForm, objectForm];
    assert.ok(true);
  });
});

describe("DataAttributes — reserved-key exclusion", () => {
  it("accepts arbitrary `data-*` keys", () => {
    const _arbitrary: DataAttributes = {
      "data-testid": "hero",
      "data-cy": "homepage-hero",
      "data-analytics-id": "main-hero",
    };
    void _arbitrary;
    assert.ok(true);
  });

  it("type-rejects the reserved `data-run402-image` key", () => {
    // @ts-expect-error — `data-run402-image` is reserved by the component.
    const _reserved: DataAttributes = { "data-run402-image": "1" };
    void _reserved;
    assert.ok(true);
  });
});

describe("RenderTreeNode — discriminated union exhaustiveness", () => {
  it("each kind has the expected attrs shape", () => {
    const pictureNode: RenderTreeNode = {
      kind: "picture",
      children: [],
      attrs: {} as PictureAttrs,
    };
    const sourceNode: RenderTreeNode = {
      kind: "source",
      attrs: { srcset: "x 1x", sizes: "100vw", type: "image/webp" } satisfies SourceAttrs,
    };
    const imgNode: RenderTreeNode = {
      kind: "img",
      attrs: { src: "x", alt: "" } satisfies ImgAttrs,
    };
    const linkNode: RenderTreeNode = {
      kind: "link",
      attrs: { rel: "preload", as: "image" } satisfies LinkAttrs,
    };
    void [pictureNode, sourceNode, imgNode, linkNode];
    assert.ok(true);
  });

  it("exhaustiveness: discriminating on `kind` covers all variants", () => {
    function visit(node: RenderTreeNode): string {
      switch (node.kind) {
        case "picture":
          return "P";
        case "source":
          return "S";
        case "img":
          return "I";
        case "link":
          return "L";
        // If a new variant is added without updating this switch,
        // TypeScript catches it here.
      }
    }
    assert.equal(
      visit({ kind: "img", attrs: { src: "x", alt: "" } }),
      "I",
    );
  });
});

describe("RenderContext — required + optional fields", () => {
  it("minimal context = isSSR only", () => {
    const _ssr: RenderContext = { isSSR: true };
    const _csr: RenderContext = { isSSR: false };
    void [_ssr, _csr];
    assert.ok(true);
  });

  it("full context carries imageDefaults + registerPreload + recordDegradation", () => {
    const _full: RenderContext = {
      isSSR: true,
      imageDefaults: {
        strict: { onSchema: ">=v1.49" },
        placeholder: "auto",
      } satisfies ImageDefaults,
      registerPreload: (link: PreloadAttrs) => {
        void link;
      },
      recordDegradation: (entry: DegradationEntry) => {
        void entry;
      },
    };
    void _full;
    assert.ok(true);
  });
});

describe("DegradationEntry — manifest shape", () => {
  it("carries the four required fields with the right types", () => {
    const _entry: DegradationEntry = {
      assetSha256: "deadbeef",
      assetKey: "images/hero.jpg",
      missingFields: ["blurhash_data_url", "width_px"],
      occurrences: 3,
      firstSeenAt: "2026-05-24T12:00:00.000Z",
    };
    void _entry;
    assert.ok(true);
  });
});
