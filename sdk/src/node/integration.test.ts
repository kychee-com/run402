/**
 * Integration-level tests for the Node `run402()` factory wiring.
 *
 * Section 3 validates construction only — the Node factory, its credential
 * provider, and the lazy paid-fetch wrapper compose cleanly. End-to-end
 * request/response tests live in section 4 once the `projects` namespace
 * exposes actual methods.
 *
 * Full x402 on-chain retry is exercised manually against a funded wallet
 * and is out of scope for the unit suite.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run402, Run402, NodeCredentialsProvider } from "./index.js";

let tempDir: string;
const originalConfigDir = process.env.RUN402_CONFIG_DIR;
const originalApiBase = process.env.RUN402_API_BASE;

before(() => {
  process.env.RUN402_API_BASE = "https://api.run402.test";
});

after(() => {
  if (originalApiBase !== undefined) process.env.RUN402_API_BASE = originalApiBase;
  else delete process.env.RUN402_API_BASE;
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-sdk-integ-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
});

afterEach(() => {
  if (originalConfigDir !== undefined) process.env.RUN402_CONFIG_DIR = originalConfigDir;
  else delete process.env.RUN402_CONFIG_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("run402() Node factory", () => {
  it("constructs a Run402 instance with no keystore and no allowance", () => {
    const r = run402({ disablePaidFetch: true });
    assert.ok(r instanceof Run402);
    assert.ok(r.projects);
  });

  it("constructs with a populated keystore", () => {
    writeFileSync(
      join(tempDir, "projects.json"),
      JSON.stringify({
        projects: { prj_test: { anon_key: "anon", service_key: "service" } },
      }),
    );
    const r = run402({ disablePaidFetch: true });
    assert.ok(r instanceof Run402);
  });

  it("accepts a custom fetch override", () => {
    const customFetch = (async () =>
      new Response("test", { status: 200 })) as typeof globalThis.fetch;
    const r = run402({ fetch: customFetch });
    assert.ok(r instanceof Run402);
  });

  it("exports NodeCredentialsProvider for advanced consumers", () => {
    const provider = new NodeCredentialsProvider();
    assert.ok(typeof provider.getAuth === "function");
    assert.ok(typeof provider.getProject === "function");
  });
});
