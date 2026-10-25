/**
 * run402 dev — Run a local Astro dev server with Run402 context injected.
 *
 * Capability `astro-ssr-runtime` (Run402 v1.52). Wraps `astro dev` with
 * Run402-specific environment + SDK proxy so the dev experience matches
 * production:
 *
 *   1. Load .env.local (if present) for project credentials.
 *   2. Confirm RUN402_PROJECT_ID + RUN402_SERVICE_KEY are set.
 *   3. With `--as <label>`, mint a test session for that label (the
 *      SDK's `auth.createTestSession`) and hand it to the child in
 *      RUN402_DEV_TEST_SESSION; the @run402/astro adapter then runs
 *      every request signed in as that test user, under `astro dev` only.
 *   4. Spawn `astro dev` as a child process inheriting the env.
 *
 * Beyond that, `run402 dev` is a thin wrapper that ensures the env shape
 * is right and the Astro dev server starts with Run402 credentials in
 * scope — SDK calls in frontmatter then hit the live project via
 * @run402/functions's default API_BASE.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fail, reportLocalOrSdkError } from "./sdk-errors.mjs";
import { apiBase } from "./config.mjs";
import { getSdk } from "./sdk.mjs";

/** The variable the @run402/astro adapter reads under `astro dev`. */
export const DEV_TEST_SESSION_ENV = "RUN402_DEV_TEST_SESSION";

const HELP = `run402 dev — Run Astro dev with Run402 context

Usage:
  run402 dev [--port <n>] [--host <h>] [--project <project_id>] [--as <label>]

Options:
  --port <n>        Astro dev port (default 4321)
  --host <h>        Astro dev host (default localhost)
  --project <project_id>    Project id (default: RUN402_PROJECT_ID env var)
  --as <label>      Preview signed in as the test user <label>@<project_id>.test.invalid
                    (a watermarked test user, never a real member; needs RUN402_ANON_KEY
                    and the project's test mode, on by default for prototype)

The command:
  1. Loads .env.local from the current directory (if present)
  2. Verifies RUN402_PROJECT_ID and RUN402_SERVICE_KEY are set
  3. With --as, mints a 2-hour test session and passes it to the dev server
     (server-side only: the browser never holds the token or the service key)
  4. Spawns 'astro dev' with the env inherited

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
      hint: "Set it in .env.local (or pass --project <project_id>). Run 'run402 projects provision' first if you don't have one.",
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

  // Only `--as` may hand the dev server a session; never one inherited from the shell.
  delete process.env[DEV_TEST_SESSION_ENV];
  const asIndex = all.indexOf("--as");
  let signedInAs = null;
  if (asIndex !== -1) {
    const label = all[asIndex + 1];
    if (!label || label.startsWith("--")) {
      fail({
        code: "BAD_USAGE",
        message: "--as needs a test-user label, e.g. `run402 dev --as alice`.",
      });
    }
    if (!process.env.RUN402_ANON_KEY) {
      fail({
        code: "BAD_USAGE",
        message: "Missing RUN402_ANON_KEY.",
        hint: "run402 dev --as signs db() calls in as the test user, which needs the anon key. Add it to .env.local; get it from 'run402 projects list'.",
      });
    }
    try {
      signedInAs = await mintDevTestSession({
        projectId,
        label,
        keys: { anon_key: process.env.RUN402_ANON_KEY, service_key: process.env.RUN402_SERVICE_KEY },
      });
    } catch (err) {
      reportLocalOrSdkError(err);
    }
    process.env[DEV_TEST_SESSION_ENV] = JSON.stringify(signedInAs);
  }

  console.log(`run402 dev — Astro on http://${host}:${port}`);
  console.log(`  project:  ${projectId}`);
  console.log(`  api_base: ${apiBase()}`);
  console.log(`  env: .env.local ${existsSync(envFile) ? "loaded" : "not present (using process env)"}`);
  if (signedInAs) {
    console.log(`  signed in as: ${signedInAs.user.email} (test user, until ${signedInAs.expires_at})`);
  }
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

/**
 * Mint a test session with the keys the dev server itself runs on, and keep
 * only what the @run402/astro dev-session middleware needs. The mint carries
 * the service key and no wallet or sign-in credential.
 */
export async function mintDevTestSession({ projectId, label, keys, sdk }) {
  const client = sdk ?? getSdk({
    credentials: {
      getAuth: async () => null,
      getProjectCredentials: async (id) => (id === projectId ? keys : null),
      getProject: async (id) => (id === projectId ? keys : null),
    },
  });
  const bundle = await client.auth.createTestSession(projectId, { label });
  const accessExpiresAt = Date.now() + bundle.expires_in * 1000;
  const sessionExpiresAt = Date.parse(bundle.session.hard_expires_at);
  return {
    project_id: projectId,
    user: {
      id: bundle.user.id,
      label: bundle.user.label,
      email: bundle.user.email,
      email_verified: bundle.user.email_verified_at !== null,
    },
    session: {
      session_id: bundle.session.session_id,
      amr: bundle.session.amr,
      auth_time: bundle.session.auth_time,
    },
    access_token: bundle.access_token,
    expires_at: new Date(Math.min(accessExpiresAt, Number.isNaN(sessionExpiresAt) ? accessExpiresAt : sessionExpiresAt)).toISOString(),
  };
}

function pickFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}
