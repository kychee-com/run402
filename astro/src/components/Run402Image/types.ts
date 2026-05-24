/**
 * `<Run402Image>` — type system foundations.
 *
 * Implements §1 of `openspec/changes/run402-image-component-impl/tasks.md`
 * (tasks 1.1 - 1.7):
 *
 *   1.1  Run402ImageProps interface (the binding source of truth for the v1.0 prop contract)
 *   1.2  DataAttributes mapped type (arbitrary `data-*` pass-through, reserved-key exclusion)
 *   1.3  AstroComponent<T> + ReactComponent<T> brand types (wrong-entry-point detection)
 *   1.4  RenderContext interface (isSSR, registerPreload, imageDefaults, recordDegradation)
 *   1.5  RenderTreeNode discriminated union (picture, source, img, link variants)
 *   1.6  Run402ImageError class (extends Error with code + suggestedFix + docs)
 *   1.7  DegradationEntry shape (manifest accumulator)
 *
 * The Run402Image component is built around a SHARED CORE (`core.ts`) that
 * produces a framework-agnostic RenderTreeNode given an AssetRef + props +
 * context. Two thin adapters render that tree:
 *
 *   - `Run402Image.astro` (the Astro entry, §4) — emits framework-shaped
 *     Astro markup that Astro's Vite plugin compiles directly.
 *   - `Run402Image/react.tsx` (the React entry, §5) — recursively maps
 *     RenderTreeNode to React.createElement(...).
 *
 * The shared core means byte-identical HTML output across both adapters for
 * any valid AssetRef + props — protected by the byte-identity test suite
 * in §8. See spec §"Component output is framework-shaped Astro markup,
 * not stringified HTML" for the rationale.
 */

import type { AssetRef } from "@run402/functions";

// =============================================================================
// 1.1 — Run402ImageProps interface (binding source of truth)
// =============================================================================

/**
 * The complete prop contract for `<Run402Image>` v1.0.
 *
 * Per spec §"A typed `Run402ImageProps` interface is exported": EXHAUSTIVE —
 * no `[k: string]: unknown` escape hatch. Unknown non-data props rejected at
 * compile time. The ONE exception is `data-*` attributes (see DataAttributes
 * below) so test infrastructure (`data-testid`, `data-cy`) and analytics
 * tooling (`data-analytics-id`) work without per-attribute spec churn.
 *
 * Treat the field set + types as protocol-stable across the entire v1.x line:
 * adding a new optional field is minor; removing or retyping is major.
 */
export interface Run402ImageProps extends DataAttributes {
  /** The image source — typed AssetRef from `r.assets.put` / `r.assets.fromRef`.
   *  String URLs are rejected (`R402_ASTRO_IMAGE_ASSET_STRING_URL`); null
   *  / undefined rejected (`R402_ASTRO_IMAGE_ASSET_MISSING`); objects without
   *  a `cdn_url` field rejected (`R402_ASTRO_IMAGE_ASSET_WRONG_SHAPE`). */
  asset: AssetRef;
  /** Required at the type level. Empty string (`alt=""`) signals decorative
   *  per HTML5 §4.7.4.4 and is allowed. */
  alt: string;
  /** REQUIRED AT RUNTIME when the AssetRef carries multiple variants
   *  (`R402_ASTRO_IMAGE_SIZES_REQUIRED`). Structurally optional in the type
   *  because single-variant AssetRefs don't need it. */
  sizes?: string;
  /** Above-the-fold shorthand: sets `loading="eager"` + `fetchpriority="high"`
   *  + emits `<link rel="preload">` in SSR contexts (or via `registerPreload`
   *  when exposed). Conflict with `loading="lazy"` rejected
   *  (`R402_ASTRO_IMAGE_CONFLICTING_LOADING_PROPS`). */
  priority?: boolean;
  /** Default `"lazy"`. Pass `"eager"` without `priority` to skip the
   *  `fetchpriority="high"` and preload-link emission. */
  loading?: "lazy" | "eager";
  /** Default `"async"`. */
  decoding?: "sync" | "async" | "auto";
  /** Overrides `AssetRef.width_px` in the rendered `<img width=...>`
   *  attribute. Variant `<source srcset>` widths are unaffected. */
  width?: number;
  /** Overrides `AssetRef.height_px` in the rendered `<img height=...>`
   *  attribute. */
  height?: number;
  /** Placeholder rendering. Default `"auto"` renders if `blurhash_data_url`
   *  is present, omits otherwise — NO warning either way. `"blurhash"` is
   *  the explicit opt-in that emits a degradation warning + strict-fails
   *  on missing field. `"none"` suppresses the placeholder unconditionally. */
  placeholder?: "auto" | "blurhash" | "none";
  /** Forwarded to the rendered `<img>`. Default derived from `priority`
   *  (`"high"` when `priority=true`, otherwise unset). */
  fetchpriority?: "high" | "low" | "auto";
  /** Strict-mode opt-in. Default off (lenient with degradation warnings).
   *  Binary form: fail on any field below the v1.49+ target. Filtered form:
   *  fail only on AssetRefs that opt in via `asset_schema`. */
  strict?: boolean | { onSchema: ">=v1.49" | ">=v1.50" | ">=v1.54" | "any" };
  /** Caller's CSS class — appended verbatim after the
   *  `data-run402-image="<major>"` data attribute. NOT merged with any
   *  component-internal class (there isn't one). null/undefined emit no
   *  class attribute; empty-string emits `class=""`. */
  class?: string;
  /** React-port passthrough. Normalized to `class` in the rendered HTML.
   *  Passing BOTH `class` AND `className` on the same call fails with
   *  `R402_ASTRO_IMAGE_CONFLICTING_CLASS_PROPS`. */
  className?: string;
  /** Forwarded to the rendered `<img>` (NOT the `<picture>` wrapper);
   *  the component's own `background-image` / `background-size` /
   *  `background-position` style for the placeholder is merged into
   *  whatever string/object the caller provides per the "Style merge
   *  semantics" requirement — caller wins on property overlap.
   *  Note: callers passing `background: <shorthand>` will reset the
   *  placeholder `background-image`; use longhand (`background-color`,
   *  `background-size`, etc.) to preserve it. */
  style?: string | Record<string, string | number>;
  /** Forwarded to the outermost element. */
  id?: string;
  /** Forwarded verbatim. Component does NOT emit by default. */
  crossorigin?: "anonymous" | "use-credentials";
  /** Forwarded verbatim. */
  referrerpolicy?: string;
}

// =============================================================================
// 1.2 — DataAttributes mapped type
// =============================================================================

/**
 * Mapped type allowing arbitrary `data-*` attributes (`data-testid`,
 * `data-cy`, `data-analytics-id`, etc.) to pass through to the rendered
 * HTML.
 *
 * The `data-run402-image` key is RESERVED: the component sets it itself
 * (with the major version as value) to mark its own rendered output for
 * CSS selectors. Callers passing `data-run402-image` collide with the
 * component's marker and fail with `R402_ASTRO_IMAGE_RESERVED_DATA_ATTR`.
 *
 * The `Exclude<...>` clause here enforces the reservation at compile time
 * (TypeScript reports an error if the caller passes `data-run402-image`);
 * a runtime guard in the core builder catches JS consumers who bypass TS.
 */
export type DataAttributes = {
  // The exclude narrows the template literal to drop the reserved key.
  // TypeScript still allows other `data-*` keys with arbitrary suffixes.
  [K in Exclude<`data-${string}`, "data-run402-image">]?: string | number | boolean;
};

// =============================================================================
// 1.3 — Brand types for wrong-entry-point detection
// =============================================================================

/**
 * Brand applied to the Astro entry point's `Run402Image` symbol.
 *
 * The Astro entry exports a `.astro` component (compiled by Astro's Vite
 * plugin); the React entry exports a `React.FC<Run402ImageProps>`. Mixing
 * them at the JSX use-site (e.g., importing from `@run402/astro/components`
 * inside a `.tsx` file) produces a TypeScript error at compile time because
 * the brands differ.
 *
 * The unique-symbol property name keeps the brand structural-typing-safe:
 * no other type can accidentally satisfy this shape.
 *
 * The runtime guard in §7 catches JS consumers who bypass TypeScript by
 * checking for `Astro.locals` presence (Astro adapter) or `React.version`
 * (React adapter) and throwing `R402_ASTRO_IMAGE_WRONG_ENTRY_POINT`.
 */
declare const ASTRO_BRAND: unique symbol;
declare const REACT_BRAND: unique symbol;

export type AstroComponent<P> = ((props: P) => unknown) & {
  readonly [ASTRO_BRAND]: "astro";
};

export type ReactComponent<P> = ((props: P) => unknown) & {
  readonly [REACT_BRAND]: "react";
};

// =============================================================================
// 1.4 — RenderContext interface
// =============================================================================

/**
 * Context the shared core builder receives from whichever adapter (Astro or
 * React) is calling it. Both adapters MUST construct a RenderContext and
 * pass it to `buildRun402ImageRenderTree(props, context)`.
 *
 * - `isSSR`: distinguishes server-rendered from client-only React. Pure-
 *   client React MUST NOT emit `<link rel="preload">` (preload after `<body>`
 *   is parsed defeats the purpose; see spec §"SSR detection mechanism").
 * - `registerPreload`: optional hook exposed via `Astro.locals.run402` for
 *   v1.1+ head-injection. When provided, the component MAY use it instead
 *   of emitting an adjacent `<link>` placement. v1.0 implementations MAY
 *   leave this `undefined` and the component falls back to adjacent
 *   placement.
 * - `imageDefaults`: project-level configuration set via the run402 Astro
 *   integration (`run402({ imageDefaults: { strict, placeholder } })`).
 *   Per-call props override these.
 * - `recordDegradation`: build-time accumulator callback. Called when an
 *   AssetRef is missing optional fields in default (lenient) mode. The
 *   adapter routes this to a per-build accumulator that flushes to
 *   `image-degradations.json` at `astro:build:done`.
 */
export interface RenderContext {
  isSSR: boolean;
  registerPreload?: (link: PreloadAttrs) => void;
  imageDefaults?: ImageDefaults;
  recordDegradation?: (entry: DegradationEntry) => void;
}

/**
 * Project-level configuration set via the run402 Astro integration.
 * Per-call `Run402ImageProps` override these.
 */
export interface ImageDefaults {
  /** Same shape as `Run402ImageProps.strict`. NO project-level default —
   *  consumers opt in via `run402({ imageDefaults: { strict: ... } })`. */
  strict?: boolean | { onSchema: ">=v1.49" | ">=v1.50" | ">=v1.54" | "any" };
  /** Same shape as `Run402ImageProps.placeholder`. */
  placeholder?: "auto" | "blurhash" | "none";
}

/**
 * Attributes passed to `registerPreload(...)`. The component emits one of
 * two shapes depending on whether the AssetRef has variants:
 *
 *   - **Multi-variant** (`<picture>` rendered): srcset + sizes form
 *   - **Single-variant** (`<img>` rendered): href form
 *
 * Per spec §"registerPreload contract": idempotency-per-`(imagesrcset,
 * imagesizes)` for the multi-variant shape and per-`(href)` for the
 * single-variant shape.
 */
export interface PreloadAttrs {
  rel: "preload";
  as: "image";
  /** Multi-variant form. */
  imagesrcset?: string;
  imagesizes?: string;
  /** Single-variant form. */
  href?: string;
  type?: string;
  fetchpriority?: "high" | "low" | "auto";
}

// =============================================================================
// 1.5 — RenderTreeNode discriminated union
// =============================================================================

/**
 * The framework-agnostic intermediate representation produced by the shared
 * core (`buildRun402ImageRenderTree`). Both the Astro adapter and the React
 * adapter receive this tree and recursively serialize it to their native
 * output (Astro JSX-like markup OR `React.createElement(...)` calls).
 *
 * The byte-identity guarantee (spec §"Deterministic render output") rests
 * on:
 *   1. The core builder is pure (given identical AssetRef + props +
 *      context, returns an identical tree).
 *   2. Both adapters serialize the tree in the same attribute order.
 *
 * The discriminated union's `kind` field is the parser-friendly tag.
 */
export type RenderTreeNode =
  | { kind: "picture"; children: RenderTreeNode[]; attrs: PictureAttrs }
  | { kind: "source"; attrs: SourceAttrs }
  | { kind: "img"; attrs: ImgAttrs }
  | { kind: "link"; attrs: LinkAttrs };

/** Attrs forwarded onto the rendered `<picture>`. `class` and `id` flow
 *  here when the AssetRef has variants (multi-source case). Without
 *  variants, those flow to the `<img>` instead. */
export interface PictureAttrs {
  class?: string;
  id?: string;
  "data-run402-image"?: string;
  // Pass-through map for caller-supplied data-* attrs.
  dataAttrs?: Record<string, string | number | boolean>;
}

/** Attrs for a `<source>` inside `<picture>`. `sizes` is structurally
 *  optional (omitted entirely for single-variant `<picture>` — the
 *  shared core's `enforceSizesRequired` validates that multi-variant
 *  renders MUST carry it; single-variant doesn't need it because the
 *  browser only has one source URL to consider). */
export interface SourceAttrs {
  srcset: string;
  sizes?: string;
  type: string;
}

/** Attrs for the `<img>` element. The placeholder `background-image` style
 *  + caller's style merge live here. */
export interface ImgAttrs {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  loading?: "lazy" | "eager";
  decoding?: "sync" | "async" | "auto";
  fetchpriority?: "high" | "low" | "auto";
  sizes?: string;
  srcset?: string;
  class?: string;
  id?: string;
  style?: string;
  crossorigin?: "anonymous" | "use-credentials";
  referrerpolicy?: string;
  "data-run402-image"?: string;
  dataAttrs?: Record<string, string | number | boolean>;
}

/** Attrs for a `<link rel="preload">` emitted next to the `<picture>` /
 *  `<img>` (or registered via `registerPreload` when exposed). */
export interface LinkAttrs {
  rel: "preload";
  as: "image";
  imagesrcset?: string;
  imagesizes?: string;
  href?: string;
  type?: string;
  fetchpriority?: "high" | "low" | "auto";
}

// =============================================================================
// 1.6 — Run402ImageError class
// =============================================================================

/**
 * Component-specific error class. Every component-emitted error carries:
 *
 * - `code`: stable identifier from the `R402_ASTRO_IMAGE_*` family. Tested
 *   against in operator tooling + tenant integrations.
 * - `message`: human-readable description.
 * - `suggestedFix`: actionable string the caller can paste into their
 *   editor. Per the spec's "Wrong-entry-point" + "Missing asset" scenarios,
 *   these include literal code suggestions (`<Run402Image asset={...}>`
 *   replacement lines).
 * - `docs`: stable URL anchor on `https://run402.com/errors/`.
 * - `subcode`: optional finer-grained classification (e.g., for strict-mode
 *   `_STRICT_DEGRADED`: which specific field was missing).
 * - `fix`: optional structured fix metadata (the `missing-fields` list for
 *   `_STRICT_DEGRADED`; helps tooling generate auto-fixes).
 */
export class Run402ImageError extends Error {
  // `declare readonly` keeps these in the static TypeScript surface
  // (consumers can type-narrow with `err.code === "..."`) WITHOUT emitting
  // runtime field initializers. Without `declare`, modern TS (with
  // useDefineForClassFields: true) would produce
  // `Object.defineProperty(this, 'suggestedFix', { value: undefined })`
  // at construction — leaking `subcode: undefined` to log shippers like
  // Bugsnag that enumerate enumerable keys, producing spurious bug reports.

  /** Stable code from the `R402_ASTRO_IMAGE_*` family. */
  declare readonly code: string;
  /** Actionable string the caller can paste into their editor. */
  declare readonly suggestedFix?: string;
  /** Stable docs URL anchor. */
  declare readonly docs?: string;
  /** Finer-grained classification (e.g., strict-mode subcode). */
  declare readonly subcode?: string;
  /** Optional structured fix metadata (e.g., missing-fields list). */
  declare readonly fix?: Record<string, unknown>;

  constructor(input: {
    code: string;
    message: string;
    suggestedFix?: string;
    docs?: string;
    subcode?: string;
    fix?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "Run402ImageError";
    // `defineProperty` with explicit `writable: false` matches the
    // `readonly` typing AND avoids the `useDefineForClassFields` semantics.
    Object.defineProperty(this, "code", { value: input.code, enumerable: true });
    if (input.suggestedFix !== undefined)
      Object.defineProperty(this, "suggestedFix", { value: input.suggestedFix, enumerable: true });
    if (input.docs !== undefined)
      Object.defineProperty(this, "docs", { value: input.docs, enumerable: true });
    if (input.subcode !== undefined)
      Object.defineProperty(this, "subcode", { value: input.subcode, enumerable: true });
    if (input.fix !== undefined)
      Object.defineProperty(this, "fix", { value: input.fix, enumerable: true });
  }
}

// =============================================================================
// 1.7 — DegradationEntry shape
// =============================================================================

/**
 * Per-asset entry recorded by `recordDegradation` and flushed to
 * `<config.outDir>/run402/image-degradations.json` at `astro:build:done`.
 *
 * The dedupe key is `(asset.sha256, sorted-missing-fields-joined)`. Two
 * renders of the same AssetRef with the same missing-fields set are merged
 * into one entry with `occurrences += 1`. Distinct missing-fields sets on
 * the same asset land as distinct entries (lets the CI regression-gate
 * spot which exact field shape regressed).
 *
 * The manifest exists as a CI regression-gating artifact: a downstream CI
 * job can diff the build output against a checked-in golden manifest and
 * fail when a previously-clean asset starts degrading.
 */
export interface DegradationEntry {
  /** Hex sha256 of the asset's source bytes (`AssetRef.sha256`). */
  assetSha256: string;
  /** Asset's logical key (`AssetRef.key`). For human-readability in the
   *  manifest output. */
  assetKey: string;
  /** Sorted list of missing-field names. Sorted so the dedupe-key string
   *  representation is deterministic. */
  missingFields: string[];
  /** Counted up on each duplicate hit; starts at 1. */
  occurrences: number;
  /** Iso-timestamp of the first occurrence (when the manifest entry was
   *  initially created). Subsequent hits don't update this. */
  firstSeenAt: string;
}
