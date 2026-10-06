/**
 * `<Run402Image>` — RenderTreeNode → React.createElement(...) serializer.
 *
 * The React path mirror of `render-html.ts`. Both files traverse the
 * SAME RenderTreeNode shape; this one produces `React.ReactNode` while
 * the HTML path produces a string.
 *
 * **Byte-identity guarantee** (spec §"Same AssetRef, two consumption
 * paths, byte-identical output"): the rendered HTML through this React
 * path (via `renderToStaticMarkup` or `renderToString`) MUST byte-match
 * the output of the HTML path against the same RenderTreeNode, with one
 * exception: attribute NAME case. React 19 emits `srcSet`,
 * `fetchPriority`, `referrerPolicy`, `imageSrcSet` and `imageSizes`
 * verbatim where the HTML path emits the lowercase spelling (HTML
 * attribute names are case-insensitive). This is tested in
 * `react.test.tsx` and again at the byte-identity-suite level in §8.
 *
 * **Attribute ordering** — see the file header of `render-html.ts` for
 * the canonical contract. React's `createElement` builds props as an
 * object literal whose key order at serialization time matches the
 * order we set the keys in the source. We construct the props object
 * in the same order `render-html.ts` emits attrs, so
 * `renderToStaticMarkup` produces matching output.
 *
 * Strict-mode-friendly: no `window` / `document` references — works
 * under any React SSR renderer.
 */

import { createElement, type ReactElement, type ReactNode } from "react";

import { preloadCrossOrigin } from "./render-html.js";
import { foldDeclarations, parseDeclarations } from "./style-declarations.js";
import type {
  ImgAttrs,
  LinkAttrs,
  PictureAttrs,
  RenderTreeNode,
  SourceAttrs,
} from "./types.js";

// =============================================================================
// Public entry
// =============================================================================

export function renderToReact(node: RenderTreeNode): ReactElement {
  switch (node.kind) {
    case "picture":
      return renderPicture(node.attrs, node.children);
    case "img":
      return renderImg(node.attrs);
    case "link":
      return renderLink(node.attrs);
    case "source":
      return renderSource(node.attrs);
  }
}

// =============================================================================
// Element factories
// =============================================================================

function renderPicture(attrs: PictureAttrs, children: RenderTreeNode[]): ReactElement {
  // Construct props in the same key order as render-html.ts (header
  // contract: data-run402-image → id → class → caller data-*). React
  // DOM prop names (`className`) — see renderSource for byte-identity
  // rationale.
  const props: Record<string, unknown> = {};
  if (attrs["data-run402-image"] !== undefined) {
    props["data-run402-image"] = attrs["data-run402-image"];
  }
  if (attrs.id !== undefined) props.id = attrs.id;
  if (attrs.class !== undefined) props.className = attrs.class;
  appendDataAttrs(props, attrs.dataAttrs);

  const reactChildren: ReactNode[] = children.map((c, i) => {
    const el = renderToReact(c);
    // React requires keys on list children. We emit them stably from
    // the discriminator + index — the byte-identity contract assumes
    // the keys are absent from the static markup output (which they
    // are; React strips key props at serialization). Tested in §8.
    return cloneWithKey(el, `${c.kind}-${i}`);
  });

  return createElement("picture", props, ...reactChildren);
}

function renderSource(attrs: SourceAttrs): ReactElement {
  // Props use React's DOM property names (`srcSet`, `className`,
  // `fetchPriority`, `crossOrigin`, `referrerPolicy`, `imageSrcSet`,
  // `imageSizes`), never the lowercase HTML attribute names: React logs
  // "Invalid DOM property" for the HTML spelling
  // (kychee-com/run402-private#796). React serializes each camelCase prop
  // back to its lowercase HTML attribute, so `renderToStaticMarkup`
  // output still byte-matches `render-html.ts`.
  //
  // `sizes` is omitted when undefined (single-variant case — see
  // SourceAttrs JSDoc).
  const props: Record<string, unknown> = { srcSet: attrs.srcset };
  if (attrs.sizes !== undefined) props.sizes = attrs.sizes;
  props.type = attrs.type;
  return createElement("source", props);
}

function renderImg(attrs: ImgAttrs): ReactElement {
  // Key order matches render-html.ts exactly. Prop names are React's
  // camelCase DOM properties, not the HTML attribute names — see
  // renderSource above for the byte-identity rationale.
  const props: Record<string, unknown> = {};
  if (attrs["data-run402-image"] !== undefined) {
    props["data-run402-image"] = attrs["data-run402-image"];
  }
  if (attrs.id !== undefined) props.id = attrs.id;
  if (attrs.class !== undefined) props.className = attrs.class;

  props.src = attrs.src;
  if (attrs.srcset !== undefined) props.srcSet = attrs.srcset;
  if (attrs.sizes !== undefined) props.sizes = attrs.sizes;
  if (attrs.width !== undefined) props.width = attrs.width;
  if (attrs.height !== undefined) props.height = attrs.height;
  if (attrs.loading !== undefined) props.loading = attrs.loading;
  if (attrs.decoding !== undefined) props.decoding = attrs.decoding;
  if (attrs.fetchpriority !== undefined) props.fetchPriority = attrs.fetchpriority;

  props.alt = attrs.alt;

  if (attrs.crossorigin !== undefined) props.crossOrigin = attrs.crossorigin;
  if (attrs.referrerpolicy !== undefined) props.referrerPolicy = attrs.referrerpolicy;
  // React refuses string-form style props at runtime. Parse the
  // serializer's string form into the object form React expects. The
  // HTML serializer's output format must match React's
  // renderToStaticMarkup serialization (`key:value;key:value` — no
  // spaces, no trailing semicolon) to preserve byte-identity. See
  // `parseStyleString` below for the round-trip.
  if (attrs.style !== undefined) props.style = parseStyleString(attrs.style);

  appendDataAttrs(props, attrs.dataAttrs);
  return createElement("img", props);
}

function renderLink(attrs: LinkAttrs): ReactElement {
  // Only reached on React 18, which has no `ReactDOM.preload()` (see
  // `preloadViaReactDom`). Same order and `crossorigin` spelling as
  // `render-html.ts`'s serializeLink, which follows `ReactDOM.preload()`.
  const props: Record<string, unknown> = { rel: attrs.rel };
  if (attrs.href !== undefined) props.href = attrs.href;
  props.as = attrs.as;
  if (attrs.crossorigin !== undefined) props.crossOrigin = preloadCrossOrigin(attrs.crossorigin);
  if (attrs.type !== undefined) props.type = attrs.type;
  if (attrs.fetchpriority !== undefined) props.fetchPriority = attrs.fetchpriority;
  if (attrs.referrerpolicy !== undefined) props.referrerPolicy = attrs.referrerpolicy;
  if (attrs.imagesrcset !== undefined) props.imageSrcSet = attrs.imagesrcset;
  if (attrs.imagesizes !== undefined) props.imageSizes = attrs.imagesizes;
  return createElement("link", props);
}

/** `ReactDOM.preload` (React 19+), as far as this adapter calls it. */
export type ReactDomPreload = (
  href: string,
  options: {
    as: "image";
    crossOrigin?: string;
    type?: string;
    fetchPriority?: "high" | "low" | "auto";
    referrerPolicy?: ReferrerPolicy;
    imageSrcSet?: string;
    imageSizes?: string;
  },
) => void;

/**
 * Hand the preload to React instead of rendering a `<link>` element.
 *
 * React 19's server renderer preloads every non-lazy `<img>` outside
 * `<picture>` on its own, and does not dedupe that against a rendered
 * `<link rel="preload">` element, so the bare-`<img>` path used to emit
 * two preloads for one URL. `ReactDOM.preload()` registers the resource
 * under the key React's automatic image preload uses (the `src`, or
 * `imagesrcset` + `imagesizes`), so React writes exactly one `<link>`,
 * hoisted into the document head (or the preamble of a fragment render).
 *
 * `href` is required by `ReactDOM.preload()`; React drops it from the
 * output when `imageSrcSet` is present, so the srcset form passes its
 * first candidate URL.
 */
export function preloadViaReactDom(attrs: LinkAttrs, preload: ReactDomPreload): void {
  const href = attrs.href ?? attrs.imagesrcset?.split(" ")[0];
  if (!href) return;
  preload(href, {
    as: attrs.as,
    ...(attrs.crossorigin !== undefined ? { crossOrigin: attrs.crossorigin } : {}),
    ...(attrs.type !== undefined ? { type: attrs.type } : {}),
    ...(attrs.fetchpriority !== undefined ? { fetchPriority: attrs.fetchpriority } : {}),
    ...(attrs.referrerpolicy !== undefined
      ? { referrerPolicy: attrs.referrerpolicy as ReferrerPolicy }
      : {}),
    ...(attrs.imagesrcset !== undefined ? { imageSrcSet: attrs.imagesrcset } : {}),
    ...(attrs.imagesizes !== undefined ? { imageSizes: attrs.imagesizes } : {}),
  });
}

// =============================================================================
// Helpers
// =============================================================================

function appendDataAttrs(
  props: Record<string, unknown>,
  dataAttrs: Record<string, string | number | boolean> | undefined,
): void {
  if (!dataAttrs) return;
  // Match render-html.ts: sorted-key serialization.
  const keys = Object.keys(dataAttrs).sort();
  for (const k of keys) {
    const v = dataAttrs[k];
    if (v === undefined || v === null) continue;
    props[k] = v;
  }
}

/**
 * Convert the serializer's string-form CSS style into React's object form
 * (which `renderToStaticMarkup` requires). React 19 serializes the object
 * back as `name:value;name:value`. Core already emits the canonical form
 * from style-declarations.ts, so parsing and folding it again is a no-op
 * there, and React writes the same bytes the HTML serializer does: same
 * properties, same order. Keys are rebuilt from insertion order, so a
 * property sits where its winning declaration was.
 */
function parseStyleString(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of foldDeclarations(parseDeclarations(s))) {
    out[reactStyleKey(name)] = value;
  }
  return out;
}

function reactStyleKey(cssName: string): string {
  // React passes custom properties through verbatim; camel-casing
  // `--brand-color` would print `-BrandColor`.
  if (cssName.startsWith("--")) return cssName;
  // CSS `background-image` → React `backgroundImage`. React hyphenates it
  // back on output (`-webkit-mask` → `WebkitMask` → `-webkit-mask`).
  return cssName.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * React requires `key` props on list children. cloneElement with key —
 * but we don't want React's `cloneElement` because it mutates the
 * element's identity. Re-call createElement with the same type + props
 * + children.
 */
function cloneWithKey(el: ReactElement, key: string): ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyEl = el as any;
  return createElement(anyEl.type, { ...anyEl.props, key }, ...(anyEl.props?.children ? [anyEl.props.children] : []));
}
