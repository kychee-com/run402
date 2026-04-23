import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let allowanceAuthReturn: any = {
  headers: {
    "SIGN-IN-WITH-X": "dGVzdA==",
  },
};

mock.module("../allowance-auth.js", {
  namedExports: {
    requireAllowanceAuth: (_path: string) => allowanceAuthReturn,
  },
});

const { handleTierStatus } = await import("./tier-status.js");
const { _resetSdk } = await import("../sdk.js");

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-tier-status-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  _resetSdk();
  allowanceAuthReturn = {
    headers: {
      "SIGN-IN-WITH-X": "dGVzdA==",
    },
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("tier_status tool", () => {
  it("returns tier info for subscribed wallet", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          wallet: "0xabc",
          tier: "prototype",
          lease_expires_at: "2026-03-21T00:00:00.000Z",
          status: "active",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleTierStatus({} as Record<string, never>);
    const text = result.content[0]!.text;
    assert.ok(text.includes("prototype"));
    assert.ok(text.includes("active"));
    assert.ok(text.includes("2026-03-21"));
    assert.equal(result.isError, undefined);
  });

  it("returns guidance when no tier subscription", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          wallet: "0xabc",
          tier: null,
          lease_expires_at: null,
          status: "none",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleTierStatus({} as Record<string, never>);
    const text = result.content[0]!.text;
    assert.ok(text.includes("No active tier"));
    assert.equal(result.isError, undefined);
  });

  it("returns isError on API failure", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleTierStatus({} as Record<string, never>);
    assert.equal(result.isError, true);
  });

  it("returns allowance auth error when no allowance configured", async () => {
    allowanceAuthReturn = {
      error: {
        content: [{ type: "text", text: "Error: No agent allowance configured." }],
        isError: true,
      },
    };

    const result = await handleTierStatus({} as Record<string, never>);
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("No agent allowance configured"));
  });
});
