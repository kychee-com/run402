#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localSchemaPath = resolve(repoRoot, "schemas/run402-app.v1.schema.json");
const coreSchemaPath = resolveCoreSchemaPath();

const localHash = sha256(localSchemaPath);
const coreHash = sha256(coreSchemaPath);

if (localHash !== coreHash) {
  console.error("Run402AppSpec schema drift detected.");
  console.error(`  local: ${localSchemaPath}`);
  console.error(`  core:  ${coreSchemaPath}`);
  console.error(`  local sha256: ${localHash}`);
  console.error(`  core sha256:  ${coreHash}`);
  process.exit(1);
}

console.log(`Run402AppSpec schema drift check passed (${localHash}).`);

function resolveCoreSchemaPath() {
  const cliPath = valueAfter("--core-schema");
  const candidates = [
    cliPath,
    process.env.RUN402_CORE_APP_SCHEMA,
    resolve(repoRoot, "node_modules/@run402/release/schemas/run402-app.v1.schema.json"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = resolve(String(candidate));
    if (existsSync(resolved)) return resolved;
  }

  console.error("Could not find the Core-owned Run402AppSpec schema.");
  console.error("Pass --core-schema <path>, set RUN402_CORE_APP_SCHEMA, or install @run402/release with the schema file.");
  process.exit(1);
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
