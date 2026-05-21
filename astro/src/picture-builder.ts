/**
 * Pure-function HTML emission for the `<Image>` component.
 *
 * Separated from the `.astro` file so it's unit-testable as plain TypeScript
 * (snapshot tests don't need to spin up the Astro compiler). The `.astro`
 * component calls `buildPictureHtml()` and inserts the result via `set:html`.
 *
 * Decisions implemented here (cross-reference design.md):
 *   - D4: srcset uses the gateway's actual variant widths from the AssetRef,
 *     not a hard-coded 320/800/1920 — if the gateway ever generates a
 *     different set we render whatever it returned.
 *   - D5: HEIC sources use `display_jpeg` for the `<img>` fallback, never
 *     the raw HEIC bytes.
 *   - D6: blurhash → 32x32 PNG data URI in `background-image` by default.
 *   - D7: width/height as HTML attributes, NOT inline aspect-ratio style.
 */

import { averageColorFromBlurhash, decodeBlurhashToDataUri } from "./blurhash-decoder.js";
import type { AssetRef, AssetVariant, ImageProps } from "./types.js";

export interface BuildPictureInput {
  ref: AssetRef;
  props: ImageProps;
}

export interface BuildPictureOutput {
  html: string;
  /** Build-time warnings to print to the integration log. */
  warnings: string[];
}

export function buildPictureHtml(input: BuildPictureInput): BuildPictureOutput {
  const { ref, props } = input;
  const warnings: string[] = [];

  const placeholder = props.placeholder ?? "blurhash";
  const sizes = props.sizes ?? "100vw";

  // Resolve dimensions. If the user passes width/height overrides, honor
  // them and recompute the other side preserving aspect ratio. Warn either
  // way so we don't silently distort.
  const { width, height } = resolveDimensions(ref, props, warnings);

  // Loading + fetchpriority resolution.
  const { loadingAttr, fetchPriorityAttr } = resolveLoading(props);

  // Style attribute for the placeholder.
  const styleAttr = resolvePlaceholderStyle(ref, placeholder);

  // Class passthrough.
  const classAttr = props.class ? ` class="${escapeAttr(props.class)}"` : "";

  // Caller-supplied attrs for the outer wrapper element. Goes on
  // <picture> in the variant path; on the <img> in the no-variant
  // fallback (the <img> IS the outer element when there's no wrapper).
  const wrapperAttrs = formatExtraAttrs(props.pictureAttrs);

  // Variants: if no variants present OR neither thumb/medium/large are set,
  // we emit a single <img> (sub-320 / decode-failed fallback).
  const variants = ref.variants;
  const hasVariants =
    !!variants && (variants.thumb || variants.medium || variants.large);

  // Fallback src: HEIC sources MUST use display_jpeg's cdn_url. Non-HEIC
  // sources use display_url (which equals cdn_url for non-HEIC) or fall
  // back to cdn_url.
  const fallbackSrc = pickFallbackSrc(ref);

  if (!hasVariants) {
    if (ref.variant_spec_version === undefined && ref.width_px === undefined) {
      // Genuinely non-image content (e.g., PDF). The component shouldn't
      // be used for these; warn but render an <img> anyway.
      warnings.push(
        `<Image src="${props.src}"> — AssetRef carries no image-intrinsic fields; the source may not be an image.`,
      );
    } else {
      // Image but undersized or decode-failed.
      warnings.push(
        `<Image src="${props.src}"> — source is below the 320-pixel variant threshold or variants are unavailable; emitting a single <img>.`,
      );
    }
    const altAttr = escapeAttr(props.alt);
    const dim = formatDimAttrs(width, height);
    return {
      html:
        `<img src="${escapeAttr(fallbackSrc)}" alt="${altAttr}"${dim}${styleAttr}${classAttr} ` +
        `loading="${loadingAttr}"${fetchPriorityAttr}${wrapperAttrs} />`,
      warnings,
    };
  }

  // Build the WebP srcset from whichever variants the gateway returned.
  const srcsetEntries: string[] = [];
  for (const kind of ["thumb", "medium", "large"] as const) {
    const v = variants[kind];
    if (v) srcsetEntries.push(`${escapeAttr(v.cdn_url)} ${v.width_px}w`);
  }
  const srcsetAttr = srcsetEntries.join(", ");

  const altAttr = escapeAttr(props.alt);
  const sizesAttr = escapeAttr(sizes);
  const dim = formatDimAttrs(width, height);

  return {
    html:
      `<picture${wrapperAttrs}>` +
      `<source type="image/webp" srcset="${srcsetAttr}" sizes="${sizesAttr}" />` +
      `<img src="${escapeAttr(fallbackSrc)}" alt="${altAttr}"${dim}${styleAttr}${classAttr} ` +
      `loading="${loadingAttr}"${fetchPriorityAttr} />` +
      `</picture>`,
    warnings,
  };
}

/**
 * Serialize a `Record<string, string>` of extra attributes into the
 * `' k1="v1" k2="v2"'` form. Skips keys that don't match the safe
 * HTML attribute name pattern (defends against a typo or
 * untrusted-input footgun that could break out of the tag). Values
 * are HTML-attribute-escaped.
 */
function formatExtraAttrs(attrs: Record<string, string> | undefined): string {
  if (!attrs) return "";
  let out = "";
  for (const [key, value] of Object.entries(attrs)) {
    if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(key)) continue;
    out += ` ${key}="${escapeAttr(value)}"`;
  }
  return out;
}

function pickFallbackSrc(ref: AssetRef): string {
  // HEIC source: variants.display_jpeg is the browser-safe fallback. NEVER
  // serve raw HEIC bytes from <img>.
  if (ref.variants?.display_jpeg?.cdn_url) {
    return ref.variants.display_jpeg.cdn_url;
  }
  return ref.display_url ?? ref.cdn_url;
}

function resolveDimensions(
  ref: AssetRef,
  props: ImageProps,
  warnings: string[],
): { width: number | undefined; height: number | undefined } {
  const refW = ref.width_px;
  const refH = ref.height_px;

  if (props.width !== undefined && props.height !== undefined) {
    warnings.push(
      `<Image src="${props.src}"> — width AND height both overridden manually; aspect ratio not enforced.`,
    );
    return { width: props.width, height: props.height };
  }
  if (props.width !== undefined && refW && refH) {
    warnings.push(
      `<Image src="${props.src}"> — width override (${props.width}); height recomputed from source aspect ratio.`,
    );
    return {
      width: props.width,
      height: Math.round((props.width * refH) / refW),
    };
  }
  if (props.height !== undefined && refW && refH) {
    warnings.push(
      `<Image src="${props.src}"> — height override (${props.height}); width recomputed from source aspect ratio.`,
    );
    return {
      width: Math.round((props.height * refW) / refH),
      height: props.height,
    };
  }
  return { width: refW, height: refH };
}

function resolveLoading(props: ImageProps): {
  loadingAttr: "lazy" | "eager";
  fetchPriorityAttr: string;
} {
  if (props.priority) {
    return { loadingAttr: "eager", fetchPriorityAttr: ` fetchpriority="high"` };
  }
  if (props.loading === "eager") {
    return { loadingAttr: "eager", fetchPriorityAttr: "" };
  }
  return { loadingAttr: "lazy", fetchPriorityAttr: "" };
}

function resolvePlaceholderStyle(
  ref: AssetRef,
  placeholder: "blurhash" | "color" | "none",
): string {
  if (placeholder === "none") return "";
  if (!ref.blurhash) return "";

  // The blurhash package throws ValidationError on malformed/short strings.
  // We treat malformed blurhash as "skip placeholder, don't fail the build"
  // — the gateway should never emit one, but a partial / corrupt cache
  // entry shouldn't crash a render.
  try {
    if (placeholder === "color") {
      const color = averageColorFromBlurhash(ref.blurhash);
      return ` style="background-color:${color};background-size:cover;"`;
    }
    const dataUri = decodeBlurhashToDataUri(ref.blurhash);
    return ` style="background-image:url(${dataUri});background-size:cover;background-repeat:no-repeat;"`;
  } catch {
    return "";
  }
}

function formatDimAttrs(width: number | undefined, height: number | undefined): string {
  let out = "";
  if (typeof width === "number" && Number.isFinite(width)) out += ` width="${width}"`;
  if (typeof height === "number" && Number.isFinite(height)) out += ` height="${height}"`;
  return out;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Test-only: expose the variant-picking helper for assertions. */
export const __test__ = {
  pickFallbackSrc,
  resolveDimensions,
  resolveLoading,
  resolvePlaceholderStyle,
};
