/**
 * run402 dev — Run a local Astro dev server with Run402 context injected.
 *
 * Capability `astro-ssr-runtime` (Run402 v1.52). Wraps `astro dev` with
 * Run402-specific environment + SDK proxy so the dev experience matches
 * production:
 *
 *   1. Load .env.local (if present) for project credentials.
 *   2. Confirm RUN402_PROJECT_ID + RUN402_SERVICE_KEY are set.
 *   3. Spawn `astro dev` as a child process inheriting the env.
 *
 * Future enhancements (deferred):
 *   - DB/auth/storage/cache emulation via a local proxy.
 *   - AsyncLocalStorage middleware that populates the same context
 *     shape as the SSR Lambda runtime.
 *   - Visible cache.invalidate() events in the dev log.
 *
 * Until those land, `run402 dev` is a thin wrapper that ensures the
 * env shape is right and the Astro dev server starts with Run402
 * credentials in scope — SDK calls in frontmatter then hit the live
 * project via @run402/functions's default API_BASE.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fail } from "./sdk-errors.mjs";

const HELP = `run402 dev — Run Astro dev with Run402 context

Usage:
  run402 dev [--port <n>] [--host <h>] [--project <id>]

Options:
  --port <n>        Astro dev port (default 4321)
  --host <h>        Astro dev host (default localhost)
  --project <id>    Project id (default: RUN402_PROJECT_ID env var)

The command:
  1. Loads .env.local from the current directory (if present)
  2. Verifies RUN402_PROJECT_ID and RUN402_SERVICE_KEY are set
  3. Spawns 'astro dev' with the env inherited

SDK calls (db, getUser, cache.invalidate, assets.put) hit the LIVE
project at https://api.run402.com — no local DB / S3 / KMS setup needed.
This is the recommended dev model: shape-parity with production.

For offline dev with a local emulator, deferred to v1.5.

Tip: in your project's package.json:
  { "scripts": { "dev": "run402 dev" } }
`;

export async function run(sub, args = []) {
  const all = [sub, ...args].filter(Boolean);
  if (all.includes("--help") || all.includes("-h")) {
    console.log(HELP);
    return;
  }

  // Load .env.local (best effort — silently ignore if missing).
  const envFile = resolve(process.cwd(), ".env.local");
  if (existsSync(envFile)) {
    const content = readFileSync(envFile, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // Strip optional surrounding quotes.
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  }

  const port = pickFlagValue(all, "--port") ?? "4321";
  const host = pickFlagValue(all, "--host") ?? "localhost";
  const projectId = pickFlagValue(all, "--project") ?? process.env.RUN402_PROJECT_ID;

  if (!projectId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing RUN402_PROJECT_ID.",
      hint: "Set it in .env.local (or pass --project <id>). Run 'run402 projects provision' first if you don't have one.",
    });
  }
  if (!process.env.RUN402_SERVICE_KEY) {
    fail({
      code: "BAD_USAGE",
      message: "Missing RUN402_SERVICE_KEY.",
      hint: "Add it to .env.local. Get the service key from 'run402 projects list' or your Run402 dashboard.",
    });
  }

  process.env.RUN402_PROJECT_ID = projectId;

  console.log(`run402 dev — Astro on http://${host}:${port}`);
  console.log(`  project:  ${projectId}`);
  console.log(`  api_base: ${process.env.RUN402_API_BASE ?? "https://api.run402.com"}`);
  console.log(`  env: .env.local ${existsSync(envFile) ? "loaded" : "not present (using process env)"}`);
  console.log("");

  // Spawn `npx astro dev`. We use `npx` so the local astro install resolves
  // even if it's not on PATH. The child inherits stdio so the user sees
  // Astro's normal output.
  const child = spawn("npx", ["astro", "dev", "--port", port, "--host", host], {
    stdio: "inherit",
    env: process.env,
    shell: false,
  });

  // Bubble up exit codes for clean tooling integration.
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });

  // Forward SIGINT / SIGTERM to the child so Ctrl-C cleanly stops Astro.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      child.kill(sig);
    });
  }
}

function pickFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}
