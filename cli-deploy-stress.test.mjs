/**
 * cli-deploy-stress.test.mjs — Stress tests for the deploy CLI's dispatcher
 * and retry path. Reproduces the symptom described in GH-31 using a local
 * HTTP server that can simulate slow responses, intermittent UND_ERR_HEADERS_TIMEOUT,
 * and large payloads.
 *
 * These tests are what catch regressions of:
 *   - Dispatcher wiring (GH-30)
 *   - headersTimeout being too short for big bodies / slow servers (GH-31 #2)
 *   - Retry not kicking in on UND_ERR_HEADERS_TIMEOUT (GH-31 #1)
 *
 * Run with: node --test cli-deploy-stress.test.mjs
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const tempDir = mkdtempSync(join(tmpdir(), "run402-deploy-stress-"));
let server;
let serverUrl;
let requestCount = 0;
let serverBehavior = { mode: "ok", slowMs: 0, timeoutBeforeHeaders: false, failCount: 0 };

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

function writeAllowance(dir) {
  const pk = "0x" + randomBytes(32).toString("hex");
  const allowance = {
    address: "0x" + "a".repeat(40),
    privateKey: pk,
    rail: "x402",
  };
  writeFileSync(join(dir, "allowance.json"), JSON.stringify(allowance), { mode: 0o600 });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

before(async () => {
  server = createServer(async (req, res) => {
    requestCount++;
    const myRequest = requestCount;
    // Read body first
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);

    if (req.method !== "POST" || req.url !== "/deploy/v1") {
      res.writeHead(404);
      res.end();
      return;
    }

    const b = serverBehavior;
    // Should this particular request fail?
    const shouldFail = b.failCount > 0;
    if (shouldFail) {
      serverBehavior.failCount--;
      // Simulate a hang past headersTimeout by never sending headers.
      // The client's dispatcher should timeout and the retry should kick in.
      // We hang for 2s — client must have been configured with something sane.
      // To keep test fast, the test will set its own short headersTimeout via
      // a module-level override below.
      await sleep(b.hangMs || 2000);
      try { res.destroy(); } catch {}
      return;
    }

    if (b.slowMs > 0) {
      await sleep(b.slowMs);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      project_id: "prj_stress",
      site_url: "https://stress.sites.run402.com",
      request_number: myRequest,
    }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  serverUrl = `http://127.0.0.1:${port}`;

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

beforeEach(() => {
  serverBehavior = { mode: "ok", slowMs: 0, failCount: 0, hangMs: 0 };
});

// Build a manifest with N "files" each ~sizeBytes bytes. Total body ≈ N*sizeBytes.
function buildLargeManifest(n, sizeBytes) {
  const filler = "A".repeat(sizeBytes);
  return {
    project_id: "prj_stress",
    files: Array.from({ length: n }, (_, i) => ({
      file: `f${i}.txt`,
      data: filler,
    })),
  };
}

describe("deploy stress — happy path at large sizes", () => {
  it("10 iterations of 20MB payloads all succeed", async () => {
    const { run } = await import("./cli/lib/deploy.mjs");
    const manifestPath = join(tempDir, "big-manifest.json");
    // 20 files × 1MB = 20MB body
    writeFileSync(manifestPath, JSON.stringify(buildLargeManifest(20, 1024 * 1024)));

    for (let i = 0; i < 10; i++) {
      captureStart();
      try {
        await run(["--manifest", manifestPath]);
      } finally {
        captureStop();
      }
      const out = captured();
      assert.ok(out.includes("prj_stress"), `iter ${i}: expected prj_stress, got: ${out.slice(0, 200)}`);
    }
  });
});

describe("deploy stress — retry on upstream header-timeout", () => {
  it("recovers from a single transient UND_ERR_HEADERS_TIMEOUT-style failure", async () => {
    // Need to install a shorter client headersTimeout so the test is fast.
    // Import deploy.mjs fresh with a test fetch that injects the timeout after
    // one failure. Simpler: use Node's undici directly with a custom Agent for this test.
    const deployMod = await import("./cli/lib/deploy.mjs");
    const { Agent, fetch: undiciFetch } = await import("undici");

    // Simulate: server hangs past 1s, client headersTimeout = 1s, retry.
    // Server fail once with 1.5s hang, then succeed.
    serverBehavior = { failCount: 1, hangMs: 1500 };

    const fastDispatcher = new Agent({
      headersTimeout: 1000,
      bodyTimeout: 1000,
      connectTimeout: 5000,
    });

    // Wrap fetch so the CLI's fetchWithRetry uses our short-timeout dispatcher.
    const shortFetch = (url, init) => undiciFetch(url, { ...init, dispatcher: fastDispatcher });
    deployMod._setFetchImpl(shortFetch);

    const manifestPath = join(tempDir, "retry-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(buildLargeManifest(2, 1024)));

    captureStart();
    try {
      await deployMod.run(["--manifest", manifestPath]);
    } finally {
      captureStop();
      deployMod._setFetchImpl(null);
    }
    const out = captured();
    assert.ok(out.includes("prj_stress"), `expected recovery, got: ${out.slice(0, 400)}`);
    assert.equal(serverBehavior.failCount, 0, "server's fail counter should be exhausted");
  });

  it("recovers from 2 consecutive transient failures (still within 3-attempt budget)", async () => {
    const deployMod = await import("./cli/lib/deploy.mjs");
    const { Agent, fetch: undiciFetch } = await import("undici");

    serverBehavior = { failCount: 2, hangMs: 1500 };
    const fastDispatcher = new Agent({
      headersTimeout: 1000,
      bodyTimeout: 1000,
      connectTimeout: 5000,
    });
    const shortFetch = (url, init) => undiciFetch(url, { ...init, dispatcher: fastDispatcher });
    deployMod._setFetchImpl(shortFetch);

    const manifestPath = join(tempDir, "retry2-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(buildLargeManifest(2, 1024)));

    captureStart();
    try {
      await deployMod.run(["--manifest", manifestPath]);
    } finally {
      captureStop();
      deployMod._setFetchImpl(null);
    }
    const out = captured();
    assert.ok(out.includes("prj_stress"), `expected recovery after 2 failures, got: ${out.slice(0, 400)}`);
  });
});

describe("deploy stress — slow servers within budget", () => {
  it("waits up to 3s for headers and still succeeds (default 10-min budget)", async () => {
    const deployMod = await import("./cli/lib/deploy.mjs");
    // Use the real in-module dispatcher (10-min). Server sleeps 3s before headers.
    deployMod._setFetchImpl(null);
    serverBehavior = { slowMs: 3000 };

    const manifestPath = join(tempDir, "slow-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(buildLargeManifest(2, 1024)));

    captureStart();
    try {
      await deployMod.run(["--manifest", manifestPath]);
    } finally {
      captureStop();
    }
    const out = captured();
    assert.ok(out.includes("prj_stress"), `expected slow-success, got: ${out.slice(0, 400)}`);
  });
});

describe("deploy stress — end-to-end mix", () => {
  it("20 iterations with mixed slow/fast and occasional retries all succeed", async () => {
    const deployMod = await import("./cli/lib/deploy.mjs");
    const { Agent, fetch: undiciFetch } = await import("undici");

    // Use a 2s headersTimeout so we can feasibly test retries in the mix.
    const fastDispatcher = new Agent({
      headersTimeout: 2000,
      bodyTimeout: 2000,
      connectTimeout: 5000,
    });
    const shortFetch = (url, init) => undiciFetch(url, { ...init, dispatcher: fastDispatcher });
    deployMod._setFetchImpl(shortFetch);

    const manifestPath = join(tempDir, "mix-manifest.json");
    // 5 × 512KB = 2.5MB, realistic for a code+migrations batch
    writeFileSync(manifestPath, JSON.stringify(buildLargeManifest(5, 512 * 1024)));

    let successes = 0;
    for (let i = 0; i < 20; i++) {
      // Every 5th iteration: inject a single transient failure
      if (i % 5 === 4) serverBehavior = { slowMs: 0, failCount: 1, hangMs: 2500 };
      // Every 3rd: slow but under the timeout budget
      else if (i % 3 === 0) serverBehavior = { slowMs: 500, failCount: 0 };
      else serverBehavior = { slowMs: 0, failCount: 0 };

      captureStart();
      try {
        await deployMod.run(["--manifest", manifestPath]);
        successes++;
      } catch (e) {
        captureStop();
        const out = captured();
        assert.fail(`iter ${i} failed: ${e.message}\nOutput: ${out.slice(0, 400)}`);
      } finally {
        captureStop();
      }
    }
    deployMod._setFetchImpl(null);
    assert.equal(successes, 20, "all 20 iterations should have succeeded");
  });
});
