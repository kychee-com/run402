import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Run402 } from "../index.js";
import { ProjectNotFound } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

function creds(): CredentialsProvider {
  return {
    async getAuth() { return { "SIGN-IN-WITH-X": "t" }; },
    async getProject(id) { return id === "prj_k" ? { anon_key: "a", service_key: "s" } : null; },
  };
}

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
function mockFetch(h: (c: Call) => Response): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    };
    calls.push(call);
    return h(call);
  };
  return { fetch, calls };
}

function sdk(f: typeof globalThis.fetch): Run402 {
  return new Run402({ apiBase: "https://api.test", credentials: creds(), fetch: f });
}

function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
}

describe("senderDomain.disableInbound", () => {
  it("DELETEs /email/v1/domains/inbound with the domain in the body", async () => {
    const { fetch, calls } = mockFetch(() => json({ status: "disabled" }));
    await sdk(fetch).senderDomain.disableInbound("prj_k", "ex.com");
    assert.equal(calls[0]!.url, "https://api.test/email/v1/domains/inbound");
    assert.equal(calls[0]!.method, "DELETE");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer s");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { domain: "ex.com" });
  });

  it("returns the gateway envelope with status", async () => {
    const { fetch } = mockFetch(() => json({ status: "disabled" }));
    const result = await sdk(fetch).senderDomain.disableInbound("prj_k", "ex.com");
    assert.equal(result.status, "disabled");
  });

  it("throws ProjectNotFound without any fetch for unknown project", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    await assert.rejects(
      sdk(fetch).senderDomain.disableInbound("prj_missing", "ex.com"),
      ProjectNotFound,
    );
    assert.equal(calls.length, 0);
  });
});
