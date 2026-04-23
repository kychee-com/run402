/**
 * Tests for the Node paid-fetch lazy wrapper. Full x402 retry against a
 * funded wallet on real chains is out of scope here (belongs in integration
 * tests, not unit). What we verify:
 *   - setupPaidFetch returns null when no allowance file exists
 *   - createLazyPaidFetch transparently falls back to globalThis.fetch
 *     when setupPaidFetch returns null
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { setupPaidFetch, createLazyPaidFetch } from "./paid-fetch.js";

let tempDir: string;
const originalConfigDir = process.env.RUN402_CONFIG_DIR;
const originalApiBase = process.env.RUN402_API_BASE;
const originalFetch = globalThis.fetch;

before(() => {
  process.env.RUN402_API_BASE = "https://api.run402.test";
});

after(() => {
  if (originalApiBase !== undefined) process.env.RUN402_API_BASE = originalApiBase;
  else delete process.env.RUN402_API_BASE;
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-sdk-paidfetch-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
});

afterEach(() => {
  if (originalConfigDir !== undefined) process.env.RUN402_CONFIG_DIR = originalConfigDir;
  else delete process.env.RUN402_CONFIG_DIR;
  rmSync(tempDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

describe("setupPaidFetch", () => {
  it("returns null when no allowance file exists", async () => {
    const f = await setupPaidFetch();
    assert.equal(f, null);
  });
});

describe("createLazyPaidFetch", () => {
  it("falls back to globalThis.fetch when no allowance is configured", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof globalThis.fetch;

    const fetchFn = createLazyPaidFetch();
    const res = await fetchFn("https://example.test/x");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.deepEqual(calls, ["https://example.test/x"]);
  });
});
