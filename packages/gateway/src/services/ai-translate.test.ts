import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mock DB pool before importing the module under test
// ---------------------------------------------------------------------------

let mockPoolQuery: (...args: any[]) => Promise<any>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      query: (...args: any[]) => mockPoolQuery(...args),
    },
  },
});

mock.module("../config.js", {
  namedExports: {
    OPENROUTER_API_KEY: "test-openrouter-key",
    OPENAI_API_KEY: "test-openai-key",
    ADMIN_KEY: "test-admin-key",
  },
});

const {
  validateLanguageCode,
  validateTranslateInput,
  translateText,
  logAiUsage,
  getTranslationAddon,
  getUsageForPeriod,
  tokensToWords,
  wordsToTokens,
  TranslateError,
} = await import("./ai-translate.js");

// ---------------------------------------------------------------------------
// validateLanguageCode
// ---------------------------------------------------------------------------

describe("validateLanguageCode", () => {
  it("accepts valid ISO 639-1 codes", () => {
    assert.equal(validateLanguageCode("en"), null);
    assert.equal(validateLanguageCode("es"), null);
    assert.equal(validateLanguageCode("zh"), null);
    assert.equal(validateLanguageCode("fr"), null);
  });

  it("rejects invalid codes", () => {
    assert.ok(validateLanguageCode("xx"));
    assert.ok(validateLanguageCode("english"));
    assert.ok(validateLanguageCode("123"));
  });
});

// ---------------------------------------------------------------------------
// validateTranslateInput
// ---------------------------------------------------------------------------

describe("validateTranslateInput", () => {
  it("accepts valid input", () => {
    assert.equal(validateTranslateInput({ text: "Hello", to: "es" }), null);
  });

  it("accepts valid input with from", () => {
    assert.equal(validateTranslateInput({ text: "Bonjour", to: "en", from: "fr" }), null);
  });

  it("accepts valid input with context", () => {
    assert.equal(validateTranslateInput({ text: "Hello", to: "es", context: "community post" }), null);
  });

  it("rejects empty text", () => {
    assert.equal(validateTranslateInput({ text: "", to: "es" }), "Text is required");
    assert.equal(validateTranslateInput({ text: "   ", to: "es" }), "Text is required");
  });

  it("rejects missing text", () => {
    assert.equal(validateTranslateInput({ to: "es" } as any), "Text is required");
  });

  it("rejects text too long", () => {
    const longText = "a".repeat(10_001);
    assert.ok(validateTranslateInput({ text: longText, to: "es" })?.includes("10000"));
  });

  it("rejects missing 'to'", () => {
    assert.ok(validateTranslateInput({ text: "Hello" } as any)?.includes("to"));
  });

  it("rejects invalid 'to' language code", () => {
    assert.ok(validateTranslateInput({ text: "Hello", to: "xx" })?.includes("Invalid"));
  });

  it("rejects invalid 'from' language code", () => {
    assert.ok(validateTranslateInput({ text: "Hello", to: "es", from: "xx" })?.includes("Invalid"));
  });

  it("rejects context too long", () => {
    const longContext = "a".repeat(201);
    assert.ok(validateTranslateInput({ text: "Hello", to: "es", context: longContext })?.includes("200"));
  });
});

// ---------------------------------------------------------------------------
// tokensToWords / wordsToTokens
// ---------------------------------------------------------------------------

describe("tokensToWords", () => {
  it("converts tokens to words (tokens / 1.3, rounded)", () => {
    assert.equal(tokensToWords(1300), 1000);
    assert.equal(tokensToWords(0), 0);
    assert.equal(tokensToWords(130), 100);
  });
});

describe("wordsToTokens", () => {
  it("converts words to tokens (words * 1.3, rounded)", () => {
    assert.equal(wordsToTokens(1000), 1300);
    assert.equal(wordsToTokens(0), 0);
  });
});

// ---------------------------------------------------------------------------
// translateText — prompt construction and error handling
// ---------------------------------------------------------------------------

describe("translateText", () => {
  it("builds system prompt with target language", async () => {
    let capturedBody: any = null;

    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Hola mundo" } }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }), { status: 200 });
    };

    try {
      const result = await translateText("Hello world", "es");
      assert.equal(result.text, "Hola mundo");
      assert.equal(result.to, "es");
      assert.equal(result.input_tokens, 20);
      assert.equal(result.output_tokens, 5);

      // System prompt should mention target language
      const systemMsg = capturedBody.messages.find((m: any) => m.role === "system");
      assert.ok(systemMsg.content.includes("es"));

      // User text is the user message, not in system prompt
      const userMsg = capturedBody.messages.find((m: any) => m.role === "user");
      assert.equal(userMsg.content, "Hello world");
      assert.ok(!systemMsg.content.includes("Hello world"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("includes context in system prompt when provided", async () => {
    let capturedBody: any = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: any, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Translated" } }],
        usage: { prompt_tokens: 25, completion_tokens: 5 },
      }), { status: 200 });
    };

    try {
      await translateText("Hello", "es", { context: "south LA community center" });
      const systemMsg = capturedBody.messages.find((m: any) => m.role === "system");
      assert.ok(systemMsg.content.includes("south LA community center"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("includes explicit source language in system prompt", async () => {
    let capturedBody: any = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: any, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Hello world" } }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }), { status: 200 });
    };

    try {
      const result = await translateText("Bonjour le monde", "en", { from: "fr" });
      assert.equal(result.from, "fr");
      const systemMsg = capturedBody.messages.find((m: any) => m.role === "system");
      assert.ok(systemMsg.content.includes("fr"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws 503 on OpenRouter error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("Internal error", { status: 500 });

    try {
      await assert.rejects(
        () => translateText("Hello", "es"),
        (err: any) => err instanceof TranslateError && err.statusCode === 503,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws 503 on empty response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [] }), { status: 200 });

    try {
      await assert.rejects(
        () => translateText("Hello", "es"),
        (err: any) => err instanceof TranslateError && err.statusCode === 503,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// getTranslationAddon
// ---------------------------------------------------------------------------

describe("getTranslationAddon", () => {
  it("returns addon if active", async () => {
    mockPoolQuery = async () => ({
      rows: [{ included_tokens: 13000, billing_cycle_start: "2024-01-01T00:00:00Z" }],
    });
    const addon = await getTranslationAddon("proj_123");
    assert.ok(addon);
    assert.equal(addon.included_tokens, 13000);
  });

  it("returns null if no addon", async () => {
    mockPoolQuery = async () => ({ rows: [] });
    const addon = await getTranslationAddon("proj_123");
    assert.equal(addon, null);
  });
});

// ---------------------------------------------------------------------------
// getUsageForPeriod
// ---------------------------------------------------------------------------

describe("getUsageForPeriod", () => {
  it("returns cumulative token usage", async () => {
    mockPoolQuery = async () => ({ rows: [{ total_tokens: 5000 }] });
    const usage = await getUsageForPeriod("proj_123", "translate", new Date("2024-01-01"));
    assert.equal(usage, 5000);
  });

  it("returns 0 if no usage", async () => {
    mockPoolQuery = async () => ({ rows: [{ total_tokens: 0 }] });
    const usage = await getUsageForPeriod("proj_123", "translate", new Date("2024-01-01"));
    assert.equal(usage, 0);
  });
});

// ---------------------------------------------------------------------------
// logAiUsage — fire and forget
// ---------------------------------------------------------------------------

describe("logAiUsage", () => {
  it("logs usage without throwing on success", async () => {
    let queryArgs: any[] = [];
    mockPoolQuery = async (...args: any[]) => { queryArgs = args; return { rows: [] }; };
    await logAiUsage("proj_123", "translate", 100, 50, "test-model");
    assert.ok(queryArgs.length > 0);
  });

  it("does not throw on DB error", async () => {
    mockPoolQuery = async () => { throw new Error("DB down"); };
    // Should not throw
    await logAiUsage("proj_123", "translate", 100, 50, "test-model");
  });
});
