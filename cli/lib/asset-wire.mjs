/**
 * toWireAssetRef — project an SDK AssetRef (which carries camelCase TS
 * conveniences like `cdnUrl`, `immutableUrl`, `contentSha256`, `size`) onto
 * the CANONICAL gateway wire shape: snake_case keys only, no duplicate
 * values under two casings.
 *
 * Canonical key set (gateway asset envelope):
 *   key, sha256, size_bytes, content_type, visibility, immutable,
 *   url, immutable_url, cdn_url, cdn_immutable_url, sri, etag,
 *   content_digest, + the v1.49/v1.50/v1.54 image fields
 *   (width_px, height_px, blurhash, variant_spec_version, display_url,
 *   display_immutable_url, variants, metadata, image_format, image_info,
 *   image_exif, image_exif_policy, blurhash_data_url, asset_schema).
 *
 * Unknown snake_case keys from newer gateways are preserved as-is; every
 * camelCase key (the documented SDK aliases and any future ones) is dropped,
 * with the aliases mapped back to their canonical snake twin when the snake
 * form is missing from the input.
 *
 * The SDK keeps its camelCase conveniences for typed consumers (e.g.
 * @run402/astro reads `cdnUrl`); this projector is the CLI/MCP output
 * boundary only.
 */

// SDK-only convenience keys that must never appear in wire output. `size`
// and `cdn` are lowercase but still SDK-only: `size` duplicates
// `size_bytes`, `cdn` is the SDK's invalidation envelope (camelCase inner
// keys, locally synthesized).
const SDK_ONLY_KEYS = new Set(["size", "cdn"]);

export function toWireAssetRef(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return ref;
  const out = {};
  for (const [key, value] of Object.entries(ref)) {
    if (typeof value === "function") continue; // tag emitters (scriptTag, …)
    if (SDK_ONLY_KEYS.has(key)) continue;
    if (/[A-Z]/.test(key)) continue; // camelCase SDK aliases/conveniences
    out[key] = value;
  }
  // Canonical fields whose only SDK source is a camelCase convenience.
  if (out.content_type === undefined && typeof ref.contentType === "string") {
    out.content_type = ref.contentType;
  }
  // SDK naming vs wire naming: `cdnUrl` is the IMMUTABLE cdn url,
  // `cdnMutableUrl` the mutable one.
  if (out.cdn_url === undefined && ref.cdnMutableUrl !== undefined) {
    out.cdn_url = ref.cdnMutableUrl;
  }
  if (out.cdn_immutable_url === undefined && ref.cdnUrl !== undefined) {
    out.cdn_immutable_url = ref.cdnUrl;
  }
  if (out.content_digest === undefined && ref.contentDigest !== undefined) {
    out.content_digest = ref.contentDigest;
  }
  if (out.immutable === undefined) {
    out.immutable = ref.immutable_url !== null && ref.immutable_url !== undefined;
  }
  return out;
}
