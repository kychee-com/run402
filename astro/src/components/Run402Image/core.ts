/**
 * `<Run402Image>` — shared core render-tree factory.
 *
 * Implements §2 of `openspec/changes/run402-image-component-impl/tasks.md`
 * (tasks 2.1 - 2.22). This is the framework-agnostic heart of the component
 * — given an `AssetRef` + `Run402ImageProps` + `RenderContext`, returns a
 * `RenderTreeNode` that the Astro and React adapters serialize to their
 * native output.
 *
 * Pure-local: NO `fetch()`, NO DB query, NO SDK call at render time. This
 * is essential for SSR cacheability (the rendered HTML is byte-deterministic
 * given the AssetRef) AND for the byte-identity guarantee across Astro /
 * React adapters (spec §"Deterministic render output").
 *
 * Entry point: `buildRun402ImageRenderTree(props, context)`. Everything
 * else in this file is a private helper.
 *
 * **Error-emission ordering** (critical for spec compliance — see scenario
 * tests):
 *
 *   1. Reserved data-attr collision     → `R402_ASTRO_IMAGE_RESERVED_DATA_ATTR`
 *   2. asset missing/null/undefined     → `R402_ASTRO_IMAGE_ASSET_MISSING`
 *   3. asset is a string                → `R402_ASTRO_IMAGE_ASSET_STRING_URL`
 *   4. asset.cdn_url missing            → `R402_ASTRO_IMAGE_ASSET_WRONG_SHAPE`
 *   5. asset.content_type non-image     → `R402_ASTRO_IMAGE_NON_IMAGE_ASSET`
 *   6. alt missing                      → `R402_ASTRO_IMAGE_ALT_REQUIRED`
 *   7. class + className both passed    → `R402_ASTRO_IMAGE_CONFLICTING_CLASS_PROPS`
 *   8. priority + loading="lazy" both   → `R402_ASTRO_IMAGE_CONFLICTING_LOADING_PROPS`
 *   9. HEIC + no display_jpeg variant   → `R402_ASTRO_IMAGE_HEIC_NO_TRANSCODE`
 *   10. variants ≥ 2 + sizes missing    → `R402_ASTRO_IMAGE_SIZES_REQUIRED`
 *   11. strict-mode degradation         → `R402_ASTRO_IMAGE_STRICT_DEGRADED`
 *
 * Order matters: HEIC fires BEFORE strict-mode resolution (spec §"HEIC
 * correctness floor"). The HEIC hard-fail is unconditional — schema-filter
 * does NOT skip it.
 */

import type { AssetRef } from "@run402/functions";

import {
  Run402ImageError,
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
// Error-code constants (single source — all references go through these)
// =============================================================================

const ERR = {
  ASSET_MISSING: "R402_ASTRO_IMAGE_ASSET_MISSING",
  ASSET_STRING_URL: "R402_ASTRO_IMAGE_ASSET_STRING_URL",
  ASSET_WRONG_SHAPE: "R402_ASTRO_IMAGE_ASSET_WRONG_SHAPE",
  NON_IMAGE_ASSET: "R402_ASTRO_IMAGE_NON_IMAGE_ASSET",
  ALT_REQUIRED: "R402_ASTRO_IMAGE_ALT_REQUIRED",
  CONFLICTING_CLASS_PROPS: "R402_ASTRO_IMAGE_CONFLICTING_CLASS_PROPS",
  CONFLICTING_LOADING_PROPS: "R402_ASTRO_IMAGE_CONFLICTING_LOADING_PROPS",
  HEIC_NO_TRANSCODE: "R402_ASTRO_IMAGE_HEIC_NO_TRANSCODE",
  SIZES_REQUIRED: "R402_ASTRO_IMAGE_SIZES_REQUIRED",
  STRICT_DEGRADED: "R402_ASTRO_IMAGE_STRICT_DEGRADED",
  RESERVED_DATA_ATTR: "R402_ASTRO_IMAGE_RESERVED_DATA_ATTR",
} as const;

const DOCS_BASE = "https://run402.com/errors/";

/** The `data-run402-image` major-version value emitted on the outermost
 *  element. v1.x → "1". CSS selectors should bind to the major: callers
 *  upgrading v1 → v2 expect the selector to break, hence the major-only
 *  marker. */
const COMPONENT_MAJOR_VERSION = "1";

/** Reserved-key set checked by the runtime guard. TS catches this at
 *  compile time via `DataAttributes`'s `Exclude`; this guard handles
 *  pure-JS consumers who bypass TypeScript. */
const RESERVED_DATA_ATTRS = new Set(["data-run402-image"]);

// =============================================================================
// Public entry point
// =============================================================================

/**
 * Build the framework-agnostic render tree for one `<Run402Image>` call.
 *
 * Both the Astro adapter (`Run402Image.astro`) and the React adapter
 * (`Run402Image/react.tsx`) call this and recursively serialize the
 * returned tree to their native output.
 *
 * Throws `Run402ImageError` (subclass of `Error`) on every validation or
 * correctness-floor failure — see the file header for the canonical
 * ordering of error emission. Strict-mode degradations also throw;
 * default-mode (lenient) degradations are reported via
 * `context.recordDegradation` and the render proceeds best-effort.
 *
 * @returns A `RenderTreeNode` representing either:
 *   - a single `<img>` (no variants OR pre-v1.49 AssetRef)
 *   - a `<picture>` wrapping a `<source srcset>` + `<img>` fallback
 *
 * The optional preload `<link>` is returned separately via
 * `RenderTreeNode.kind === "link"` — implementations either emit it
 * adjacently OR use `context.registerPreload` if exposed.
 */
export function buildRun402ImageRenderTree(
  props: Run402ImageProps,
  context: RenderContext,
): { root: RenderTreeNode; preload?: RenderTreeNode } {
  validateProps(props);

  const assetSchema = resolveAssetSchema(props.asset);
  const strictAppliesHere = resolveStrictApplies(
    props.strict,
    context.imageDefaults?.strict,
    assetSchema,
  );

  const variantLineup = collectOrderedVariants(props.asset);
  enforceHeicCorrectnessFloor(props.asset);
  enforceSizesRequired(props.asset, props.sizes, variantLineup.length);

  // Strict-mode evaluation runs LAST among validation steps. Any other
  // validation failure (HEIC, sizes) throws before we get here, so
  // strict-mode is only reached on otherwise-valid renders.
  enforceStrictMode({
    asset: props.asset,
    placeholder: resolvePlaceholder(props.placeholder, context.imageDefaults?.placeholder),
    strictApplies: strictAppliesHere,
    variantCount: variantLineup.length,
  });

  // Default-mode lenient degradation reporting. Schema-filtered: when
  // the project sets `imageDefaults.strict: { onSchema: ">=v1.49" }` AND
  // the AssetRef lacks `asset_schema`, the warning is suppressed (per
  // spec §"strict for new, lenient for legacy"). The `strictApplies`
  // flag captures the schema-filter result, so we reuse it here.
  if (!strictAppliesHere && projectFilteredOutLegacyAsset(
    context.imageDefaults?.strict,
    assetSchema,
  )) {
    // Legacy asset, project filter explicitly opted into "lenient for
    // legacy" — suppress warnings entirely.
  } else {
    maybeRecordDegradation({
      asset: props.asset,
      placeholder: resolvePlaceholder(props.placeholder, context.imageDefaults?.placeholder),
      variantCount: variantLineup.length,
      recordDegradation: context.recordDegradation,
    });
  }

  // Render-path branch.
  const rendered = renderTree({ props, context, variants: variantLineup });
  const preload = maybePreload({ props, context, variants: variantLineup });
  return preload ? { root: rendered, preload } : { root: rendered };
}

// =============================================================================
// 2.2 - 2.7 — Validation
// =============================================================================

function validateProps(props: Run402ImageProps): void {
  // 2.7 — reserved data-attr collision check runs FIRST so a caller who
  // passes both `data-run402-image` and (say) `asset: null` sees the
  // collision message, not the missing-asset message. This is a
  // pure-JS-consumer guard; TypeScript catches the same case at compile
  // time via `DataAttributes`'s `Exclude` clause.
  for (const key of Object.keys(props)) {
    if (RESERVED_DATA_ATTRS.has(key)) {
      throw new Run402ImageError({
        code: ERR.RESERVED_DATA_ATTR,
        message:
          `"${key}" is reserved by <Run402Image> — the component emits it itself ` +
          `(value "${COMPONENT_MAJOR_VERSION}") for stable CSS selectors and test hooks. ` +
          `Drop the prop or use a different data-* key (e.g., "data-component-marker").`,
        docs: DOCS_BASE + "#R402_ASTRO_IMAGE_RESERVED_DATA_ATTR",
      });
    }
  }

  // 2.2 — asset validation (3-way split per spec rev 1).
  const a: unknown = props.asset;
  if (a === null || a === undefined) {
    throw new Run402ImageError({
      code: ERR.ASSET_MISSING,
      message:
        '<Run402Image asset={...} alt="..." /> requires the `asset` prop. ' +
        "If you have a stored AssetRef in your DB, rehydrate it with " +
        "`r.assets.fromRef(rawJsonbValue)`. If you have raw bytes to upload, " +
        "use `r.assets.put(file, key)` server-side first.",
      suggestedFix:
        '<Run402Image asset={r.assets.fromRef(row.hero_asset)} alt="..." />',
      docs: DOCS_BASE + "#R402_ASTRO_IMAGE_ASSET_MISSING",
    });
  }
  if (typeof a === "string") {
    throw new Run402ImageError({
      code: ERR.ASSET_STRING_URL,
      message:
        `<Run402Image asset={...}> requires a typed AssetRef object, not a URL string. ` +
        `Got: "${truncate(a, 120)}". ` +
        "If you have a stored AssetRef in your DB, rehydrate with " +
        "`r.assets.fromRef(rawJsonbValue)`. If you have raw bytes to upload, " +
        "use `r.assets.put(file, key)` server-side first.",
      suggestedFix:
        '<Run402Image asset={r.assets.fromRef(row.hero_asset)} alt="..." />',
      docs: DOCS_BASE + "#R402_ASTRO_IMAGE_ASSET_STRING_URL",
    });
  }
  if (typeof a !== "object") {
    throw new Run402ImageError({
      code: ERR.ASSET_WRONG_SHAPE,
      message:
        `<Run402Image asset={...}> received a non-object: ${typeof a}. ` +
        "Pass a typed AssetRef object.",
      docs: DOCS_BASE + "#R402_ASTRO_IMAGE_ASSET_WRONG_SHAPE",
    });
  }
  // 2.2 — `cdn_url` is the only truly-required AssetRef field. Every
  // other field is independently optional per spec §"Field-level fallback
  // rules" — missing fields drive specific render decisions but don't
  // throw.
  const assetRecord = a as Record<string, unknown>;
  if (typeof assetRecord.cdn_url !== "string" || assetRecord.cdn_url === "") {
    throw new Run402ImageError({
      code: ERR.ASSET_WRONG_SHAPE,
      message:
        "AssetRef is missing the required `cdn_url` field. " +
        "The component cannot render an `<img src>` without a servable URL. " +
        "Re-fetch the AssetRef via `r.assets.fromRef(...)` or `r.assets.get(key)`.",
      fix: { missing_fields: ["cdn_url"] },
      docs: DOCS_BASE + "#R402_ASTRO_IMAGE_ASSET_WRONG_SHAPE",
    });
  }

  // 2.4 — content_type must be an image MIME (if present). Missing
  // content_type is permitted per the field-level fallback table; only
  // a *present* non-image content_type throws.
  if (assetRecord.content_type !== undefined && assetRecord.content_type !== null) {
    const ct = String(assetRecord.content_type);
    if (!ct.startsWith("image/")) {
      throw new Run402ImageError({
        code: ERR.NON_IMAGE_ASSET,
        message:
          `AssetRef has non-image content_type "${ct}". <Run402Image> renders ` +
          "only image assets. For PDFs / videos / generic downloads, use a " +
          "plain `<a href={asset.cdn_url} download>` link instead.",
        suggestedFix: '<a href={asset.cdn_url} download>{asset.key}</a>',
        docs: DOCS_BASE + "#R402_ASTRO_IMAGE_NON_IMAGE_ASSET",
      });
    }
  }

  // 2.3 — alt is required at the type level (TS); runtime guard catches
  // JS consumers. Empty string is allowed for decorative images per
  // HTML5 §4.7.4.4.
  if (typeof props.alt !== "string") {
    throw new Run402ImageError({
      code: ERR.ALT_REQUIRED,
      message:
        `<Run402Image alt={...}> requires an alt string (empty string ` +
        `\`alt=""\` is allowed for decorative images per HTML5 §4.7.4.4).`,
      suggestedFix: '<Run402Image asset={...} alt="..." />',
      docs: DOCS_BASE + "#R402_ASTRO_IMAGE_ALT_REQUIRED",
    });
  }

  // 2.5 — class + className mutual exclusion (React + Astro callers may
  // accidentally pass both during a port).
  if (props.class !== undefined && props.className !== undefined) {
    throw new Run402ImageError({
      code: ERR.CONFLICTING_CLASS_PROPS,
      message:
        `<Run402Image> received both \`class\` and \`className\`. ` +
        `Pass one or the other (\`class\` is the canonical form; ` +
        `\`className\` is the React port alias and is normalized to \`class\` ` +
        `in the rendered HTML).`,
      docs: DOCS_BASE + "#R402_ASTRO_IMAGE_CONFLICTING_CLASS_PROPS",
    });
  }

  // 2.6 — priority + loading="lazy" conflict. Silent resolution would
  // surprise (which one wins?), so we fail loudly.
  if (props.priority === true && props.loading === "lazy") {
    throw new Run402ImageError({
      code: ERR.CONFLICTING_LOADING_PROPS,
      message:
        '<Run402Image priority={true} loading="lazy" /> is contradictory. ' +
        '`priority` implies loading="eager"; passing loading="lazy" alongside ' +
        "is ambiguous. Drop one.",
      docs: DOCS_BASE + "#R402_ASTRO_IMAGE_CONFLICTING_LOADING_PROPS",
    });
  }
}

// =============================================================================
// 2.8 — HEIC correctness floor (unconditional hard-fail)
// =============================================================================

function enforceHeicCorrectnessFloor(asset: AssetRef): void {
  const ct = asset.content_type;
  if (ct !== "image/heic" && ct !== "image/heif") return;
  if (asset.variants?.display_jpeg) return;
  // The asset is HEIC AND has no display_jpeg variant. In Firefox + Chrome
  // (~75% of global browser share) the rendered `<img src="<heic-url>">`
  // produces ZERO pixels. This is total-render breakage, not partial
  // degradation — so the spec carves it out from BOTH the field-level
  // fallback table AND the schema-filtered strict mode.
  throw new Run402ImageError({
    code: ERR.HEIC_NO_TRANSCODE,
    message:
      `AssetRef is HEIC/HEIF (content_type "${ct}") but is missing the ` +
      "`display_jpeg` variant. <Run402Image> cannot render — `<img src=...>` " +
      "points at HEIC bytes that don't decode in Firefox + Chrome. " +
      "Three paths forward: (a) re-upload the source so the gateway " +
      "produces `display_jpeg`, (b) run the asset-image-variants backfill " +
      "with `--regenerate-heic-transcodes` to materialize `display_jpeg` " +
      "for already-stored HEIC, OR (c) replace the asset with a non-HEIC source.",
    fix: { remediation_options: ["re-upload", "backfill-heic-transcodes", "replace-asset"] },
    docs: DOCS_BASE + "#R402_ASTRO_IMAGE_HEIC_NO_TRANSCODE",
  });
}

// =============================================================================
// 2.9 — URL resolution (display_url with non-empty-string check)
// =============================================================================

/**
 * Resolve the `<img src>` URL. Spec §"display_url emptiness" rule:
 * `display_url: ""` (empty string) falls through to `cdn_url` instead of
 * rendering `<img src="">`. The browser bug being avoided: `<img src="">`
 * historically meant "re-fetch the document" in some browsers; modern
 * browsers degrade to broken-image, neither what the caller intends.
 *
 * Order: `display_url` (if non-empty-string) → `cdn_url`. Note `display_url`
 * is what the gateway sets for HEIC sources (points at the JPEG variant);
 * for non-HEIC sources `display_url === cdn_url` so the fallback is a no-op.
 */
function resolveImgSrc(asset: AssetRef): string {
  if (typeof asset.display_url === "string" && asset.display_url !== "") {
    return asset.display_url;
  }
  // Validated non-empty in `validateProps`.
  return asset.cdn_url as string;
}

// =============================================================================
// 2.10 + 2.12 — Variant detection + ordering
// =============================================================================

interface OrderedVariant {
  kind: "thumb" | "medium" | "large";
  url: string;
  width_px: number;
  format: "webp" | "jpeg";
}

/**
 * Collect the AssetRef's `thumb` / `medium` / `large` variants, drop any
 * with a missing URL, and return them ordered ASCENDING by `width_px`.
 *
 * Spec §"Variant ordering" (2.12): order by width, not by hardcoded
 * `["thumb", "medium", "large"]`. This keeps tests stable when the
 * upload-pipeline variant widths change.
 *
 * `display_jpeg` is intentionally NOT in this list — it's the HEIC
 * fallback for the bare `<img>` `src`, not a `<source>` entry.
 *
 * AVIF is NOT emitted in v1.0 (spec §"AVIF is NOT emitted"). When the
 * gateway eventually produces AVIF variants, this function stays unchanged
 * — the source-type-precedence footgun is documented in the spec.
 */
function collectOrderedVariants(asset: AssetRef): OrderedVariant[] {
  const variants = asset.variants;
  if (!variants) return [];

  const lineup: OrderedVariant[] = [];
  for (const kind of ["thumb", "medium", "large"] as const) {
    const v = variants[kind];
    if (!v) continue;
    const url = v.cdn_url ?? v.url;
    if (!url) continue;
    lineup.push({
      kind,
      url,
      width_px: v.width_px,
      format: (v.format as "webp" | "jpeg") ?? "webp",
    });
  }
  lineup.sort((a, b) => a.width_px - b.width_px);
  return lineup;
}

// =============================================================================
// 2.11 — Sizes-required enforcement
// =============================================================================

function enforceSizesRequired(
  asset: AssetRef,
  sizes: string | undefined,
  variantCount: number,
): void {
  // Spec: `sizes` is REQUIRED whenever the component would emit a
  // `<source srcset="...,...">` (two or more variants). One-variant
  // and zero-variant cases render a bare `<img>` and don't need it.
  if (variantCount < 2) return;
  if (typeof sizes === "string" && sizes.length > 0) return;
  throw new Run402ImageError({
    code: ERR.SIZES_REQUIRED,
    message:
      `<Run402Image asset={...key="${asset.key ?? "<unknown>"}"} ...> requires the ` +
      "`sizes` prop because the AssetRef has multiple variants. Without it, " +
      "browsers over-fetch the largest variant on mobile. See " +
      DOCS_BASE +
      "#R402_ASTRO_IMAGE_SIZES_REQUIRED for `sizes=` patterns and the " +
      "rationale.",
    docs: DOCS_BASE + "#R402_ASTRO_IMAGE_SIZES_REQUIRED",
  });
}

// =============================================================================
// 2.14 — Strict-mode resolution
// =============================================================================

type AssetSchema = "v1.49" | "v1.50" | "v1.54" | null;

function resolveAssetSchema(asset: AssetRef): AssetSchema {
  const raw = asset.asset_schema;
  if (raw === "v1.49" || raw === "v1.50" || raw === "v1.54") return raw;
  return null;
}

/**
 * Resolve whether strict-mode applies to THIS render given the caller's
 * `strict` prop, the project-level default, and the asset's schema.
 *
 * Resolution order:
 *   1. Per-call `props.strict` (if set, wins)
 *   2. Project default `imageDefaults.strict`
 *   3. Default: lenient (return `false`)
 *
 * Once resolved to a `strict` value, apply schema-filter:
 *   - `strict === true` → applies unconditionally
 *   - `strict === false | undefined` → never applies
 *   - `strict === { onSchema: ">=v1.49" | ... | "any" }` → applies iff the
 *      asset's `asset_schema` matches the predicate
 *
 * Per spec §"HEIC precondition for schema-filtered strict mode": this
 * function runs AFTER `enforceHeicCorrectnessFloor`, so an HEIC-no-transcode
 * row will have already thrown by the time we get here.
 */
function resolveStrictApplies(
  perCallStrict: Run402ImageProps["strict"],
  projectStrict: ImageDefaults["strict"],
  assetSchema: AssetSchema,
): boolean {
  const effective: Run402ImageProps["strict"] | undefined =
    perCallStrict ?? projectStrict;

  if (effective === undefined || effective === false) return false;
  if (effective === true) return true;

  // Schema-filtered form. The asset must carry an `asset_schema` AND
  // match the predicate.
  if (assetSchema === null) return false;
  const predicate = effective.onSchema;
  if (predicate === "any") return true;
  return schemaSatisfies(assetSchema, predicate);
}

/**
 * Compare an asset's `asset_schema` against a predicate like `">=v1.49"`.
 *
 * The contract enum in v1.0 is `"v1.49" | "v1.50" | "v1.54"`. Comparison
 * is done on the numeric components (1.49 vs 1.50 vs 1.54), NOT on
 * lexicographic order of the strings — `"v1.54" >= "v1.50"` would be
 * lex-false (`"5" === "5"`, `"4" > "0"` so `"v1.54" > "v1.50"`, ok lex
 * works here too — but only by accident). Keep the numeric comparator so
 * future contracts like `"v1.100"` continue to work.
 */
function schemaSatisfies(
  schema: Exclude<AssetSchema, null>,
  predicate: ">=v1.49" | ">=v1.50" | ">=v1.54" | "any",
): boolean {
  if (predicate === "any") return true;
  const schemaNum = parseSchemaVersion(schema);
  const predicateNum = parseSchemaVersion(
    predicate.slice(2) as Exclude<AssetSchema, null>,
  );
  return schemaNum >= predicateNum;
}

function parseSchemaVersion(s: Exclude<AssetSchema, null>): number {
  // "v1.49" → 1.49, "v1.54" → 1.54, etc. Multiply the minor by 1000 (so
  // future "v1.100" sorts after "v1.99") for a comparator-safe integer.
  const m = /^v(\d+)\.(\d+)$/.exec(s);
  if (!m) return -1;
  return parseInt(m[1]!, 10) * 1000 + parseInt(m[2]!, 10);
}

/**
 * Mirror of resolveStrictApplies for the default-mode warning-suppression
 * path. Returns true when the project default is schema-filtered AND the
 * asset's schema doesn't satisfy the predicate — meaning the project has
 * explicitly opted into "lenient for legacy" and warnings should be
 * suppressed for this render.
 */
function projectFilteredOutLegacyAsset(
  projectStrict: ImageDefaults["strict"],
  assetSchema: AssetSchema,
): boolean {
  if (!projectStrict || typeof projectStrict !== "object") return false;
  // Schema-filtered form. Asset lacks asset_schema → filtered out.
  if (assetSchema === null) return true;
  // Asset has asset_schema but doesn't satisfy the predicate → filtered out.
  return !schemaSatisfies(assetSchema, projectStrict.onSchema);
}

interface StrictModeInputs {
  asset: AssetRef;
  placeholder: "auto" | "blurhash" | "none";
  strictApplies: boolean;
  variantCount: number;
}

function enforceStrictMode(input: StrictModeInputs): void {
  if (!input.strictApplies) return;

  const missing: string[] = [];

  // NO_VARIANTS: AssetRef has no variant URLs whatsoever (zero entries
  // in the lineup). Pre-v1.49 AssetRefs hit this case.
  if (input.variantCount === 0) {
    missing.push("variants");
    throwStrictDegraded("NO_VARIANTS", input.asset, missing);
  }
  // NO_INTRINSICS: width_px OR height_px missing. Either-or fires
  // (the CLS-reservation goal needs both).
  if (input.asset.width_px === undefined || input.asset.height_px === undefined) {
    if (input.asset.width_px === undefined) missing.push("width_px");
    if (input.asset.height_px === undefined) missing.push("height_px");
    throwStrictDegraded("NO_INTRINSICS", input.asset, missing);
  }
  // NO_PLACEHOLDER: gated by EXPLICIT `placeholder="blurhash"` opt-in.
  // Default "auto" + missing blurhash_data_url does NOT trip strict-mode
  // (per spec §"Strict + placeholder="auto" interaction").
  if (
    input.placeholder === "blurhash" &&
    (input.asset.blurhash_data_url === undefined ||
      input.asset.blurhash_data_url === null)
  ) {
    missing.push("blurhash_data_url");
    throwStrictDegraded("NO_PLACEHOLDER", input.asset, missing);
  }
}

function throwStrictDegraded(
  subcode: "NO_VARIANTS" | "NO_INTRINSICS" | "NO_PLACEHOLDER" | "NO_CDN_URL" | "WRONG_SHAPE",
  asset: AssetRef,
  missing: string[],
): never {
  throw new Run402ImageError({
    code: ERR.STRICT_DEGRADED,
    subcode,
    message:
      `AssetRef "${asset.key ?? "<unknown>"}" (sha256=${(asset.sha256 ?? "").slice(0, 8)}…) ` +
      `degraded under strict mode. Missing required fields: [${missing.join(", ")}]. ` +
      `Subcode: ${subcode}.`,
    fix: { missing_fields: missing, subcode },
    docs: DOCS_BASE + "#R402_ASTRO_IMAGE_STRICT_DEGRADED",
  });
}

// =============================================================================
// Placeholder resolution + style block
// =============================================================================

function resolvePlaceholder(
  perCall: Run402ImageProps["placeholder"],
  projectDefault: ImageDefaults["placeholder"],
): "auto" | "blurhash" | "none" {
  // Per-call override wins (matches strict-mode resolution direction).
  if (perCall !== undefined) return perCall;
  if (projectDefault !== undefined) return projectDefault;
  return "auto";
}

/**
 * Build the placeholder style block. Returns a CSS string fragment to
 * prepend to the `<img>`'s inline style (the caller's style fragment is
 * appended AFTER — see 2.17 for the merge semantics).
 *
 * Empty string when no placeholder should be emitted (no
 * `blurhash_data_url` + placeholder !== "blurhash", or placeholder ===
 * "none", etc.).
 *
 * Per spec §"Placeholder is rendered from a PRE-DECODED `blurhash_data_url`
 * field" the block contains ALL THREE of:
 *   - background-image
 *   - background-size: cover
 *   - background-position: center
 *
 * Without all three, the 16×16 PNG tiles in the top-left of a 1920w hero
 * — a visibly broken placeholder.
 */
function buildPlaceholderStyle(
  asset: AssetRef,
  placeholder: "auto" | "blurhash" | "none",
): string {
  if (placeholder === "none") return "";
  if (asset.blurhash_data_url === undefined || asset.blurhash_data_url === null) {
    return "";
  }
  // Both "auto" + present and "blurhash" + present produce the block.
  //
  // Format: `key:value;key:value` (NO spaces between `:` and value, NO
  // trailing semicolon). This matches React's `renderToStaticMarkup`
  // output for object-form styles, which is essential for byte-identity
  // between the Astro and React adapters (see render-react.tsx's
  // parseStyleString round-trip).
  return (
    `background-image:url(${asset.blurhash_data_url});` +
    `background-size:cover;` +
    `background-position:center`
  );
}

// =============================================================================
// 2.13 + 2.17 — Style merge semantics
// =============================================================================

function mergeStyles(
  componentStyle: string,
  callerStyle: Run402ImageProps["style"],
): string | undefined {
  // Per spec §"Style merge semantics":
  //   - object form → `{...component, ...caller}` (caller wins on overlap)
  //   - string form → component-then-caller append (CSS cascade: later wins)
  // The placeholder style is built as a CSS string by buildPlaceholderStyle,
  // so the merge always treats `componentStyle` as a string.

  if (callerStyle === undefined || callerStyle === null) {
    return componentStyle === "" ? undefined : componentStyle;
  }

  if (typeof callerStyle === "string") {
    const merged = componentStyle + callerStyle;
    return merged === "" ? undefined : merged;
  }

  // Object form. Convert component-string to property map (just splits on
  // ";" + ":"), spread caller object on top, serialize back. The output
  // format matches React's `renderToStaticMarkup` object-style serialization
  // — `key:value;key:value` (NO spaces, NO trailing semicolon) — so the
  // Astro adapter and React adapter produce byte-identical HTML.
  const componentProps = parseInlineStyle(componentStyle);
  const callerProps: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(callerStyle)) {
    callerProps[normalizeStyleKey(k)] = v;
  }
  const merged = { ...componentProps, ...callerProps };
  const out = Object.entries(merged)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  return out === "" ? undefined : out;
}

function parseInlineStyle(s: string): Record<string, string> {
  if (s === "") return {};
  const out: Record<string, string> = {};
  for (const decl of splitDeclarations(s)) {
    const trimmed = decl.trim();
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const k = trimmed.slice(0, colon).trim();
    const v = trimmed.slice(colon + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/**
 * Split a CSS-declarations string on `;`, but only at top-level depth
 * (outside of `url(...)`, `calc(...)`, and quoted strings). Required
 * because data URLs contain a `;` (between the MIME and the payload —
 * `data:image/png;base64,...`) that would otherwise be misread as a
 * property separator. See render-react.tsx's matching helper for the
 * full rationale.
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

/**
 * Convert a JS camelCase style key to its CSS kebab-case form when
 * needed. React's `style` prop convention is `backgroundColor`, while
 * Astro's is `background-color`. Both work in `<img style="...">` HTML,
 * but the byte-identity guarantee requires we normalize to one form.
 */
function normalizeStyleKey(k: string): string {
  // If the key already has a dash, treat as-is (Astro form).
  if (k.includes("-")) return k;
  // camelCase → kebab-case. `backgroundColor` → `background-color`.
  return k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

// =============================================================================
// 2.18 — class / className normalization
// =============================================================================

function resolveClass(
  classProp: string | undefined,
  classNameProp: string | undefined,
): string | undefined {
  // The mutual-exclusion check runs in validateProps; by the time we
  // reach here, AT MOST one is non-undefined. Returning undefined means
  // "emit no class attribute".
  if (classProp !== undefined) return classProp;
  if (classNameProp !== undefined) return classNameProp;
  return undefined;
}

// =============================================================================
// 2.19 — data-* pass-through
// =============================================================================

function collectDataAttrs(props: Run402ImageProps): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!k.startsWith("data-")) continue;
    if (RESERVED_DATA_ATTRS.has(k)) continue; // validated above, defensive
    if (v === undefined || v === null) continue;
    out[k] = v as string | number | boolean;
  }
  return out;
}

// =============================================================================
// 2.20, 2.21, 2.22 — loading / decoding / fetchpriority / width / height
// =============================================================================

interface ResolvedImgAttrDefaults {
  width: number | undefined;
  height: number | undefined;
  loading: "lazy" | "eager";
  decoding: "sync" | "async" | "auto";
  fetchpriority: "high" | "low" | "auto" | undefined;
}

function resolveImgAttrDefaults(props: Run402ImageProps): ResolvedImgAttrDefaults {
  // 2.20 — width/height: caller props win over AssetRef intrinsics.
  const width = props.width ?? props.asset.width_px;
  const height = props.height ?? props.asset.height_px;

  // 2.22 — loading + priority + fetchpriority interaction.
  let loading: "lazy" | "eager";
  let fetchpriority: "high" | "low" | "auto" | undefined;
  if (props.priority === true) {
    loading = "eager";
    fetchpriority = "high";
  } else {
    loading = props.loading ?? "lazy";
    fetchpriority = props.fetchpriority;
  }

  // 2.21 — decoding default.
  const decoding = props.decoding ?? "async";

  return { width, height, loading, decoding, fetchpriority };
}

// =============================================================================
// 2.10 — Render-tree assembly (picture vs bare img)
// =============================================================================

interface RenderTreeInputs {
  props: Run402ImageProps;
  context: RenderContext;
  variants: OrderedVariant[];
}

function renderTree(input: RenderTreeInputs): RenderTreeNode {
  const { props, context, variants } = input;
  const { width, height, loading, decoding, fetchpriority } =
    resolveImgAttrDefaults(props);

  const src = resolveImgSrc(props.asset);
  const placeholderResolved = resolvePlaceholder(
    props.placeholder,
    context.imageDefaults?.placeholder,
  );
  const placeholderStyle = buildPlaceholderStyle(props.asset, placeholderResolved);
  const callerStyle = props.style;
  const style = mergeStyles(placeholderStyle, callerStyle);

  const dataAttrs = collectDataAttrs(props);
  const klass = resolveClass(props.class, props.className);
  const id = props.id;

  // No variants → bare `<img>` (pre-v1.49 AssetRef or below-threshold).
  if (variants.length === 0) {
    const imgAttrs: ImgAttrs = {
      src,
      alt: props.alt,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      loading,
      decoding,
      ...(fetchpriority !== undefined ? { fetchpriority } : {}),
      ...(klass !== undefined ? { class: klass } : {}),
      ...(id !== undefined ? { id } : {}),
      ...(style !== undefined ? { style } : {}),
      ...(props.crossorigin !== undefined ? { crossorigin: props.crossorigin } : {}),
      ...(props.referrerpolicy !== undefined ? { referrerpolicy: props.referrerpolicy } : {}),
      "data-run402-image": COMPONENT_MAJOR_VERSION,
      ...(Object.keys(dataAttrs).length > 0 ? { dataAttrs } : {}),
    };
    return { kind: "img", attrs: imgAttrs };
  }

  // Variants ≥ 1 → `<picture>` wrapper with `<source>` + `<img>` fallback.
  // Per spec §"Variants present but display_url missing": the `<img>`
  // src ALWAYS resolves to `display_url ?? cdn_url`, NOT the variant URLs
  // (which only appear in the `<source srcset>`).
  const srcset = variants.map((v) => `${v.url} ${v.width_px}w`).join(", ");
  // `enforceSizesRequired` validated when variants ≥ 2. For variants === 1
  // the caller MAY pass `sizes` but isn't required to — and if they
  // didn't, we OMIT `sizes` from the `<source>` rather than emit
  // `sizes="undefined"` (which the React renderer would also emit and
  // which the browser would treat as the literal string "undefined").
  const sourceAttrs: SourceAttrs = {
    srcset,
    ...(props.sizes !== undefined ? { sizes: props.sizes } : {}),
    type: variants[0]!.format === "webp" ? "image/webp" : "image/jpeg",
  };

  // The `<img>` fallback inside `<picture>` carries the picture-level
  // attrs (class, id, data-*) AND the placeholder style.
  const fallbackImg: ImgAttrs = {
    src,
    alt: props.alt,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    loading,
    decoding,
    ...(fetchpriority !== undefined ? { fetchpriority } : {}),
    ...(style !== undefined ? { style } : {}),
    ...(props.crossorigin !== undefined ? { crossorigin: props.crossorigin } : {}),
    ...(props.referrerpolicy !== undefined ? { referrerpolicy: props.referrerpolicy } : {}),
  };

  const pictureAttrs: PictureAttrs = {
    ...(klass !== undefined ? { class: klass } : {}),
    ...(id !== undefined ? { id } : {}),
    "data-run402-image": COMPONENT_MAJOR_VERSION,
    ...(Object.keys(dataAttrs).length > 0 ? { dataAttrs } : {}),
  };

  return {
    kind: "picture",
    attrs: pictureAttrs,
    children: [
      { kind: "source", attrs: sourceAttrs },
      { kind: "img", attrs: fallbackImg },
    ],
  };
}

// =============================================================================
// 2.15 — Preload emission for priority + SSR
// =============================================================================

function maybePreload(input: RenderTreeInputs): RenderTreeNode | undefined {
  // Spec §"SSR detection mechanism": pure-client React renders SHALL NOT
  // emit preload links — preload after `<body>` is parsed defeats the
  // purpose.
  if (input.props.priority !== true) return undefined;
  if (!input.context.isSSR) return undefined;

  const { props, variants } = input;

  // Per spec §"registerPreload contract extended to single-source
  // preload": there are two shapes —
  //
  //   multi-variant: imagesrcset + imagesizes
  //   single-source: href
  //
  // When variants exist, emit multi-variant. When no variants (bare
  // `<img>` path), emit single-source href form (the LCP win still
  // applies for single-source heroes).
  const fetchpriority: "high" | "low" | "auto" =
    props.fetchpriority ?? "high"; // priority=true defaults to high; caller can override

  if (variants.length === 0) {
    const href = resolveImgSrc(props.asset);
    const link: LinkAttrs = {
      rel: "preload",
      as: "image",
      href,
      ...(props.asset.content_type ? { type: props.asset.content_type } : {}),
      fetchpriority,
    };
    if (input.context.registerPreload) {
      input.context.registerPreload(linkToPreloadAttrs(link));
      return undefined; // hook consumed; no adjacent emission needed
    }
    return { kind: "link", attrs: link };
  }

  // Multi-variant shape.
  const imagesrcset = variants
    .map((v) => `${v.url} ${v.width_px}w`)
    .join(", ");
  const link: LinkAttrs = {
    rel: "preload",
    as: "image",
    imagesrcset,
    imagesizes: props.sizes,
    type: variants[0]!.format === "webp" ? "image/webp" : "image/jpeg",
    fetchpriority,
  };
  if (input.context.registerPreload) {
    input.context.registerPreload(linkToPreloadAttrs(link));
    return undefined;
  }
  return { kind: "link", attrs: link };
}

function linkToPreloadAttrs(link: LinkAttrs): PreloadAttrs {
  // LinkAttrs is the render-tree node; PreloadAttrs is the registerPreload
  // hook input. They have the same shape — the conversion exists to keep
  // the two type identities separate at the layer boundary.
  const out: PreloadAttrs = { rel: link.rel, as: link.as };
  if (link.imagesrcset !== undefined) out.imagesrcset = link.imagesrcset;
  if (link.imagesizes !== undefined) out.imagesizes = link.imagesizes;
  if (link.href !== undefined) out.href = link.href;
  if (link.type !== undefined) out.type = link.type;
  if (link.fetchpriority !== undefined) out.fetchpriority = link.fetchpriority;
  return out;
}

// =============================================================================
// Default-mode degradation recording (lenient render path)
// =============================================================================

interface DegradationInputs {
  asset: AssetRef;
  placeholder: "auto" | "blurhash" | "none";
  variantCount: number;
  recordDegradation?: (entry: DegradationEntry) => void;
}

function maybeRecordDegradation(input: DegradationInputs): void {
  if (!input.recordDegradation) return;

  const missing: string[] = [];
  if (input.variantCount === 0) missing.push("variants");
  if (input.asset.width_px === undefined) missing.push("width_px");
  if (input.asset.height_px === undefined) missing.push("height_px");
  if (
    input.placeholder === "blurhash" &&
    (input.asset.blurhash_data_url === undefined ||
      input.asset.blurhash_data_url === null)
  ) {
    missing.push("blurhash_data_url");
  }
  if (missing.length === 0) return;

  missing.sort();
  input.recordDegradation({
    assetSha256: input.asset.sha256 ?? "",
    assetKey: input.asset.key ?? "",
    missingFields: missing,
    occurrences: 1,
    firstSeenAt: new Date().toISOString(),
  });
}

// =============================================================================
// Helpers
// =============================================================================

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
