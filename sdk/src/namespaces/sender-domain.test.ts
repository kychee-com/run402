import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Run402 } from "../index.js";
import { LocalError } from "../errors.js";
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

describe("senderDomain removed shim", () => {
  it("fails locally with COMMAND_REMOVED and no fetch", async () => {
    const { fetch, calls } = mockFetch(() => json({ status: "disabled" }));
    await assert.rejects(
      sdk(fetch).senderDomain.disableInbound("prj_k", "ex.com"),
      (err: unknown) => {
        assert.ok(err instanceof LocalError);
        assert.equal((err as LocalError).code, "COMMAND_REMOVED");
        assert.match((err as Error).message, /run402 domains disconnect ex\.com --project prj_k --confirm/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  it("does not require local project credentials before throwing", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    await assert.rejects(
      sdk(fetch).senderDomain.register("prj_missing", "ex.com"),
      (err: unknown) => err instanceof LocalError && (err as LocalError).code === "COMMAND_REMOVED",
    );
    assert.equal(calls.length, 0);
  });
});
