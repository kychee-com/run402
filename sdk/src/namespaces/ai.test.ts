import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { LocalError } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  const credentials: CredentialsProvider = {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject() {
      return null;
    },
  };
  return new Run402({
    apiBase: "https://api.example.test",
    credentials,
    fetch: fetchImpl,
  });
}

describe("ai.generateImage", () => {
  it("rejects unsupported image aspects before fetch", async () => {
    const calls: unknown[] = [];
    const sdk = makeSdk(async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true }));
    });

    await assert.rejects(
      sdk.ai.generateImage({ prompt: "a logo", aspect: "panorama" as any }),
      LocalError,
    );
    assert.equal(calls.length, 0);
  });

  it("sends the default square aspect when omitted", async () => {
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    const sdk = makeSdk(async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({
        image: "aW1n",
        content_type: "image/png",
        aspect: "square",
      }), { headers: { "content-type": "application/json" } });
    });

    await sdk.ai.generateImage({ prompt: "a logo" });

    assert.equal(String(calls[0]!.input), "https://api.example.test/generate-image/v1");
    assert.deepEqual(JSON.parse(calls[0]!.init!.body as string), {
      prompt: "a logo",
      aspect: "square",
    });
  });
});
