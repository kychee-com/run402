#!/usr/bin/env node
/*
 * Demos registry gate (kychee-com/run402). Fails (exit 1) if any
 * demos/<name>/app.json is structurally invalid or carries a secret-bearing key.
 *
 * Run: node demos/_deploy/check-registry.mjs
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, isProvisioned } from "./registry.mjs";

const DEMOS = dirname(fileURLToPath(import.meta.url)).replace(/\/_deploy$/, "");
const registry = loadRegistry(DEMOS);
const failures = [];
for (const entry of registry) {
  if (!entry.valid) for (const e of entry.errors) failures.push(`demos/${entry.name}/app.json: ${e}`);
}
if (failures.length) {
  console.error("✗ demos registry check failed:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
const provisioned = registry.filter((e) => isProvisioned(e.config));
console.log(
  `✓ demos registry check passed: ${registry.length} demo(s) registered ` +
    `(${provisioned.length} provisioned, ${registry.length - provisioned.length} awaiting provisioning).`,
);
