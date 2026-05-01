import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleInit } from "./init.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-init-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

function readAllowanceFile() {
  return JSON.parse(readFileSync(join(tempDir, "allowance.json"), "utf-8"));
}

function writeAllowanceFile(data: Record<string, unknown>) {
  writeFileSync(join(tempDir, "allowance.json"), JSON.stringify(data), { mode: 0o600 });
}

function writeKeystoreFile(data: Record<string, unknown>) {
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify(data), { mode: 0o600 });
}

// Mock fetch that handles faucet + tier endpoints
function mockFetch(opts: {
  faucetOk?: boolean;
  faucetBody?: Record<string, unknown>;
  tierOk?: boolean;
  tierBody?: Record<string, unknown>;
}) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("/faucet/v1")) {
      // Wire shape (snake_case + micros) — SDK normalizes for callers.
      return new Response(
        JSON.stringify(opts.faucetBody ?? { transaction_hash: "0xabc", amount_usd_micros: 250000, token: "USDC", network: "base-sepolia" }),
        { status: opts.faucetOk !== false ? 200 : 429, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/tiers/v1/status")) {
      return new Response(
        JSON.stringify(opts.tierBody ?? { wallet: "0xabc", tier: null, lease_started_at: null, lease_expires_at: null, active: false, pool_usage: { projects: 0, total_api_calls: 0, total_storage_bytes: 0, api_calls_limit: 0, storage_bytes_limit: 0 } }),
        { status: opts.tierOk !== false ? 200 : 500, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("init tool", () => {
  it("creates allowance when none exists", async () => {
    mockFetch({});

    const result = await handleInit({});
    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    assert.ok(text.includes("(created)"));

    const allowance = readAllowanceFile();
    assert.ok(allowance.address.startsWith("0x"));
    assert.ok(allowance.privateKey.startsWith("0x"));
    assert.equal(allowance.funded, true); // faucet succeeded
    assert.equal(allowance.rail, "x402");
  });

  it("reuses existing allowance", async () => {
    writeAllowanceFile({
      address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      created: "2026-01-01T00:00:00.000Z",
      funded: true,
      rail: "x402",
    });
    mockFetch({});

    const result = await handleInit({});
    const text = result.content[0]!.text;
    assert.ok(!text.includes("(created)"));
    assert.ok(text.includes("0xf39f...2266"));

    // Allowance unchanged
    const allowance = readAllowanceFile();
    assert.equal(allowance.privateKey, "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  });

  it("requests x402 faucet when unfunded", async () => {
    writeAllowanceFile({
      address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      created: "2026-01-01T00:00:00.000Z",
      funded: false,
      rail: "x402",
    });
    mockFetch({ faucetOk: true, faucetBody: { transaction_hash: "0xabc", amount_usd_micros: 250000, token: "USDC", network: "base-sepolia" } });

    const result = await handleInit({});
    const text = result.content[0]!.text;
    assert.ok(text.includes("funded"));

    const allowance = readAllowanceFile();
    assert.equal(allowance.funded, true);
    assert.ok(allowance.lastFaucet);
  });

  it("requests mpp faucet when rail is mpp", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("rpc.moderato.tempo.xyz")) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", result: "0xfaucettx", id: 1 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/tiers/v1/status")) {
        return new Response(
          JSON.stringify({ wallet: "0xabc", tier: null, lease_started_at: null, lease_expires_at: null, active: false, pool_usage: { projects: 0, total_api_calls: 0, total_storage_bytes: 0, api_calls_limit: 0, storage_bytes_limit: 0 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await handleInit({ rail: "mpp" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("Tempo Moderato"));
    assert.ok(text.includes("mpp"));
    assert.ok(text.includes("funded"));

    const allowance = readAllowanceFile();
    assert.equal(allowance.rail, "mpp");
    assert.equal(allowance.funded, true);
  });

  it("skips faucet when already funded", async () => {
    writeAllowanceFile({
      address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      created: "2026-01-01T00:00:00.000Z",
      funded: true,
      rail: "x402",
    });

    let faucetCalled = false;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/faucet/v1")) faucetCalled = true;
      if (url.includes("/tiers/v1/status")) {
        return new Response(
          JSON.stringify({ wallet: "0xabc", tier: null, lease_started_at: null, lease_expires_at: null, active: false, pool_usage: { projects: 0, total_api_calls: 0, total_storage_bytes: 0, api_calls_limit: 0, storage_bytes_limit: 0 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await handleInit({});
    const text = result.content[0]!.text;
    assert.ok(text.includes("already funded"));
    assert.equal(faucetCalled, false);
  });

  it("handles faucet failure gracefully", async () => {
    mockFetch({ faucetOk: false, faucetBody: { error: "rate limited" } });

    const result = await handleInit({});
    assert.equal(result.isError, undefined); // non-fatal
    const text = result.content[0]!.text;
    assert.ok(text.includes("failed"));
  });

  it("includes tier status in summary", async () => {
    writeAllowanceFile({
      address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      created: "2026-01-01T00:00:00.000Z",
      funded: true,
      rail: "x402",
    });
    mockFetch({
      tierOk: true,
      tierBody: { wallet: "0xabc", tier: "prototype", active: true, lease_started_at: "2026-03-18T00:00:00.000Z", lease_expires_at: "2026-04-01T00:00:00.000Z", pool_usage: { projects: 1, total_api_calls: 0, total_storage_bytes: 0, api_calls_limit: 500_000, storage_bytes_limit: 250_000_000 } },
    });

    const result = await handleInit({});
    const text = result.content[0]!.text;
    assert.ok(text.includes("prototype"));
    assert.ok(text.includes("2026-04-01"));
    assert.ok(text.includes("Ready to deploy"));
  });

  it("includes project count in summary", async () => {
    writeAllowanceFile({
      address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      created: "2026-01-01T00:00:00.000Z",
      funded: true,
      rail: "x402",
    });
    writeKeystoreFile({
      projects: {
        "proj-1": { anon_key: "ak1", service_key: "sk1" },
        "proj-2": { anon_key: "ak2", service_key: "sk2" },
      },
    });
    mockFetch({});

    const result = await handleInit({});
    const text = result.content[0]!.text;
    assert.ok(text.includes("2 active"));
  });

  it("rail switching updates allowance.json", async () => {
    writeAllowanceFile({
      address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      created: "2026-01-01T00:00:00.000Z",
      funded: true,
      rail: "x402",
    });
    mockFetch({});

    await handleInit({ rail: "mpp" });
    const allowance = readAllowanceFile();
    assert.equal(allowance.rail, "mpp");
  });

  it("idempotent — second call does not duplicate state", async () => {
    mockFetch({});

    const result1 = await handleInit({});
    const text1 = result1.content[0]!.text;
    assert.ok(text1.includes("(created)"));

    const allowance1 = readAllowanceFile();

    // Second call — allowance already exists and funded
    const result2 = await handleInit({});
    const text2 = result2.content[0]!.text;
    assert.ok(!text2.includes("(created)"));

    const allowance2 = readAllowanceFile();
    assert.equal(allowance1.address, allowance2.address);
    assert.equal(allowance1.privateKey, allowance2.privateKey);
  });
});
