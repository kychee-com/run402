/*
 * Change-detection for the demos deploy matrix (kychee-com/run402).
 *
 * Pure mapping: changed file paths (from `git diff --name-only`) + the loaded
 * registry → the set of demo names to deploy this push.
 *
 *   - A change under `demos/<name>/**` for a registered, PROVISIONED demo with
 *     `cd !== false` ⇒ deploy `<name>`.
 *   - A change to shared tooling (`demos/_deploy/**` or the workflow) ⇒ deploy
 *     ALL eligible demos.
 *   - Anything outside `demos/` is ignored.
 */

import { fileURLToPath } from "node:url";

/** Demos under demos/ deployed by a different pipeline (none today). */
export const NON_MATRIX_APPS = new Set();

/** Path prefixes that force a deploy-all (shared tooling). */
const SHARED_TOOLING_PREFIXES = ["demos/_deploy/", ".github/workflows/deploy-demos.yml"];

function normalize(p) {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}

function provisioned(config) {
  const p = config?.project_id;
  return typeof p === "string" && p.length > 0 && !p.startsWith("<");
}

/** Registry entries eligible for matrix deploy (valid, provisioned, cd !== false). */
export function deployableEntries(registry) {
  return registry.filter(
    (e) => e.valid && provisioned(e.config) && !NON_MATRIX_APPS.has(e.name) && e.config?.cd !== false,
  );
}

export function deployableAppNames(registry) {
  return deployableEntries(registry).map((e) => e.name);
}

/**
 * @param {string[]} changedPaths
 * @param {Array<{name,relDir,config,valid}>} registry
 * @returns {{ apps: string[], reason: "shared-tooling" | "per-app" | "none" }}
 */
export function detectChangedApps(changedPaths, registry) {
  const eligible = deployableEntries(registry);
  const paths = changedPaths.map(normalize).filter(Boolean);

  const sharedTouched = paths.some((p) => SHARED_TOOLING_PREFIXES.some((pre) => p === pre || p.startsWith(pre)));
  if (sharedTouched) {
    return { apps: eligible.map((e) => e.name).sort(), reason: "shared-tooling" };
  }

  const selected = new Set();
  for (const p of paths) {
    for (const e of eligible) {
      const rel = e.relDir || `demos/${e.name}`;
      const prefix = rel.endsWith("/") ? rel : `${rel}/`;
      if (p.startsWith(prefix)) {
        selected.add(e.name);
        break;
      }
    }
  }
  return { apps: [...selected].sort(), reason: selected.size > 0 ? "per-app" : "none" };
}

// ---------------------------------------------------------------------------
// CLI:  git diff --name-only <before> <after> | node demos/_deploy/detect.mjs
// Emits `matrix=<json>` to $GITHUB_OUTPUT (a JSON array of demo names).
// ---------------------------------------------------------------------------
async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { loadRegistry } = await import("./registry.mjs");
  const { dirname, join } = await import("node:path");
  const { appendFileSync } = await import("node:fs");
  const demosDir = dirname(fileURLToPath(import.meta.url)).replace(/\/_deploy$/, "");
  const changed = (await readStdin()).split("\n").map((s) => s.trim()).filter(Boolean);
  const { apps, reason } = detectChangedApps(changed, loadRegistry(demosDir));
  process.stderr.write(`demos detect: ${apps.length} demo(s) [${reason}]: ${apps.join(", ") || "(none)"}\n`);
  const line = `matrix=${JSON.stringify(apps)}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
}
