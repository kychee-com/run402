import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

mock.module("./config.js", {
  namedExports: {
    config: {
      API_BASE: "https://test.run402.com",
      PROJECT_ID: "prj_test",
      SERVICE_KEY: "sk_test",
    },
  },
});

const { ai } = await import("./ai.js");

describe("ai.translate", () => {
  let lastFetchUrl = "";
  let lastFetchOpts: RequestInit = {};

  beforeEach(() => {
    lastFetchUrl = "";
    lastFetchOpts = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      lastFetchUrl = url;
      lastFetchOpts = opts;
      return new Response(JSON.stringify({ text: "Hola mundo", from: "en", to: "es" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  it("posts to /ai/v1/translate with service credentials", async () => {
    const result = await ai.translate("Hello world", "es", { from: "en", context: "greeting" });

    assert.equal(lastFetchUrl, "https://test.run402.com/ai/v1/translate");
    assert.equal(lastFetchOpts.method, "POST");
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk_test");
    assert.equal(headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(lastFetchOpts.body as string), {
      text: "Hello world",
      to: "es",
      from: "en",
      context: "greeting",
    });
    assert.deepEqual(result, { text: "Hola mundo", from: "en", to: "es" });
  });

  it("omits optional from/context when not provided", async () => {
    await ai.translate("Hello", "fr");
    assert.deepEqual(JSON.parse(lastFetchOpts.body as string), { text: "Hello", to: "fr" });
  });

  it("throws on non-ok response", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ error: "quota exceeded" }), { status: 429 }),
    );
    await assert.rejects(
      async () => { await ai.translate("x", "es"); },
      /Translation failed \(429\)/,
    );
  });
});

describe("ai.moderate", () => {
  it("posts to /ai/v1/moderate with service credentials", async () => {
    let lastFetchUrl = "";
    let lastFetchOpts: RequestInit = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      lastFetchUrl = url;
      lastFetchOpts = opts;
      return new Response(JSON.stringify({ flagged: false, categories: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await ai.moderate("some text to check");

    assert.equal(lastFetchUrl, "https://test.run402.com/ai/v1/moderate");
    assert.equal(lastFetchOpts.method, "POST");
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk_test");
    assert.equal(headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(lastFetchOpts.body as string), { text: "some text to check" });
    assert.deepEqual(result, { flagged: false, categories: {} });
  });

  it("throws on non-ok response", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }),
    );
    await assert.rejects(
      async () => { await ai.moderate("x"); },
      /Moderation failed \(429\)/,
    );
  });
});

describe("ai.generateImage", () => {
  let lastFetchUrl = "";
  let lastFetchOpts: RequestInit = {};

  beforeEach(() => {
    lastFetchUrl = "";
    lastFetchOpts = {};
    mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
      lastFetchUrl = url;
      lastFetchOpts = opts;
      return new Response(JSON.stringify({
        image: "base64-png",
        content_type: "image/png",
        aspect: "landscape",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  it("calls the project runtime image endpoint with service credentials", async () => {
    const result = await ai.generateImage({
      prompt: "  a moonlit dream  ",
      aspect: "landscape",
    });

    assert.equal(lastFetchUrl, "https://test.run402.com/generate-image/v1");
    assert.equal(lastFetchOpts.method, "POST");
    const headers = lastFetchOpts.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk_test");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(lastFetchOpts.body, JSON.stringify({
      prompt: "a moonlit dream",
      aspect: "landscape",
    }));
    assert.deepEqual(result, {
      image: "base64-png",
      content_type: "image/png",
      aspect: "landscape",
    });
  });

  it("defaults aspect to square", async () => {
    await ai.generateImage({ prompt: "avatar" });

    assert.equal(lastFetchOpts.body, JSON.stringify({
      prompt: "avatar",
      aspect: "square",
    }));
  });

  it("rejects invalid aspects before sending a request", async () => {
    let called = false;
    mock.method(globalThis, "fetch", async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });

    await assert.rejects(
      async () => {
        await ai.generateImage({ prompt: "x", aspect: "panorama" as never });
      },
      /Invalid image aspect/,
    );
    assert.equal(called, false);
  });

  it("rejects missing prompt before sending a request", async () => {
    let called = false;
    mock.method(globalThis, "fetch", async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });

    await assert.rejects(
      async () => {
        await ai.generateImage({ prompt: "   " });
      },
      /prompt is required/,
    );
    assert.equal(called, false);
  });

  it("surfaces quota and spend-cap errors as ordinary runtime errors", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({
        code: "QUOTA_EXCEEDED",
        message: "Image generation runtime budget exhausted.",
      }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await assert.rejects(
      async () => {
        await ai.generateImage({ prompt: "x" });
      },
      /Image generation failed \(403\): QUOTA_EXCEEDED: Image generation runtime budget exhausted\./,
    );
  });
});
