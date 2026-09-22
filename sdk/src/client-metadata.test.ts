/**
 * Client surface metadata and client capabilities (code-mode MCP, task 1.1).
 *
 * The surface a client is built for travels two ways: as the bounded
 * `Run402-Client` header on every gateway request, and as the capability set
 * the client carries. A `sandbox` client (an MCP `run` snippet) identifies
 * itself as `sandbox` and refuses one-time secrets; every other surface keeps
 * `returnSecrets: true`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402, DEFAULT_CLIENT_CAPABILITIES } from "./index.js";
import { run402 } from "./node/index.js";
import type { CredentialsProvider } from "./credentials.js";

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers[name];
}

function captureFetch(seen: string[]): typeof globalThis.fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(headerOf(init, "Run402-Client") ?? "");
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

const noCreds: CredentialsProvider = {
  async getAuth() { return null; },
  async getProject() { return null; },
};

describe("client metadata surface", () => {
  for (const surface of ["cli", "mcp", "sdk", "sandbox"] as const) {
    it(`a ${surface} client sends surface=${surface} on gateway requests`, async () => {
      const seen: string[] = [];
      const r = run402({ surface, credentials: noCreds, fetch: captureFetch(seen), apiBase: "https://api.run402.test" });
      await r.service.health();
      assert.equal(seen.length, 1);
      assert.match(seen[0]!, new RegExp(`surface="${surface}"`));
    });
  }

  it("a client built with no surface identifies as sdk", async () => {
    const seen: string[] = [];
    const r = run402({ credentials: noCreds, fetch: captureFetch(seen), apiBase: "https://api.run402.test" });
    await r.service.health();
    assert.match(seen[0]!, /surface="sdk"/);
  });
});

describe("client capabilities", () => {
  it("returnSecrets is true for cli, mcp, and sdk and false for sandbox", () => {
    for (const surface of ["cli", "mcp", "sdk"] as const) {
      const r = run402({ surface, credentials: noCreds, fetch: captureFetch([]), apiBase: "https://api.run402.test" });
      assert.equal(r.capabilities.returnSecrets, true, `surface=${surface}`);
    }
    const sandbox = run402({ surface: "sandbox", credentials: noCreds, fetch: captureFetch([]), apiBase: "https://api.run402.test" });
    assert.equal(sandbox.capabilities.returnSecrets, false);
  });

  it("an isomorphic client defaults to returnSecrets: true and honours an explicit capability", () => {
    const plain = new Run402({ apiBase: "https://api.run402.test", credentials: noCreds, fetch: captureFetch([]) });
    assert.deepEqual({ ...plain.capabilities }, { ...DEFAULT_CLIENT_CAPABILITIES });
    const refusing = new Run402({
      apiBase: "https://api.run402.test",
      credentials: noCreds,
      fetch: captureFetch([]),
      capabilities: { returnSecrets: false },
    });
    assert.equal(refusing.capabilities.returnSecrets, false);
  });

  it("capabilities are frozen", () => {
    const r = run402({ surface: "sandbox", credentials: noCreds, fetch: captureFetch([]), apiBase: "https://api.run402.test" });
    assert.throws(() => {
      (r.capabilities as { returnSecrets: boolean }).returnSecrets = true;
    });
  });
});
