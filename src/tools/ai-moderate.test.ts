import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleAiModerate } from "./ai-moderate.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-ai-moderate-test-"));
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

describe("ai_moderate tool", () => {
  it("returns moderation result when not flagged", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          flagged: false,
          categories: { harassment: false, violence: false },
          category_scores: { harassment: 0.001, violence: 0.0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleAiModerate({
      project_id: "proj-001",
      text: "This is a friendly message",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("OK"));
    assert.ok(result.content[0]!.text.includes("harassment"));
    assert.ok(result.content[0]!.text.includes("0.0010"));
  });

  it("returns flagged result with YES markers", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          flagged: true,
          categories: { harassment: true, violence: false },
          category_scores: { harassment: 0.95, violence: 0.01 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleAiModerate({
      project_id: "proj-001",
      text: "some text",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("FLAGGED"));
    assert.ok(result.content[0]!.text.includes("YES"));
  });

  it("returns isError on 400", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ message: "Invalid input" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleAiModerate({
      project_id: "proj-001",
      text: "",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("Invalid input"));
  });

  it("returns isError on 429", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ message: "Rate limit exceeded" }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleAiModerate({
      project_id: "proj-001",
      text: "some text",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("Rate limit"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleAiModerate({
      project_id: "nonexistent",
      text: "some text",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
