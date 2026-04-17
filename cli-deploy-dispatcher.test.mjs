/**
 * cli-deploy-dispatcher.test.mjs — Real-network test for the deploy CLI's
 * undici dispatcher wiring.
 *
 * This test does NOT mock globalThis.fetch. It stands up a local http.createServer
 * and lets cli/lib/deploy.mjs make a real HTTP call through its custom undici
 * Agent. This is what catches version mismatches between the bundled-Node
 * undici (used by globalThis.fetch) and the npm-installed undici whose Agent
 * we pass in as `dispatcher:`. The mocked-fetch tests in cli-e2e.test.mjs
 * bypass that code path entirely, which is how v1.34.1 shipped a broken deploy.
 *
 * Env and config dir must be set before cli/lib/deploy.mjs is imported, because
 * cli/lib/config.mjs reads them at module load.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ─── Harness ────────────────────────────────────────────────────────────────

const tempDir = mkdtempSync(join(tmpdir(), "run402-deploy-disp-"));
let server;
let serverUrl;
let lastRequest = null;

const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
let output = [];

function captureStart() {
  output = [];
  console.log = (...args) =>
    output.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  console.error = (...args) =>
    output.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
}
function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}
function captured() { return output.join("\n"); }

// Minimal valid allowance (address + private key). A random EVM-style key is
// fine — the local server does not verify the signature, it only needs the
// CLI to get past its "do I have an allowance?" check.
function writeAllowance(dir) {
  const pk = "0x" + randomBytes(32).toString("hex");
  // Address is never validated by the local server; use a stable dummy.
  const allowance = {
    address: "0x" + "a".repeat(40),
    privateKey: pk,
    rail: "x402",
  };
  writeFileSync(join(dir, "allowance.json"), JSON.stringify(allowance), { mode: 0o600 });
}

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      lastRequest = { method: req.method, url: req.url, body };
      if (req.method === "POST" && req.url === "/deploy/v1") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          project_id: "prj_real_disp",
          site_url: "https://real-disp.sites.run402.com",
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  serverUrl = `http://127.0.0.1:${port}`;

  // Must be set BEFORE importing deploy.mjs / config.mjs
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = serverUrl;
  writeAllowance(tempDir);

  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  captureStop();
  process.exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("deploy dispatcher (real network)", () => {
  it("POSTs /deploy/v1 through the custom undici Agent and returns the server's JSON", async () => {
    const { run } = await import("./cli/lib/deploy.mjs");
    const manifestPath = join(tempDir, "disp-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      project_id: "prj_real_disp",
      files: [{ file: "index.html", data: "<h1>dispatcher ok</h1>" }],
    }));

    lastRequest = null;
    captureStart();
    try {
      await run(["--manifest", manifestPath]);
    } finally {
      captureStop();
    }

    // The server MUST have received the request. If the dispatcher is
    // incompatible with globalThis.fetch's internal undici, fetch rejects
    // before making the call and this assertion fails.
    assert.ok(lastRequest, "server should have received a request");
    assert.equal(lastRequest.method, "POST");
    assert.equal(lastRequest.url, "/deploy/v1");

    const body = JSON.parse(lastRequest.body);
    assert.equal(body.project_id, "prj_real_disp");
    assert.ok(Array.isArray(body.files) && body.files[0].file === "index.html");

    // CLI should print the server's success JSON on stdout.
    const out = captured();
    assert.ok(out.includes("prj_real_disp"), `expected project id in output, got: ${out}`);
    assert.ok(out.includes("real-disp.sites.run402.com"), `expected site_url in output, got: ${out}`);
  });
});
