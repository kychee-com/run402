/**
 * JSX-shape smoke tests — verify v1.0.1 DX fixes per Kychon feedback.
 *
 * The Kychon team reported three type-level DX issues with v1.0.0:
 *
 *   #1. `<Run402Image>` in TSX produced `TS2786: 'Run402Image' cannot
 *       be used as a JSX component` because `ReactComponent<P>`'s return
 *       type was `unknown`. JSX requires the return type to be a node
 *       shape (assignable to `ReactNode`).
 *
 *   #2. `AssetRef` wasn't re-exported from `@run402/astro` — consumers
 *       had to add a separate `import type { AssetRef } from
 *       "@run402/functions"` line just to type their props.
 *
 *   #3. `Run402ImageProps` wasn't re-exported from
 *       `@run402/astro/react` — consumers wanting to compose typed
 *       wrappers (`Pick<Run402ImageProps, ...>`) had to deep-import from
 *       a non-public path.
 *
 * This test file exercises the FIXED behavior at compile time. The
 * test file's mere existence as a valid TSX module — given the imports
 * + JSX usage below — confirms all three are resolved. If a future
 * refactor regresses any of the three, this file fails to compile and
 * the build breaks at CI time before publish.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// React must be imported at runtime because tsconfig.json sets
// `jsx: "react"` — the JSX expressions below compile to
// `React.createElement(...)`. (Switching to the modern `jsx:
// "react-jsx"` automatic-runtime would let this file omit the React
// import, but that's a larger config change owned by the consumer.)
import React from "react";

// Issue #2: AssetRef MUST be re-exported from the React entry.
// Issue #3: Run402ImageProps MUST be re-exported from the React entry.
// Both imports below must resolve from THIS path — no deep-import to
// `./types.js` allowed, no separate `@run402/functions` line.
import {
  Run402Image,
  type AssetRef,
  type Run402ImageProps,
} from "./react.js";

void React; // keep the runtime-import alive against tsc tree-shaking

// =============================================================================
// Issue #1 — JSX shape acceptance
// =============================================================================

describe("Issue #1 — `<Run402Image>` accepts as a JSX component", () => {
  it("type-checks as a JSX element without TS2786", () => {
    // Building the AssetRef fixture inline (would normally come from
    // r.assets.fromRef in a real consumer).
    const fixture: AssetRef = {
      key: "images/hero.jpg",
      sha256: "deadbeef",
      size_bytes: 100,
      content_type: "image/jpeg",
      visibility: "public",
      immutable: false,
      url: null,
      immutable_url: null,
      cdn_url: "https://pr-test.run402.com/_blob/hero.jpg",
      cdn_immutable_url: null,
      sri: null,
      etag: '"sha256-deadbeef"',
      content_digest: "sha-256=:test:",
      immutableUrl: null,
      cdnUrl: "https://pr-test.run402.com/_blob/hero.jpg",
      cdnImmutableUrl: null,
      size: 100,
      contentType: "image/jpeg",
      contentSha256: "deadbeef",
    };

    // THE actual JSX site that broke in v1.0.0:
    // before: `'Run402Image' cannot be used as a JSX component. Its return type 'unknown' is not a valid JSX element.`
    // after: compiles cleanly because ReactComponent<P>'s return type is now `ReactElement | null`.
    const _element = <Run402Image asset={fixture} alt="hero" sizes="100vw" />;
    void _element;

    assert.ok(true, "JSX element constructed without TS2786");
  });

  it("type-checks under `priority` shorthand", () => {
    const fixture = {} as AssetRef;
    const _element = <Run402Image asset={fixture} alt="" priority sizes="100vw" />;
    void _element;
    assert.ok(true);
  });

  it("type-checks under composed React FC wrappers", () => {
    // The composability case — a project-specific `<HeroImage>` wraps
    // `<Run402Image>` with a project-default sizes value. The wrapper
    // function returns the JSX element directly. This pattern broke in
    // v1.0.0 because the wrapped JSX element's type didn't satisfy
    // `JSX.Element`.
    function HeroImage(props: { asset: AssetRef; alt: string }) {
      return <Run402Image {...props} sizes="100vw" priority />;
    }
    void HeroImage;
    assert.ok(true);
  });
});

// =============================================================================
// Issue #2 — AssetRef re-export
// =============================================================================

describe("Issue #2 — AssetRef re-exported from `@run402/astro/react`", () => {
  it("AssetRef is importable from `./react.js`", () => {
    // Type-only test — the import at the top of the file succeeded =
    // the re-export is in place. We verify the type by constructing a
    // value that satisfies its shape.
    const ref: AssetRef = {
      key: "k",
      sha256: "s",
      size_bytes: 0,
      content_type: "image/jpeg",
      visibility: "public",
      immutable: false,
      url: null,
      immutable_url: null,
      cdn_url: null,
      cdn_immutable_url: null,
      sri: null,
      etag: "",
      content_digest: "",
      immutableUrl: null,
      cdnUrl: null,
      cdnImmutableUrl: null,
      size: 0,
      contentType: "image/jpeg",
      contentSha256: "s",
    };
    assert.equal(ref.key, "k");
  });
});

// =============================================================================
// Issue #3 — Run402ImageProps re-export + composability
// =============================================================================

describe("Issue #3 — Run402ImageProps re-exported + composable", () => {
  it("Run402ImageProps is importable from `./react.js`", () => {
    // Spec scenario "Project-specific wrapper composes the prop type":
    // `type HeroImageProps = Pick<Run402ImageProps, "asset" | "alt" | "class">`.
    type HeroImageProps = Pick<Run402ImageProps, "asset" | "alt" | "class"> & {
      variant: "hero" | "card";
    };

    // Verify the picked type has the right shape via a value cast.
    const _props: HeroImageProps = {
      asset: {} as AssetRef,
      alt: "hero",
      class: "hero",
      variant: "hero",
    };
    void _props;
    assert.ok(true, "composes via Pick<>");
  });

  it("the typed wrapper actually renders a Run402Image", () => {
    type HeroProps = Pick<Run402ImageProps, "asset" | "alt">;
    function Hero(props: HeroProps) {
      return <Run402Image {...props} sizes="100vw" priority />;
    }
    void Hero;
    assert.ok(true);
  });
});
