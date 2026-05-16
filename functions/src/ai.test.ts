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

    assert.equal(lastFetchUrl, "https://test.run402.com/ai/v1/generate-image");
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
