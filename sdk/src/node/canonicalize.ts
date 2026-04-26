/**
 * RFC 8785 (JCS) canonical JSON for the v1.32 deploy-plan manifest digest.
 *
 * MUST stay byte-for-byte identical to the gateway's
 * `services/deploy-plans.ts:canonicalizeJson`. A digest mismatch breaks
 * idempotency: the SDK's hash won't match the gateway's, so retrying a
 * plan creates a NEW plan instead of finding the existing one.
 *
 * Spec for our value domain:
 *   - object keys sorted ASCII-ascending
 *   - arrays comma-separated, no whitespace
 *   - strings/numbers via JSON.stringify (matches RFC 8785 for ASCII paths,
 *     hex sha256, integer sizes, ASCII content_types)
 */

export interface ManifestEntry {
  path: string;
  sha256: string;
  size: number;
  content_type: string;
}

export interface Manifest {
  files: ManifestEntry[];
}

export function canonicalizeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalizeJson).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((k) => JSON.stringify(k) + ":" + canonicalizeJson(obj[k]));
    return "{" + pairs.join(",") + "}";
  }
  throw new Error("canonicalizeJson: unsupported value type");
}

/**
 * Build the canonical manifest object the gateway hashes: `{ files: [...] }`
 * with entries sorted by path and only the four expected keys per entry.
 * `content_type` defaults to `"application/octet-stream"` when absent.
 */
export function buildCanonicalManifest(
  entries: Array<{ path: string; sha256: string; size: number; content_type?: string }>,
): Manifest {
  const files: ManifestEntry[] = entries
    .map((e) => ({
      path: e.path,
      sha256: e.sha256,
      size: e.size,
      content_type: e.content_type ?? "application/octet-stream",
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files };
}

/**
 * Compute the hex SHA-256 of the canonical JSON encoding of a manifest.
 * Matches the gateway's `computeManifestDigest`.
 */
export async function computeManifestDigest(manifest: Manifest): Promise<string> {
  const canonical = canonicalizeJson(manifest);
  const bytes = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
