import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mock } from "node:test";

mock.module("../config.js", {
  namedExports: {
    OPENAI_API_KEY: "test-openai-key",
  },
});

const {
  validateModerateInput,
  moderateText,
  ModerateError,
} = await import("./ai-moderate.js");

// ---------------------------------------------------------------------------
// validateModerateInput
// ---------------------------------------------------------------------------

describe("validateModerateInput", () => {
  it("accepts valid input", () => {
    assert.equal(validateModerateInput({ text: "Hello world" }), null);
  });

  it("rejects empty text", () => {
    assert.equal(validateModerateInput({ text: "" }), "Text is required");
    assert.equal(validateModerateInput({ text: "   " }), "Text is required");
  });

  it("rejects missing text", () => {
    assert.equal(validateModerateInput({} as any), "Text is required");
  });

  it("rejects text too long", () => {
    const longText = "a".repeat(10_001);
    assert.ok(validateModerateInput({ text: longText })?.includes("10000"));
  });
});

// ---------------------------------------------------------------------------
// moderateText — response mapping and error handling
// ---------------------------------------------------------------------------

describe("moderateText", () => {
  it("maps OpenAI results[0] correctly", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      results: [{
        flagged: true,
        categories: { harassment: true, violence: false, sexual: false },
        category_scores: { harassment: 0.92, violence: 0.01, sexual: 0.0 },
      }],
    }), { status: 200 });

    try {
      const result = await moderateText("bad content");
      assert.equal(result.flagged, true);
      assert.equal(result.categories.harassment, true);
      assert.equal(result.categories.violence, false);
      assert.ok(result.category_scores.harassment > 0.9);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns clean result for benign content", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      results: [{
        flagged: false,
        categories: { harassment: false, violence: false, sexual: false },
        category_scores: { harassment: 0.001, violence: 0.0, sexual: 0.0 },
      }],
    }), { status: 200 });

    try {
      const result = await moderateText("hello world");
      assert.equal(result.flagged, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws 503 on OpenAI error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("error", { status: 500 });

    try {
      await assert.rejects(
        () => moderateText("test"),
        (err: any) => err instanceof ModerateError && err.statusCode === 503,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws 503 on empty response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ results: [] }), { status: 200 });

    try {
      await assert.rejects(
        () => moderateText("test"),
        (err: any) => err instanceof ModerateError && err.statusCode === 503,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
