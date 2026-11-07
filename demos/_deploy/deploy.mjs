#!/usr/bin/env node
/*
 * CI deploy dispatcher for one internal app (internal-apps-cicd → internal-apps-deploy).
 *
 *   tsx apps/_deploy/deploy.mjs <app-name>
 *
 * Runs in the matrix workflow's per-app leg AFTER the GitHub OIDC token has been
 * exchanged for a Run402 CI session (provided as RUN402_CI_SESSION). It is
 * PROVISIONING-FREE: reads apps/<name>/app.json, asserts the app is provisioned,
 * delegates spec-building to the app's own `deploy({ baseUrl, auth, config })`
 * (which ships only deploy-time slices), then smoke-tests the live URL.
 *
 * Run via tsx (so it can import the app's deploy.ts).
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { smokeTest, applyRelease, readStaticDir } from "./apply.mjs";
import { loadRegistry } from "./registry.mjs";

const APPS = join(dirname(fileURLToPath(import.meta.url)), "..");

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const name = process.argv[2];
if (!name) die("usage: tsx apps/_deploy/deploy.mjs <app-name>");

// Resolve the app via the registry (handles nested apps/demos/<name>/).
const entry = loadRegistry(APPS).find((e) => e.name === name);
if (!entry) die(`no registered app '${name}' (no apps/**/app.json with name=${name})`);
if (!entry.valid) die(`apps/${name} app.json is invalid: ${entry.errors.join("; ")}`);
const appDir = entry.dir;
const config = entry.config;

if (!config.project_id || String(config.project_id).startsWith("<")) {
  die(`${name} is not provisioned (no project_id). Run its provision flow first.`);
}

const baseUrl = process.env.BASE_URL || "https://api.run402.com";
const token = process.env.RUN402_CI_SESSION;
if (!token) die("Missing RUN402_CI_SESSION (the exchanged Run402 CI-session bearer).");
const auth = { mode: "ci", token };

// App build gate (e.g. the console API-first check), from app.json.
if (config.gate) {
  console.log(`Running gate: ${config.gate}`);
  execSync(config.gate, { stdio: "inherit" });
}

const deployModPath = join(appDir, "deploy.ts");
let result;
if (existsSync(deployModPath)) {
  // Custom deploy module (apps with functions / db / bespoke specs).
  const mod = await import(pathToFileURL(deployModPath).href);
  if (typeof mod.deploy !== "function") die(`apps/${name}/deploy.ts must export an async deploy({ baseUrl, auth, config })`);
  console.log(`Deploying ${name} → project ${config.project_id} (ci-session, custom deploy.ts)…`);
  result = await mod.deploy({ baseUrl, auth, config });
} else {
  // Generic static deploy: ship the app dir's static files (no deploy.ts needed).
  const files = readStaticDir(appDir);
  if (files.length === 0) die(`apps/${name} has no deploy.ts and no static files to deploy`);
  console.log(`Deploying ${name} → project ${config.project_id} (ci-session, static: ${files.map((f) => f.file).join(", ")})…`);
  result = await applyRelease({ baseUrl, auth, body: { project_id: config.project_id, files } });
}
console.log(`  apply ${result.status} (release ${result.release_id})`);

const url = `https://${config.subdomain}.run402.com`;
const smoke = await smokeTest({ url, marker: config.smoke_marker });
if (!smoke.ok) die(`  smoke FAILED for ${url}: ${smoke.reason} (status ${smoke.status})`);
console.log(`  smoke ok — ${url} serving (200).`);
