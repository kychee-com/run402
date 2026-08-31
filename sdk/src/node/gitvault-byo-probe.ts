/**
 * gitvault-byo-primary-bucket — the allocation-time bucket-policy probe
 * (design D6, task 3.1). Runs BEFORE the allocation request ever reaches
 * the gateway, against the DESTINATION's own root (no `repo_id` exists yet
 * — allocation is what mints one) — so a failed probe means "no vault
 * half-exists", never a partially-created one.
 *
 * Reuses the shipped mirror backend's SigV4 client — no second S3 client.
 */
import { LocalError } from "../errors.js";
import type { GitvaultBucketProbeResult } from "./gitvault-mirror-backend.js";
import { openGitvaultDestinationBackend } from "./gitvault-mirror-backend.js";
import type { GitvaultMirrorCredential, GitvaultMirrorDestination } from "./gitvault-mirror-config.js";
import { formatMirrorDestination } from "./gitvault-mirror-config.js";

function fail(code: string, message: string, context: string, details?: unknown, nextActions?: unknown[]): never {
  throw new LocalError(message, context, { code, details, ...(nextActions ? { next_actions: nextActions } : {}) });
}

/**
 * The failing properties, named — never a bundled "the probe failed". Every
 * entry maps 1:1 to one of {@link GitvaultBucketProbeResult}'s three
 * booleans, so a caller (or a test) can assert on exactly what broke.
 */
export function gitvaultByoProbeFailingProperties(result: GitvaultBucketProbeResult): string[] {
  const failing: string[] = [];
  if (!result.write_permitted) failing.push("write_permitted");
  if (!result.create_only_honored) failing.push("create_only_honored");
  if (!result.versioning_off) failing.push("versioning_off");
  return failing;
}

/**
 * `repos create --byo`'s pre-allocation gate: open a root-scoped backend at
 * `destination` (no `repo_id` — the probe never collides with any vault's
 * own `source/<repo_id>/` prefix, since it writes under `_byo-probe/`
 * instead) and run {@link GitvaultMirrorBackend.probeWritePolicy}. A failed
 * property (or a thrown transport error) refuses with
 * `GITVAULT_BYO_BUCKET_PROBE_FAILED`, naming exactly which propert(y/ies)
 * failed and the underlying fact — the caller MUST NOT proceed to
 * allocation on a failed probe.
 */
export async function probeGitvaultByoDestination(destination: GitvaultMirrorDestination, credential?: GitvaultMirrorCredential): Promise<GitvaultBucketProbeResult> {
  const backend = openGitvaultDestinationBackend(destination, credential);
  let result: GitvaultBucketProbeResult;
  try {
    result = await backend.probeWritePolicy();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    fail(
      "GITVAULT_BYO_BUCKET_PROBE_FAILED",
      `the bucket-policy probe against ${formatMirrorDestination(destination)} failed before any property could be confirmed: ${message}`,
      "probing the BYO destination before allocation",
      { destination: formatMirrorDestination(destination), failing_properties: ["write_permitted", "create_only_honored", "versioning_off"] },
      [{ action: "confirm the destination and credential are correct, and that the bucket policy grants PutObject + GetBucketVersioning to this credential, then retry" }],
    );
  }
  const failing = gitvaultByoProbeFailingProperties(result);
  if (failing.length > 0) {
    fail(
      "GITVAULT_BYO_BUCKET_PROBE_FAILED",
      `${formatMirrorDestination(destination)} does not satisfy the BYO bucket-policy profile (versioning disabled, create-only if-none-match writes honored, write permitted) — failing: ${failing.join(", ")}${result.detail ? ` (${result.detail})` : ""}`,
      "probing the BYO destination before allocation",
      { destination: formatMirrorDestination(destination), failing_properties: failing, probe: result },
      [{ action: "disable bucket versioning, confirm the bucket policy enforces s3:if-none-match create-only writes, and confirm PutObject is permitted for this credential, then retry" }],
    );
  }
  return result;
}
