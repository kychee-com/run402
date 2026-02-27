import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRenew } from "./renew.js";
import { saveProject, getProject } from "../keystore.js";

const originalFetch = globalThis.fetch;
let tempDir: string;
let storePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-renew-test-"));
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

describe("renew tool", () => {
  it("updates keystore with new expiry on 200", async () => {
    saveProject("proj-rn1", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          project_id: "proj-rn1",
          tier: "prototype",
          lease_expires_at: "2026-03-13T00:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleRenew({ project_id: "proj-rn1" });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("renewed"));
    assert.ok(result.content[0]!.text.includes("2026-03-13"));

    const stored = getProject("proj-rn1", storePath);
    assert.equal(stored!.expires_at, "2026-03-13T00:00:00.000Z");
  });

  it("returns needs_allowance text (NOT isError) on 402", async () => {
    saveProject("proj-rn2", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          x402: { price: "$0.10", network: "base-sepolia" },
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleRenew({ project_id: "proj-rn2" });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Payment Required"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleRenew({ project_id: "no-proj" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
