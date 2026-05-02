/**
 * cli-env.test.mjs — Subprocess tests for environment-variable validation.
 *
 * Bug GH-197: RUN402_API_BASE was previously read with `||` fallback, which
 * meant an empty string silently used the default and any non-URL/junk value
 * produced opaque "fetch failed" errors. The fix in `core/src/config.ts` adds
 * URL validation and a stderr warning for set-but-empty values.
 *
 * These tests spawn the CLI as a subprocess so each scenario gets its own
 * process with a freshly read env, which is what real users hit.
 *
 * Run:  node --test cli-env.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "cli", "cli.mjs");

async function runCli(argv, env) {
  const configDir = mkdtempSync(join(tmpdir(), "run402-env-"));
  const child = spawn(process.execPath, [CLI_PATH, ...argv], {
    env: {
      ...process.env,
      RUN402_CONFIG_DIR: configDir,
      HOME: configDir,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  const killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [code] = await once(child, "exit");
  clearTimeout(killTimer);

  rmSync(configDir, { recursive: true, force: true });
  return { code, stdout, stderr };
}

describe("RUN402_API_BASE env-var validation", () => {
  it("invalid scheme (javascript:) produces clear error mentioning the env var", async () => {
    const r = await runCli(
      ["allowance", "status"],
      { RUN402_API_BASE: "javascript:alert(1)" },
    );
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /RUN402_API_BASE/,
      `stderr must mention the env var name; got: ${r.stderr}`);
    assert.match(r.stderr, /javascript:/,
      `stderr must mention the bad scheme; got: ${r.stderr}`);
    // Must NOT be the opaque "fetch failed" or generic Node stack trace.
    assert.doesNotMatch(r.stderr, /fetch failed/,
      `stderr must not be the opaque generic error; got: ${r.stderr}`);
  });

  it("invalid scheme (file:) produces clear error mentioning the env var", async () => {
    const r = await runCli(
      ["allowance", "status"],
      { RUN402_API_BASE: "file:///etc/passwd" },
    );
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /RUN402_API_BASE/);
    assert.match(r.stderr, /file:/);
  });

  it("no scheme (api.run402.com) produces clear error mentioning the env var", async () => {
    const r = await runCli(
      ["allowance", "status"],
      { RUN402_API_BASE: "api.run402.com" },
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /RUN402_API_BASE/,
      `must mention env var so the user knows where to look; got: ${r.stderr}`);
    assert.match(r.stderr, /not a valid URL|http\(s\)/i);
  });

  it("empty string emits a stderr warning and falls back to default", async () => {
    // We avoid actually hitting the real production API by checking only that
    // the warning is on stderr — we also force the command to be one that
    // exits without making a network call (--help).
    const r = await runCli(
      ["allowance", "--help"],
      { RUN402_API_BASE: "" },
    );
    assert.equal(r.code, 0, `--help should exit 0; got ${r.code}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /RUN402_API_BASE/,
      `expected a warning naming the env var; got stderr: ${r.stderr}`);
    assert.match(r.stderr, /empty/i);
  });

  it("valid http://localhost URL is accepted (test/local dev shape)", async () => {
    // We give the CLI an unreachable localhost port for a command that DOES
    // try to hit the API (status). The validation should pass (we don't
    // expect the structured "BAD_ENV" / scheme-validation message), and any
    // failure must come from the network attempt, not URL validation.
    const r = await runCli(
      ["service", "health"],
      { RUN402_API_BASE: "http://127.0.0.1:1" },
    );
    // We don't care what exit code we get from the unreachable port —
    // we only care that the URL validation didn't reject it.
    assert.doesNotMatch(r.stderr, /not a valid URL/i,
      `valid http:// URL must not be rejected; got: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /must use http\(s\):/i,
      `valid http:// URL must not be rejected; got: ${r.stderr}`);
  });
});
