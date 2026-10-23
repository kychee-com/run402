/**
 * Project reads whose gateway routes accept the project's own service key
 * (push status, the project events feed, snapshot reads) authenticate as the
 * caller's principal when the credential provider has one, and otherwise with
 * the locally cached service key. `projects.delete` does the inverse: the
 * cached service key when present, otherwise the owner's principal, instead of
 * refusing locally.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "./index.js";
import type { CredentialsProvider } from "./credentials.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function mockFetch(
  handler: (call: FetchCall) => Response = () => jsonResponse({}),
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const KEYS = { anon_key: "anon_cached", service_key: "service_cached" };

function makeSdk(
  fetchImpl: typeof globalThis.fetch,
  opts: { principal: boolean; cachedKey: boolean; removed?: string[] },
): Run402 {
  const creds: CredentialsProvider = {
    async getAuth() {
      return opts.principal ? { "SIGN-IN-WITH-X": "test-siwx" } : null;
    },
    async getProjectCredentials(id: string) {
      return opts.cachedKey && id === "prj_1" ? KEYS : null;
    },
    async removeProject(id: string) {
      opts.removed?.push(id);
    },
  };
  return new Run402({ apiBase: "https://api.example.test", credentials: creds, fetch: fetchImpl });
}

const READS: Array<[string, (r: Run402) => Promise<unknown>]> = [
  ["push.status", (r) => r.push.status("prj_1")],
  ["push.getMessage", (r) => r.push.getMessage("prj_1", "pmsg_1")],
  ["events.list", (r) => r.events.list("prj_1")],
  ["snapshots.list", (r) => r.snapshots.list("prj_1")],
  ["snapshots.get", (r) => r.snapshots.get("prj_1", "snap_1")],
  ["snapshots.getRestore", (r) => r.snapshots.getRestore("prj_1", "snap_1", "rst_1")],
  ["project(id).push.status", (r) => r.project("prj_1").push.status()],
  ["project(id).events.list", (r) => r.project("prj_1").events.list()],
];

describe("project reads: cached service key fallback", () => {
  for (const [name, call] of READS) {
    it(`${name} sends the cached service key when no principal is present`, async () => {
      const { fetch, calls } = mockFetch();
      await call(makeSdk(fetch, { principal: false, cachedKey: true }));
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.headers["Authorization"], "Bearer service_cached");
      assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    });

    it(`${name} goes as the principal when one is present, even with a cached key`, async () => {
      const { fetch, calls } = mockFetch();
      await call(makeSdk(fetch, { principal: true, cachedKey: true }));
      assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
      assert.equal(calls[0]!.headers["Authorization"], undefined);
    });

    it(`${name} sends no credential when neither is present`, async () => {
      const { fetch, calls } = mockFetch();
      await call(makeSdk(fetch, { principal: false, cachedKey: false }));
      assert.equal(calls[0]!.headers["Authorization"], undefined);
      assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
    });
  }

  it("events.listForOrg never sends a project service key (principal-only route)", async () => {
    const { fetch, calls } = mockFetch();
    await makeSdk(fetch, { principal: false, cachedKey: true }).events.listForOrg("prj_1");
    assert.equal(calls[0]!.headers["Authorization"], undefined);
  });
});

describe("projects.delete: principal when no cached service key", () => {
  it("DELETEs as the owner's principal when this machine holds no key for the project", async () => {
    const removed: string[] = [];
    const { fetch, calls } = mockFetch(() => jsonResponse({ status: "purged", project_id: "prj_2" }));
    await makeSdk(fetch, { principal: true, cachedKey: false, removed }).projects.delete("prj_2");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "DELETE");
    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/prj_2");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.equal(calls[0]!.headers["Authorization"], undefined);
    assert.deepEqual(removed, ["prj_2"]);
  });

  it("prefers the cached service key when one exists", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ status: "purged", project_id: "prj_1" }));
    await makeSdk(fetch, { principal: true, cachedKey: true }).projects.delete("prj_1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers["Authorization"], "Bearer service_cached");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);
  });

  it("retries once as the principal when the gateway refuses the cached key", async () => {
    const { fetch, calls } = mockFetch((call) =>
      call.headers["Authorization"]
        ? jsonResponse({ code: "CREDENTIAL_REVOKED", message: "revoked" }, 401)
        : jsonResponse({ status: "purged", project_id: "prj_1" }));
    await makeSdk(fetch, { principal: true, cachedKey: true }).projects.delete("prj_1");
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.equal(calls[1]!.headers["Authorization"], undefined);
  });
});
