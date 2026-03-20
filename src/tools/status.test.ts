import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleStatus } from "./status.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-status-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

function writeAllowance(data: Record<string, unknown>) {
  writeFileSync(join(tempDir, "allowance.json"), JSON.stringify(data), { mode: 0o600 });
}

function writeKeystore(data: Record<string, unknown>) {
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify(data), { mode: 0o600 });
}

function mockApis(opts: {
  tier?: Record<string, unknown> | null;
  billing?: Record<string, unknown> | null;
  projects?: Record<string, unknown> | null;
}) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/tiers/v1/status") && opts.tier) {
      return new Response(JSON.stringify(opts.tier), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/billing/v1/accounts/") && opts.billing) {
      return new Response(JSON.stringify(opts.billing), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/wallets/v1/") && opts.projects) {
      return new Response(JSON.stringify(opts.projects), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("error", { status: 500 });
  }) as typeof fetch;
}

describe("status tool", () => {
  it("returns full account snapshot", async () => {
    writeAllowance({ address: TEST_ADDR, privateKey: TEST_PK, created: "2026-01-01T00:00:00Z", funded: true, rail: "x402" });
    writeKeystore({ active_project_id: "proj-1", projects: { "proj-1": { anon_key: "ak1", service_key: "sk1" } } });
    mockApis({
      tier: { tier: "prototype", status: "active", lease_expires_at: "2026-04-01T00:00:00Z" },
      billing: { exists: true, available_usd_micros: 250000, held_usd_micros: 0 },
      projects: { projects: [{ id: "proj-1" }] },
    });

    const result = await handleStatus({} as Record<string, never>);
    const text = result.content[0]!.text;
    assert.ok(text.includes(TEST_ADDR));
    assert.ok(text.includes("prototype"));
    assert.ok(text.includes("$0.25"));
    assert.ok(text.includes("proj-1"));
    assert.ok(text.includes("(active)"));
    assert.equal(result.isError, undefined);
  });

  it("returns error when no allowance", async () => {
    const result = await handleStatus({} as Record<string, never>);
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("No agent allowance"));
  });

  it("handles API failures gracefully", async () => {
    writeAllowance({ address: TEST_ADDR, privateKey: TEST_PK, created: "2026-01-01T00:00:00Z", funded: true, rail: "x402" });
    // All APIs return 500
    globalThis.fetch = (async () => new Response("error", { status: 500 })) as typeof fetch;

    const result = await handleStatus({} as Record<string, never>);
    assert.equal(result.isError, undefined); // not an error
    const text = result.content[0]!.text;
    assert.ok(text.includes("(unavailable)"));
    assert.ok(text.includes("(none)"));
  });
});
