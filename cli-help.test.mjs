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
  tier: { shared: ["status", "set"], specific: [] },
  projects: {
    shared: [
      "quote", "use", "list", "info", "keys", "rest",
      "usage", "schema", "rls", "delete", "pin", "promote-user", "demote-user",
    ],
    specific: ["provision", "sql"],
  },
  deploy: { shared: [], specific: [] },
  functions: {
    shared: ["list", "delete"],
    specific: ["deploy", "invoke", "logs", "update"],
  },
  secrets: { shared: ["list", "delete"], specific: ["set"] },
  blob: {
    shared: [],
    specific: ["put", "get", "ls", "rm", "sign"],
  },
  storage: { shared: ["download", "delete", "list"], specific: ["upload"] },
  sites: { shared: ["status"], specific: ["deploy"] },
  subdomains: { shared: ["delete", "list"], specific: ["claim"] },
  domains: { shared: ["add", "list", "status", "delete"], specific: [] },
  apps: {
    shared: ["versions", "inspect", "delete"],
    specific: ["browse", "fork", "publish", "update"],
  },
  ai: { shared: ["moderate", "usage"], specific: ["translate"] },
  image: { shared: ["generate"], specific: [] },
  email: {
    shared: ["create", "status", "list", "get"],
    specific: ["send", "get-raw"],
  },
  message: { shared: ["send"], specific: [] },
  auth: {
    shared: [],
    specific: ["magic-link", "verify", "set-password", "settings", "providers"],
  },
  "sender-domain": {
    shared: ["register", "status", "remove", "inbound-enable", "inbound-disable"],
    specific: [],
  },
  billing: {
    shared: ["create-email", "link-wallet", "balance"],
    specific: ["tier-checkout", "buy-email-pack", "auto-recharge", "history"],
  },
  contracts: {
    shared: ["get-wallet", "list-wallets", "status"],
    specific: [
      "provision-wallet", "set-recovery", "set-alert", "call", "read", "drain", "delete",
    ],
  },
  agent: { shared: ["contact"], specific: [] },
  service: { shared: ["status", "health"], specific: [] },
};

// `run402 email webhooks <action>` delegates to lib/webhooks.mjs.
const EMAIL_WEBHOOKS = {
  shared: ["list", "get", "delete"],
  specific: ["update", "register"],
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
});
