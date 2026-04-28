#!/usr/bin/env node
// Tarball smoke test for @run402/functions.
//
// Builds the package, packs it, installs in a scratch dir, and exercises
// getUser() end-to-end with a real signed JWT. This catches the
// jsonwebtoken bundling regression class — if `auth.ts` ever reverts to
// `createRequire("jsonwebtoken")` or jsonwebtoken stops being a runtime
// dep, this script will fail loudly.
//
// Also asserts the legacy `run402-functions` import path is not provided
// by the package (no leakage of the deprecated name).
//
// Usage:
//   node functions/test/smoke-tarball.mjs
//
// Used by:
//   - Local sanity check
//   - The /publish skill's pre-publish smoke section

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = resolve(__dirname, "..");

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf-8", ...opts });
}

function step(label, fn) {
  process.stdout.write(`▶ ${label} ... `);
  try {
    const out = fn();
    process.stdout.write("OK\n");
    return out;
  } catch (err) {
    process.stdout.write("FAIL\n");
    console.error(err.stdout?.toString() ?? "");
    console.error(err.stderr?.toString() ?? "");
    console.error(err.message);
    process.exit(1);
  }
}

const SCRATCH = mkdtempSync(join(tmpdir(), "run402-functions-smoke-"));
console.log(`Scratch dir: ${SCRATCH}`);

try {
  step("npm run build (functions package)", () => {
    run("npm run build", { cwd: FUNCTIONS_DIR });
  });

  let tarball;
  step("npm pack", () => {
    const out = run(`npm pack --pack-destination "${SCRATCH}"`, { cwd: FUNCTIONS_DIR });
    const tgz = readdirSync(SCRATCH).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error("npm pack produced no tarball");
    tarball = join(SCRATCH, tgz);
    process.stdout.write(`(${tgz}) `);
    return out;
  });

  const installDir = join(SCRATCH, "install");
  mkdirSync(installDir);
  step("npm init + install tarball", () => {
    run("npm init -y", { cwd: installDir });
    // --before=9999-12-31 bypasses any global supply-chain pin so the smoke
    // test isn't blocked by stale `before` config in this environment
    run(`npm install --before=9999-12-31 "${tarball}" jsonwebtoken@^9`, { cwd: installDir });
  });

  step("import resolves: @run402/functions exposes db, adminDb, QueryBuilder, getUser, email, ai", () => {
    const result = run(
      `node --input-type=module -e "import * as m from '@run402/functions'; const need = ['db','adminDb','QueryBuilder','getUser','email','ai']; const missing = need.filter(n => !(n in m)); if (missing.length) { console.error('missing:', missing); process.exit(1); } console.log('exports OK');"`,
      { cwd: installDir },
    );
    if (!result.includes("exports OK")) throw new Error("export check produced unexpected output: " + result);
  });

  step("legacy 'run402-functions' import path is NOT provided", () => {
    try {
      run(
        `node --input-type=module -e "import('run402-functions').then(() => { console.error('UNEXPECTED: legacy name resolved'); process.exit(1); }).catch(() => process.exit(0));"`,
        { cwd: installDir },
      );
    } catch (err) {
      // Exit-code 1 is failure (legacy resolved). Exit-code 0 is success (legacy missing).
      if (err.status === 1) throw new Error("Legacy 'run402-functions' import path is unexpectedly resolvable");
      // Other exit codes are unexpected too.
      if (err.status !== 0 && err.status !== undefined) throw err;
    }
  });

  step("getUser() round-trips a signed JWT (jsonwebtoken bundling check)", () => {
    const result = run(
      `RUN402_PROJECT_ID=prj_smoke RUN402_JWT_SECRET=smoke-secret-32chars-min!!1234567 node --input-type=module -e "
        import jwt from 'jsonwebtoken';
        import { getUser } from '@run402/functions';
        const token = jwt.sign({ sub: 'user_smoke', role: 'authenticated', email: 's@x.com', project_id: 'prj_smoke' }, 'smoke-secret-32chars-min!!1234567');
        const req = new Request('https://x', { headers: { authorization: 'Bearer ' + token } });
        const u = getUser(req);
        if (!u || u.id !== 'user_smoke') { console.error('getUser returned', u); process.exit(1); }
        console.log('getUser OK:', u.id);
      "`,
      { cwd: installDir },
    );
    if (!result.includes("getUser OK")) throw new Error("getUser smoke produced unexpected output: " + result);
  });

  console.log("\n✓ All smoke checks passed");
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
