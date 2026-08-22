/**
 * gitvault conformance-vector loading (add-gitvault task 5.6b).
 *
 * WHY THIS FILE EXISTS. Every gitvault suite used to resolve the vector set
 * through `process.env.GITVAULT_VECTORS_DIR ?? "<a hard-coded absolute path on
 * one developer's laptop>"`, and `describe.skip` when it was absent. On a CI
 * runner the path never exists, so a green run hid roughly 130 vectors —
 * exactly the shape of failure the vectors exist to prevent. The rule now:
 *
 *   - an UNRESOLVABLE vector directory is a FAILURE, never a skip;
 *   - the only way to skip is the explicit `GITVAULT_VECTORS_OPTOUT=1`;
 *   - whatever directory is resolved, its bytes are asserted against
 *     `CONTINUITY.json`'s `current` block before a single case runs.
 *
 * That last rule is what makes the vendored copy trustworthy: `CONTINUITY.json`
 * is the D188 golden-byte continuity manifest, and its `current` block records
 * the exact SHA-256 of `vectors.json` and `hpke-interop/golden.json` at the
 * pinned protocol revision. A location override (`GITVAULT_VECTORS_DIR`) is
 * never an integrity override.
 *
 * NOT SHIPPED: excluded from `sdk/tsconfig.json`, so it never reaches `dist`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The vendored set: `<repo>/test-vectors/r402s-v0` (from `sdk/src/node/`). */
export const VENDORED_VECTORS_DIR = resolve(__dirname, "..", "..", "..", "test-vectors", "r402s-v0");

/** Set to `1` to deliberately skip every vector suite. Nothing else skips them. */
export const OPTOUT_ENV = "GITVAULT_VECTORS_OPTOUT";
/** Point the suites at a different copy. The integrity assertions still run. */
export const DIR_ENV = "GITVAULT_VECTORS_DIR";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GitvaultVector = { id: string; class: string; description: string; inputs: any; expected: any; reject_reason?: string; reject_code?: string; schema?: string };

export interface GitvaultVectorFile {
  vectors: GitvaultVector[];
  counts_by_class: Record<string, string>;
  test_keys?: Record<string, string>;
  "x-r402s-revision": string;
}

export interface GitvaultVectorSet {
  dir: string;
  file: GitvaultVectorFile;
  /** `hpke-interop/golden.json`, parsed. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  golden: any;
  revision: string;
  byClass(cls: string): GitvaultVector[];
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function resolveDir(): string {
  const override = process.env[DIR_ENV];
  if (override) {
    if (!existsSync(join(override, "vectors.json"))) {
      throw new Error(
        `${DIR_ENV}=${override} does not contain vectors.json.\n` +
          `Point it at a directory holding vectors.json + CONTINUITY.json + hpke-interop/golden.json, ` +
          `or unset it to use the vendored copy at ${VENDORED_VECTORS_DIR}.`,
      );
    }
    return override;
  }
  if (existsSync(join(VENDORED_VECTORS_DIR, "vectors.json"))) return VENDORED_VECTORS_DIR;
  throw new Error(
    `gitvault conformance vectors are missing.\n` +
      `Expected the vendored set at ${VENDORED_VECTORS_DIR}, or ${DIR_ENV} pointing at a copy.\n` +
      `This is a FAILURE, not a skip: a silent skip here hid ~130 vectors behind a green CI run (task 5.6b).\n` +
      `To skip deliberately, set ${OPTOUT_ENV}=1.`,
  );
}

/**
 * Assert the resolved copy IS the frozen set `CONTINUITY.json` vouches for.
 * Throws with the expected/actual digests — a drifted copy must never replay.
 */
export function assertVectorContinuity(dir: string): { revision: string } {
  const continuityPath = join(dir, "CONTINUITY.json");
  if (!existsSync(continuityPath)) {
    throw new Error(`${dir} has no CONTINUITY.json — the vector set cannot be integrity-checked, so it is not usable.`);
  }
  const continuity = JSON.parse(readFileSync(continuityPath, "utf8")) as {
    current?: { protocol_revision?: string; vectors_json_sha256?: string; golden_json_sha256?: string };
  };
  const current = continuity.current;
  if (!current?.vectors_json_sha256 || !current.golden_json_sha256) {
    throw new Error(`${continuityPath} has no \`current\` block with vectors_json_sha256 + golden_json_sha256; cannot verify the vendored copy.`);
  }
  const checks: Array<[string, string, string]> = [
    ["vectors.json", join(dir, "vectors.json"), current.vectors_json_sha256],
    ["hpke-interop/golden.json", join(dir, "hpke-interop", "golden.json"), current.golden_json_sha256],
  ];
  for (const [label, path, expected] of checks) {
    if (!existsSync(path)) throw new Error(`${label} is missing from ${dir}; the vector set is incomplete.`);
    const actual = sha256File(path);
    if (actual !== expected) {
      throw new Error(
        `${label} in ${dir} does not match CONTINUITY.json.\n  expected ${expected}\n  actual   ${actual}\n` +
          `The copy has drifted from the frozen set — regenerate in the private repo and re-vendor; never edit these files by hand.`,
      );
    }
  }
  return { revision: current.protocol_revision ?? "unknown" };
}

/**
 * Load the vector set, or `null` when `GITVAULT_VECTORS_OPTOUT=1`.
 *
 * Any other failure — missing directory, missing file, digest mismatch —
 * THROWS. Suites call this at module scope so the throw fails the file.
 */
export function loadGitvaultVectors(): GitvaultVectorSet | null {
  if (process.env[OPTOUT_ENV] === "1") return null;
  const dir = resolveDir();
  const { revision } = assertVectorContinuity(dir);
  const file = JSON.parse(readFileSync(join(dir, "vectors.json"), "utf8")) as GitvaultVectorFile;
  const golden = JSON.parse(readFileSync(join(dir, "hpke-interop", "golden.json"), "utf8")) as unknown;
  if (file["x-r402s-revision"] !== revision) {
    throw new Error(`vectors.json declares rev ${file["x-r402s-revision"]} but CONTINUITY.json's current block declares rev ${revision}.`);
  }
  return {
    dir,
    file,
    golden,
    revision,
    byClass: (cls: string) => file.vectors.filter((v) => v.class === cls),
  };
}

/**
 * The message printed by the single `it.skip` a suite emits under the opt-out,
 * so a skipped run still says WHY in the test output.
 */
export const OPTOUT_SKIP_MESSAGE = `skipped deliberately: ${OPTOUT_ENV}=1`;
