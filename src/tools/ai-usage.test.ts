import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleAiUsage } from "./ai-usage.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-ai-usage-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";

  const store = {
    projects: {
      "proj-001": {
        anon_key: "ak-123",
        service_key: "sk-456",
      },
    },
  };
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify(store));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("ai_usage tool", () => {
  it("returns formatted usage on success", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          translation: {
            active: true,
            used_words: 847,
            included_words: 10000,
            remaining_words: 9153,
            billing_cycle_start: "2024-01-01T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleAiUsage({ project_id: "proj-001" });

    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    assert.ok(text.includes("AI Translation Usage"));
    assert.ok(text.includes("Active"));
    assert.ok(text.includes("847"));
    assert.ok(text.includes("9,153") || text.includes("9153"));
    assert.ok(text.includes("2024-01-01"));
  });

  it("returns isError on API error", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ message: "Internal server error" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleAiUsage({ project_id: "proj-001" });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("Internal server error"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleAiUsage({ project_id: "nonexistent" });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
