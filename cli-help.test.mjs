/**
 * cli-help.test.mjs — Regression test for --help across every CLI command.
 *
 * Contract enforced:
 *   1. Every top-level command and every subcommand must accept `--help`
 *      (and `-h`) and print a usage block that includes "Usage:".
 *   2. When `--help` (or `-h`) appears anywhere in the argv, the command
 *      must NOT perform any action — i.e. no HTTP calls, no files written
 *      to the config directory, no non-zero exit.
 *
 * Strategy: spawn the real CLI as a subprocess with
 *   RUN402_CONFIG_DIR pointed at a fresh temp dir, and
 *   RUN402_API_BASE pointed at a local mock server that records and 500s
 *   every request. After each run we assert:
 *     - exit code 0
 *     - stdout contains "Usage:"
 *     - mock server recorded zero requests
 *     - the config dir's file set is unchanged
 *
 * Matrix is declared explicitly below, mirroring cli.mjs + lib/*.mjs. When a
 * new command or subcommand lands in the CLI, add it here. The test will then
 * fail loudly if the new command doesn't honor --help, protecting the
 * contract by construction.
 *
 * Run:  node --test cli-help.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "cli", "cli.mjs");

// ─── Command / subcommand matrix ────────────────────────────────────────────
// Mirrors cli.mjs dispatch + each lib/<cmd>.mjs switch. Update when adding a
// command or subcommand so the contract coverage keeps up with the surface.
//
// Each entry is { shared: [...], specific: [...] }:
//  - shared:   subs that fall back to the module-level help (module HELP is fine)
//  - specific: subs that must print per-subcommand help (stdout must start with
//              `run402 <cmd> <sub>`, not `run402 <cmd> —`)
const MATRIX = {
  init: { shared: ["mpp"], specific: [] },
  status: { shared: [], specific: [] },
  allowance: {
    shared: ["status", "create", "fund", "balance", "export"],
    specific: ["checkout", "history"],
  },
  tier: { shared: [], specific: ["status", "set"] },
  projects: {
    shared: [
      "quote", "use", "list", "info", "keys", "rest",
      "usage", "schema", "rls", "delete", "pin", "promote-user", "demote-user",
    ],
    specific: ["provision", "sql", "costs", "validate-expose"],
  },
  deploy: { shared: [], specific: ["apply", "resume", "list", "events", "release"] },
  ci: { shared: [], specific: ["link", "list", "revoke"] },
  functions: {
    shared: [],
    specific: ["deploy", "invoke", "logs", "update", "list", "delete"],
  },
  secrets: { shared: [], specific: ["set", "list", "delete"] },
  blob: {
    shared: [],
    specific: ["put", "get", "ls", "rm", "sign"],
  },
  sites: { shared: ["status"], specific: ["deploy", "deploy-dir"] },
  subdomains: { shared: [], specific: ["claim", "list", "delete"] },
  domains: { shared: [], specific: ["add", "list", "status", "delete"] },
  apps: {
    shared: [],
    specific: ["browse", "fork", "publish", "update", "versions", "inspect", "delete"],
  },
  ai: { shared: [], specific: ["translate", "moderate", "usage"] },
  image: { shared: [], specific: ["generate"] },
  email: {
    shared: [],
    specific: ["info", "status", "send", "list", "get-raw", "reply", "delete", "create", "get"],
  },
  message: { shared: [], specific: ["send"] },
  auth: {
    shared: [],
    specific: [
      "magic-link", "verify", "create-user", "invite-user", "set-password", "settings",
      "passkey-register-options", "passkey-register-verify", "passkey-login-options",
      "passkey-login-verify", "passkeys", "delete-passkey", "providers",
    ],
  },
  "sender-domain": {
    shared: [],
    specific: ["register", "status", "remove", "inbound-enable", "inbound-disable"],
  },
  billing: {
    shared: [],
    specific: ["tier-checkout", "buy-email-pack", "auto-recharge", "history", "create-email", "link-wallet", "balance"],
  },
  contracts: {
    shared: [],
    specific: [
      "provision-wallet", "set-recovery", "set-alert", "call", "read", "drain", "delete",
      "get-wallet", "list-wallets", "status",
    ],
  },
  agent: { shared: [], specific: ["contact"] },
  service: { shared: [], specific: ["status", "health"] },
};

// `run402 email webhooks <action>` delegates to lib/webhooks.mjs.
const EMAIL_WEBHOOKS = {
  shared: ["list", "get", "delete"],
  specific: ["update", "register"],
};

const DEPLOY_RELEASE = {
  shared: [],
  specific: ["get", "active", "diff"],
};

// ─── Mock API server ────────────────────────────────────────────────────────
// Records every request. Returns 500 so any accidental call is loud.
const requestLog = [];
let server;
let apiBase;

before(async () => {
  server = createServer((req, res) => {
    requestLog.push({ method: req.method, url: req.url });
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end('{"error":"mock: no request should reach here during --help"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  apiBase = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// ─── Subprocess runner ──────────────────────────────────────────────────────

function snapshotDir(dir) {
  const out = [];
  function walk(d, rel) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      const st = statSync(full);
      if (st.isDirectory()) walk(full, relPath);
      else out.push(`${relPath}:${st.size}`);
    }
  }
  try { walk(dir, ""); } catch { /* dir may not exist */ }
  return out.sort().join("|");
}

async function runCli(argv) {
  const configDir = mkdtempSync(join(tmpdir(), "run402-help-"));
  const before = snapshotDir(configDir);
  const requestsBefore = requestLog.length;

  const child = spawn(process.execPath, [CLI_PATH, ...argv], {
    env: {
      ...process.env,
      RUN402_CONFIG_DIR: configDir,
      RUN402_API_BASE: apiBase,
      // Ensure the CLI doesn't read developer credentials from the real home.
      HOME: configDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  // Safety kill — help should print and exit in well under a second.
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);

  const [code, signal] = await once(child, "exit");
  clearTimeout(killTimer);

  const after = snapshotDir(configDir);
  const requestsMade = requestLog.slice(requestsBefore);
  rmSync(configDir, { recursive: true, force: true });

  return {
    argv,
    code,
    signal,
    stdout,
    stderr,
    sideEffectFiles: before !== after,
    requestsMade,
  };
}

function assertHelp(result, label, opts = {}) {
  assert.equal(result.signal, null,
    `${label}: killed by signal ${result.signal} (exceeded timeout?)\nstderr:\n${result.stderr}`);
  assert.equal(result.code, 0,
    `${label}: expected exit 0, got ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /Usage:/,
    `${label}: stdout missing "Usage:" marker\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(result.requestsMade.length, 0,
    `${label}: made ${result.requestsMade.length} HTTP request(s) during --help: ${JSON.stringify(result.requestsMade)}`);
  assert.equal(result.sideEffectFiles, false,
    `${label}: wrote files to the config dir during --help (side effect)`);
  if (opts.expectHeadingStartsWith) {
    const firstLine = result.stdout.trimStart().split(/\r?\n/, 1)[0];
    assert.ok(firstLine.startsWith(opts.expectHeadingStartsWith),
      `${label}: expected first line to start with "${opts.expectHeadingStartsWith}" (per-subcommand help), got: "${firstLine}"\nstdout:\n${result.stdout}`);
  }
}

// ─── Test cases ─────────────────────────────────────────────────────────────

describe("CLI --help contract", () => {
  it("run402 --help prints usage without side effects", async () => {
    assertHelp(await runCli(["--help"]), "run402 --help");
  });

  it("run402 -h prints usage without side effects", async () => {
    assertHelp(await runCli(["-h"]), "run402 -h");
  });

  it("deploy apply help includes the route manifest shape", async () => {
    const result = await runCli(["deploy", "apply", "--help"]);
    assertHelp(result, "run402 deploy apply --help", {
      expectHeadingStartsWith: "run402 deploy apply",
    });
    assert.match(result.stdout, /"routes"\s*:\s*\{\s*"replace"/);
    assert.match(result.stdout, /\/api\/\*/);
    assert.match(result.stdout, /\/admin\b/);
    assert.match(result.stdout, /\/admin\/\*/);
    assert.match(result.stdout, /Fetch Request -> Response/);
    assert.match(result.stdout, /req\.url is the full public URL/);
    assert.match(result.stdout, /verified custom domains/);
    assert.match(result.stdout, /\/functions\/v1\/:name remains API-key protected/);
    assert.match(result.stdout, /ROUTED_RESPONSE_TOO_LARGE/);
    assert.doesNotMatch(result.stdout, /"routes"\s*:\s*\{\s*"\/api\/\*"/);
    assert.doesNotMatch(result.stdout, /routedHttp\.json\(\{ ok: true, path: event\.path \}\)/);
  });

  for (const [cmd, { shared, specific }] of Object.entries(MATRIX)) {
    describe(`run402 ${cmd}`, () => {
      it(`${cmd} --help prints usage without side effects`, async () => {
        assertHelp(await runCli([cmd, "--help"]), `run402 ${cmd} --help`);
      });

      if (shared.length + specific.length > 0) {
        it(`${cmd} -h (short flag) prints usage without side effects`, async () => {
          assertHelp(await runCli([cmd, "-h"]), `run402 ${cmd} -h`);
        });
      }

      for (const sub of shared) {
        it(`${cmd} ${sub} --help prints usage (module-level help)`, async () => {
          assertHelp(await runCli([cmd, sub, "--help"]),
            `run402 ${cmd} ${sub} --help`);
        });
      }

      for (const sub of specific) {
        it(`${cmd} ${sub} --help prints PER-SUBCOMMAND help`, async () => {
          assertHelp(await runCli([cmd, sub, "--help"]),
            `run402 ${cmd} ${sub} --help`,
            { expectHeadingStartsWith: `run402 ${cmd} ${sub}` });
        });
      }
    });
  }

  describe("run402 email webhooks (nested)", () => {
    it("email webhooks --help prints usage without side effects", async () => {
      assertHelp(await runCli(["email", "webhooks", "--help"]),
        "run402 email webhooks --help");
    });
    for (const action of EMAIL_WEBHOOKS.shared) {
      it(`email webhooks ${action} --help prints usage (module-level help)`, async () => {
        assertHelp(await runCli(["email", "webhooks", action, "--help"]),
          `run402 email webhooks ${action} --help`);
      });
    }
    for (const action of EMAIL_WEBHOOKS.specific) {
      it(`email webhooks ${action} --help prints PER-SUBCOMMAND help`, async () => {
        assertHelp(await runCli(["email", "webhooks", action, "--help"]),
          `run402 email webhooks ${action} --help`,
          { expectHeadingStartsWith: `run402 email webhooks ${action}` });
      });
    }
  });

  describe("run402 deploy release (nested)", () => {
    it("deploy release --help prints usage without side effects", async () => {
      assertHelp(await runCli(["deploy", "release", "--help"]),
        "run402 deploy release --help",
        { expectHeadingStartsWith: "run402 deploy release" });
    });
    for (const action of DEPLOY_RELEASE.specific) {
      it(`deploy release ${action} --help prints PER-SUBCOMMAND help`, async () => {
        assertHelp(await runCli(["deploy", "release", action, "--help"]),
          `run402 deploy release ${action} --help`,
          { expectHeadingStartsWith: `run402 deploy release ${action}` });
      });
    }
  });

  // GH-198 — `run402 deploy --help` was showing the v1 bundle manifest format
  // (top-level `migrations` string, `secrets` array, `functions` array, `files`
  // array) which the v2 gateway rejects. The example must match the v2
  // ReleaseSpec shape documented in cli/llms-cli.txt: object trees rooted at
  // `database`, `site`, `functions.replace`, `secrets.require`, `subdomains`.
  describe("run402 deploy --help shows v2 manifest format (GH-198)", () => {
    it("deploy --help example uses v2 keys (database/site/replace), not v1 arrays", async () => {
      const result = await runCli(["deploy", "--help"]);
      assertHelp(result, "run402 deploy --help");

      const out = result.stdout;

      // v2 keys must be present in the example block.
      assert.match(out, /"database":/,
        `deploy --help: example must contain a top-level "database": key (v2 ReleaseSpec)\nstdout:\n${out}`);
      assert.match(out, /"site":/,
        `deploy --help: example must contain a top-level "site": key (v2 ReleaseSpec)\nstdout:\n${out}`);
      assert.match(out, /"replace":/,
        `deploy --help: example must contain a "replace": key (v2 site/functions shape)\nstdout:\n${out}`);
      assert.match(out, /"require":/,
        `deploy --help: example must contain a "require": key (value-free secrets shape)\nstdout:\n${out}`);
      assert.match(out, /"set":/,
        `deploy --help: example must contain a "set": key (v2 subdomains shape)\nstdout:\n${out}`);
      assert.match(out, /"subdomains":/,
        `deploy --help: example must contain a "subdomains": key (v2 ReleaseSpec)\nstdout:\n${out}`);

      // v1 shapes that are NOT accepted by the v2 gateway must be gone.
      // - top-level `"migrations":` as a string (v1) — v2 nests under database.migrations as an array of {id, sql}
      assert.doesNotMatch(out, /^\s*"migrations":\s*"/m,
        `deploy --help: example must not have v1 top-level "migrations": "<string>" (use database.migrations: [{id, sql}])\nstdout:\n${out}`);
      // - top-level `"files":` as an array (v1) — v2 uses site.replace as an object map
      assert.doesNotMatch(out, /^\s*"files":\s*\[/m,
        `deploy --help: example must not have v1 top-level "files": [...] array (use site.replace: { "<path>": {...} })\nstdout:\n${out}`);
      // - top-level `"secrets":` as an array (v1) — v2 uses secrets.require/delete as value-free declarations
      assert.doesNotMatch(out, /^\s*"secrets":\s*\[/m,
        `deploy --help: example must not have v1 top-level "secrets": [...] array (use secrets.require: ["<KEY>"])\nstdout:\n${out}`);
      assert.doesNotMatch(out, /"secrets"\s*:\s*\{\s*"set"\s*:/,
        `deploy --help: example must not put secret values in secrets.set (use secrets.require)\nstdout:\n${out}`);
      // - top-level `"functions":` as an array (v1) — v2 uses functions.replace as an object map
      assert.doesNotMatch(out, /^\s*"functions":\s*\[/m,
        `deploy --help: example must not have v1 top-level "functions": [...] array (use functions.replace: { "<name>": {...} })\nstdout:\n${out}`);
      // - top-level `"subdomain":` (singular, v1) — v2 uses `subdomains.set: ["..."]`
      assert.doesNotMatch(out, /^\s*"subdomain":/m,
        `deploy --help: example must not have v1 top-level "subdomain" (singular); use "subdomains": { "set": [...] }\nstdout:\n${out}`);
    });
  });

  // Regression test for GH-188: confirm the previously-broken subcommands now
  // print their own per-subcommand help instead of falling back to the parent
  // namespace's help page. The MATRIX above also covers these (each one moved
  // from `shared` to `specific`), but this explicit suite spot-checks a
  // representative sample across namespaces and asserts both that the
  // subcommand-specific title is present AND that the parent's general
  // "Manage ..." headline is NOT.
  describe("GH-188 regression — SUB_HELP entries for previously-broken subs", () => {
    const cases = [
      // [command sequence, parent-help heading that should NOT appear]
      [["secrets", "list"],            "run402 secrets — Manage project secrets"],
      [["functions", "list"],          "run402 functions — Manage serverless functions"],
      [["domains", "list"],            "run402 domains — Manage custom domains"],
      [["ai", "moderate"],             "run402 ai — AI translation and moderation tools"],
      [["tier", "status"],             "run402 tier — Manage your Run402 tier subscription"],
      [["service", "status"],          "run402 service — Run402 service health and availability"],
      [["sender-domain", "register"],  "run402 sender-domain — Manage custom email sender domain"],
      [["contracts", "get-wallet"],    "run402 contracts — KMS-backed Ethereum wallets"],
    ];
    for (const [argv, parentHeading] of cases) {
      it(`run402 ${argv.join(" ")} --help shows per-subcommand title`, async () => {
        const result = await runCli([...argv, "--help"]);
        const expectedHeading = `run402 ${argv.join(" ")}`;
        assertHelp(result, `run402 ${argv.join(" ")} --help`, {
          expectHeadingStartsWith: expectedHeading,
        });
        // Belt-and-suspenders: parent-only headline must NOT be the first line.
        const firstLine = result.stdout.trimStart().split(/\r?\n/, 1)[0];
        assert.ok(!firstLine.startsWith(parentHeading.split(" — ")[0] + " —"),
          `run402 ${argv.join(" ")} --help fell through to parent help: first line was "${firstLine}"`);
      });
    }
  });
});
