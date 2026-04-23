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

const { handleProvision, provisionSchema } = await import("./provision.js");
const { getProject, getActiveProjectId } = await import("../keystore.js");

const originalFetch = globalThis.fetch;
let tempDir: string;
let storePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-provision-test-"));
  storePath = join(tempDir, "projects.json");
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
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

describe("provision tool", () => {
  it("saves project to keystore on 200", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          project_id: "proj-001",
          anon_key: "ak-123",
          service_key: "sk-456",
          schema_slot: "p0042",
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
    assert.equal(getActiveProjectId(storePath), "proj-001");
  });

  it("returns allowance auth error when no allowance configured", async () => {
    allowanceAuthReturn = {
      error: {
        content: [{ type: "text", text: "Error: No agent allowance configured." }],
        isError: true,
      },
    };

    const result = await handleProvision({ tier: "prototype" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("No agent allowance configured"));
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
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    await handleProvision({ tier: "hobby" });
    const stored = getProject("proj-dup", storePath);
    assert.equal(stored!.anon_key, "ak-new");
  });

  // GH-110: tier description must reflect actual $0.10 price, not "free/testnet"
  it("tier schema description shows prototype as $0.10/7d (GH-110)", () => {
    const desc = provisionSchema.tier.description || "";
    assert.doesNotMatch(
      desc,
      /free\/testnet/i,
      `prototype tier must not be described as 'free/testnet' — server charges $0.10. Got: ${desc}`,
    );
    assert.match(
      desc,
      /\$0\.10\/7d/,
      `prototype tier must be described as '$0.10/7d' to match server pricing. Got: ${desc}`,
    );
  });
});
