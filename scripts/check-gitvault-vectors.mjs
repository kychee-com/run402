#!/usr/bin/env node
/**
 * Assert the vendored `r402s/v0` conformance vectors are present, intact, and
 * about to be replayed — BEFORE the test job runs (add-gitvault task 5.6b).
 *
 * Why a standalone check when the suites already assert this on load: a test
 * file that throws at module scope fails, but a test file that never runs
 * (renamed, dropped from a glob, moved behind an opt-out) fails NOTHING. This
 * script is the tripwire for that second case — it counts what is on disk and
 * refuses a set that is empty, drifted, or short of what CONTINUITY.json says
 * should be there.
 *
 * Run:  node scripts/check-gitvault-vectors.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.env.GITVAULT_VECTORS_DIR || join(root, "test-vectors", "r402s-v0");

function die(message) {
  console.error(`gitvault vectors: ${message}`);
  process.exit(1);
}

if (process.env.GITVAULT_VECTORS_OPTOUT) {
  die("GITVAULT_VECTORS_OPTOUT is set — the vector suites would skip. This is only legal on a developer machine, never in CI.");
}

const vectorsPath = join(dir, "vectors.json");
const goldenPath = join(dir, "hpke-interop", "golden.json");
const continuityPath = join(dir, "CONTINUITY.json");

for (const [label, path] of [["vectors.json", vectorsPath], ["hpke-interop/golden.json", goldenPath], ["CONTINUITY.json", continuityPath]]) {
  if (!existsSync(path)) die(`${label} is missing from ${dir}. The vendored set is incomplete — restore it from the private repo's docs/strategy/products/gitvault/vectors/.`);
}

const continuity = JSON.parse(readFileSync(continuityPath, "utf8"));
const current = continuity.current;
if (!current?.vectors_json_sha256 || !current?.golden_json_sha256) {
  die("CONTINUITY.json has no `current` block with vectors_json_sha256 + golden_json_sha256 — the copy cannot be verified.");
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
for (const [label, path, expected] of [
  ["vectors.json", vectorsPath, current.vectors_json_sha256],
  ["hpke-interop/golden.json", goldenPath, current.golden_json_sha256],
]) {
  const actual = sha256(path);
  if (actual !== expected) die(`${label} does not match CONTINUITY.json\n  expected ${expected}\n  actual   ${actual}\nRegenerate in the private repo and re-vendor; never hand-edit these files.`);
}

const file = JSON.parse(readFileSync(vectorsPath, "utf8"));
const count = Array.isArray(file.vectors) ? file.vectors.length : 0;
const declared = Number(current.vectors_json_vector_count ?? 0);
if (count === 0) die("vectors.json declares zero vectors.");
if (declared && count !== declared) die(`vectors.json holds ${count} vectors but CONTINUITY.json declares ${declared}.`);
if (file["x-r402s-revision"] !== current.protocol_revision) {
  die(`vectors.json is rev ${file["x-r402s-revision"]} but CONTINUITY.json's current block is rev ${current.protocol_revision}.`);
}

const classes = new Map();
for (const v of file.vectors) classes.set(v.class, (classes.get(v.class) ?? 0) + 1);
console.log(`gitvault vectors: ${count} vectors across ${classes.size} classes at protocol rev ${current.protocol_revision} — ${dir}`);
console.log("gitvault vectors: CONTINUITY.json digests match; the suites will replay, not skip.");
