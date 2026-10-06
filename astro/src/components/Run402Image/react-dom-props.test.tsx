/**
 * Regression test for kychee-com/run402-private#796.
 *
 * `render-react.tsx` used to hand React the lowercase HTML attribute
 * names (`class`, `srcset`, `fetchpriority`, `crossorigin`,
 * `referrerpolicy`, `imagesrcset`, `imagesizes`), so every render logged
 * "Invalid DOM property" in dev and in consumers' tests. It now passes
 * React's DOM prop names.
 *
 * React dedupes that warning per process (one message per property
 * name), so these renders must be the first React renders in the
 * process. Keep this in its own file: `node --test` runs each file in a
 * separate process.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { AssetRef } from "@run402/functions";

import { lowercaseAttributeNames } from "./attr-case.test-helper.js";
import { Run402Image } from "./react.js";
import { buildRun402ImageRenderTree } from "./core.js";
import { serializeRenderTree } from "./render-html.js";
import type { Run402ImageProps } from "./types.js";

function variant(kind: "thumb" | "medium" | "large", width: number) {
  const url = `https://pr-abc.run402.com/_blob/${kind}`;
  return {
    kind,
    format: "webp",
    width_px: width,
    height_px: Math.round((width * 3) / 4),
    sha256: `${kind}1234`,
    url,
    immutable_url: null,
    cdn_url: url,
    cdn_immutable_url: null,
  };
}

function makeAssetRef(overrides: Partial<AssetRef> = {}): AssetRef {
  const url = "https://pr-abc.run402.com/_blob/images/hero.jpg";
  return {
    key: "images/hero.jpg",
    sha256: "deadbeef0123456789",
    size_bytes: 102400,
    content_type: "image/jpeg",
    visibility: "public",
    immutable: false,
    url,
    immutable_url: null,
    cdn_url: url,
    cdn_immutable_url: null,
    sri: null,
    etag: '"sha256-deadbeef"',
    content_digest: "sha-256=:3q2+7w==:",
    immutableUrl: null,
    cdnUrl: url,
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
    display_url: url,
    display_immutable_url: null,
    variants: {
      thumb: variant("thumb", 320),
      medium: variant("medium", 800),
      large: variant("large", 1920),
    },
    ...overrides,
  } as AssetRef;
}

function renderHtmlPath(props: Run402ImageProps): string {
  // No `document` in the Node test runner, so the React FC renders in SSR
  // mode (preload emitted); mirror that on the HTML path.
  const { root, preload } = buildRun402ImageRenderTree(props, { isSSR: true });
  return (preload ? serializeRenderTree(preload) : "") + serializeRenderTree(root);
}

function renderCapturingConsoleErrors(props: Run402ImageProps): { html: string; errors: unknown[][] } {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    return { html: renderToString(createElement(Run402Image, props)), errors };
  } finally {
    console.error = original;
  }
}

const CASES: Array<{ name: string; props: Run402ImageProps; compareWithHtml: boolean }> = [
  {
    name: "multi-variant <picture> with priority, class, crossorigin, referrerpolicy",
    props: {
      asset: makeAssetRef(),
      alt: "Event hero",
      sizes: "100vw",
      priority: true,
      class: "event-hero",
      crossorigin: "anonymous",
      referrerpolicy: "no-referrer",
    },
    compareWithHtml: true,
  },
  {
    name: "bare <img> (no variants) with priority, class, crossorigin, referrerpolicy",
    props: {
      asset: makeAssetRef({ variants: undefined }),
      alt: "Bare hero",
      priority: true,
      class: "bare-hero",
      crossorigin: "use-credentials",
      referrerpolicy: "origin",
    },
    // Not compared with the HTML renderer: React 19's SSR adds its own
    // preload <link> for a non-lazy <img> outside <picture>, so this
    // render carries two preloads where the HTML path has one. That
    // predates #796 and is tracked separately.
    compareWithHtml: false,
  },
];

describe("<Run402Image> passes React DOM prop names (run402-private#796)", () => {
  for (const { name, props, compareWithHtml } of CASES) {
    it(`renderToString logs no console.error: ${name}`, () => {
      const { html, errors } = renderCapturingConsoleErrors(props);
      assert.deepEqual(
        errors.map((args) => args.map(String).join(" ")),
        [],
        `React logged console.error while rendering:\n${html}`,
      );
    });

    if (!compareWithHtml) continue;

    it(`renderToString matches the HTML renderer: ${name}`, () => {
      const { html } = renderCapturingConsoleErrors(props);
      const expected = renderHtmlPath(props);
      // The attributes this fix touches must actually be in the output,
      // so the comparison below covers them.
      for (const attr of ["class=", "fetchpriority=", "crossorigin=", "referrerpolicy="]) {
        assert.ok(expected.includes(attr), `fixture should exercise ${attr} — got ${expected}`);
      }
      assert.equal(
        lowercaseAttributeNames(html),
        lowercaseAttributeNames(expected),
        `React and HTML renderers diverged for "${name}"`,
      );
    });
  }
});
