/**
 * v1.50 client-side validators for asset metadata, EXIF policy, and the
 * `Assets.list` (`assets.ls`) sort + filter surface. Every validator
 * throws {@link LocalError} with the same `code` the gateway would return
 * for the equivalent server-side rejection so consumers can branch on
 * `e.code` regardless of whether validation happened locally or remotely.
 *
 * - `INVALID_ASSET_METADATA` — nested objects, non-allowed leaf types,
 *   undefined leaves, or serialized size > 4 KB.
 * - `INVALID_EXIF_POLICY` — value other than `"keep"` | `"strip"`.
 * - `INVALID_SORT` — sort value not in {@link ASSET_SORT_KEYS}.
 * - `INVALID_FILTER_KEY` — unknown key on the filter bag.
 */

import { LocalError } from "../errors.js";
import {
  ASSET_FILTER_KEYS,
  ASSET_SORT_KEYS,
  type AssetFilter,
  type AssetMetadata,
  type AssetMetadataValue,
  type AssetSortKey,
  type ExifPolicy,
} from "./assets.types.js";

/** Maximum serialized size (bytes) for the caller-provided metadata bag. */
export const ASSET_METADATA_MAX_BYTES = 4096;

/** v1.50: validate caller-supplied metadata bag. Throws {@link LocalError}
 *  with `code === "INVALID_ASSET_METADATA"` for any structural violation. */
export function assertAssetMetadata(
  value: unknown,
  context: string,
): asserts value is AssetMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalError(
      "metadata must be a plain object with string / number / boolean / string[] leaves.",
      context,
      { code: "INVALID_ASSET_METADATA" },
    );
  }
  const obj = value as Record<string, unknown>;
  for (const [k, leaf] of Object.entries(obj)) {
    if (typeof k !== "string" || k.length === 0) {
      throw new LocalError(
        "metadata keys must be non-empty strings.",
        context,
        { code: "INVALID_ASSET_METADATA", details: { key: k } },
      );
    }
    if (!isAssetMetadataValue(leaf)) {
      throw new LocalError(
        `metadata.${k} must be a string, number, boolean, or string[] — got ${describe(leaf)}.`,
        context,
        { code: "INVALID_ASSET_METADATA", details: { key: k } },
      );
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(obj);
  } catch (err) {
    throw new LocalError(
      "metadata must be JSON-serializable.",
      context,
      { code: "INVALID_ASSET_METADATA", details: { cause: String(err) } },
    );
  }
  const bytes = byteLength(serialized);
  if (bytes > ASSET_METADATA_MAX_BYTES) {
    throw new LocalError(
      `metadata exceeds the 4 KB serialized limit (${bytes} bytes).`,
      context,
      {
        code: "INVALID_ASSET_METADATA",
        details: { size_bytes: bytes, limit_bytes: ASSET_METADATA_MAX_BYTES },
      },
    );
  }
}

/** v1.50: validate the EXIF policy enum. */
export function assertExifPolicy(
  value: unknown,
  context: string,
): asserts value is ExifPolicy {
  if (value !== "keep" && value !== "strip") {
    throw new LocalError(
      `exifPolicy must be "keep" or "strip" — got ${describe(value)}.`,
      context,
      { code: "INVALID_EXIF_POLICY", details: { value } },
    );
  }
}

/** v1.50: validate the sort key enum. */
export function assertAssetSortKey(
  value: unknown,
  context: string,
): asserts value is AssetSortKey {
  if (
    typeof value !== "string" ||
    !ASSET_SORT_KEYS.includes(value as AssetSortKey)
  ) {
    throw new LocalError(
      `sort must be one of: ${ASSET_SORT_KEYS.join(", ")} — got ${describe(value)}.`,
      context,
      { code: "INVALID_SORT", details: { value } },
    );
  }
}

/** v1.50: reject unknown filter keys; type-check each known key. */
export function assertAssetFilter(
  value: unknown,
  context: string,
): asserts value is AssetFilter {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalError(
      "filter must be a plain object.",
      context,
      { code: "INVALID_FILTER_KEY" },
    );
  }
  const obj = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (!ASSET_FILTER_KEYS.has(k)) {
      throw new LocalError(
        `filter.${k} is not a known filter key — allowed: ${[...ASSET_FILTER_KEYS].join(", ")}.`,
        context,
        { code: "INVALID_FILTER_KEY", details: { key: k } },
      );
    }
    if (v === undefined) continue;
    switch (k) {
      case "is_image":
        if (typeof v !== "boolean") {
          throw new LocalError(
            `filter.${k} must be a boolean — got ${describe(v)}.`,
            context,
            { code: "INVALID_FILTER_KEY", details: { key: k, value: v } },
          );
        }
        break;
      case "min_width":
      case "max_width":
      case "min_height":
      case "max_height":
        if (!Number.isSafeInteger(v as number) || (v as number) < 0) {
          throw new LocalError(
            `filter.${k} must be a non-negative integer — got ${describe(v)}.`,
            context,
            { code: "INVALID_FILTER_KEY", details: { key: k, value: v } },
          );
        }
        break;
      default:
        if (typeof v !== "string" || (v as string).length === 0) {
          throw new LocalError(
            `filter.${k} must be a non-empty string — got ${describe(v)}.`,
            context,
            { code: "INVALID_FILTER_KEY", details: { key: k, value: v } },
          );
        }
    }
  }
}

/**
 * v1.50: serialize a validated filter bag as query parameters. The wire
 * convention is `filter[<key>]=<value>` per design D-filter (see private
 * gateway docs). Booleans render as `"true"` / `"false"`; numbers
 * render verbatim; string arrays are not allowed on filter values.
 */
export function appendAssetFilterTo(
  qs: URLSearchParams,
  filter: AssetFilter,
): void {
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined) continue;
    if (typeof v === "boolean") qs.set(`filter[${k}]`, v ? "true" : "false");
    else qs.set(`filter[${k}]`, String(v));
  }
}

function isAssetMetadataValue(v: unknown): v is AssetMetadataValue {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return true;
  }
  if (Array.isArray(v)) {
    for (const item of v) if (typeof item !== "string") return false;
    return true;
  }
  return false;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function byteLength(s: string): number {
  // Node's TextEncoder is universally available in our supported runtimes.
  return new TextEncoder().encode(s).byteLength;
}
