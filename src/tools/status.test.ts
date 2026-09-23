import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleStatus } from "./status.js";
import { statusOutputSchema } from "../structured.js";

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

function writeWallet(data: Record<string, unknown>) {
  writeFileSync(join(tempDir, "wallet.json"), JSON.stringify(data), { mode: 0o600 });
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
    if (url.includes("/orgs/v1/lookup") && opts.billing) {
      return new Response(JSON.stringify(opts.billing), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/wallets/v1/") && opts.projects) {
      return new Response(JSON.stringify(opts.projects), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("error", { status: 500 });
  }) as typeof fetch;
}

/** The fenced JSON is the structured object; its `result` is `r.status()`. */
function envelope(text: string): Record<string, any> {
  const structured = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)![1]!);
  assert.equal(structured.status, "ok");
  return structured.result;
}

function assertStructured(result: { content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }): void {
  assert.ok(result.structuredContent, "structuredContent is present");
  statusOutputSchema.parse(result.structuredContent);
  assert.deepEqual(result.structuredContent, JSON.parse(/```json\n([\s\S]*?)\n```/.exec(result.content[0]!.text)![1]!), "the fenced JSON is the structured object");
}

describe("status tool", () => {
  it("returns r.status(): the wallet, the tier and lease, the projects, the active project", async () => {
    writeWallet({ address: TEST_ADDR, privateKey: TEST_PK, created: "2026-01-01T00:00:00Z", funded: true, rail: "x402" });
    writeKeystore({ active_project_id: "proj-1", projects: { "proj-1": { anon_key: "ak1", service_key: "sk1" } } });
    mockApis({
      tier: { tier: "prototype", status: "active", lease_expires_at: "2026-04-01T00:00:00Z" },
      billing: { org_id: "00000000-0000-4000-8000-000000000001", allowance_usd_micros: 250000, held_usd_micros: 0 },
      projects: { projects: [{ id: "proj-1" }] },
    });

    const result = await handleStatus();
    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    assert.match(text, /^## Status: wallet default \(/);
    const status = envelope(text);
    assert.equal(status.wallet.local_label, "default");
    assert.equal(status.wallet.address.toLowerCase(), TEST_ADDR);
    assert.equal(status.balances.allowance_usd_micros, 250000);
    assert.equal(status.tier.name, "prototype");
    assert.ok(!/privateKey|private_key|sk1/.test(text), "never key material");
    assertStructured(result);
    assert.ok(!/privateKey|private_key|sk1/.test(JSON.stringify(result.structuredContent)), "never key material in the structured channel");
  });

  it("names the next command when there is no local wallet", async () => {
    globalThis.fetch = (async () => new Response("error", { status: 500 })) as typeof fetch;
    const result = await handleStatus();
    assert.equal(result.isError, undefined);
    assert.match(result.content[0]!.text, /^## Status: no local wallet/);
    assert.equal(envelope(result.content[0]!.text).wallet, null);
    assertStructured(result);
  });

  it("reports unavailable remote reads without failing", async () => {
    writeWallet({ address: TEST_ADDR, privateKey: TEST_PK, created: "2026-01-01T00:00:00Z", funded: true, rail: "x402" });
    globalThis.fetch = (async () => new Response("error", { status: 500 })) as typeof fetch;

    const result = await handleStatus();
    assert.equal(result.isError, undefined);
    const status = envelope(result.content[0]!.text);
    assert.equal(status.tier, null);
  });
});
