/**
 * `<Run402Image>` — RenderTreeNode → HTML string serializer.
 *
 * Used by the Astro adapter (`Run402Image.astro` injects the result via
 * `set:html`). The byte-identity guarantee (spec §"Deterministic render
 * output") rests on this serializer producing byte-identical output for
 * byte-identical RenderTreeNode inputs.
 *
 * **Attribute serialization order is part of the determinism contract.**
 * HTML attribute order isn't semantic to browsers, but text-based
 * comparison (CI golden-file diffs, SSR cache key derivation) treats it
 * as significant. This serializer commits to a STABLE order:
 *
 *   1. `data-run402-image` first (so CSS selectors / test hooks read
 *      it consistently in the rendered HTML, even if a test snapshot
 *      truncates at a fixed character count)
 *   2. `id` second (sibling identifier)
 *   3. `class` third (presentational identifier)
 *   4. Required content attrs in spec-declared order: `src`, `srcset`,
 *      `sizes`, `type`, `href` (varies by element)
 *   5. Display + dimension attrs: `width`, `height`
 *   6. Loading + decoding: `loading`, `decoding`, `fetchpriority`
 *   7. `alt` (after dimensions per HTML5 §4.7.4.4 — `width/height`
 *      need to land before alt for layout-reservation parsers)
 *   8. `crossorigin`, `referrerpolicy`
 *   9. `style` (last among quoted attrs since it tends to be the longest)
 *  10. Caller `data-*` pass-through in iteration order (`Object.entries`)
 *
 * The React adapter's `render-react.ts` uses the SAME ordering when
 * spreading attrs into `React.createElement(...)` so the SSR-rendered
 * HTML through `renderToStaticMarkup` byte-matches the Astro path.
 */

import type {
  ImgAttrs,
  LinkAttrs,
  PictureAttrs,
  RenderTreeNode,
  SourceAttrs,
} from "./types.js";

// =============================================================================
// Public entry point
// =============================================================================

/**
 * Serialize a RenderTreeNode into an HTML string. Both the optional
 * preload `<link>` and the root rendered element are serialized; the
 * caller composes them in the order the adapter prefers (the spec is
 * neutral on whether `<link>` precedes or follows the `<picture>` —
 * either works for browser preload).
 */
export function serializeRenderTree(node: RenderTreeNode): string {
  switch (node.kind) {
    case "picture":
      return serializePicture(node.attrs, node.children);
    case "img":
      return serializeImg(node.attrs);
    case "link":
      return serializeLink(node.attrs);
    case "source":
      return serializeSource(node.attrs);
  }
}

// =============================================================================
// Element serializers
// =============================================================================

function serializePicture(
  attrs: PictureAttrs,
  children: RenderTreeNode[],
): string {
  const inner = children.map(serializeRenderTree).join("");
  return `<picture${serializePictureAttrs(attrs)}>${inner}</picture>`;
}

function serializePictureAttrs(attrs: PictureAttrs): string {
  // Attribute order (see file header for the determinism contract):
  // data-run402-image → id → class → caller data-*.
  const parts: string[] = [];
  if (attrs["data-run402-image"] !== undefined) {
    parts.push(attr("data-run402-image", attrs["data-run402-image"]));
  }
  if (attrs.id !== undefined) parts.push(attr("id", attrs.id));
  if (attrs.class !== undefined) parts.push(attr("class", attrs.class));
  appendDataAttrs(parts, attrs.dataAttrs);
  return joinAttrs(parts);
}

function serializeSource(attrs: SourceAttrs): string {
  // <source> is HTML-spec self-closing inside <picture>. Browsers accept
  // `<source ...>` and `<source ... />` equivalently in HTML5 parsers;
  // we emit `<source ... />` (XML-style self-close) for compatibility
  // with React's `renderToStaticMarkup` output, which uses self-closing
  // form for void elements. This keeps byte-identity holding across
  // adapters.
  const parts: string[] = [attr("srcset", attrs.srcset)];
  if (attrs.sizes !== undefined) parts.push(attr("sizes", attrs.sizes));
  parts.push(attr("type", attrs.type));
  return `<source${joinAttrs(parts)}/>`;
}

function serializeImg(attrs: ImgAttrs): string {
  const parts: string[] = [];
  // data-run402-image first when present (bare-img case; not present
  // when img is inside <picture>).
  if (attrs["data-run402-image"] !== undefined) {
    parts.push(attr("data-run402-image", attrs["data-run402-image"]));
  }
  if (attrs.id !== undefined) parts.push(attr("id", attrs.id));
  if (attrs.class !== undefined) parts.push(attr("class", attrs.class));

  // Required content attr.
  parts.push(attr("src", attrs.src));

  // Variant-related attrs (only emitted in some paths).
  if (attrs.srcset !== undefined) parts.push(attr("srcset", attrs.srcset));
  if (attrs.sizes !== undefined) parts.push(attr("sizes", attrs.sizes));

  // Dimensions BEFORE alt per CLS-reservation parsers.
  if (attrs.width !== undefined) parts.push(attr("width", attrs.width));
  if (attrs.height !== undefined) parts.push(attr("height", attrs.height));

  // Loading + decoding cluster.
  if (attrs.loading !== undefined) parts.push(attr("loading", attrs.loading));
  if (attrs.decoding !== undefined) parts.push(attr("decoding", attrs.decoding));
  if (attrs.fetchpriority !== undefined) {
    parts.push(attr("fetchpriority", attrs.fetchpriority));
  }

  // alt is required at the type level — every render emits it.
  parts.push(attr("alt", attrs.alt));

  if (attrs.crossorigin !== undefined) {
    parts.push(attr("crossorigin", attrs.crossorigin));
  }
  if (attrs.referrerpolicy !== undefined) {
    parts.push(attr("referrerpolicy", attrs.referrerpolicy));
  }

  // style last among non-data attrs (tends to be the longest).
  if (attrs.style !== undefined) parts.push(attr("style", attrs.style));

  appendDataAttrs(parts, attrs.dataAttrs);

  return `<img${joinAttrs(parts)}/>`;
}

function serializeLink(attrs: LinkAttrs): string {
  // <link rel="preload" as="image" ...> — order: rel, as, then conditional
  // payload attrs in spec order.
  const parts: string[] = [
    attr("rel", attrs.rel),
    attr("as", attrs.as),
  ];
  if (attrs.imagesrcset !== undefined) parts.push(attr("imagesrcset", attrs.imagesrcset));
  if (attrs.imagesizes !== undefined) parts.push(attr("imagesizes", attrs.imagesizes));
  if (attrs.href !== undefined) parts.push(attr("href", attrs.href));
  if (attrs.type !== undefined) parts.push(attr("type", attrs.type));
  if (attrs.fetchpriority !== undefined) {
    parts.push(attr("fetchpriority", attrs.fetchpriority));
  }
  return `<link${joinAttrs(parts)}/>`;
}

// =============================================================================
// Attribute formatters + escapers
// =============================================================================

function appendDataAttrs(
  parts: string[],
  dataAttrs: Record<string, string | number | boolean> | undefined,
): void {
  if (!dataAttrs) return;
  // Deterministic order: caller-passed `data-*` attrs serialize in
  // sorted-key order. `Object.entries` insertion order is undefined
  // across V8 versions for string keys with all-integer-like prefixes,
  // but our keys are `data-<word>` so they're string-typed; sorting
  // makes the contract explicit either way.
  const keys = Object.keys(dataAttrs).sort();
  for (const k of keys) {
    const v = dataAttrs[k];
    if (v === undefined || v === null) continue;
    parts.push(attr(k, v));
  }
}

function attr(name: string, value: string | number | boolean): string {
  // Booleans serialize as bare attribute names (e.g., `<img disabled>`)
  // when true; omitted when false. Spec-driven attrs in our shape are
  // all string/number; this branch is defensive for caller data-* attrs.
  if (value === true) return name;
  if (value === false) return "";
  return `${name}="${escapeAttr(String(value))}"`;
}

/**
 * Escape an attribute value per HTML5 §13.1.2.3. We escape:
 *   - `&` → `&amp;`  (must come first or other escapes double-encode)
 *   - `"` → `&quot;` (our attrs are double-quoted)
 *   - `<` → `&lt;`   (defense-in-depth; should never appear in attrs)
 *   - `>` → `&gt;`
 *
 * The component never accepts user-supplied strings into attribute
 * positions without going through this escaper. The shared core's
 * validation ensures `asset.cdn_url`, `alt`, etc. are well-typed
 * primitives, but they ARE user-controlled at the consumer layer (an
 * admin uploading content). Escaping here is the defense-in-depth tier.
 */
export function escapeAttr(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    switch (c) {
      case "&":
        out += "&amp;";
        break;
      case '"':
        out += "&quot;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      default:
        out += c;
    }
  }
  return out;
}

function joinAttrs(parts: string[]): string {
  const filtered = parts.filter((p) => p !== "");
  if (filtered.length === 0) return "";
  return " " + filtered.join(" ");
}
