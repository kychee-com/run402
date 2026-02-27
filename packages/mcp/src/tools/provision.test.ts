import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleProvision } from "./provision.js";
import { getProject, loadKeyStore } from "../keystore.js";

const originalFetch = globalThis.fetch;
let tempDir: string;
let storePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-provision-test-"));
  storePath = join(tempDir, "projects.json");
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("provision tool", () => {
  it("saves project to keystore on 200", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          project_id: "proj-001",
          anon_key: "ak-123",
          service_key: "sk-456",
          schema_slot: "p0042",
          tier: "prototype",
          lease_expires_at: "2026-03-06T00:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleProvision({ tier: "prototype" });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("proj-001"));
    assert.ok(result.content[0]!.text.includes("Project Provisioned"));

    const stored = getProject("proj-001", storePath);
    assert.ok(stored);
    assert.equal(stored!.anon_key, "ak-123");
    assert.equal(stored!.service_key, "sk-456");
    assert.equal(stored!.tier, "prototype");
  });

  it("returns needs_allowance text (NOT isError) on 402", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          x402: { price: "$0.10", network: "base-sepolia", address: "0xabc" },
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleProvision({ tier: "prototype" });
    // 402 should NOT be an error — the LLM should reason about payment
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Payment Required"));
    assert.ok(result.content[0]!.text.includes("$0.10"));
  });

  it("returns isError on 400 (invalid tier)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Unknown tier: invalid" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleProvision({ tier: "invalid" as any });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("Unknown tier"));
  });

  it("returns isError on 503 (no slots)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "No schema slots available" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleProvision({ tier: "prototype" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("No schema slots"));
  });

  it("overwrites keystore entry on re-provision", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          project_id: "proj-dup",
          anon_key: "ak-new",
          service_key: "sk-new",
          schema_slot: "p0001",
          tier: "hobby",
          lease_expires_at: "2026-04-01T00:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    await handleProvision({ tier: "hobby" });
    const stored = getProject("proj-dup", storePath);
    assert.equal(stored!.anon_key, "ak-new");
    assert.equal(stored!.tier, "hobby");
  });
});
