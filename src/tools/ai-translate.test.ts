import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleAiTranslate } from "./ai-translate.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-ai-translate-test-"));
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

describe("ai_translate tool", () => {
  it("returns translated text on success", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ text: "Hola mundo", from: "en", to: "es" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleAiTranslate({
      project_id: "proj-001",
      text: "Hello world",
      to: "es",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Hola mundo"));
    assert.ok(result.content[0]!.text.includes("Translation"));
  });

  it("sends from and context when provided", async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ text: "translated", from: "en", to: "ja" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleAiTranslate({
      project_id: "proj-001",
      text: "Hello",
      to: "ja",
      from: "en",
      context: "formal business email",
    });

    const parsed = JSON.parse(capturedBody!);
    assert.equal(parsed.from, "en");
    assert.equal(parsed.context, "formal business email");
  });

  it("returns informational message on 402", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ message: "AI Translation add-on not enabled" }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleAiTranslate({
      project_id: "proj-001",
      text: "Hello",
      to: "es",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Translation Unavailable"));
    assert.ok(result.content[0]!.text.includes("add-on"));
  });

  it("returns isError on 400", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ message: "Invalid language code" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleAiTranslate({
      project_id: "proj-001",
      text: "Hello",
      to: "xyz",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("Invalid language code"));
  });

  it("returns isError on 429", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ message: "Rate limit exceeded" }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleAiTranslate({
      project_id: "proj-001",
      text: "Hello",
      to: "es",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("Rate limit"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleAiTranslate({
      project_id: "nonexistent",
      text: "Hello",
      to: "es",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
