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
 * the output of the HTML path against the same RenderTreeNode. This is
 * tested in `core.test.ts` and again at the byte-identity-suite level
 * in §8.
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
  // contract: data-run402-image → id → class → caller data-*). HTML
  // attribute names (lowercase) — see renderSource for byte-identity
  // rationale.
  const props: Record<string, unknown> = {};
  if (attrs["data-run402-image"] !== undefined) {
    props["data-run402-image"] = attrs["data-run402-image"];
  }
  if (attrs.id !== undefined) props.id = attrs.id;
  if (attrs.class !== undefined) props.class = attrs.class;
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
  // React 19's renderToStaticMarkup preserves attribute names verbatim
  // when they don't match a known DOM IDL property. To keep byte-identity
  // with `render-html.ts`'s lowercase HTML-attribute serialization, we
  // pass the HTML-attribute names (`srcset`, not `srcSet`). React still
  // renders them correctly — the camelCase form is a JSX convention, not
  // a runtime requirement.
  //
  // `sizes` is omitted when undefined (single-variant case — see
  // SourceAttrs JSDoc).
  const props: Record<string, unknown> = { srcset: attrs.srcset };
  if (attrs.sizes !== undefined) props.sizes = attrs.sizes;
  props.type = attrs.type;
  return createElement("source", props);
}

function renderImg(attrs: ImgAttrs): ReactElement {
  // Key order matches render-html.ts exactly. Attribute names match the
  // HTML form (lowercase) NOT React's JSX camelCase — see renderSource
  // above for the byte-identity rationale.
  const props: Record<string, unknown> = {};
  if (attrs["data-run402-image"] !== undefined) {
    props["data-run402-image"] = attrs["data-run402-image"];
  }
  if (attrs.id !== undefined) props.id = attrs.id;
  if (attrs.class !== undefined) props.class = attrs.class;

  props.src = attrs.src;
  if (attrs.srcset !== undefined) props.srcset = attrs.srcset;
  if (attrs.sizes !== undefined) props.sizes = attrs.sizes;
  if (attrs.width !== undefined) props.width = attrs.width;
  if (attrs.height !== undefined) props.height = attrs.height;
  if (attrs.loading !== undefined) props.loading = attrs.loading;
  if (attrs.decoding !== undefined) props.decoding = attrs.decoding;
  if (attrs.fetchpriority !== undefined) props.fetchpriority = attrs.fetchpriority;

  props.alt = attrs.alt;

  if (attrs.crossorigin !== undefined) props.crossorigin = attrs.crossorigin;
  if (attrs.referrerpolicy !== undefined) props.referrerpolicy = attrs.referrerpolicy;
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
  const props: Record<string, unknown> = {
    rel: attrs.rel,
    as: attrs.as,
  };
  if (attrs.imagesrcset !== undefined) props.imagesrcset = attrs.imagesrcset;
  if (attrs.imagesizes !== undefined) props.imagesizes = attrs.imagesizes;
  if (attrs.href !== undefined) props.href = attrs.href;
  if (attrs.type !== undefined) props.type = attrs.type;
  if (attrs.fetchpriority !== undefined) props.fetchpriority = attrs.fetchpriority;
  return createElement("link", props);
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
 * Convert the serializer's string-form CSS style into React's object
 * form (which `renderToStaticMarkup` requires). React 19 serializes the
 * object back to a compact form `key:value;key:value` (no spaces) —
 * matching `render-html.ts`'s output format. The HTML serializer's
 * placeholder block is built WITHOUT spaces between key:value:; pairs
 * specifically to round-trip cleanly through this parser without
 * format drift.
 *
 * Style keys arrive in CSS kebab-case (`background-image`); React
 * requires camelCase (`backgroundImage`). The roundtrip preserves
 * insertion order, so the React output lays properties down in the
 * same order the HTML serializer emits them.
 */
function parseStyleString(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of splitDeclarations(s)) {
    const trimmed = decl.trim();
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const k = trimmed.slice(0, colon).trim();
    const v = trimmed.slice(colon + 1).trim();
    if (k) out[reactStyleKey(k)] = v;
  }
  return out;
}

/**
 * Split a CSS-declarations string on `;`, BUT only at top-level depth
 * (outside of `url(...)`, `calc(...)`, etc).
 *
 * The default `string.split(";")` fails for data URLs:
 *
 *   background-image:url(data:image/png;base64,iVBORw...);background-size:cover
 *
 * `;base64` looks like a property separator but is part of the URL.
 * This depth-aware splitter tracks `(` / `)` and only splits at depth 0.
 *
 * Also handles quoted strings (`url("...")`, `content:"..."`) so a `;`
 * inside a quoted value doesn't trigger a split. Both `"` and `'` quote
 * forms are accepted; the active quote char remains escaped until the
 * matching closer.
 */
function splitDeclarations(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

function reactStyleKey(cssKey: string): string {
  // CSS `background-image` → React `backgroundImage`.
  return cssKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
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
